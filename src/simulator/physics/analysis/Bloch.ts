/**
 * Bloch representation of a single-qubit state: ρ = ½(I + xX + yY + zZ).
 */
import { complex, type Complex, formatComplex, magnitudeSquared } from '../../complex';
import { blochBallRhoExpectationFast } from '../numerics/blochQuadrature';
import type { DensityMatrix } from '../state/QuantumState';
import { PURE_TOLERANCE } from './Purity';

/** Bloch-vector Cartesian components: x = r sinθ cosφ, y = r sinθ sinφ, z = r cosθ. */
export type BlochVector = {
  x: number;
  y: number;
  z: number;
};

// Spherical coordinates on the Bloch ball: r is radial, θ is polar from +Z, and φ is azimuthal.
export type SphericalCoordinates = {
  r: number;
  theta: number;
  phi: number;
};

/** |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩ */
export type PsiKet = {
  alpha: Complex;
  beta: Complex;
  theta: number;
  phi: number;
  formatted: string;
};

// Mixed-state metrics from the Bloch radius: purity = Tr(ρ²), mixedness = normalized linear entropy.
// Local mixedness can come from entanglement with the rest of the register, not physical noise.
export type MixedStateMetrics = {
  blochRadius: number;
  purity: number;
  mixedness: number;
  /** Visualization estimate from the Bloch-ball quadrature, not an authoritative physical quantity. */
  rhoExpectation: number;
  isPure: boolean;
};

/** (⟨X⟩, ⟨Y⟩, ⟨Z⟩) of a 2×2 density matrix: x = 2 Re ρ01, y = −2 Im ρ01, z = ρ00 − ρ11. */
export const blochVectorFromDensity = (rho: DensityMatrix): BlochVector => ({
  x: 2 * rho[0][1].re,
  // `+ 0` folds −0 to 0 so real states report y = 0 exactly.
  y: -2 * rho[0][1].im + 0,
  z: rho[0][0].re - rho[1][1].re,
});

export const densityFromBlochVector = ({ x, y, z }: BlochVector): DensityMatrix => [
  [complex((1 + z) / 2, 0), complex(x / 2, -y / 2)],
  [complex(x / 2, y / 2), complex((1 - z) / 2, 0)],
];

/** Pauli Bloch coordinates from spherical angles. */
export const blochCartesianFromSpherical = (r: number, theta: number, phi: number): BlochVector => ({
  x: r * Math.sin(theta) * Math.cos(phi),
  y: r * Math.sin(theta) * Math.sin(phi),
  z: r * Math.cos(theta),
});

export const sphericalFromBlochCartesian = ({ x, y, z }: BlochVector): SphericalCoordinates => {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-12) return { r: 0, theta: 0, phi: 0 };
  return {
    r,
    theta: Math.acos(Math.min(1, Math.max(-1, z / r))),
    phi: Math.atan2(y, x),
  };
};

export const formatPsiKet = (alpha: Complex, beta: Complex): string => {
  const alphaText = formatComplex(alpha);
  const betaText = formatComplex(beta);
  if (magnitudeSquared(beta) < 1e-12) return `|ψ⟩ = ${alphaText}|0⟩`;
  if (magnitudeSquared(alpha) < 1e-12) return `|ψ⟩ = ${betaText}|1⟩`;
  return `|ψ⟩ = ${alphaText}|0⟩ + ${betaText}|1⟩`;
};

/** |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩ */
export const ketFromSpherical = (theta: number, phi: number): PsiKet => {
  const half = theta / 2;
  const alpha = complex(Math.cos(half), 0);
  const beta = complex(Math.cos(phi) * Math.sin(half), Math.sin(phi) * Math.sin(half));
  return {
    alpha,
    beta,
    theta,
    phi,
    formatted: formatPsiKet(alpha, beta),
  };
};

/** ⟨ρ⟩ via separable O(1) quadrature (see numerics/blochQuadrature.ts). Visualization estimate only. */
export const blochBallRhoExpectation = blochBallRhoExpectationFast;

export const mixedStateMetrics = (spherical: SphericalCoordinates): MixedStateMetrics => {
  const blochRadius = spherical.r;
  // For one qubit Tr(ρ²) = (1 + r²)/2.
  const purity = (1 + blochRadius * blochRadius) / 2;
  // Normalized linear entropy: 0 = pure, 1 = maximally mixed one-qubit state.
  const mixedness = 2 * (1 - purity);
  return {
    blochRadius,
    purity,
    mixedness,
    rhoExpectation: blochBallRhoExpectation(spherical.r, spherical.theta, spherical.phi, mixedness),
    isPure: purity >= 1 - PURE_TOLERANCE,
  };
};
