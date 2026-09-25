// Circuit execution orchestration: WHEN operations happen (sequencing, conditions, checkpoints, tracing).
// HOW the quantum state changes is delegated to the Physics Engine; WHAT each gate does comes from the registry.
import { Complex, ZERO } from './complex';
import { applyGate as applyRegisteredGate, getGateDefinition } from './gates/registry';
import { conditionSatisfied } from './gates/conditions';
import { applyInverseAwareDefinition } from './gates/inverse';
import { buildOperationTransition, snapshotAllParticles } from './physics/particleTracking';
import { physics } from './physics/PhysicsEngine';
import { measureStateVector } from './physics/measurement/Measurement';
import type { NoiseModel } from './physics/noise/NoiseModel';
import { type DensityMatrixState, type QuantumState, stateVector } from './physics/state/QuantumState';
import {
  createRegister,
  marginalProbabilities,
  padStateVector,
  prepareStartState,
  resolveStateQubitCount,
} from './physics/state/StateVector';
import { CircuitGate, ExecutionResult, MeasurementMap, ParticleStartState, StateCheckpoint } from './types';

export {
  applySingleQubitGate,
  applyControlledX,
  applyControlledPredicateX,
  hasBit,
  measureQubit,
  prepareZeroQubit,
} from './gates/operations';

export const basisLabel = (index: number, qubitCount: number): string => index.toString(2).padStart(qubitCount, '0');

/** Marginalize a state vector onto the selected qubit indices for logical-param display. */
export const projectStateOntoQubits = (
  state: Complex[],
  sourceQubitCount: number,
  qubits: number[],
): Complex[] =>
  marginalProbabilities(state, sourceQubitCount, qubits)
    .map((probability) => (probability > 0 ? { re: Math.sqrt(probability), im: 0 } : ZERO));

export { conditionSatisfied };

// When the compiler does not supply explicit param indices, start states bind to the first N simulator wires.
const resolveParamQubitIndices = (
  qubitCount: number,
  startStates: ParticleStartState[],
  paramQubitIndices?: number[],
): number[] => {
  if (Array.isArray(paramQubitIndices)) return paramQubitIndices;
  return Array.from({ length: Math.min(qubitCount, startStates.length) }, (_, qubit) => qubit);
};

// Start-state preparation applies only to logical parameter qubits; compiler-created ancilla stay initialized to |0⟩.
export const createInitialState = (
  qubitCount: number,
  startStates: ParticleStartState[] = [],
  paramQubitIndices?: number[],
): Complex[] => {
  let state = createRegister(qubitCount);

  const indices = resolveParamQubitIndices(qubitCount, startStates, paramQubitIndices);
  const invalid = indices.filter((qubit) => qubit < 0 || qubit >= qubitCount);
  if (invalid.length > 0) {
    throw new RangeError(`Invalid qubit indices: ${invalid.join(', ')} (qubitCount=${qubitCount})`);
  }
  indices.forEach((qubit) => {
    state = prepareStartState(state, qubitCount, qubit, startStates[qubit] ?? '0p');
  });

  return state;
};

export { resolveStateQubitCount };

// The engine decides WHEN a register must grow (a gate names a higher wire); the physics layer pads it.
const requiredWidth = (qubitCount: number, gate: CircuitGate) => {
  const touched = [...gate.targets, ...gate.controls];
  if (touched.length === 0) return qubitCount;
  return Math.max(qubitCount, Math.max(...touched) + 1);
};

const ensureStateWidth = (state: Complex[], qubitCount: number, gate: CircuitGate) => {
  const nextCount = requiredWidth(qubitCount, gate);
  if (nextCount === qubitCount) return { state, qubitCount };
  return { state: padStateVector(state, qubitCount, nextCount), qubitCount: nextCount };
};

export type ApplyGateOptions = {
  librarySources?: Record<string, string>;
  trackParticles?: boolean;
  checkpoints?: Record<string, StateCheckpoint>;
};

// Legacy call sites pass a plain librarySources map; newer paths pass an options object with trackParticles.
const isExecutionOptions = (
  input: Record<string, string> | ApplyGateOptions | RunCircuitOptions,
): boolean => {
  const candidate = input as {
    trackParticles?: unknown;
    librarySources?: unknown;
    checkpoints?: unknown;
  };
  return typeof candidate.trackParticles === 'boolean'
    || (
      candidate.librarySources !== undefined
      && candidate.librarySources !== null
      && typeof candidate.librarySources === 'object'
      && !Array.isArray(candidate.librarySources)
    )
    || (
      candidate.checkpoints !== undefined
      && candidate.checkpoints !== null
      && typeof candidate.checkpoints === 'object'
      && !Array.isArray(candidate.checkpoints)
    );
};

const normalizeApplyGateOptions = (
  input: Record<string, string> | ApplyGateOptions = {},
): ApplyGateOptions => {
  if (isExecutionOptions(input)) {
    return input as ApplyGateOptions;
  }
  return { librarySources: input as Record<string, string>, trackParticles: false };
};

const checkpointStore = (options: ApplyGateOptions) => {
  if (!options.checkpoints) options.checkpoints = {};
  return options.checkpoints;
};

// CYCLE, SAVE_STATE, and LOAD_STATE are simulator markers, not registry matrices.
const applyMarkerGate = (
  state: Complex[],
  gate: CircuitGate,
  measurements: MeasurementMap,
  checkpoints: Record<string, StateCheckpoint>,
): ExecutionResult | undefined => {
  if (gate.type === 'CYCLE') {
    return {
      state,
      measurements,
      log: [`Cycle ${gate.cycle ?? 0} started.`],
      checkpoints,
    };
  }
  if (gate.type !== 'SAVE_STATE' && gate.type !== 'LOAD_STATE') return undefined;
  const name = gate.checkpoint ?? 'checkpoint';
  if (gate.type === 'SAVE_STATE') {
    checkpoints[name] = {
      state: state.map((amplitude) => ({ ...amplitude })),
      measurements: { ...measurements },
    };
    return { state, measurements, log: [`Saved checkpoint ${name}.`], checkpoints };
  }
  const saved = checkpoints[name];
  if (!saved) throw new Error(`Unknown checkpoint '${name}'`);
  return {
    state: saved.state.map((amplitude) => ({ ...amplitude })),
    measurements: { ...saved.measurements },
    log: [`Loaded checkpoint ${name}.`],
    checkpoints,
  };
};

const applyInverseOrRegistered = (
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
): ExecutionResult => {
  // Predicates may use custom gates, so hand the evaluator the same registry-aware path.
  const runPredicateGate = (
    probe: CircuitGate,
    probeState: Complex[],
    probeQubitCount: number,
    probeMeasurements: MeasurementMap,
  ): ExecutionResult => {
    const probeDefinition = getGateDefinition(String(probe.type));
    return probeDefinition
      ? applyInverseAwareDefinition(probeDefinition, probeState, probeQubitCount, probe, probeMeasurements, librarySources)
      : applyRegisteredGate(probeState, probeQubitCount, probe, probeMeasurements, librarySources);
  };
  const satisfied = conditionSatisfied(gate, measurements, state, qubitCount, runPredicateGate);
  // Recorded per gate so the canvas can mark gate-expression branches taken/skipped.
  const conditionOutcomes = gate.condition ? { [gate.id]: satisfied } : undefined;
  if (!satisfied) {
    return {
      state,
      measurements,
      log: [`${gate.type} skipped because classical condition was false.`],
      conditionOutcomes,
    };
  }
  const definition = getGateDefinition(String(gate.type));
  const result = definition
    ? applyInverseAwareDefinition(definition, state, qubitCount, gate, measurements, librarySources)
    : applyRegisteredGate(state, qubitCount, gate, measurements, librarySources);
  return conditionOutcomes ? { ...result, conditionOutcomes } : result;
};

// Gate application pads the state vector on demand because compiled child processes may introduce workspace qubits.
export const applyGate = (
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySourcesOrOptions: Record<string, string> | ApplyGateOptions = {},
): ExecutionResult => {
  const options = normalizeApplyGateOptions(librarySourcesOrOptions);
  const librarySources = options.librarySources ?? {};
  const marker = applyMarkerGate(state, gate, measurements, checkpointStore(options));
  if (marker && !options.trackParticles) return marker;

  const beforeState = state;
  const beforeMeasurements = measurements;
  const result = marker ?? applyInverseOrRegistered(state, qubitCount, gate, measurements, librarySources);

  if (!options.trackParticles) return result;

  // Particle tracking snapshots before/after one gate so the Bloch view can animate a single transition.
  const effectiveQubitCount = resolveStateQubitCount(result.state, qubitCount);
  const particles = snapshotAllParticles(result.state, effectiveQubitCount, result.measurements);
  const transition = buildOperationTransition(
    gate,
    beforeState,
    result.state,
    effectiveQubitCount,
    beforeMeasurements,
    result.measurements,
  );
  return { ...result, particles, transitions: [transition] };
};

// Single-gate step path used by the UI run control; pads width first so stepped custom gates stay addressable.
export const stepCircuitGate = (
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySourcesOrOptions: Record<string, string> | ApplyGateOptions = {},
): { result: ExecutionResult; qubitCount: number } => {
  let workingQubitCount = resolveStateQubitCount(state, qubitCount);
  const sized = ensureStateWidth(state, workingQubitCount, gate);
  workingQubitCount = sized.qubitCount;
  const result = applyGate(sized.state, workingQubitCount, gate, measurements, librarySourcesOrOptions);
  return { result, qubitCount: resolveStateQubitCount(result.state, workingQubitCount) };
};

export type RunCircuitOptions = {
  librarySources?: Record<string, string>;
  trackParticles?: boolean;
  checkpoints?: Record<string, StateCheckpoint>;
};

const normalizeRunCircuitOptions = (
  input: Record<string, string> | RunCircuitOptions = {},
): RunCircuitOptions => {
  if (isExecutionOptions(input)) {
    return input as RunCircuitOptions;
  }
  return { librarySources: input as Record<string, string>, trackParticles: false };
};

// Full-circuit runs share the stepping path so logs, measurements, and particle transitions stay consistent.
export const runCircuit = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  paramQubitIndices?: number[],
  librarySourcesOrOptions: Record<string, string> | RunCircuitOptions = {},
): ExecutionResult => {
  const options = normalizeRunCircuitOptions(librarySourcesOrOptions);
  const librarySources = options.librarySources ?? {};
  const checkpoints = options.checkpoints ?? {};
  const initSummary = Array.isArray(paramQubitIndices)
    ? paramQubitIndices.map((qubit) => startStates[qubit] ?? '0p').join(' ') || '(no mapped params)'
    : Array.from({ length: qubitCount }, (_, index) => startStates[index] ?? '0p').join(' ');

  let workingQubitCount = qubitCount;
  let workingState = createInitialState(qubitCount, startStates, paramQubitIndices);

  return gates
    .slice()
    .sort((a, b) => a.step - b.step)
    .reduce<ExecutionResult>(
      (result, gate) => {
        const sized = ensureStateWidth(workingState, workingQubitCount, gate);
        workingState = sized.state;
        workingQubitCount = sized.qubitCount;
        const next = applyGate(workingState, workingQubitCount, gate, result.measurements, {
          librarySources,
          trackParticles: options.trackParticles,
          checkpoints,
        });
        workingState = next.state;
        const vectorWidth = Math.round(Math.log2(workingState.length));
        if (Number.isFinite(vectorWidth) && vectorWidth > workingQubitCount) {
          workingQubitCount = vectorWidth;
        }
        return {
          state: workingState,
          measurements: next.measurements,
          log: [...result.log, ...next.log],
          particles: next.particles ?? result.particles,
          transitions: [...(result.transitions ?? []), ...(next.transitions ?? [])],
          checkpoints,
          conditionOutcomes: next.conditionOutcomes
            ? { ...result.conditionOutcomes, ...next.conditionOutcomes }
            : result.conditionOutcomes,
        };
      },
      {
        state: workingState,
        measurements: {},
        log: [`Initialized ${initSummary}.`],
        particles: options.trackParticles
          ? snapshotAllParticles(workingState, workingQubitCount, {})
          : undefined,
        transitions: [],
      },
    );
};

// Collapse any qubits not already recorded in the measurements map (e.g. after explicit MEASURE gates).
export const measureAll = (state: Complex[], qubitCount: number, measurements: MeasurementMap): ExecutionResult => {
  let current = state;
  const nextMeasurements = { ...measurements };
  const log: string[] = [];

  for (let qubit = 0; qubit < qubitCount; qubit += 1) {
    if (nextMeasurements[qubit] === undefined) {
      const measured = measureStateVector(current, qubitCount, qubit);
      current = measured.state;
      nextMeasurements[qubit] = measured.outcome;
      log.push(`Measured q${qubit} = ${measured.outcome} (P(1)=${measured.probabilityOne.toFixed(3)}).`);
    }
  }

  return { state: current, measurements: nextMeasurements, log };
};

export type NoisyRunOptions = {
  noise: NoiseModel;
  librarySources?: Record<string, string>;
  /** Injectable sampler for MEASURE outcomes (defaults to Math.random). */
  random?: () => number;
};

export type NoisyExecutionResult = {
  state: DensityMatrixState;
  measurements: MeasurementMap;
  log: string[];
  conditionOutcomes?: Record<string, boolean>;
};

const sameMeasurements = (a: MeasurementMap, b: MeasurementMap) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[Number(key)] === b[Number(key)]);
};

// Registered gate kernels are linear on state vectors, so the physics layer can lift them to ρ → UρU†.
const densityGateKernel = (
  gate: CircuitGate,
  qubitCount: number,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
  log: string[],
) => (column: Complex[]): Complex[] => {
  const definition = getGateDefinition(String(gate.type));
  const result = definition
    ? applyInverseAwareDefinition(definition, column, qubitCount, gate, measurements, librarySources)
    : applyRegisteredGate(column, qubitCount, gate, measurements, librarySources);
  if (result.state.length !== column.length || !sameMeasurements(result.measurements, measurements)) {
    throw new Error(`${gate.type} adds wires or measures internally, which density-matrix mode does not support.`);
  }
  if (log.length === 0) log.push(...result.log);
  return result.state;
};

/**
 * Open-system run: same sequencing as runCircuit, but the state is a density
 * matrix and the NoiseModel is applied after every physical operation. Logical
 * CYCLE markers are not physical time and receive no noise. Ideal runs should
 * keep using runCircuit, which never allocates a density matrix.
 */
export const runNoisyCircuit = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  paramQubitIndices: number[] | undefined,
  options: NoisyRunOptions,
): NoisyExecutionResult => {
  const librarySources = options.librarySources ?? {};
  const random = options.random ?? Math.random;
  const checkpoints: Record<string, { state: QuantumState; measurements: MeasurementMap }> = {};
  let state: QuantumState = physics.toDensityMatrix(
    stateVector(createInitialState(qubitCount, startStates, paramQubitIndices), qubitCount),
  );
  let measurements: MeasurementMap = {};
  const log: string[] = [`Initialized ${qubitCount} qubit(s) as a density matrix with noise.`];
  let conditionOutcomes: Record<string, boolean> | undefined;

  gates
    .slice()
    .sort((a, b) => a.step - b.step)
    .forEach((gate) => {
      state = physics.expandRegister(state, requiredWidth(state.qubitCount, gate));
      if (gate.type === 'CYCLE') {
        log.push(`Cycle ${gate.cycle ?? 0} started.`);
        return;
      }
      if (gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE') {
        const name = gate.checkpoint ?? 'checkpoint';
        if (gate.type === 'SAVE_STATE') {
          checkpoints[name] = { state, measurements: { ...measurements } };
          log.push(`Saved checkpoint ${name}.`);
          return;
        }
        const saved = checkpoints[name];
        if (!saved) throw new Error(`Unknown checkpoint '${name}'`);
        state = saved.state;
        measurements = { ...saved.measurements };
        log.push(`Loaded checkpoint ${name}.`);
        return;
      }
      if (gate.condition?.predicate) {
        throw new Error('Gate-expression IF predicates read amplitudes and are not supported in density-matrix mode.');
      }
      const satisfied = conditionSatisfied(gate, measurements);
      if (gate.condition) conditionOutcomes = { ...conditionOutcomes, [gate.id]: satisfied };
      if (!satisfied) {
        log.push(`${gate.type} skipped because classical condition was false.`);
        return;
      }

      if (gate.type === 'MEASURE') {
        const target = gate.targets[0];
        const measured = physics.measure(state, target, gate.basis ?? 'Z', random());
        state = measured.state;
        measurements = { ...measurements, [target]: measured.outcome };
        const basisNote = measured.basis === 'Z' ? '' : ` in ${measured.basis} basis`;
        log.push(`Measured q${target}${basisNote} = ${measured.outcome} (P(1)=${measured.probabilityOne.toFixed(3)}).`);
      } else if (gate.type === 'RESET') {
        state = gate.targets.reduce((current, qubit) => physics.reset(current, qubit), state);
        log.push(`Reset q${gate.targets.join(', q')} to |0⟩.`);
      } else {
        const gateLog: string[] = [];
        state = physics.applyLinearKernel(
          state,
          densityGateKernel(gate, state.qubitCount, measurements, librarySources, gateLog),
        );
        log.push(...gateLog);
      }
      state = physics.applyNoise(state, options.noise, {
        touched: [...gate.targets, ...gate.controls],
        operation: String(gate.type),
      });
    });

  return {
    state: physics.toDensityMatrix(state),
    measurements,
    log,
    ...(conditionOutcomes ? { conditionOutcomes } : {}),
  };
};
