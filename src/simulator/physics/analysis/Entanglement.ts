/**
 * Entanglement diagnostics. Entanglement is never manufactured here: it is
 * read off the joint state produced by ordinary gates (H, CNOT, …).
 *
 * - Pure global state: a subsystem is entangled with the rest exactly when its
 *   reduced state is mixed; S(ρ_A) is the entanglement entropy.
 * - Mixed global state: local mixedness no longer implies entanglement, so the
 *   PPT (Peres–Horodecki) test is used. Negativity > 0 proves entanglement and
 *   is also necessary for 2×2 and 2×3 splits.
 */
import { complex } from '../../complex';
import { hermitianEigenvalues } from '../numerics/linearAlgebra';
import type { DensityMatrix } from '../state/QuantumState';
import { bitMask } from '../state/StateVector';
import { PURE_TOLERANCE, purity } from './Purity';

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
