// Circuit execution orchestration: WHEN operations happen (sequencing, conditions, checkpoints, tracing).
// HOW the quantum state changes is delegated to the Physics Engine; WHAT each gate does comes from the registry.
import { Complex, ZERO } from './complex';
import { applyGate as applyRegisteredGate, getGateDefinition } from './gates/registry';
import { conditionSatisfied } from './gates/conditions';
import { applyInverseAwareDefinition } from './gates/inverse';
import { customGateNeedsStateVector } from './gates/customGateEngine';
import { buildStateTransition, snapshotStateParticles } from './physics/particleTracking';
import { physics } from './physics/PhysicsEngine';
import type { NoiseModel, PhysicalTimingModel } from './physics/noise/NoiseModel';
import type { PhysicalSystem } from './physics/frequency/PhysicalEvolution';
import type { ControlPulse, PulseEnvelope } from './physics/frequency/Pulses';
import type { DensityMatrixState, QuantumState } from './physics/state/QuantumState';
import { CircuitGate, ExecutionResult, MeasurementBasisMap, MeasurementMap, ParticleStartState, StateCheckpoint } from './types';

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
  /** Bases of earlier non-Z measurements, from the previous step's `measurementBases`. */
  measurementBases?: MeasurementBasisMap;
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
export type QuantumCheckpoint = { state: QuantumState; measurements: MeasurementMap; measurementBases?: MeasurementBasisMap };

/**
 * Engine-native result. The state stays a QuantumState, so a density matrix
 * produced by noise is never squeezed into Complex[]. ExecutionResult is the
 * Complex[] compatibility view of this type.
 */
export type QuantumExecutionResult = Omit<ExecutionResult, 'state' | 'checkpoints'> & {
  state: QuantumState;
  checkpoints: Record<string, QuantumCheckpoint>;
  /** Physical clock after the run or step (physical simulation mode only). */
  physicalTime?: number;
  /**
   * Population driven out of the computational subspace (to |2⟩) per wire,
   * summed over the run; only anharmonic wires driven by pulses leak.
   */
  leakage?: Record<number, number>;
};

/**
 * Opt-in physical simulation: every scheduled operation lasts its physical
 * duration, during which each wire evolves under its idle Hamiltonian (and
 * couplings), then relaxes with its profile's T1/T2. The ideal path is untouched.
 */
export type PhysicalRunOptions = {
  system: PhysicalSystem;
  /** Physical duration of each operation; logical CYCLE markers take no time. */
  timing?: PhysicalTimingModel;
  /**
   * 'matrix' (default) applies gate matrices instantly at the start of their slot.
   * 'drive' replaces uncontrolled X, Y, NOT, RX, and RY with calibrated resonant pulses.
   */
  gates?: 'matrix' | 'drive';
  envelope?: PulseEnvelope;
  /** Apply each profile's T1/T2 (and temperature) over every duration (default true). */
  decoherence?: boolean;
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
  /** Bases of earlier non-Z measurements (carry `measurementBases` from the previous step's result). */
  measurementBases?: MeasurementBasisMap;
  /** Sampler for MEASURE and RESET outcomes (defaults to Math.random). */
  random?: () => number;
  physical?: PhysicalRunOptions;
  /** Physical clock at the start of this step (carry `physicalTime` from the previous result). */
  physicalTime?: number;
};

// Single-qubit rotations a resonant drive implements directly: rotation angle and XY-plane axis phase.
const driveRotation = (gate: CircuitGate): { angle: number; axisPhase: number } | undefined => {
  if (gate.controls.length > 0 || gate.targets.length !== 1) return undefined;
  switch (gate.type) {
    case 'X':
    case 'NOT':
      return { angle: Math.PI, axisPhase: 0 };
    case 'Y':
      return { angle: Math.PI, axisPhase: Math.PI / 2 };
    case 'RX':
      return { angle: gate.phase ?? 0, axisPhase: 0 };
    case 'RY':
      return { angle: gate.phase ?? 0, axisPhase: Math.PI / 2 };
    default:
      return undefined;
  }
};

const calibratedGatePulse = (physicalOptions: PhysicalRunOptions, gate: CircuitGate, duration: number): ControlPulse | undefined => {
  if (physicalOptions.gates !== 'drive' || duration <= 0) return undefined;
  const rotation = driveRotation(gate);
  if (!rotation) return undefined;
  const target = gate.targets[0];
  const profile = physicalOptions.system.profiles?.[target] ?? physicalOptions.system.defaultProfile;
  if (!profile) return undefined;
  return physics.frequency.calibratedPulse({ target, profile, ...rotation, duration, envelope: physicalOptions.envelope });
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
type StepOutcome = Pick<QuantumExecutionResult, 'state' | 'measurements' | 'log'> & { measurementBases: MeasurementBasisMap };

const applyMarker = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  measurementBases: MeasurementBasisMap,
  checkpoints: Record<string, QuantumCheckpoint>,
): StepOutcome | undefined => {
  if (gate.type === 'CYCLE') return { state, measurements, measurementBases, log: [`Logical cycle ${gate.cycle ?? 0} started.`] };
  if (gate.type !== 'SAVE_STATE' && gate.type !== 'LOAD_STATE') return undefined;
  const name = gate.checkpoint ?? 'checkpoint';
  if (gate.type === 'SAVE_STATE') {
    // Engine states are never mutated in place, so the checkpoint can share it.
    checkpoints[name] = { state, measurements: { ...measurements }, measurementBases: { ...measurementBases } };
    return { state, measurements, measurementBases, log: [`Saved checkpoint ${name}.`] };
  }
  const saved = checkpoints[name];
  if (!saved) throw new Error(`Unknown checkpoint '${name}'`);
  return {
    state: saved.state,
    measurements: { ...saved.measurements },
    measurementBases: { ...saved.measurementBases },
    log: [`Loaded checkpoint ${name}.`],
  };
};

const sameMeasurements = (a: MeasurementMap, b: MeasurementMap) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[Number(key)] === b[Number(key)]);
};

// Registered gate kernels are linear on state vectors, so the physics layer can lift them to ρ → UρU†.
// A custom gate whose body reads amplitudes (gate-expression IF) or resets a wire is not one linear map, so it is refused.
const densityGateKernel = (
  gate: CircuitGate,
  qubitCount: number,
  measurements: MeasurementMap,
  librarySources: Record<string, string>,
  log: string[],
) => {
  if (customGateNeedsStateVector(String(gate.type), librarySources)) {
    throw new Error(
      `${gate.type} contains a gate-expression IF or a RESET (SET … 0p), which is not supported inside a custom gate on a density matrix.`,
    );
  }
  return (column: Complex[]): Complex[] => {
    const result = runRegisteredGate(column, qubitCount, gate, measurements, librarySources);
    if (result.state.length !== column.length || !sameMeasurements(result.measurements, measurements)) {
      throw new Error(`${gate.type} adds wires or measures internally, which density-matrix execution does not support.`);
    }
    if (log.length === 0) log.push(...result.log);
    return result.state;
  };
};

// MEASURE and RESET are physics operations in every representation; other gates come from the registry.
const applyPhysicalOperation = (
  state: QuantumState,
  gate: CircuitGate,
  measurements: MeasurementMap,
  measurementBases: MeasurementBasisMap,
  librarySources: Record<string, string>,
  random: () => number,
): StepOutcome => {
  if (gate.type === 'MEASURE') {
    const target = gate.targets[0];
    const measured = physics.measure(state, target, gate.basis ?? 'Z', random());
    const basisNote = measured.basis === 'Z' ? '' : ` in ${measured.basis} basis`;
    // The bit alone does not say which axis it lies on; keep the observable for X/Y reads.
    const { [target]: _previous, ...otherBases } = measurementBases;
    return {
      state: measured.state,
      measurements: { ...measurements, [target]: measured.outcome },
      measurementBases: measured.basis === 'Z' ? otherBases : { ...otherBases, [target]: measured.basis },
      log: [`Measured q${target}${basisNote} = ${measured.outcome} (P(1)=${measured.probabilityOne.toFixed(3)}).`],
    };
  }
  if (gate.type === 'RESET') {
    return {
      state: gate.targets.reduce((current, qubit) => physics.reset(current, qubit, random), state),
      measurements,
      measurementBases,
      log: [`${WORKSPACE_RESET_LOG_PREFIX}: q${gate.targets.join(', q')} as |0⟩.`],
    };
  }
  if (state.kind === 'stateVector') {
    // Custom and child gates may add workspace wires, so the width comes back from the result.
    const result = runRegisteredGate(state.amplitudes, state.qubitCount, gate, measurements, librarySources);
    return {
      state: physics.fromAmplitudes(result.state, physics.resolveQubitCount(result.state, state.qubitCount)),
      measurements: result.measurements,
      measurementBases,
      log: result.log,
    };
  }
  const log: string[] = [];
  return {
    state: physics.applyLinearKernel(state, densityGateKernel(gate, state.qubitCount, measurements, librarySources, log)),
    measurements,
    measurementBases,
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
  const measurementBases = options.measurementBases ?? {};
  const widened = physics.expandRegister(state, requiredWidth(state.qubitCount, gate));
  let result: StepOutcome & Pick<QuantumExecutionResult, 'conditionOutcomes'>;

  const marker = applyMarker(widened, gate, measurements, measurementBases, checkpoints);
  if (marker) {
    result = marker;
  } else {
    const satisfied = evaluateCondition(widened, gate, measurements, librarySources);
    // Recorded per gate so the canvas can mark gate-expression branches taken/skipped.
    const conditionOutcomes = gate.condition ? { [gate.id]: satisfied } : undefined;
    if (!satisfied) {
      result = {
        state: widened,
        measurements,
        measurementBases,
        log: [`${gate.type} skipped because classical condition was false.`],
        conditionOutcomes,
      };
    } else {
      const pulse = options.physical
        ? calibratedGatePulse(options.physical, gate, physics.frequency.operationDuration(options.physical.timing, String(gate.type)))
        : undefined;
      const applied = pulse
        ? {
          // The drive itself is the operation: the coherent evolution below implements the rotation.
          state: widened,
          measurements,
          measurementBases,
          log: [`${gate.type} on q${pulse.target} as a ${pulse.envelope.kind} drive pulse (f = ${pulse.carrierFrequency}, Ω/2π = ${pulse.amplitude.toPrecision(4)}, ${pulse.duration} time units).`],
        }
        : applyPhysicalOperation(widened, gate, measurements, measurementBases, librarySources, options.random ?? Math.random);
      // In physical mode gate noise follows the operation's physical evolution instead (below).
      const noisy = options.noise && !options.physical
        ? physics.applyNoise(applied.state, options.noise, {
          touched: [...new Set([...gate.targets, ...gate.controls])],
          operation: String(gate.type),
        })
        : applied.state;
      result = { ...applied, state: noisy, ...(conditionOutcomes ? { conditionOutcomes } : {}) };
    }
  }

  let physicalTime: number | undefined;
  let leakage: Record<number, number> = {};
  if (options.physical) {
    const start = options.physicalTime ?? 0;
    // Markers are logical; a skipped conditional gate still occupies its scheduled slot.
    const duration = marker ? 0 : physics.frequency.operationDuration(options.physical.timing, String(gate.type));
    const executed = !marker && result.conditionOutcomes?.[gate.id] !== false;
    const pulse = executed ? calibratedGatePulse(options.physical, gate, duration) : undefined;
    const physical = physics.evolvePhysicalWithLeakage(result.state, options.physical.system, { start, duration, ...(pulse ? { pulses: [pulse] } : {}) });
    let evolved = physical.state;
    leakage = physical.leakage;
    if (options.noise && executed) {
      evolved = physics.applyNoise(evolved, options.noise, {
        touched: [...new Set([...gate.targets, ...gate.controls])],
        operation: String(gate.type),
      });
    }
    if (options.physical.decoherence !== false && duration > 0) {
      evolved = physics.applyPhysicalDecoherence(evolved, options.physical.system, start, duration);
    }
    const leakageLog = Object.entries(leakage).map(([wire, population]) =>
      `q${wire} leaked ${population.toExponential(2)} of its population to |2⟩ (returned as |1⟩).`);
    result = { ...result, state: evolved, log: [...result.log, ...leakageLog] };
    physicalTime = start + duration;
  }
  const timing = {
    ...(physicalTime === undefined ? {} : { physicalTime }),
    ...(Object.keys(leakage).length > 0 ? { leakage } : {}),
  };

  if (!options.trackParticles) return { ...result, checkpoints, ...timing };
  // Particle tracking snapshots before/after one gate so the Bloch view can animate a single transition.
  return {
    ...result,
    checkpoints,
    ...timing,
    particles: snapshotStateParticles(result.state, result.measurements, result.state.qubitCount, result.measurementBases),
    transitions: [buildStateTransition(
      gate,
      state,
      result.state,
      measurements,
      result.measurements,
      result.state.qubitCount,
      measurementBases,
      result.measurementBases,
    )],
  };
};

const initializationSummary = (qubitCount: number, startStates: ParticleStartState[], paramQubitIndices?: number[]) =>
  (Array.isArray(paramQubitIndices)
    ? paramQubitIndices.map((qubit) => startStates[qubit] ?? '0p').join(' ') || '(no mapped params)'
    : Array.from({ length: qubitCount }, (_, index) => startStates[index] ?? '0p').join(' '));

const sumLeakage = (total: Record<number, number> = {}, step: Record<number, number> = {}) =>
  Object.entries(step).reduce<Record<number, number>>((sum, [wire, population]) => ({
    ...sum,
    [wire]: (sum[Number(wire)] ?? 0) + population,
  }), { ...total });

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
        const next = applyGateToState(result.state, gate, result.measurements, {
          ...options,
          checkpoints,
          measurementBases: result.measurementBases,
          physicalTime: result.physicalTime,
        });
        return {
          state: next.state,
          measurements: next.measurements,
          measurementBases: next.measurementBases,
          ...(next.physicalTime === undefined ? {} : { physicalTime: next.physicalTime }),
          ...(next.leakage || result.leakage ? { leakage: sumLeakage(result.leakage, next.leakage) } : {}),
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
        measurementBases: {},
        ...(options.physical ? { physicalTime: options.physicalTime ?? 0 } : {}),
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
    { state: physics.fromAmplitudes(saved.state), measurements: saved.measurements, measurementBases: saved.measurementBases },
  ]));

// SAVE_STATE writes into the engine store; mirror state-vector entries back into the caller's legacy store.
const syncLegacyCheckpoints = (
  native: Record<string, QuantumCheckpoint>,
  legacy: Record<string, StateCheckpoint>,
) => {
  Object.entries(native).forEach(([name, saved]) => {
    if (saved.state.kind === 'stateVector') {
      legacy[name] = { state: saved.state.amplitudes, measurements: saved.measurements, measurementBases: saved.measurementBases };
    }
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
    measurementBases: options.measurementBases,
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
