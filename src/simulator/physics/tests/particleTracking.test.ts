import { describe, expect, it } from 'vitest';
import { createInitialState, runCircuit } from '../../engine';
import {
  blochCartesianFromSpherical,
  blochVectorForQubit,
  blochBallRhoExpectation,
  ketFromSpherical,
  mixedStateMetrics,
  particleDelta,
  snapshotParticle,
  sphericalFromBlochCartesian,
} from '../particleTracking';
import type { CircuitGate } from '../../types';

const gate = (type: string, step: number, targets: number[], controls: number[] = []): CircuitGate => ({
  id: `${type}-${step}`,
  type,
  step,
  targets,
  controls,
});

describe('particleTracking', () => {
  it('maps measured |1⟩ to south pole (θ = π) on the Bloch sphere', () => {
    const bloch = blochVectorForQubit(createInitialState(1), 1, 0, { 0: 1 });
    expect(bloch.z).toBeCloseTo(-1, 5);
  });

  it('maps measured |0⟩ to north pole (θ = 0) on the Bloch sphere', () => {
    const bloch = blochVectorForQubit(createInitialState(1), 1, 0, { 0: 0 });
    expect(bloch.z).toBeCloseTo(1, 5);
  });

  it('maps |0⟩ to z = cosθ = 1 on the Bloch sphere', () => {
    const state = createInitialState(1);
    const bloch = blochVectorForQubit(state, 1, 0);
    expect(bloch.z).toBeCloseTo(1, 5);
    const spherical = sphericalFromBlochCartesian(bloch);
    expect(spherical.r).toBeCloseTo(1, 5);
    expect(spherical.theta).toBeCloseTo(0, 5);
    expect(bloch).toEqual(blochCartesianFromSpherical(1, 0, 0));
  });

  it('builds |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩', () => {
    const theta = Math.PI / 2;
    const phi = Math.PI / 2;
    const ket = ketFromSpherical(theta, phi);
    expect(ket.alpha.re).toBeCloseTo(Math.cos(theta / 2), 5);
    expect(ket.beta.re).toBeCloseTo(0, 5);
    expect(ket.beta.im).toBeCloseTo(Math.sin(theta / 2), 5);
    expect(ket.formatted).toContain('|ψ⟩');
  });

// Case: uses x = sinθ cosφ, y = sinθ sinφ, z = cosθ for Pauli-axis directions.
  it('uses x = sinθ cosφ, y = sinθ sinφ, z = cosθ for Pauli-axis directions', () => {
    const xGate = blochCartesianFromSpherical(1, Math.PI / 2, 0);
    expect(xGate.x).toBeCloseTo(1, 5);
    expect(xGate.z).toBeCloseTo(0, 5);

    const yGate = blochCartesianFromSpherical(1, Math.PI / 2, Math.PI / 2);
    expect(yGate.y).toBeCloseTo(1, 5);

    const zGate = blochCartesianFromSpherical(1, 0, 0);
    expect(zGate.z).toBeCloseTo(1, 5);
  });

// Case: detects particle movement after a Hadamard gate.
  it('detects particle movement after a Hadamard gate', () => {
    const initial = snapshotParticle(createInitialState(1), 1, 0);
    const afterH = snapshotParticle(runCircuit(1, [gate('H', 0, [0])], undefined, undefined, { trackParticles: true }).state, 1, 0);
    const delta = particleDelta(initial, afterH);
    expect(delta.displacement).toBeGreaterThan(0.5);
    expect(delta.deltaTheta).toBeGreaterThan(0.5);
  });

// Case: lowers ⟨ρ⟩ expectation for mixed marginals.
  it('lowers ⟨ρ⟩ expectation for mixed marginals', () => {
    const pure = mixedStateMetrics({ r: 1, theta: Math.PI / 4, phi: 0 });
    const mixed = mixedStateMetrics({ r: 0.4, theta: Math.PI / 3, phi: Math.PI / 6 });
    expect(pure.isPure).toBe(true);
    expect(pure.purity).toBeCloseTo(1, 5);
    expect(pure.mixedness).toBeCloseTo(0, 5);
    expect(pure.blochRadius).toBeCloseTo(1, 5);
    expect(mixed.isPure).toBe(false);
    expect(mixed.blochRadius).toBeCloseTo(0.4, 5);
    expect(mixed.purity).toBeCloseTo((1 + 0.16) / 2, 5);
    expect(mixed.mixedness).toBeCloseTo(2 * (1 - mixed.purity), 5);
    expect(mixed.rhoExpectation).toBeLessThan(pure.rhoExpectation);
    expect(blochBallRhoExpectation(0.4, Math.PI / 3, Math.PI / 6, mixed.mixedness)).toBeGreaterThan(0);
  });

  it('distinguishes local mixedness from physical noise', () => {
    const mixed = mixedStateMetrics({
      r: 0,
      theta: 0,
      phi: 0,
    });
    expect(mixed.purity).toBeCloseTo(0.5);
    expect(mixed.mixedness).toBeCloseTo(1);
    expect(mixed.isPure).toBe(false);
  });

  it('flags entanglement with the register for Bell marginals', () => {
    const result = runCircuit(2, [gate('H', 0, [0]), gate('CNOT', 1, [1], [0])], undefined, undefined, {
      trackParticles: true,
    });
    const q0 = snapshotParticle(result.state, 2, 0);
    const q1 = snapshotParticle(result.state, 2, 1);
    expect(q0.mixed.purity).toBeCloseTo(0.5, 5);
    expect(q1.mixed.purity).toBeCloseTo(0.5, 5);
    expect(q0.entangledWithRegister).toBe(true);
    expect(q1.entangledWithRegister).toBe(true);
  });

// Case: records transitions when runCircuit tracking is enabled.
  it('records transitions when runCircuit tracking is enabled', () => {
    const result = runCircuit(2, [gate('H', 0, [0]), gate('CNOT', 1, [1], [0])], undefined, undefined, {
      trackParticles: true,
    });
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions?.[0].after[0].ket.formatted).toContain('|ψ⟩');
    expect(result.transitions?.[1].inputQubits).toEqual([0]);
    expect(result.transitions?.[1].outputQubits).toEqual([1]);
  });
});
