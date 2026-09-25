/**
 * Projective single-qubit measurement and state collapse.
 *
 * P(1) = Σ_{i: q=1} |α_i|², the incompatible branch is removed, and the kept
 * branch is renormalized. The random draw is injectable for deterministic tests.
 */
import { type Complex, scale, ZERO } from '../../complex';
import type { DensityMatrix } from '../state/QuantumState';
import { applyUnitaryToDensity } from '../state/DensityMatrix';
import { applySingleQubitGate, hasBit, probabilityOfOne } from '../state/StateVector';
import { basisRotation, type MeasurementBasis } from './MeasurementBasis';

export type MeasurementResult<TState> = {
  outcome: 0 | 1;
  /** Probability of the observed outcome. */
  probability: number;
  /** Probability of outcome 1 before collapse (kept for legacy log lines). */
  probabilityOne: number;
  basis: MeasurementBasis;
  state: TState;
};

/** Outcome distribution for a basis without collapsing the state. */
export type MeasurementDiagnostics = {
  basis: MeasurementBasis;
  probabilities: [number, number];
  /** ⟨σ⟩ = P(0) − P(1) for the measured Pauli observable. */
  expectation: number;
  /** True when one outcome is certain. */
  deterministic: boolean;
};

const DETERMINISTIC_TOLERANCE = 1e-9;

const sampleOutcome = (probabilityOne: number, random: number): 0 | 1 => {
  const sample = Math.min(Math.max(random, 0), 1 - Number.EPSILON);
  return sample < probabilityOne ? 1 : 0;
};

// Legacy Z-basis collapse, unchanged so existing MEASURE logs and outcomes stay identical.
export const measureQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  random = Math.random(),
): { state: Complex[]; value: 0 | 1; probabilityOne: number } => {
  const probabilityOne = probabilityOfOne(state, qubitCount, qubit);
  const value = sampleOutcome(probabilityOne, random);
  const keptProbability = value === 1 ? probabilityOne : 1 - probabilityOne;
  const normalizer = keptProbability > 0 ? 1 / Math.sqrt(keptProbability) : 0;

  const collapsed = state.map((amplitude, index) =>
    hasBit(index, qubit, qubitCount) === Boolean(value) ? scale(amplitude, normalizer) : ZERO,
  );

  return { state: collapsed, value, probabilityOne };
};

export const measureStateVector = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  basis: MeasurementBasis = 'Z',
  random = Math.random(),
): MeasurementResult<Complex[]> => {
  const rotation = basisRotation(basis);
  const rotated = rotation ? applySingleQubitGate(state, qubitCount, qubit, rotation.toZ) : state;
  const measured = measureQubit(rotated, qubitCount, qubit, random);
  return {
    outcome: measured.value,
    probability: measured.value === 1 ? measured.probabilityOne : 1 - measured.probabilityOne,
    probabilityOne: measured.probabilityOne,
    basis,
    state: rotation ? applySingleQubitGate(measured.state, qubitCount, qubit, rotation.fromZ) : measured.state,
  };
};

const densityProbabilityOfOne = (rho: DensityMatrix, qubitCount: number, qubit: number) =>
  rho.reduce((sum, row, index) => sum + (hasBit(index, qubit, qubitCount) ? row[index].re : 0), 0);

export const measureDensityMatrix = (
  rho: DensityMatrix,
  qubitCount: number,
  qubit: number,
  basis: MeasurementBasis = 'Z',
  random = Math.random(),
): MeasurementResult<DensityMatrix> => {
  const rotation = basisRotation(basis);
  const rotated = rotation ? applyUnitaryToDensity(rho, qubitCount, [qubit], rotation.toZ) : rho;
  const probabilityOne = Math.min(1, Math.max(0, densityProbabilityOfOne(rotated, qubitCount, qubit)));
  const outcome = sampleOutcome(probabilityOne, random);
  const probability = outcome === 1 ? probabilityOne : 1 - probabilityOne;
  const normalizer = probability > 0 ? 1 / probability : 0;
  const keep = (index: number) => hasBit(index, qubit, qubitCount) === Boolean(outcome);
  const collapsed = rotated.map((row, i) => row.map((value, j) => (keep(i) && keep(j) ? scale(value, normalizer) : ZERO)));
  return {
    outcome,
    probability,
    probabilityOne,
    basis,
    state: rotation ? applyUnitaryToDensity(collapsed, qubitCount, [qubit], rotation.fromZ) : collapsed,
  };
};

export const measurementDiagnostics = (probabilityOne: number, basis: MeasurementBasis): MeasurementDiagnostics => {
  const one = Math.min(1, Math.max(0, probabilityOne));
  const zero = 1 - one;
  return {
    basis,
    probabilities: [zero, one],
    expectation: zero - one,
    deterministic: one <= DETERMINISTIC_TOLERANCE || zero <= DETERMINISTIC_TOLERANCE,
  };
};

export const stateVectorMeasurementDiagnostics = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  basis: MeasurementBasis = 'Z',
): MeasurementDiagnostics => {
  const rotation = basisRotation(basis);
  const rotated = rotation ? applySingleQubitGate(state, qubitCount, qubit, rotation.toZ) : state;
  return measurementDiagnostics(probabilityOfOne(rotated, qubitCount, qubit), basis);
};

export const densityMeasurementDiagnostics = (
  rho: DensityMatrix,
  qubitCount: number,
  qubit: number,
  basis: MeasurementBasis = 'Z',
): MeasurementDiagnostics => {
  const rotation = basisRotation(basis);
  const rotated = rotation ? applyUnitaryToDensity(rho, qubitCount, [qubit], rotation.toZ) : rho;
  return measurementDiagnostics(densityProbabilityOfOne(rotated, qubitCount, qubit), basis);
};
