// Circuit execution orchestration: WHEN operations happen (sequencing, conditions, checkpoints, tracing).
// HOW the quantum state changes is delegated to the Physics Engine; WHAT each gate does comes from the registry.
import { Complex, ZERO } from './complex';
import { applyGate as applyRegisteredGate, getGateDefinition } from './gates/registry';
import { conditionSatisfied } from './gates/conditions';
import { applyInverseAwareDefinition } from './gates/inverse';
import { buildStateTransition, snapshotStateParticles } from './physics/particleTracking';
import { physics } from './physics/PhysicsEngine';
import type { NoiseModel } from './physics/noise/NoiseModel';
import type { DensityMatrixState, QuantumState } from './physics/state/QuantumState';
import { CircuitGate, ExecutionResult, MeasurementMap, ParticleStartState, StateCheckpoint } from './types';

export {
  applySingleQubitGate,
  applyControlledX,
  applyControlledPredicateX,
  hasBit,
  measureQubit,
  prepareZeroQubit,
} from './gates/operations';

/** Prefix of the log line for compiler-inserted RESETs, which the UI hides like the gates themselves. */
export const WORKSPACE_RESET_LOG_PREFIX = 'Logical-cycle workspace prepared';

export const basisLabel = (index: number, qubitCount: number): string => index.toString(2).padStart(qubitCount, '0');

/** Marginalize a state vector onto the selected qubit indices for logical-param display. */
export const projectStateOntoQubits = (
  state: Complex[],
  sourceQubitCount: number,
  qubits: number[],
): Complex[] =>
  physics.marginalProbabilities(physics.fromAmplitudes(state, sourceQubitCount), qubits)
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
  let state = physics.createState(qubitCount);

  const indices = resolveParamQubitIndices(qubitCount, startStates, paramQubitIndices);
  const invalid = indices.filter((qubit) => qubit < 0 || qubit >= qubitCount);
  if (invalid.length > 0) {
    throw new RangeError(`Invalid qubit indices: ${invalid.join(', ')} (qubitCount=${qubitCount})`);
  }
  indices.forEach((qubit) => {
    state = physics.prepare(state, qubit, startStates[qubit] ?? '0p');
  });

  return state.amplitudes;
};

// Custom/child gates may pad the state vector beyond the UI qubit count; trust vector width when it is larger.
export const resolveStateQubitCount = (state: Complex[], qubitCount: number): number =>
  physics.resolveQubitCount(state, qubitCount);

// The engine decides WHEN a register must grow (a gate names a higher wire); the physics layer pads it.
const requiredWidth = (qubitCount: number, gate: CircuitGate) => {
  const touched = [...gate.targets, ...gate.controls];
  if (touched.length === 0) return qubitCount;
  return Math.max(qubitCount, Math.max(...touched) + 1);
};

const ensureStateWidth = (state: Complex[], qubitCount: number, gate: CircuitGate) => {
  const nextCount = requiredWidth(qubitCount, gate);
  if (nextCount === qubitCount) return { state, qubitCount };
  return { state: physics.expandRegister(physics.fromAmplitudes(state, qubitCount), nextCount).amplitudes, qubitCount: nextCount };
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

// ── Engine-native execution (QuantumState) ───────────────────────────────

/** A saved register in any representation. */
export type QuantumCheckpoint = { state: QuantumState; measurements: MeasurementMap };

/**
 * Engine-native result. The state stays a QuantumState, so a density matrix
 * produced by noise is never squeezed into Complex[]. ExecutionResult is the
 * Complex[] compatibility view of this type.
 */
export type QuantumExecutionResult = Omit<ExecutionResult, 'state' | 'checkpoints'> & {
  state: QuantumState;
  checkpoints: Record<string, QuantumCheckpoint>;
};

export type ExecuteOptions = {
  librarySources?: Record<string, string>;
  trackParticles?: boolean;
  checkpoints?: Record<string, QuantumCheckpoint>;
  /**
   * Open-system noise applied after every physical operation. The register
   * becomes a density matrix only once a channel can actually change it.
   */
  noise?: NoiseModel;
  /** Start from a density matrix even without noise. */
  representation?: QuantumState['kind'];
  /** Sampler for MEASURE and RESET outcomes (defaults to Math.random). */
  random?: () => number;
};

const runRegisteredGate = (
  amplitudes: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
): ExecutionResult => {
  const definition = getGateDefinition(String(gate.type));
  return definition
    ? applyInverseAwareDefinition(definition, amplitudes, qubitCount, gate, measurements, librarySources)
    : applyRegisteredGate(amplitudes, qubitCount, gate, measurements, librarySources);
};

// Gate-expression predicates run a gate on a scratch copy and read amplitudes, so they need a state vector.
const evaluateCondition = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
): boolean => {
  if (gate.condition?.predicate && state.kind !== 'stateVector') {
    throw new Error('Gate-expression IF predicates read amplitudes and are not supported on a density matrix.');
  }
  return conditionSatisfied(
    gate,
    measurements,
    state.kind === 'stateVector' ? state.amplitudes : undefined,
    state.qubitCount,
    (probe, probeState, probeQubitCount, probeMeasurements) =>
      runRegisteredGate(probeState, probeQubitCount, probe, probeMeasurements, librarySources),
  );
};

// CYCLE marks a logical stage (not physical time); SAVE_STATE / LOAD_STATE are simulator checkpoints.
const applyMarker = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  checkpoints: Record<string, QuantumCheckpoint>,
): Pick<QuantumExecutionResult, 'state' | 'measurements' | 'log'> | undefined => {
  if (gate.type === 'CYCLE') return { state, measurements, log: [`Logical cycle ${gate.cycle ?? 0} started.`] };
  if (gate.type !== 'SAVE_STATE' && gate.type !== 'LOAD_STATE') return undefined;
  const name = gate.checkpoint ?? 'checkpoint';
  if (gate.type === 'SAVE_STATE') {
    // Engine states are never mutated in place, so the checkpoint can share it.
    checkpoints[name] = { state, measurements: { ...measurements } };
    return { state, measurements, log: [`Saved checkpoint ${name}.`] };
  }
  const saved = checkpoints[name];
  if (!saved) throw new Error(`Unknown checkpoint '${name}'`);
  return { state: saved.state, measurements: { ...saved.measurements }, log: [`Loaded checkpoint ${name}.`] };
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
  const result = runRegisteredGate(column, qubitCount, gate, measurements, librarySources);
  if (result.state.length !== column.length || !sameMeasurements(result.measurements, measurements)) {
    throw new Error(`${gate.type} adds wires or measures internally, which density-matrix execution does not support.`);
  }
  if (log.length === 0) log.push(...result.log);
  return result.state;
};

// MEASURE and RESET are physics operations in every representation; other gates come from the registry.
const applyPhysicalOperation = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
  random: () => number,
): Pick<QuantumExecutionResult, 'state' | 'measurements' | 'log'> => {
  if (gate.type === 'MEASURE') {
    const target = gate.targets[0];
    const measured = physics.measure(state, target, gate.basis ?? 'Z', random());
    const basisNote = measured.basis === 'Z' ? '' : ` in ${measured.basis} basis`;
    return {
      state: measured.state,
      measurements: { ...measurements, [target]: measured.outcome },
      log: [`Measured q${target}${basisNote} = ${measured.outcome} (P(1)=${measured.probabilityOne.toFixed(3)}).`],
    };
  }
  if (gate.type === 'RESET') {
    return {
      state: gate.targets.reduce((current, qubit) => physics.reset(current, qubit, random), state),
      measurements,
      log: [`${WORKSPACE_RESET_LOG_PREFIX}: q${gate.targets.join(', q')} as |0⟩.`],
    };
  }
  if (state.kind === 'stateVector') {
    // Custom and child gates may add workspace wires, so the width comes back from the result.
    const result = runRegisteredGate(state.amplitudes, state.qubitCount, gate, measurements, librarySources);
    return {
      state: physics.fromAmplitudes(result.state, physics.resolveQubitCount(result.state, state.qubitCount)),
      measurements: result.measurements,
      log: result.log,
    };
  }
  const log: string[] = [];
  return {
    state: physics.applyLinearKernel(state, densityGateKernel(gate, state.qubitCount, measurements, librarySources, log)),
    measurements,
    log,
  };
};

/**
 * Apply one scheduled gate to an engine-native state: grow the register if
 * the gate names a new wire, handle markers and classical conditions, let the
 * Physics Engine change the state, then apply optional noise.
 */
export const applyGateToState = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  options: ExecuteOptions = {},
): QuantumExecutionResult => {
  const librarySources = options.librarySources ?? {};
  const checkpoints = options.checkpoints ?? {};
  const widened = physics.expandRegister(state, requiredWidth(state.qubitCount, gate));
  let result: Pick<QuantumExecutionResult, 'state' | 'measurements' | 'log' | 'conditionOutcomes'>;

  const marker = applyMarker(widened, gate, measurements, checkpoints);
  if (marker) {
    result = marker;
  } else {
    const satisfied = evaluateCondition(widened, gate, measurements, librarySources);
    // Recorded per gate so the canvas can mark gate-expression branches taken/skipped.
    const conditionOutcomes = gate.condition ? { [gate.id]: satisfied } : undefined;
    if (!satisfied) {
      result = { state: widened, measurements, log: [`${gate.type} skipped because classical condition was false.`], conditionOutcomes };
    } else {
      const applied = applyPhysicalOperation(widened, gate, measurements, librarySources, options.random ?? Math.random);
      const noisy = options.noise
        ? physics.applyNoise(applied.state, options.noise, {
          touched: [...gate.targets, ...gate.controls],
          operation: String(gate.type),
        })
        : applied.state;
      result = { ...applied, state: noisy, ...(conditionOutcomes ? { conditionOutcomes } : {}) };
    }
  }

  if (!options.trackParticles) return { ...result, checkpoints };
  // Particle tracking snapshots before/after one gate so the Bloch view can animate a single transition.
  return {
    ...result,
    checkpoints,
    particles: snapshotStateParticles(result.state, result.measurements),
    transitions: [buildStateTransition(gate, state, result.state, measurements, result.measurements)],
  };
};

const initializationSummary = (qubitCount: number, startStates: ParticleStartState[], paramQubitIndices?: number[]) =>
  (Array.isArray(paramQubitIndices)
    ? paramQubitIndices.map((qubit) => startStates[qubit] ?? '0p').join(' ') || '(no mapped params)'
    : Array.from({ length: qubitCount }, (_, index) => startStates[index] ?? '0p').join(' '));

/** Engine-native full run: the state stays a QuantumState from preparation to result. */
export const executeCircuit = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  paramQubitIndices?: number[],
  options: ExecuteOptions = {},
): QuantumExecutionResult => {
  const checkpoints = options.checkpoints ?? {};
  const prepared = physics.fromAmplitudes(createInitialState(qubitCount, startStates, paramQubitIndices), qubitCount);
  const initial: QuantumState = options.representation === 'densityMatrix' ? physics.toDensityMatrix(prepared) : prepared;

  return gates
    .slice()
    .sort((a, b) => a.step - b.step)
    .reduce<QuantumExecutionResult>(
      (result, gate) => {
        const next = applyGateToState(result.state, gate, result.measurements, { ...options, checkpoints });
        return {
          state: next.state,
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
        state: initial,
        measurements: {},
        log: [`Initialized ${initializationSummary(qubitCount, startStates, paramQubitIndices)}.`],
        particles: options.trackParticles ? snapshotStateParticles(initial, {}) : undefined,
        transitions: [],
        checkpoints,
      },
    );
};

// ── Complex[] compatibility adapters ─────────────────────────────────────

// Raw amplitudes are read at their true width; a caller's larger qubit count adds fresh |0⟩ wires.
const amplitudeView = (state: Complex[], qubitCount: number): QuantumState => {
  const view = physics.fromAmplitudes(state, physics.resolveQubitCount(state, 0));
  return qubitCount > view.qubitCount ? physics.expandRegister(view, qubitCount) : view;
};

const quantumCheckpoints = (legacy: Record<string, StateCheckpoint>): Record<string, QuantumCheckpoint> =>
  Object.fromEntries(Object.entries(legacy).map(([name, saved]) => [
    name,
    { state: physics.fromAmplitudes(saved.state), measurements: saved.measurements },
  ]));

// SAVE_STATE writes into the engine store; mirror state-vector entries back into the caller's legacy store.
const syncLegacyCheckpoints = (
  native: Record<string, QuantumCheckpoint>,
  legacy: Record<string, StateCheckpoint>,
) => {
  Object.entries(native).forEach(([name, saved]) => {
    if (saved.state.kind === 'stateVector') legacy[name] = { state: saved.state.amplitudes, measurements: saved.measurements };
  });
};

const toLegacyResult = (
  result: QuantumExecutionResult,
  checkpoints: Record<string, StateCheckpoint> | undefined,
): ExecutionResult => {
  if (result.state.kind !== 'stateVector') {
    throw new Error('This run produced a density matrix; use executeCircuit to read engine-native state.');
  }
  const { checkpoints: _native, state, ...rest } = result;
  return { ...rest, state: state.amplitudes, ...(checkpoints ? { checkpoints } : {}) };
};

const isMarker = (gate: CircuitGate) => gate.type === 'CYCLE' || gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE';

/** Complex[] adapter over applyGateToState. */
export const applyGate = (
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySourcesOrOptions: Record<string, string> | ApplyGateOptions = {},
): ExecutionResult => {
  const options = normalizeApplyGateOptions(librarySourcesOrOptions);
  if (!options.checkpoints) options.checkpoints = {};
  const native = quantumCheckpoints(options.checkpoints);
  const result = applyGateToState(amplitudeView(state, qubitCount), gate, measurements, {
    librarySources: options.librarySources,
    trackParticles: options.trackParticles,
    checkpoints: native,
  });
  syncLegacyCheckpoints(native, options.checkpoints);
  return toLegacyResult(result, isMarker(gate) ? options.checkpoints : undefined);
};

// Single-gate step path used by the UI run control; the register grows first so stepped custom gates stay addressable.
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

/** Complex[] adapter over executeCircuit for ideal (noise-free) runs. */
export const runCircuit = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  paramQubitIndices?: number[],
  librarySourcesOrOptions: Record<string, string> | RunCircuitOptions = {},
): ExecutionResult => {
  const options = normalizeRunCircuitOptions(librarySourcesOrOptions);
  const legacyCheckpoints = options.checkpoints ?? {};
  const native = quantumCheckpoints(legacyCheckpoints);
  const result = executeCircuit(qubitCount, gates, startStates, paramQubitIndices, {
    librarySources: options.librarySources,
    trackParticles: options.trackParticles,
    checkpoints: native,
  });
  syncLegacyCheckpoints(native, legacyCheckpoints);
  return toLegacyResult(result, legacyCheckpoints);
};

// Collapse any qubits not already recorded in the measurements map (e.g. after explicit MEASURE gates).
export const measureAll = (state: Complex[], qubitCount: number, measurements: MeasurementMap): ExecutionResult => {
  let current = state;
  const nextMeasurements = { ...measurements };
  const log: string[] = [];

  for (let qubit = 0; qubit < qubitCount; qubit += 1) {
    if (nextMeasurements[qubit] === undefined) {
      const measured = physics.measure(physics.fromAmplitudes(current, qubitCount), qubit);
      current = measured.state.amplitudes;
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

/**
 * Open-system run that always reports a density matrix. Equivalent to
 * executeCircuit with `noise` and `representation: 'densityMatrix'`; logical
 * CYCLE markers are not physical time and receive no noise.
 */
export const runNoisyCircuit = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  paramQubitIndices: number[] | undefined,
  options: NoisyRunOptions,
): NoisyExecutionResult => {
  const result = executeCircuit(qubitCount, gates, startStates, paramQubitIndices, {
    noise: options.noise,
    librarySources: options.librarySources,
    random: options.random,
    representation: 'densityMatrix',
  });
  return {
    state: physics.toDensityMatrix(result.state),
    measurements: result.measurements,
    log: result.log,
    ...(result.conditionOutcomes ? { conditionOutcomes: result.conditionOutcomes } : {}),
  };
};
