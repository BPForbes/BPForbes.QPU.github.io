/**
 * Entanglement diagnostics. Entanglement is never manufactured here: it is
 * read off the joint state produced by ordinary gates (H, CNOT, …).
 *
 * Results are assessments, not booleans, because not every test is decisive:
 * - Pure global state: a subsystem is entangled with the rest exactly when its
 *   reduced state is mixed. Always conclusive.
 * - Mixed global state: the PPT (Peres–Horodecki) test. Negativity > 0 proves
 *   entanglement for any split. Negativity = 0 proves separability only for
 *   2×2 and 2×3 splits; larger splits have PPT-entangled states, so a zero
 *   result there is inconclusive, never "separable".
 */
import { complex } from '../../complex';
import { hermitianEigenvalues } from '../numerics/linearAlgebra';
import type { DensityMatrix } from '../state/QuantumState';
import { bitMask } from '../state/StateVector';
import { PURE_TOLERANCE, purity } from './Purity';

export type EntanglementStatus = 'entangled' | 'separable' | 'inconclusive';

export type EntanglementMethod = 'pure-state-reduction' | 'ppt-negativity';

export type EntanglementAssessment = {
  status: EntanglementStatus;
  method: EntanglementMethod;
  /** Present when the PPT test ran. */
  negativity?: number;
  /** True when `status` is proven; false only for 'inconclusive'. */
  conclusive: boolean;
  /** Why an inconclusive result could not be decided. */
  reason?: string;
};

/** Negativity below this is treated as numerical zero (eigensolver error is ~1e-15). */
export const NEGATIVITY_TOLERANCE = 1e-9;

// PPT is necessary and sufficient only when dim(A)·dim(B) ≤ 6 (Horodecki 1996).
const pptIsExact = (subsystemDimension: number, restDimension: number) => subsystemDimension * restDimension <= 6;

export const ENTANGLEMENT_TOLERANCE = PURE_TOLERANCE;

/** For a pure global state: is the reduced state of the subsystem mixed? */
export const reducedStateIndicatesEntanglement = (reduced: DensityMatrix, tolerance = ENTANGLEMENT_TOLERANCE): boolean =>
  purity(reduced) < 1 - tolerance;

/** ρ^{T_B}: transpose the `transposed` qubits' indices. */
export const partialTranspose = (rho: DensityMatrix, qubitCount: number, transposed: number[]): DensityMatrix => {
  const mask = transposed.reduce((all, qubit) => all | bitMask(qubit, qubitCount), 0);
  return rho.map((row, i) => row.map((_, j) => {
    const swappedI = (i & ~mask) | (j & mask);
    const swappedJ = (j & ~mask) | (i & mask);
    const value = rho[swappedI][swappedJ];
    return complex(value.re, value.im);
  }));
};

/** N(ρ) = Σ |negative eigenvalues of ρ^{T_B}|; 0.5 for a Bell pair. */
export const negativity = (rho: DensityMatrix, qubitCount: number, subsystem: number[]): number =>
  hermitianEigenvalues(partialTranspose(rho, qubitCount, subsystem))
    .reduce((sum, value) => (value < 0 ? sum - value : sum), 0);

/** Pure global state: entangled with the rest exactly when the reduced state is mixed. */
export const assessPureStateReduction = (reduced: DensityMatrix, tolerance = ENTANGLEMENT_TOLERANCE): EntanglementAssessment => ({
  status: reducedStateIndicatesEntanglement(reduced, tolerance) ? 'entangled' : 'separable',
  method: 'pure-state-reduction',
  conclusive: true,
});

/** Mixed global state: interpret a PPT negativity for a split of the given dimensions. */
export const assessPptNegativity = (
  value: number,
  subsystemDimension: number,
  restDimension: number,
): EntanglementAssessment => {
  if (value > NEGATIVITY_TOLERANCE) {
    return { status: 'entangled', method: 'ppt-negativity', negativity: value, conclusive: true };
  }
  if (pptIsExact(subsystemDimension, restDimension)) {
    return { status: 'separable', method: 'ppt-negativity', negativity: value, conclusive: true };
  }
  return {
    status: 'inconclusive',
    method: 'ppt-negativity',
    negativity: value,
    conclusive: false,
    reason: `PPT found no entanglement, but a ${subsystemDimension}×${restDimension} split can hide PPT-entangled states.`,
  };
};
