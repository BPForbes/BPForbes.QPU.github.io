/**
 * Von Neumann entropy S(ρ) = −Tr(ρ log₂ ρ), in bits.
 */
import { hermitianEigenvalues } from '../numerics/linearAlgebra';
import type { DensityMatrix } from '../state/QuantumState';

const EIGENVALUE_FLOOR = 1e-12;

export const entropyFromEigenvalues = (eigenvalues: readonly number[]): number =>
  eigenvalues.reduce((sum, value) => (value > EIGENVALUE_FLOOR ? sum - value * Math.log2(value) : sum), 0);

// One-qubit spectrum is (1 ± r)/2, so skip the eigensolver.
const qubitEigenvalues = (rho: DensityMatrix): number[] => {
  const x = 2 * rho[0][1].re;
  const y = 2 * rho[0][1].im;
  const z = rho[0][0].re - rho[1][1].re;
  const r = Math.min(1, Math.sqrt(x * x + y * y + z * z));
  return [(1 - r) / 2, (1 + r) / 2];
};

export const densityEigenvalues = (rho: DensityMatrix): number[] =>
  (rho.length === 2 ? qubitEigenvalues(rho) : hermitianEigenvalues(rho));

export const vonNeumannEntropy = (rho: DensityMatrix): number => {
  const value = entropyFromEigenvalues(densityEigenvalues(rho));
  return Math.abs(value) < 1e-12 ? 0 : value;
};
