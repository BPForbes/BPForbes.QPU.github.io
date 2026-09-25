/**
 * State fidelity F(ρ, σ) = (Tr √(√ρ σ √ρ))², the squared (Uhlmann–Jozsa)
 * convention, so pure states reduce to |⟨ψ|φ⟩|².
 */
import { type Complex, magnitudeSquared, mul } from '../../complex';
import { conj, hermitianEigenvalues, hermitianFunction, matMul } from '../numerics/linearAlgebra';
import type { DensityMatrix } from '../state/QuantumState';
import { innerProduct } from '../state/StateVector';

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export const pureStateFidelity = (a: readonly Complex[], b: readonly Complex[]): number =>
  clampUnit(magnitudeSquared(innerProduct(a, b)));

/** ⟨ψ|σ|ψ⟩ */
export const pureMixedFidelity = (psi: readonly Complex[], sigma: DensityMatrix): number => {
  let re = 0;
  for (let i = 0; i < psi.length; i += 1) {
    const left = conj(psi[i]);
    for (let j = 0; j < psi.length; j += 1) {
      re += mul(mul(left, sigma[i][j]), psi[j]).re;
    }
  }
  return clampUnit(re);
};

export const densityFidelity = (rho: DensityMatrix, sigma: DensityMatrix): number => {
  const sqrtRho = hermitianFunction(rho, (value) => Math.sqrt(Math.max(0, value)));
  const inner = matMul(matMul(sqrtRho, sigma), sqrtRho);
  const traceSqrt = hermitianEigenvalues(inner).reduce((sum, value) => sum + Math.sqrt(Math.max(0, value)), 0);
  return clampUnit(traceSqrt * traceSqrt);
};
