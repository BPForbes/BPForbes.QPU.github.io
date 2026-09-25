/**
 * Optional continuous-time dynamics: iħ ∂t|ψ⟩ = H|ψ⟩, so for time-independent
 * H the propagator is U(t) = e^{−iHt/ħ}. Units are chosen by the caller
 * (ħ defaults to 1). Circuit execution never depends on this module.
 */
import { type ComplexMatrix, dagger, unitaryFromHermitian } from '../numerics/linearAlgebra';

export type Hamiltonian = {
  /** Hermitian 2^k × 2^k operator acting on `targets` (targets[0] is its most significant bit). */
  matrix: ComplexMatrix;
  targets: number[];
};

export const isHermitian = (matrix: ComplexMatrix, tolerance = 1e-9): boolean => {
  const adjoint = dagger(matrix);
  return matrix.every((row, i) =>
    row.every((value, j) => Math.abs(value.re - adjoint[i][j].re) < tolerance && Math.abs(value.im - adjoint[i][j].im) < tolerance));
};

export const propagator = (hamiltonian: ComplexMatrix, duration: number, hbar = 1): ComplexMatrix => {
  if (!isHermitian(hamiltonian)) throw new RangeError('Hamiltonian must be Hermitian.');
  if (!Number.isFinite(duration)) throw new RangeError(`Duration must be finite (got ${duration}).`);
  if (!(hbar > 0)) throw new RangeError(`ħ must be positive (got ${hbar}).`);
  return unitaryFromHermitian(hamiltonian, duration / hbar);
};
