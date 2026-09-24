// Circuit execution orchestration: initial state, per-gate application via the gate registry, and full runs.
import { Complex, magnitudeSquared, ONE, ZERO } from './complex';
import { applyGate as applyRegisteredGate, getGateDefinition } from './gates/registry';
import { applySingleQubitGate, applyStartState, hasBit, measureQubit, padStateVector } from './gates/operations';
import { conditionSatisfied } from './gates/conditions';
import { applyInverseAwareDefinition } from './gates/inverse';
import { buildOperationTransition, snapshotAllParticles } from './physics/particleTracking';
import { CircuitGate, ExecutionResult, MeasurementMap, OperationTransition, ParticleStartState, StateCheckpoint } from './types';

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
): Complex[] => {
  const targetCount = qubits.length;
  const probabilities = Array.from({ length: 2 ** targetCount }, () => 0);

  state.forEach((amplitude, sourceIndex) => {
    const probability = magnitudeSquared(amplitude);
    if (probability < 1e-20) return;
    let targetIndex = 0;
    qubits.forEach((sourceQubit) => {
      targetIndex = (targetIndex << 1) | (hasBit(sourceIndex, sourceQubit, sourceQubitCount) ? 1 : 0);
    });
    probabilities[targetIndex] += probability;
  });

  return probabilities.map((probability) => (probability > 0 ? { re: Math.sqrt(probability), im: 0 } : ZERO));
};

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
  let state = Array.from({ length: 2 ** qubitCount }, () => ZERO);
  state[0] = ONE;

  const indices = resolveParamQubitIndices(qubitCount, startStates, paramQubitIndices);
  const invalid = indices.filter((qubit) => qubit < 0 || qubit >= qubitCount);
  if (invalid.length > 0) {
    throw new RangeError(`Invalid qubit indices: ${invalid.join(', ')} (qubitCount=${qubitCount})`);
  }
  indices.forEach((qubit) => {
    const startState = startStates[qubit] ?? '0p';
    if (startState === '1p') state = applyStartState(state, qubitCount, qubit, '1p');
    if (startState === 'sp') state = applyStartState(state, qubitCount, qubit, 'sp');
  });

  return state;
};

// Custom/child gates may pad the state vector beyond the UI qubit count; trust vector width when it is larger.
export const resolveStateQubitCount = (state: Complex[], qubitCount: number): number => {
  const vectorWidth = Math.round(Math.log2(state.length));
  if (Number.isFinite(vectorWidth) && vectorWidth > 0 && vectorWidth > qubitCount) {
    return vectorWidth;
  }
  return qubitCount;
};

// Pad the state vector before applying a gate whose controls/targets reference a higher wire index.
const ensureStateWidth = (state: Complex[], qubitCount: number, gate: CircuitGate) => {
  const touched = [...gate.targets, ...gate.controls];
  if (touched.length === 0) return { state, qubitCount };
  const maxWire = Math.max(...touched);
  if (maxWire < qubitCount) return { state, qubitCount };
  const nextCount = maxWire + 1;
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
  if (!conditionSatisfied(gate, measurements)) {
    return {
      state,
      measurements,
      log: [`${gate.type} skipped because classical condition was false.`],
    };
  }
  const definition = getGateDefinition(String(gate.type));
  if (!definition) {
    return applyRegisteredGate(state, qubitCount, gate, measurements, librarySources);
  }
  return applyInverseAwareDefinition(definition, state, qubitCount, gate, measurements, librarySources);
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
      const measured = measureQubit(current, qubitCount, qubit);
      current = measured.state;
      nextMeasurements[qubit] = measured.value;
      log.push(`Measured q${qubit} = ${measured.value} (P(1)=${measured.probabilityOne.toFixed(3)}).`);
    }
  }

  return { state: current, measurements: nextMeasurements, log };
};
