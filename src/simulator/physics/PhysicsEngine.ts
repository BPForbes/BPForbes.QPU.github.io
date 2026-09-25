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
import type { Complex } from '../complex';
import type { ParticleStartState } from '../types';
import {
  blochVectorFromDensity,
  type BlochVector,
  sphericalFromBlochCartesian,
  type SphericalCoordinates,
} from './analysis/Bloch';
import { entropyFromEigenvalues, vonNeumannEntropy } from './analysis/Entropy';
import { negativity, reducedStateIndicatesEntanglement } from './analysis/Entanglement';
import { densityFidelity, pureMixedFidelity, pureStateFidelity } from './analysis/Fidelity';
import { analyzeInterference, type InterferenceAnalysis, type InterferenceOperation } from './analysis/Interference';
import { comparePhase, type PhaseComparison, relativePhases, type RelativePhase } from './analysis/Phase';
import { isPure, linearEntropy, normalizedMixedness, PURE_TOLERANCE, purity } from './analysis/Purity';
import { propagator, type Hamiltonian } from './dynamics/Hamiltonian';
import {
  densityMeasurementDiagnostics,
  measureDensityMatrix,
  type MeasurementDiagnostics,
  type MeasurementResult,
  measureStateVector,
  stateVectorMeasurementDiagnostics,
} from './measurement/Measurement';
import type { MeasurementBasis } from './measurement/MeasurementBasis';
import { decoherenceChannels, operationDuration } from './noise/Decoherence';
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
  type QuantumState,
  stateVector,
} from './state/QuantumState';
import { partialTrace, reducedStateFromVector } from './state/ReducedState';
import {
  applyMultiQubitUnitary,
  applyStartState,
  basisProbabilities,
  createRegister,
  marginalProbabilities,
  padStateVector,
} from './state/StateVector';
import { resetStateVector } from './measurement/Reset';
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
  /**
   * Pure global state: true when this qubit is entangled with the rest of the
   * register. Undefined for a mixed global state, where local mixedness alone
   * cannot separate entanglement from classical noise (use isEntangled).
   */
  entangledWithRest: boolean | undefined;
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
  /** Same semantics as QubitInspection.entangledWithRest, for the whole subsystem. */
  entangledWithRest: boolean | undefined;
};

export type GlobalInspection = {
  qubitCount: number;
  representation: QuantumState['kind'];
  purity: number;
  isPure: boolean;
  /** ‖ψ‖² or Tr ρ; 1 for a valid state. */
  normalization: number;
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
  // ── State creation and preparation ─────────────────────────────────────

  createState(qubitCount: number, representation: QuantumState['kind'] = 'stateVector'): QuantumState {
    const amplitudes = createRegister(qubitCount);
    return representation === 'stateVector'
      ? stateVector(amplitudes, qubitCount)
      : densityState(densityFromStateVector(amplitudes), qubitCount);
  }

  /** Prepare a fresh |0⟩ wire as 0p, 1p (|1⟩), or sp (|+⟩). */
  prepare<S extends QuantumState>(state: S, qubit: number, preparation: ParticleStartState): S {
    if (preparation === '0p') return state;
    if (state.kind === 'stateVector') {
      return stateVector(applyStartState(state.amplitudes, state.qubitCount, qubit, preparation), state.qubitCount) as S;
    }
    return this.applyUnitary(state, [qubit], preparation === '1p' ? MATRIX_X : MATRIX_H);
  }

  /** Append |0⟩ wires so the register holds `qubitCount` qubits. */
  expandRegister<S extends QuantumState>(state: S, qubitCount: number): S {
    if (qubitCount <= state.qubitCount) return state;
    return (state.kind === 'stateVector'
      ? stateVector(padStateVector(state.amplitudes, state.qubitCount, qubitCount), qubitCount)
      : densityState(padDensityMatrix(state.rho, state.qubitCount, qubitCount), qubitCount)) as S;
  }

  toDensityMatrix(state: QuantumState): DensityMatrixState {
    if (state.kind === 'densityMatrix') return state;
    assertDensityWidth(state.qubitCount);
    return densityState(densityFromStateVector(state.amplitudes), state.qubitCount);
  }

  // ── Evolution ──────────────────────────────────────────────────────────

  /** |ψ'⟩ = U|ψ⟩ or ρ' = UρU†. The engine does not care which gate supplied U. */
  applyUnitary<S extends QuantumState>(state: S, targets: number[], matrix: ComplexMatrix): S {
    return this.applyControlledUnitary(state, [], targets, matrix);
  }

  applyControlledUnitary<S extends QuantumState>(state: S, controls: number[], targets: number[], matrix: ComplexMatrix): S {
    if (state.kind === 'stateVector') {
      return stateVector(applyMultiQubitUnitary(state.amplitudes, state.qubitCount, targets, matrix, controls), state.qubitCount) as S;
    }
    return densityState(applyUnitaryToDensity(state.rho, state.qubitCount, targets, matrix, controls), state.qubitCount) as S;
  }

  /**
   * Apply any linear state-vector kernel A (e.g. a registered gate's fast
   * path). On a density matrix this is ρ → AρA†.
   */
  applyLinearKernel<S extends QuantumState>(state: S, kernel: (amplitudes: Complex[]) => Complex[]): S {
    if (state.kind === 'stateVector') return stateVector(kernel(state.amplitudes), state.qubitCount) as S;
    return densityState(conjugateByLinearMap(state.rho, kernel), state.qubitCount) as S;
  }

  /** Continuous evolution under a time-independent Hamiltonian: U = e^{−iHt/ħ}. */
  evolve<S extends QuantumState>(state: S, hamiltonian: Hamiltonian, duration: number, hbar = 1): S {
    return this.applyUnitary(state, hamiltonian.targets, propagator(hamiltonian.matrix, duration, hbar));
  }

  // ── Measurement ────────────────────────────────────────────────────────

  measure<S extends QuantumState>(state: S, qubit: number, basis: MeasurementBasis = 'Z', random = Math.random()): MeasurementResult<S> {
    if (state.kind === 'stateVector') {
      const result = measureStateVector(state.amplitudes, state.qubitCount, qubit, basis, random);
      return { ...result, state: stateVector(result.state, state.qubitCount) as S };
    }
    const result = measureDensityMatrix(state.rho, state.qubitCount, qubit, basis, random);
    return { ...result, state: densityState(result.state, state.qubitCount) as S };
  }

  /** Outcome probabilities for a basis without collapsing the state. */
  measurementDiagnostics(state: QuantumState, qubit: number, basis: MeasurementBasis = 'Z'): MeasurementDiagnostics {
    return state.kind === 'stateVector'
      ? stateVectorMeasurementDiagnostics(state.amplitudes, state.qubitCount, qubit, basis)
      : densityMeasurementDiagnostics(state.rho, state.qubitCount, qubit, basis);
  }

  /**
   * Force `qubit` to |0⟩. Density matrices get the exact reset channel; state
   * vectors follow one measure-and-flip trajectory of it (see measurement/Reset.ts).
   */
  reset<S extends QuantumState>(state: S, qubit: number, random: () => number = Math.random): S {
    return (state.kind === 'stateVector'
      ? stateVector(resetStateVector(state.amplitudes, state.qubitCount, qubit, random), state.qubitCount)
      : densityState(resetQubitDensity(state.rho, state.qubitCount, qubit), state.qubitCount)) as S;
  }

  probabilities(state: QuantumState): number[] {
    return state.kind === 'stateVector' ? basisProbabilities(state.amplitudes) : densityProbabilities(state.rho);
  }

  marginalProbabilities(state: QuantumState, qubits: number[]): number[] {
    if (state.kind === 'stateVector') return marginalProbabilities(state.amplitudes, state.qubitCount, qubits);
    return densityProbabilities(partialTrace(state.rho, state.qubitCount, qubits));
  }

  // ── Reduced states and inspection ──────────────────────────────────────

  /** ρ_S = Tr_{rest}(ρ); subsystem[0] is the most significant bit. */
  reducedState(state: QuantumState, subsystem: number[]): DensityMatrix {
    return state.kind === 'stateVector'
      ? reducedStateFromVector(state.amplitudes, state.qubitCount, subsystem)
      : partialTrace(state.rho, state.qubitCount, subsystem);
  }

  reducedDensityMatrix(state: QuantumState, subsystem: number[]): DensityMatrix {
    return this.reducedState(state, subsystem);
  }

  blochVector(state: QuantumState, qubit: number): BlochVector {
    return blochVectorFromDensity(this.reducedState(state, [qubit]));
  }

  inspectQubit(state: QuantumState, qubit: number): QubitInspection {
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
      entangledWithRest: this.entangledWithRest(state, densityMatrix),
    };
  }

  inspectSubsystem(state: QuantumState, subsystem: number[]): SubsystemInspection {
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
      entangledWithRest: subsystem.length === state.qubitCount ? false : this.entangledWithRest(state, densityMatrix),
    };
  }

  inspectGlobal(state: QuantumState): GlobalInspection {
    const probabilities = this.probabilities(state);
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
    return purity(rho);
  }

  linearEntropy(rho: DensityMatrix): number {
    return linearEntropy(rho);
  }

  vonNeumannEntropy(rho: DensityMatrix): number {
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
   * Pure global state: exact (reduced state mixed). Mixed global state: PPT
   * criterion, exact for 2×2 / 2×3 splits and a sufficient witness otherwise.
   */
  isEntangled(state: QuantumState, subsystem: number[]): boolean {
    const rest = complement(state.qubitCount, subsystem);
    if (rest.length === 0) return false;
    if (this.isGloballyPure(state)) {
      return reducedStateIndicatesEntanglement(this.reducedState(state, subsystem));
    }
    return this.negativity(state, subsystem) > PURE_TOLERANCE;
  }

  /** S(ρ_A) in bits; an entanglement measure only for a pure global state. */
  entanglementEntropy(state: QuantumState, subsystem: number[]): number {
    if (!this.isGloballyPure(state)) {
      throw new RangeError('Entanglement entropy is only defined for a pure global state; use negativity for mixed states.');
    }
    if (complement(state.qubitCount, subsystem).length === 0) return 0;
    return vonNeumannEntropy(this.reducedState(state, subsystem));
  }

  /** Negativity of the bipartition subsystem | rest (0.5 for a Bell pair). */
  negativity(state: QuantumState, subsystem: number[]): number {
    if (state.qubitCount > MAX_PPT_QUBITS) {
      throw new RangeError(`Negativity is limited to ${MAX_PPT_QUBITS} qubits (got ${state.qubitCount}).`);
    }
    const { rho } = this.toDensityMatrix(state);
    return negativity(rho, state.qubitCount, subsystem);
  }

  // ── Fidelity, interference, phase ──────────────────────────────────────

  /** F(actual, expected) = (Tr √(√ρ σ √ρ))²; |⟨ψ|φ⟩|² for pure states. */
  fidelity(actual: QuantumState, expected: QuantumState): number {
    if (actual.qubitCount !== expected.qubitCount) {
      throw new RangeError(`Fidelity needs equal register sizes (${actual.qubitCount} vs ${expected.qubitCount}).`);
    }
    if (actual.kind === 'stateVector') {
      return expected.kind === 'stateVector'
        ? pureStateFidelity(actual.amplitudes, expected.amplitudes)
        : pureMixedFidelity(actual.amplitudes, expected.rho);
    }
    return expected.kind === 'stateVector'
      ? pureMixedFidelity(expected.amplitudes, actual.rho)
      : densityFidelity(actual.rho, expected.rho);
  }

  analyzeInterference(state: QuantumState, operation: InterferenceOperation): InterferenceAnalysis {
    if (state.kind !== 'stateVector') throw new RangeError('Amplitude interference analysis needs a pure state vector.');
    return analyzeInterference(state.amplitudes, state.qubitCount, operation);
  }

  comparePhase(a: QuantumState, b: QuantumState): PhaseComparison {
    if (a.kind !== 'stateVector' || b.kind !== 'stateVector') {
      throw new RangeError('Phase comparison needs pure state vectors; density matrices carry no global phase.');
    }
    return comparePhase(a.amplitudes, b.amplitudes);
  }

  relativePhases(state: QuantumState): RelativePhase[] {
    if (state.kind !== 'stateVector') throw new RangeError('Relative phases need a pure state vector.');
    return relativePhases(state.amplitudes);
  }

  // ── Open-system physics ────────────────────────────────────────────────

  /** Apply one single-qubit channel to each listed qubit. Upgrades to a density matrix. */
  applyChannel(state: QuantumState, channel: NoiseChannel, qubits: number[]): QuantumState {
    if (isIdentityChannel(channel) || qubits.length === 0) return state;
    const { rho } = this.toDensityMatrix(state);
    const next = qubits.reduce((current, qubit) => applySingleQubitKraus(current, state.qubitCount, qubit, channel.kraus), rho);
    return densityState(next, state.qubitCount);
  }

  /**
   * Apply a NoiseModel after one operation: gate channels on touched wires,
   * idle channels and T1/T2 decoherence (for the operation's physical duration)
   * on every wire. A model that cannot change the state leaves it untouched.
   */
  applyNoise(state: QuantumState, model: NoiseModel, context: NoiseContext = {}): QuantumState {
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
    return steps.reduce((current, step) => this.applyChannel(current, step.channel, step.qubits), state);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private isGloballyPure(state: QuantumState): boolean {
    return state.kind === 'stateVector' || isPure(state.rho);
  }

  private entangledWithRest(state: QuantumState, reduced: DensityMatrix): boolean | undefined {
    if (state.qubitCount < 2) return false;
    if (!this.isGloballyPure(state)) return undefined;
    return reducedStateIndicatesEntanglement(reduced);
  }
}

/** Shared stateless instance; the engine holds no per-run state. */
export const physics = new PhysicsEngine();
