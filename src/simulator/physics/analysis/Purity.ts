/**
 * Purity P = Tr(ρ²) and linear-entropy diagnostics.
 */
import { magnitudeSquared } from '../../complex';
import type { DensityMatrix } from '../state/QuantumState';

export const PURE_TOLERANCE = 1e-6;

/** Tr(ρ²) = Σ_ij |ρ_ij|² for Hermitian ρ. */
export const purity = (rho: DensityMatrix): number =>
  rho.reduce((sum, row) => sum + row.reduce((rowSum, value) => rowSum + magnitudeSquared(value), 0), 0);

/** S_L = 1 − Tr(ρ²). */
export const linearEntropy = (rho: DensityMatrix): number => 1 - purity(rho);

/** Linear entropy scaled to [0, 1] by d/(d−1); equals 2(1 − P) for one qubit. */
export const normalizedMixedness = (rho: DensityMatrix): number => {
  const dimension = rho.length;
  if (dimension < 2) return 0;
  return (dimension / (dimension - 1)) * linearEntropy(rho);
};

export const isPure = (rho: DensityMatrix, tolerance = PURE_TOLERANCE): boolean => purity(rho) >= 1 - tolerance;
