/**
 * Fast quadrature approximations for Bloch-ball expectation values.
 *
 * The routines collapse noisy angular/radial integrations into deterministic
 * one-dimensional estimates suitable for UI feedback rather than research-grade
 * numerical simulation. Background: https://en.wikipedia.org/wiki/Bloch_sphere
 *
 * Accuracy level: visualization estimate. Nothing here feeds authoritative
 * state evolution; the Physics Engine only surfaces it as `rhoExpectation`.
 */
// Fixed-order Gauss–Legendre nodes and weights on [-1, 1] (n = 10).
const GL_NODES = [
  -0.973906528517172, -0.865063366688985, -0.679409568299024, -0.43388843412695, -0.148874338981631,
  0.148874338981631, 0.43388843412695, 0.679409568299024, 0.865063366688985, 0.973906528517172,
] as const;

const GL_WEIGHTS = [
  0.066671344308688, 0.149451349150581, 0.219086362515982, 0.269266719309963, 0.295524224714753,
  0.295524224714753, 0.269266719309963, 0.219086362515982, 0.149451349150581, 0.066671344308688,
] as const;

const BLOCH_BALL_VOLUME = (4 * Math.PI) / 3;
const UNIFORM_RHO = 3 / (4 * Math.PI);

const angularDistance = (thetaA: number, phiA: number, thetaB: number, phiB: number) => {
  const ax = Math.sin(thetaA) * Math.cos(phiA);
  const ay = Math.sin(thetaA) * Math.sin(phiA);
  const az = Math.cos(thetaA);
  const bx = Math.sin(thetaB) * Math.cos(phiB);
  const by = Math.sin(thetaB) * Math.sin(phiB);
  const bz = Math.cos(thetaB);
  const dot = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
  return Math.acos(dot);
};

// Separable peaked integrals use fixed Gauss–Legendre samples for radial and angular terms.
export const radialPeakedIntegral = (r0: number, spread: number): number => {
  let sum = 0;
  for (let index = 0; index < GL_NODES.length; index += 1) {
    const xi = GL_NODES[index];
    const r = (xi + 1) / 2;
    const weight = GL_WEIGHTS[index] / 2;
    sum += weight * r * r * Math.exp(-((r - r0) ** 2) / (2 * spread * spread));
  }
  return sum;
};

export const angularPeakedIntegral = (theta0: number, phi0: number, spread: number): number => {
  let sum = 0;
  for (let muIndex = 0; muIndex < GL_NODES.length; muIndex += 1) {
    const mu = GL_NODES[muIndex];
    const theta = Math.acos(mu);
    const muWeight = GL_WEIGHTS[muIndex];
    for (let phiIndex = 0; phiIndex < GL_NODES.length; phiIndex += 1) {
      const xi = GL_NODES[phiIndex];
      const phi = Math.PI * (xi + 1);
      const phiWeight = GL_WEIGHTS[phiIndex];
      const distance = angularDistance(theta0, phi0, theta, phi);
      sum += muWeight * phiWeight * Math.exp(-(distance * distance) / (2 * spread * spread));
    }
  }
  return sum * Math.PI;
};

/**
 * ⟨ρ⟩ = (1/V) ∫ ρ(r,θ,φ) r² sinθ dr dθ dφ with separable peaked kernel.
 * Complexity O(1) — fixed 10-point GL radial × 10×10 angular (100 evals) vs O(n³) voxel grid.
 */
export const blochBallRhoExpectationFast = (
  r0: number,
  theta0: number,
  phi0: number,
  noise: number,
): number => {
  if (noise < 1e-8) return 1;

  const spread = Math.max(noise, 0.05);
  const peakedAverage = (radialPeakedIntegral(r0, spread) * angularPeakedIntegral(theta0, phi0, spread))
    / BLOCH_BALL_VOLUME;
  return (1 - noise) * peakedAverage + noise * UNIFORM_RHO;
};

export const blochBallConstants = {
  volume: BLOCH_BALL_VOLUME,
  uniformRho: UNIFORM_RHO,
} as const;
