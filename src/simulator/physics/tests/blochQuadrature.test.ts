import { describe, expect, it } from 'vitest';
import { angularPeakedIntegral, blochBallRhoExpectationFast, radialPeakedIntegral } from '../numerics/blochQuadrature';
/** Legacy O(n³) reference integrator for regression checks only. */
const blochBallRhoExpectationGrid = (
  r0: number,
  theta0: number,
  phi0: number,
  noise: number,
  gridSize: number,
): number => {
  if (noise < 1e-8) return 1;
  const spread = Math.max(noise, 0.05);
  let weighted = 0;
  let measure = 0;
  const dr = 1 / gridSize;
  const dtheta = Math.PI / gridSize;
  const dphi = (2 * Math.PI) / gridSize;
  const angularDistance = (thetaA: number, phiA: number, thetaB: number, phiB: number) => {
    const ax = Math.sin(thetaA) * Math.cos(phiA);
    const ay = Math.sin(thetaA) * Math.sin(phiA);
    const az = Math.cos(thetaA);
    const bx = Math.sin(thetaB) * Math.cos(phiB);
    const by = Math.sin(thetaB) * Math.sin(phiB);
    const bz = Math.cos(thetaB);
    return Math.acos(Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz)));
  };

  for (let ir = 0; ir < gridSize; ir += 1) {
    const r = (ir + 0.5) * dr;
    for (let it = 0; it < gridSize; it += 1) {
      const theta = (it + 0.5) * dtheta;
      const sinTheta = Math.sin(theta);
      for (let ip = 0; ip < gridSize; ip += 1) {
        const phi = (ip + 0.5) * dphi;
        const volume = r * r * sinTheta * dr * dtheta * dphi;
        const radial = Math.exp(-((r - r0) ** 2) / (2 * spread * spread));
        const angular = Math.exp(-(angularDistance(theta0, phi0, theta, phi) ** 2) / (2 * spread * spread));
        const rho = (1 - noise) * radial * angular + noise * (3 / (4 * Math.PI));
        weighted += rho * volume;
        measure += volume;
      }
    }
  }
  return measure > 0 ? weighted / measure : 0;
};

describe('blochQuadrature', () => {
  it('separates radial and angular peaked factors', () => {
    const radial = radialPeakedIntegral(0.4, 0.2);
    const angular = angularPeakedIntegral(Math.PI / 3, Math.PI / 6, 0.2);
    expect(radial).toBeGreaterThan(0);
    expect(angular).toBeGreaterThan(0);
  });

// Case: matches coarse grid quadrature within tolerance.
  it('matches coarse grid quadrature within tolerance', () => {
    const args = [0.4, Math.PI / 3, Math.PI / 6, 0.6] as const;
    const fast = blochBallRhoExpectationFast(...args);
    const grid = blochBallRhoExpectationGrid(...args, 10);
    expect(fast).toBeCloseTo(grid, 2);
  });
});
