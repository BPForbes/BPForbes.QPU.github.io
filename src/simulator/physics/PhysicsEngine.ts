/**
 * PhysicsEngine: the single authoritative boundary for quantum mechanics in QPU.
 *
 * The compiler describes the circuit, the simulator engine schedules it, the
 * gate registry supplies operators, and this engine decides how the quantum
 * state changes and what can be measured about it. It never parses QPU source,
 * evaluates IF/ELSE, expands recursion, or renders anything.
 *
 * Accuracy levels:
 * - Simulation state (state vector, density matrix, collapse, channels) is authoritative.
 * - Diagnostics (purity, entropy, fidelity, entanglement, Bloch) are exact derived quantities.
 * - Visualization estimates (Bloch-ball quadrature) live in numerics/ and are labelled as such.
 */
import { type Complex, ONE, ZERO } from '../complex';
import type { ParticleStartState } from '../types';
import {
  blochVectorFromDensity,
  type BlochVector,
  ketFromSpherical,
  mixedStateMetrics,
  type MixedStateMetrics,
  type PsiKet,
  sphericalFromBlochCartesian,
  type SphericalCoordinates,
} from './analysis/Bloch';
import { entropyFromEigenvalues, vonNeumannEntropy } from './analysis/Entropy';
import {
  assessPptNegativity,
  assessPureStateReduction,
  type EntanglementAssessment,
  negativity,
} from './analysis/Entanglement';
import { densityFidelity, pureMixedFidelity, pureStateFidelity } from './analysis/Fidelity';
import { analyzeInterference, type InterferenceAnalysis, type InterferenceOperation } from './analysis/Interference';
import { comparePhase, type PhaseComparison, relativePhases, type RelativePhase } from './analysis/Phase';
import { isPure, linearEntropy, normalizedMixedness, PURE_TOLERANCE, purity } from './analysis/Purity';
import { propagator, timeDependentPropagator, type Hamiltonian, type TimeDependentHamiltonian } from './dynamics/Hamiltonian';
import { driveDiagnostics } from './frequency/DriveDiagnostics';
import {
  segmentPropagators,
  profileFor,
  transitionFrequencies,
  type PhysicalSegment,
  type PhysicalSystem,
} from './frequency/PhysicalEvolution';
import {
  deBroglieWavelength,
  deBroglieWavelengthForMass,
  energyGap,
  joulesToElectronVolts,
  photonEnergy,
  photonWavelength,
  thermalExcitedPopulation,
  transitionFrequency,
} from './frequency/PlanckEinstein';
import { calibratedPulse, envelopeArea, envelopeAt } from './frequency/Pulses';
import {
  actualTransitionFrequency,
  freePrecessionPhase,
  idleHamiltonian,
  profileFromEnergies,
} from './frequency/QubitProfile';
import { advanceClock, startClock } from './frequency/PhysicalClock';
import { angularFrequency, DEFAULT_UNITS, fromHertz, toHertz } from './frequency/Units';
import { generalizedAmplitudeDamping } from './noise/GeneralizedAmplitudeDamping';
import {
  densityMeasurementDiagnostics,
  measureDensityMatrix,
  type MeasurementDiagnostics,
  type MeasurementResult,
  measureStateVector,
  stateVectorMeasurementDiagnostics,
} from './measurement/Measurement';
import type { MeasurementBasis } from './measurement/MeasurementBasis';
import { amplitudeDamping } from './noise/AmplitudeDamping';
import { bitFlip } from './noise/BitFlip';
import { decoherenceChannels, operationDuration } from './noise/Decoherence';
import { phaseDamping } from './noise/Dephasing';
import { depolarizing } from './noise/Depolarizing';
import { phaseFlip } from './noise/PhaseFlip';
import { isIdentityChannel, type NoiseChannel, type NoiseModel } from './noise/NoiseModel';
import type { ComplexMatrix } from './numerics/linearAlgebra';
import {
  applySingleQubitKraus,
  applyUnitaryToDensity,
  conjugateByLinearMap,
  densityFromStateVector,
  densityProbabilities,
  padDensityMatrix,
  resetQubitDensity,
} from './state/DensityMatrix';
import {
  assertDensityWidth,
  type DensityMatrix,
  type DensityMatrixState,
  densityState,
  type StateVectorState,
  type QuantumState,
  stateVector,
} from './state/QuantumState';
import { partialTrace, reducedStateFromVector } from './state/ReducedState';
import {
  applyMultiQubitUnitary,
  applyStartState,
  basisProbabilities,
  bitMask,
  controlsAreActive,
  createRegister,
  hasBit,
  innerProduct,
  marginalProbabilities,
  padStateVector,
  resolveStateQubitCount,
  truncateStateVector,
} from './state/StateVector';
import { resetStateVector } from './measurement/Reset';
import {
  defaultValidationEnabled,
  type StateValidationOptions,
  validateChannel,
  validateDensityMatrix,
  validateOperatorShape,
  validateQubits,
  validateState,
  validateUnitary,
} from './validation/Validation';
import { MATRIX_H, MATRIX_X } from '../gates/matrices';

export type QubitInspection = {
  qubit: number;
  densityMatrix: DensityMatrix;
  bloch: BlochVector;
  spherical: SphericalCoordinates;
  purity: number;
  /** Normalized linear entropy 2(1 − P): 0 pure, 1 maximally mixed. */
  mixedness: number;
  /** Von Neumann entropy in bits. */
  entropy: number;
  probabilities: { zero: number; one: number };
  /** Is this qubit entangled with the rest of the register? See assessEntanglement. */
  entanglement: EntanglementAssessment;
};

export type SubsystemInspection = {
  subsystem: number[];
  densityMatrix: DensityMatrix;
  purity: number;
  linearEntropy: number;
  mixedness: number;
  vonNeumannEntropy: number;
  /** Joint computational-basis distribution (subsystem[0] is the most significant bit). */
  probabilities: number[];
  /** Is the subsystem entangled with the rest of the register? See assessEntanglement. */
  entanglement: EntanglementAssessment;
};

export type GlobalInspection = {
  qubitCount: number;
  representation: QuantumState['kind'];
  purity: number;
  isPure: boolean;
  /** ‖ψ‖² or Tr ρ; 1 for a valid state. */
  normalization: number;
};

/** Display geometry of a Bloch vector, shared by inspected and measured wires. */
export type BlochGeometry = {
  bloch: BlochVector;
  spherical: SphericalCoordinates;
  ket: PsiKet;
  mixed: MixedStateMetrics;
};

export type NoiseContext = {
  /** Qubits the preceding operation touched (targets and controls). */
  touched?: number[];
  /** Operation type, for per-gate physical durations. */
  operation?: string;
};

// Mixed-state entanglement tests diagonalize a 2^n × 2^n partial transpose, so bound it.
const MAX_PPT_QUBITS = 6;

const allQubits = (qubitCount: number) => Array.from({ length: qubitCount }, (_, qubit) => qubit);

const complement = (qubitCount: number, subsystem: number[]) =>
  allQubits(qubitCount).filter((qubit) => !subsystem.includes(qubit));

export class PhysicsEngine {
  /** Single-qubit noise channel constructors for building a NoiseModel. */
  readonly channels = {
    bitFlip,
    phaseFlip,
    depolarizing,
    amplitudeDamping,
    phaseDamping,
    generalizedAmplitudeDamping,
    /** T1/T2 channels for a physical duration (same unit as T1/T2). */
    decoherence: decoherenceChannels,
  } as const;

  /**
   * Energy/frequency physics: Planck–Einstein relations (SI), qubit profiles,
   * the physical clock, calibrated drive pulses, and resonance diagnostics.
   * Simulation frequencies are cycles per time unit (GHz for ns).
   */
  readonly frequency = {
    photonEnergy,
    energyGap,
    transitionFrequency,
    joulesToElectronVolts,
    photonWavelength,
    thermalExcitedPopulation,
    deBroglieWavelength,
    deBroglieWavelengthForMass,
    toHertz,
    fromHertz,
    angularFrequency,
    defaultUnits: DEFAULT_UNITS,
    profileFromEnergies,
    actualTransitionFrequency,
    idleHamiltonian,
    freePrecessionPhase,
    transitionFrequencies,
    calibratedPulse,
    envelopeAt,
    envelopeArea,
    driveDiagnostics,
    startClock,
    advanceClock,
    /** Physical duration of an operation under a timing model (default 1 time unit). */
    operationDuration,
  } as const;

  // ── Validation ─────────────────────────────────────────────────────────

  private validationEnabled = defaultValidationEnabled();

  // Only the outermost public call validates its input state; nested engine calls (and gate kernels run on
  // unnormalized density-matrix columns) skip the repeat. Qubit, operator, and channel checks always run.
  private depth = 0;

  /** Automatic boundary checks default to on in development/tests and off in production. */
  setValidation(enabled: boolean): void {
    this.validationEnabled = enabled;
  }

  get validating(): boolean {
    return this.validationEnabled;
  }

  /** Explicit checks; these always run and throw PhysicsValidationError on failure. */
  validateState(state: QuantumState, options?: StateValidationOptions): void {
    validateState(state, options);
  }

  validateUnitary(matrix: ComplexMatrix, targets?: number[]): void {
    if (targets) validateOperatorShape(matrix, targets);
    validateUnitary(matrix);
  }

  validateChannel(channel: NoiseChannel): void {
    validateChannel(channel);
  }

  private guard<T>(state: QuantumState, run: () => T, ...extra: QuantumState[]): T {
    if (this.validationEnabled && this.depth === 0) {
      validateState(state);
      extra.forEach((other) => validateState(other));
    }
    this.depth += 1;
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  private checkQubits(state: QuantumState, qubits: readonly number[], label: string): void {
    if (this.validationEnabled) validateQubits(state.qubitCount, qubits, label);
  }

  private checkOperator(state: QuantumState, controls: number[], targets: number[], matrix: ComplexMatrix): void {
    if (!this.validationEnabled) return;
    validateQubits(state.qubitCount, [...targets, ...controls], 'targets/controls');
    validateOperatorShape(matrix, targets);
    validateUnitary(matrix);
  }

  private checkDensityInput(rho: DensityMatrix): void {
    if (this.validationEnabled && this.depth === 0) validateDensityMatrix(rho);
  }

  // ── State creation and preparation ─────────────────────────────────────

  createState(qubitCount: number): StateVectorState;
  createState(qubitCount: number, representation: 'stateVector'): StateVectorState;
  createState(qubitCount: number, representation: 'densityMatrix'): DensityMatrixState;
  createState(qubitCount: number, representation?: QuantumState['kind']): QuantumState;
  createState(qubitCount: number, representation: QuantumState['kind'] = 'stateVector'): QuantumState {
    const amplitudes = createRegister(qubitCount);
    return representation === 'stateVector'
      ? stateVector(amplitudes, qubitCount)
      : densityState(densityFromStateVector(amplitudes), qubitCount);
  }

  /**
   * View raw simulator amplitudes as a state without copying. The width is the
   * larger of `qubitCount` and the vector's own width: custom gates append |0⟩
   * workspace wires as low-order bits, so callers holding the logical width keep
   * the same qubit indices.
   */
  fromAmplitudes(amplitudes: Complex[], qubitCount = 0): StateVectorState {
    return stateVector(amplitudes, this.resolveQubitCount(amplitudes, qubitCount));
  }

  /** The computational basis state |index⟩. */
  basisState(index: number, qubitCount: number): StateVectorState {
    const amplitudes = Array.from({ length: 2 ** qubitCount }, (_, entry) => (entry === index ? ONE : ZERO));
    return stateVector(amplitudes, qubitCount);
  }

  /** Register width, trusting the vector when custom/child gates have padded it past `qubitCount`. */
  resolveQubitCount(amplitudes: Complex[], qubitCount: number): number {
    return resolveStateQubitCount(amplitudes, qubitCount);
  }

  /**
   * Drop trailing wires that are known to be |0⟩ (the inverse of expandRegister).
   * Amplitude elsewhere is discarded, so callers must check the result's norm.
   */
  truncateRegister(state: StateVectorState, qubitCount: number): StateVectorState {
    if (this.validationEnabled && (!Number.isInteger(qubitCount) || qubitCount < 0)) {
      throw new RangeError(`Invalid register width ${qubitCount}.`);
    }
    if (qubitCount >= state.qubitCount) return state;
    return stateVector(truncateStateVector(state.amplitudes, state.qubitCount, qubitCount), qubitCount);
  }

  // ── Basis-index conventions (qubit 0 is the most significant bit) ──────

  qubitMask(qubit: number, qubitCount: number): number {
    return bitMask(qubit, qubitCount);
  }

  hasBit(basisIndex: number, qubit: number, qubitCount: number): boolean {
    return hasBit(basisIndex, qubit, qubitCount);
  }

  controlsActive(basisIndex: number, qubitCount: number, controls: number[]): boolean {
    return controlsAreActive(basisIndex, qubitCount, controls);
  }

  /** Prepare a fresh |0⟩ wire as 0p, 1p (|1⟩), or sp (|+⟩). */
  prepare<S extends QuantumState>(state: S, qubit: number, preparation: ParticleStartState): S {
    this.checkQubits(state, [qubit], 'qubit');
    if (preparation === '0p') return state;
    return this.guard(state, () => {
      if (state.kind === 'stateVector') {
        return stateVector(applyStartState(state.amplitudes, state.qubitCount, qubit, preparation), state.qubitCount) as S;
      }
      return this.applyUnitary(state, [qubit], preparation === '1p' ? MATRIX_X : MATRIX_H);
    });
  }

  /** Append |0⟩ wires so the register holds `qubitCount` qubits. */
  expandRegister<S extends QuantumState>(state: S, qubitCount: number): S {
    if (qubitCount <= state.qubitCount) return state;
    return this.guard(state, () => (state.kind === 'stateVector'
      ? stateVector(padStateVector(state.amplitudes, state.qubitCount, qubitCount), qubitCount)
      : densityState(padDensityMatrix(state.rho, state.qubitCount, qubitCount), qubitCount)) as S);
  }

  toDensityMatrix(state: QuantumState): DensityMatrixState {
    return this.guard(state, () => {
      if (state.kind === 'densityMatrix') return state;
      assertDensityWidth(state.qubitCount);
      return densityState(densityFromStateVector(state.amplitudes), state.qubitCount);
    });
  }

  // ── Evolution ──────────────────────────────────────────────────────────

  /** |ψ'⟩ = U|ψ⟩ or ρ' = UρU†. The engine does not care which gate supplied U. */
  applyUnitary<S extends QuantumState>(state: S, targets: number[], matrix: ComplexMatrix): S {
    return this.applyControlledUnitary(state, [], targets, matrix);
  }

  applyControlledUnitary<S extends QuantumState>(state: S, controls: number[], targets: number[], matrix: ComplexMatrix): S {
    this.checkOperator(state, controls, targets, matrix);
    return this.guard(state, () => {
      if (state.kind === 'stateVector') {
        return stateVector(applyMultiQubitUnitary(state.amplitudes, state.qubitCount, targets, matrix, controls), state.qubitCount) as S;
      }
      return densityState(applyUnitaryToDensity(state.rho, state.qubitCount, targets, matrix, controls), state.qubitCount) as S;
    });
  }

  /**
   * Apply any linear state-vector kernel A (e.g. a registered gate's fast
   * path). On a density matrix this is ρ → AρA†.
   */
  applyLinearKernel<S extends QuantumState>(state: S, kernel: (amplitudes: Complex[]) => Complex[]): S {
    return this.guard(state, () => {
      if (state.kind === 'stateVector') return stateVector(kernel(state.amplitudes), state.qubitCount) as S;
      return densityState(conjugateByLinearMap(state.rho, kernel), state.qubitCount) as S;
    });
  }

  /** Evolution under H(t) from `start` for `duration` (piecewise-constant midpoint steps). */
  evolveTimeDependent<S extends QuantumState>(
    state: S,
    hamiltonian: TimeDependentHamiltonian,
    start: number,
    duration: number,
    hbar = 1,
  ): S {
    return this.applyUnitary(state, hamiltonian.targets, timeDependentPropagator(hamiltonian, start, duration, hbar));
  }

  /**
   * Coherent physical evolution for one time segment: every wire evolves under
   * its idle Hamiltonian (so idle qubits precess), plus couplings and any drive
   * pulses, in the system's frame and approximation.
   */
  evolvePhysical<S extends QuantumState>(state: S, system: PhysicalSystem, segment: PhysicalSegment): S {
    return this.guard(state, () => segmentPropagators(system, state.qubitCount, segment)
      .reduce((current, { wires, unitary }) => this.applyUnitary(current, wires, unitary), state));
  }

  /**
   * T1/T2 decoherence from each wire's profile over the same physical duration
   * as coherent evolution; a profile temperature relaxes toward the Boltzmann
   * population of its transition instead of |0⟩.
   */
  applyPhysicalDecoherence(state: QuantumState, system: PhysicalSystem, start: number, duration: number): QuantumState {
    const units = system.units ?? DEFAULT_UNITS;
    return this.guard(state, () => Array.from({ length: state.qubitCount }, (_, wire) => wire).reduce((current, wire) => {
      const profile = profileFor(system, wire);
      if (profile.t1 === undefined && profile.t2 === undefined) return current;
      const excited = profile.temperature
        ? thermalExcitedPopulation(toHertz(actualTransitionFrequency(profile, start), units), profile.temperature)
        : 0;
      return decoherenceChannels({ t1: profile.t1, t2: profile.t2 }, duration, excited)
        .reduce((next, channel) => this.applyChannel(next, channel, [wire]), current);
    }, state));
  }

  /** Continuous evolution under a time-independent Hamiltonian: U = e^{−iHt/ħ}. */
  evolve<S extends QuantumState>(state: S, hamiltonian: Hamiltonian, duration: number, hbar = 1): S {
    return this.applyUnitary(state, hamiltonian.targets, propagator(hamiltonian.matrix, duration, hbar));
  }

  // ── Measurement ────────────────────────────────────────────────────────

  measure<S extends QuantumState>(state: S, qubit: number, basis: MeasurementBasis = 'Z', random = Math.random()): MeasurementResult<S> {
    this.checkQubits(state, [qubit], 'qubit');
    return this.guard(state, () => {
      if (state.kind === 'stateVector') {
        const result = measureStateVector(state.amplitudes, state.qubitCount, qubit, basis, random);
        return { ...result, state: stateVector(result.state, state.qubitCount) as S };
      }
      const result = measureDensityMatrix(state.rho, state.qubitCount, qubit, basis, random);
      return { ...result, state: densityState(result.state, state.qubitCount) as S };
    });
  }

  /** Outcome probabilities for a basis without collapsing the state. */
  measurementDiagnostics(state: QuantumState, qubit: number, basis: MeasurementBasis = 'Z'): MeasurementDiagnostics {
    this.checkQubits(state, [qubit], 'qubit');
    return this.guard(state, () => (state.kind === 'stateVector'
      ? stateVectorMeasurementDiagnostics(state.amplitudes, state.qubitCount, qubit, basis)
      : densityMeasurementDiagnostics(state.rho, state.qubitCount, qubit, basis)));
  }

  /**
   * Force `qubit` to |0⟩. Density matrices get the exact reset channel; state
   * vectors follow one measure-and-flip trajectory of it (see measurement/Reset.ts).
   */
  reset<S extends QuantumState>(state: S, qubit: number, random: () => number = Math.random): S {
    this.checkQubits(state, [qubit], 'qubit');
    return this.guard(state, () => (state.kind === 'stateVector'
      ? stateVector(resetStateVector(state.amplitudes, state.qubitCount, qubit, random), state.qubitCount)
      : densityState(resetQubitDensity(state.rho, state.qubitCount, qubit), state.qubitCount)) as S);
  }

  /** P(qubit = 1) in the computational basis. */
  probabilityOfOne(state: QuantumState, qubit: number): number {
    return this.measurementDiagnostics(state, qubit, 'Z').probabilities[1];
  }

  probabilities(state: QuantumState): number[] {
    return this.guard(state, () => (state.kind === 'stateVector'
      ? basisProbabilities(state.amplitudes)
      : densityProbabilities(state.rho)));
  }

  marginalProbabilities(state: QuantumState, qubits: number[]): number[] {
    this.checkQubits(state, qubits, 'qubits');
    return this.guard(state, () => (state.kind === 'stateVector'
      ? marginalProbabilities(state.amplitudes, state.qubitCount, qubits)
      : densityProbabilities(partialTrace(state.rho, state.qubitCount, qubits))));
  }

  // ── Reduced states and inspection ──────────────────────────────────────

  /** ρ_S = Tr_{rest}(ρ); subsystem[0] is the most significant bit. */
  reducedState(state: QuantumState, subsystem: number[]): DensityMatrix {
    this.checkQubits(state, subsystem, 'subsystem');
    return this.guard(state, () => (state.kind === 'stateVector'
      ? reducedStateFromVector(state.amplitudes, state.qubitCount, subsystem)
      : partialTrace(state.rho, state.qubitCount, subsystem)));
  }

  reducedDensityMatrix(state: QuantumState, subsystem: number[]): DensityMatrix {
    return this.reducedState(state, subsystem);
  }

  blochVector(state: QuantumState, qubit: number): BlochVector {
    return blochVectorFromDensity(this.reducedState(state, [qubit]));
  }

  /** Spherical angles, display ket, and mixed-state metrics for a Bloch vector. */
  describeBlochVector(bloch: BlochVector): BlochGeometry {
    const spherical = sphericalFromBlochCartesian(bloch);
    return { bloch, spherical, ket: ketFromSpherical(spherical.theta, spherical.phi), mixed: mixedStateMetrics(spherical) };
  }

  /**
   * Bloch geometry of a wire whose outcome has been recorded: the eigenstate it collapsed to,
   * on the axis of the measured observable (0 → +axis, 1 → −axis).
   */
  measuredBlochGeometry(outcome: 0 | 1, basis: MeasurementBasis = 'Z'): BlochGeometry {
    const sign = outcome === 1 ? -1 : 1;
    return this.describeBlochVector({
      x: basis === 'X' ? sign : 0,
      y: basis === 'Y' ? sign : 0,
      z: basis === 'Z' ? sign : 0,
    });
  }

  inspectQubit(state: QuantumState, qubit: number): QubitInspection {
    return this.guard(state, () => this.inspectQubitUnchecked(state, qubit));
  }

  private inspectQubitUnchecked(state: QuantumState, qubit: number): QubitInspection {
    const densityMatrix = this.reducedState(state, [qubit]);
    const bloch = blochVectorFromDensity(densityMatrix);
    const spherical = sphericalFromBlochCartesian(bloch);
    const r = Math.min(1, spherical.r);
    const qubitPurity = (1 + spherical.r * spherical.r) / 2;
    return {
      qubit,
      densityMatrix,
      bloch,
      spherical,
      purity: qubitPurity,
      mixedness: 2 * (1 - qubitPurity),
      entropy: entropyFromEigenvalues([(1 - r) / 2, (1 + r) / 2]),
      probabilities: { zero: densityMatrix[0][0].re, one: densityMatrix[1][1].re },
      entanglement: this.assessWithReduced(state, [qubit], densityMatrix),
    };
  }

  inspectSubsystem(state: QuantumState, subsystem: number[]): SubsystemInspection {
    return this.guard(state, () => this.inspectSubsystemUnchecked(state, subsystem));
  }

  private inspectSubsystemUnchecked(state: QuantumState, subsystem: number[]): SubsystemInspection {
    const densityMatrix = this.reducedState(state, subsystem);
    const subsystemPurity = purity(densityMatrix);
    return {
      subsystem: [...subsystem],
      densityMatrix,
      purity: subsystemPurity,
      linearEntropy: 1 - subsystemPurity,
      mixedness: normalizedMixedness(densityMatrix),
      vonNeumannEntropy: vonNeumannEntropy(densityMatrix),
      probabilities: densityProbabilities(densityMatrix),
      entanglement: this.assessWithReduced(state, subsystem, densityMatrix),
    };
  }

  inspectGlobal(state: QuantumState): GlobalInspection {
    // Diagnoses the state as given, so it deliberately skips input validation.
    const probabilities = state.kind === 'stateVector' ? basisProbabilities(state.amplitudes) : densityProbabilities(state.rho);
    const globalPurity = this.globalPurity(state);
    return {
      qubitCount: state.qubitCount,
      representation: state.kind,
      purity: globalPurity,
      isPure: globalPurity >= 1 - PURE_TOLERANCE,
      normalization: probabilities.reduce((sum, probability) => sum + probability, 0),
    };
  }

  // ── Diagnostics on density matrices ────────────────────────────────────

  purity(rho: DensityMatrix): number {
    this.checkDensityInput(rho);
    return purity(rho);
  }

  linearEntropy(rho: DensityMatrix): number {
    this.checkDensityInput(rho);
    return linearEntropy(rho);
  }

  vonNeumannEntropy(rho: DensityMatrix): number {
    this.checkDensityInput(rho);
    return vonNeumannEntropy(rho);
  }

  /** Tr(ρ²) of the whole register; 1 for any normalized state vector. */
  globalPurity(state: QuantumState): number {
    if (state.kind === 'stateVector') {
      const normSquared = basisProbabilities(state.amplitudes).reduce((sum, probability) => sum + probability, 0);
      return normSquared * normSquared;
    }
    return purity(state.rho);
  }

  // ── Entanglement ───────────────────────────────────────────────────────

  /**
   * Is `subsystem` entangled with the rest of the register?
   * - Pure global state: exact, from whether the reduced state is mixed.
   * - Mixed global state: PPT negativity. Positive negativity proves
   *   entanglement; zero proves separability only for 2×2 / 2×3 splits and is
   *   'inconclusive' otherwise. Registers past the PPT size limit are also
   *   'inconclusive' rather than silently treated as separable.
   */
  assessEntanglement(state: QuantumState, subsystem: number[]): EntanglementAssessment {
    this.checkQubits(state, subsystem, 'subsystem');
    return this.guard(state, () => this.assessWithReduced(state, subsystem));
  }

  /** S(ρ_A) in bits; an entanglement measure only for a pure global state. */
  entanglementEntropy(state: QuantumState, subsystem: number[]): number {
    this.checkQubits(state, subsystem, 'subsystem');
    return this.guard(state, () => {
      if (!this.isGloballyPure(state)) {
        throw new RangeError('Entanglement entropy is only defined for a pure global state; use negativity for mixed states.');
      }
      if (complement(state.qubitCount, subsystem).length === 0) return 0;
      return vonNeumannEntropy(this.reducedState(state, subsystem));
    });
  }

  /** Negativity of the bipartition subsystem | rest (0.5 for a Bell pair). */
  negativity(state: QuantumState, subsystem: number[]): number {
    this.checkQubits(state, subsystem, 'subsystem');
    if (state.qubitCount > MAX_PPT_QUBITS) {
      throw new RangeError(`Negativity is limited to ${MAX_PPT_QUBITS} qubits (got ${state.qubitCount}).`);
    }
    return this.guard(state, () => negativity(this.toDensityMatrix(state).rho, state.qubitCount, subsystem));
  }

  // ── Fidelity, interference, phase ──────────────────────────────────────

  /** F(actual, expected) = (Tr √(√ρ σ √ρ))²; |⟨ψ|φ⟩|² for pure states. */
  fidelity(actual: QuantumState, expected: QuantumState): number {
    if (actual.qubitCount !== expected.qubitCount) {
      throw new RangeError(`Fidelity needs equal register sizes (${actual.qubitCount} vs ${expected.qubitCount}).`);
    }
    return this.guard(actual, () => {
      if (actual.kind === 'stateVector') {
        return expected.kind === 'stateVector'
          ? pureStateFidelity(actual.amplitudes, expected.amplitudes)
          : pureMixedFidelity(actual.amplitudes, expected.rho);
      }
      return expected.kind === 'stateVector'
        ? pureMixedFidelity(expected.amplitudes, actual.rho)
        : densityFidelity(actual.rho, expected.rho);
    }, expected);
  }

  analyzeInterference(state: QuantumState, operation: InterferenceOperation): InterferenceAnalysis {
    if (state.kind !== 'stateVector') throw new RangeError('Amplitude interference analysis needs a pure state vector.');
    this.checkOperator(state, operation.controls ?? [], operation.targets, operation.matrix);
    return this.guard(state, () => analyzeInterference(state.amplitudes, state.qubitCount, operation));
  }

  /** ⟨a|b⟩ for pure states. */
  overlap(a: StateVectorState, b: StateVectorState): Complex {
    if (a.amplitudes.length !== b.amplitudes.length) throw new RangeError('Overlap needs states of the same dimension.');
    return this.guard(a, () => innerProduct(a.amplitudes, b.amplitudes), b);
  }

  comparePhase(a: QuantumState, b: QuantumState): PhaseComparison {
    if (a.kind !== 'stateVector' || b.kind !== 'stateVector') {
      throw new RangeError('Phase comparison needs pure state vectors; density matrices carry no global phase.');
    }
    return this.guard(a, () => comparePhase(a.amplitudes, b.amplitudes), b);
  }

  relativePhases(state: QuantumState): RelativePhase[] {
    if (state.kind !== 'stateVector') throw new RangeError('Relative phases need a pure state vector.');
    return this.guard(state, () => relativePhases(state.amplitudes));
  }

  // ── Open-system physics ────────────────────────────────────────────────

  /** Apply one single-qubit channel to each listed qubit. Upgrades to a density matrix. */
  applyChannel(state: QuantumState, channel: NoiseChannel, qubits: number[]): QuantumState {
    if (this.validationEnabled) validateChannel(channel);
    this.checkQubits(state, qubits, 'qubits');
    if (isIdentityChannel(channel) || qubits.length === 0) return state;
    return this.guard(state, () => {
      const { rho } = this.toDensityMatrix(state);
      const next = qubits.reduce((current, qubit) => applySingleQubitKraus(current, state.qubitCount, qubit, channel.kraus), rho);
      return densityState(next, state.qubitCount);
    });
  }

  /**
   * Apply a NoiseModel after one operation: gate channels on touched wires,
   * idle channels and T1/T2 decoherence (for the operation's physical duration)
   * on every wire. A model that cannot change the state leaves it untouched.
   */
  applyNoise(state: QuantumState, model: NoiseModel, context: NoiseContext = {}): QuantumState {
    if (context.touched) this.checkQubits(state, context.touched, 'touched qubits');
    const everyQubit = allQubits(state.qubitCount);
    const touched = (context.touched ?? everyQubit).filter((qubit) => qubit >= 0 && qubit < state.qubitCount);
    const steps: Array<{ channel: NoiseChannel; qubits: number[] }> = [
      ...(model.gate ?? []).map((channel) => ({ channel, qubits: touched })),
      ...(model.idle ?? []).map((channel) => ({ channel, qubits: everyQubit })),
      ...(model.decoherence
        ? decoherenceChannels(model.decoherence, operationDuration(model.timing, context.operation ?? ''))
          .map((channel) => ({ channel, qubits: everyQubit }))
        : []),
    ];
    return this.guard(state, () => steps.reduce((current, step) => this.applyChannel(current, step.channel, step.qubits), state));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private isGloballyPure(state: QuantumState): boolean {
    return state.kind === 'stateVector' || isPure(state.rho);
  }

  // Shares an already computed reduced state with the inspection methods.
  private assessWithReduced(state: QuantumState, subsystem: number[], reduced?: DensityMatrix): EntanglementAssessment {
    const rest = complement(state.qubitCount, subsystem);
    const pure = this.isGloballyPure(state);
    if (rest.length === 0) {
      // Nothing outside the subsystem to be entangled with.
      return { status: 'separable', method: pure ? 'pure-state-reduction' : 'ppt-negativity', conclusive: true };
    }
    if (pure) return assessPureStateReduction(reduced ?? this.reducedState(state, subsystem));
    if (state.qubitCount > MAX_PPT_QUBITS) {
      return {
        status: 'inconclusive',
        method: 'ppt-negativity',
        conclusive: false,
        reason: `The PPT test is limited to ${MAX_PPT_QUBITS} qubits (register has ${state.qubitCount}).`,
      };
    }
    return assessPptNegativity(this.negativity(state, subsystem), 2 ** subsystem.length, 2 ** rest.length);
  }
}

/** Shared stateless instance; the engine holds no per-run state. */
export const physics = new PhysicsEngine();
