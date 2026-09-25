/**
 * Optional continuous-time dynamics: iħ ∂t|ψ⟩ = H|ψ⟩, so for time-independent
 * H the propagator is U(t) = e^{−iHt/ħ}. Units are chosen by the caller
 * (ħ defaults to 1). Ideal circuit execution never uses this module; the
 * physical simulation mode (frequency/) builds its H(t) here.
 */
import { add, type Complex, complex, mul, ZERO } from '../../complex';
import { type ComplexMatrix, dagger, qubitUnitary, unitaryFromHermitian } from '../numerics/linearAlgebra';

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

/**
 * H(t) on `targets`, evaluated by `at(t)` for absolute time t. Evolution uses
 * fourth-order Magnus steps no longer than `maxStep`; pick maxStep well below
 * the fastest period in H.
 */
export type TimeDependentHamiltonian = {
  kind: 'timeDependent';
  targets: number[];
  at: (time: number) => ComplexMatrix;
  maxStep: number;
  /** Hilbert-space dimension when it is not 2^targets.length (e.g. 3 for a transmon qutrit). */
  dimension?: number;
};

/** Refuse step counts that would freeze the tab; lab-frame GHz carriers over long pulses hit this first. */
export const MAX_PROPAGATOR_STEPS = 200_000;

const multiply = (a: ComplexMatrix, b: ComplexMatrix): Complex[][] =>
  a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => add(sum, mul(value, b[k][j])), ZERO)));

const GAUSS_OFFSET = Math.sqrt(3) / 6;

/**
 * One fourth-order Magnus step: with H₁, H₂ sampled at the two Gauss–Legendre
 * points, H_eff = (H₁ + H₂)/2 − i(√3·dt/12)[H₂, H₁] (Hermitian) and U = e^{−iH_eff·dt}.
 */
const magnusStepHamiltonian = (h1: ComplexMatrix, h2: ComplexMatrix, dt: number): Complex[][] => {
  const h21 = multiply(h2, h1);
  const h12 = multiply(h1, h2);
  const scale = (Math.sqrt(3) * dt) / 12;
  return h1.map((row, i) => row.map((value, j) => {
    const commutator = complex(h21[i][j].re - h12[i][j].re, h21[i][j].im - h12[i][j].im);
    // −i·scale·[H₂, H₁]
    return complex((value.re + h2[i][j].re) / 2 + scale * commutator.im, (value.im + h2[i][j].im) / 2 - scale * commutator.re);
  }));
};

/** U(start + duration, start) = T exp(−i∫H dt/ħ) as a product of fourth-order Magnus steps. */
export const timeDependentPropagator = (
  hamiltonian: TimeDependentHamiltonian,
  start: number,
  duration: number,
  hbar = 1,
): Complex[][] => {
  if (!(duration >= 0) || !Number.isFinite(duration)) throw new RangeError(`Duration must be finite and non-negative (got ${duration}).`);
  if (!(hamiltonian.maxStep > 0)) throw new RangeError(`maxStep must be positive (got ${hamiltonian.maxStep}).`);
  const steps = Math.max(1, Math.ceil(duration / hamiltonian.maxStep));
  if (steps > MAX_PROPAGATOR_STEPS) {
    throw new RangeError(`H(t) evolution needs ${steps} steps (limit ${MAX_PROPAGATOR_STEPS}); use a rotating frame with the RWA or a larger step.`);
  }
  const dt = duration / steps;
  const size = hamiltonian.dimension ?? 2 ** hamiltonian.targets.length;
  let total: Complex[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? complex(1) : ZERO)));
  for (let step = 0; step < steps; step += 1) {
    const midpoint = start + (step + 0.5) * dt;
    const effective = magnusStepHamiltonian(
      hamiltonian.at(midpoint - GAUSS_OFFSET * dt),
      hamiltonian.at(midpoint + GAUSS_OFFSET * dt),
      dt / hbar,
    );
    const stepUnitary = size === 2 ? qubitUnitary(effective, dt / hbar) : unitaryFromHermitian(effective, dt / hbar);
    total = multiply(stepUnitary, total);
  }
  return total;
};
