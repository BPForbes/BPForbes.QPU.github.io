import { describe, expect, it } from 'vitest';
import { executeCircuit, type PhysicalRunOptions } from '../../engine';
import type { CircuitGate } from '../../types';
import { physics } from '../PhysicsEngine';
import { leakageChannel, transmonPropagator } from '../frequency/Leakage';
import { segmentPropagators, type PhysicalSystem } from '../frequency/PhysicalEvolution';
import type { ControlPulse } from '../frequency/Pulses';
import type { QubitPhysicsProfile } from '../frequency/QubitProfile';

// Frequencies in GHz, times in ns. A typical transmon: f₀₁ = 5 GHz, α/2π = −0.2 GHz.
const transmon: QubitPhysicsProfile = { transitionFrequency: 5, anharmonicity: -0.2 };
const probability = (value: { re: number; im: number }) => value.re ** 2 + value.im ** 2;
const piPulse = (profile: QubitPhysicsProfile, duration: number, envelope: ControlPulse['envelope']) =>
  physics.frequency.calibratedPulse({ target: 0, profile, angle: Math.PI, duration, envelope });
const gate = (id: string, type: string, step: number, targets: number[], controls: number[] = []): CircuitGate => ({ id, type, step, targets, controls });

describe('transmon leakage model', () => {
  it('with two levels it is exactly the qubit drive model', () => {
    const profile: QubitPhysicsProfile = { transitionFrequency: 5, frequencyOffset: 0.003 };
    const pulses: ControlPulse[] = [
      piPulse(profile, 20, { kind: 'square' }),
      { ...piPulse(profile, 16, { kind: 'drag', sigma: 4, beta: 0.3 }), carrierFrequency: 5.01, phase: 0.4 },
    ];
    for (const pulse of pulses) {
      for (const frame of ['rotating', 'lab'] as const) {
        const system: PhysicalSystem = { defaultProfile: profile, frame, approximation: 'rwa' };
        const [qubit] = segmentPropagators(system, 1, { start: 1.5, duration: pulse.duration, pulses: [pulse] });
        const reduced = transmonPropagator(profile, pulse, 1.5, pulse.duration, { frame, levels: 2 });
        if (!('unitary' in qubit)) throw new Error('expected a unitary');
        qubit.unitary.forEach((row, j) => row.forEach((value, k) => {
          expect(reduced[j][k].re).toBeCloseTo(value.re, 9);
          expect(reduced[j][k].im).toBeCloseTo(value.im, 9);
        }));
      }
    }
  });

  it('puts |2⟩ at f₁₂ = f₀₁ + α: idle |1⟩→|2⟩ phase advances at 2π(f₀₁ + α)', () => {
    const idle: ControlPulse = { target: 0, carrierFrequency: 5, amplitude: 0, phase: 0, duration: 0.37, envelope: { kind: 'square' } };
    const unitary = transmonPropagator(transmon, idle, 0, 0.37, { frame: 'lab', approximation: 'exact' });
    const phase = Math.atan2(unitary[2][2].im, unitary[2][2].re) - Math.atan2(unitary[1][1].im, unitary[1][1].re);
    const expected = -2 * Math.PI * (5 - 0.2) * 0.37;
    expect(Math.cos(phase)).toBeCloseTo(Math.cos(expected), 9);
    expect(Math.sin(phase)).toBeCloseTo(Math.sin(expected), 9);
  });

  it('a drive resonant with 1↔2 Rabi-oscillates |1⟩ into |2⟩ at √2·Ω (the transmon matrix element)', () => {
    // Weak drive, |α| ≫ Ω: the 0↔1 transition is off resonance by α, so the 1↔2 pair is an isolated
    // two-level system with coupling √2·Ω; corrections are O((Ω/α)²).
    const profile: QubitPhysicsProfile = { transitionFrequency: 5, anharmonicity: -0.3 };
    const rabi = 0.004;
    for (const duration of [30, 60, 90]) {
      const pulse: ControlPulse = { target: 0, carrierFrequency: 4.7, amplitude: rabi, phase: 0, duration, envelope: { kind: 'square' } };
      const unitary = transmonPropagator(profile, pulse, 0, duration);
      const expected = Math.sin((Math.sqrt(2) * 2 * Math.PI * rabi * duration) / 2) ** 2;
      expect(probability(unitary[2][1])).toBeCloseTo(expected, 3);
      expect(probability(unitary[2][0])).toBeLessThan(1e-3);
    }
  });

  it('short pulses leak more, and DRAG at β = 1/α suppresses leakage by orders of magnitude', () => {
    const leakage = (duration: number, envelope: ControlPulse['envelope']) =>
      physics.frequency.leakageDiagnostics(transmon, piPulse(transmon, duration, envelope)).averageLeakage;
    const short = leakage(6, { kind: 'gaussian', sigma: 1.5 });
    const long = leakage(20, { kind: 'gaussian', sigma: 5 });
    expect(short).toBeGreaterThan(1e-3);
    expect(long).toBeLessThan(short / 10);

    const { leakageDragBeta } = physics.frequency.leakageDiagnostics(transmon, piPulse(transmon, 20, { kind: 'gaussian', sigma: 5 }));
    expect(leakageDragBeta).toBeCloseTo(1 / (2 * Math.PI * -0.2), 12);
    const drag = leakage(20, { kind: 'drag', sigma: 5, beta: leakageDragBeta });
    expect(drag).toBeLessThan(long / 1000);
    // The wrong sign makes it worse, not better.
    expect(leakage(20, { kind: 'drag', sigma: 5, beta: -leakageDragBeta })).toBeGreaterThan(long);
  });

  it('the qubit channel is trace preserving and matches the leaked populations', () => {
    const unitary = transmonPropagator(transmon, piPulse(transmon, 6, { kind: 'gaussian', sigma: 1.5 }), 0, 6);
    const channel = leakageChannel(unitary);
    expect(() => physics.validateChannel({ name: 'leakage', parameter: 0, kraus: channel.kraus })).not.toThrow();
    expect(channel.leakageFrom[0]).toBeCloseTo(probability(unitary[2][0]), 12);
    expect(channel.leakageFrom[1]).toBeCloseTo(probability(unitary[2][1]), 12);
  });

  it('rejects zero anharmonicity and leaky drives on coupled wires', () => {
    expect(() => physics.frequency.leakageDiagnostics({ transitionFrequency: 5, anharmonicity: 0 }, piPulse(transmon, 20, { kind: 'square' }))).toThrow(RangeError);
    const system: PhysicalSystem = { defaultProfile: transmon, couplings: [{ qubits: [0, 1], kind: 'zz', strength: 0.001 }] };
    expect(() => physics.evolvePhysical(physics.createState(2), system, { start: 0, duration: 20, pulses: [piPulse(transmon, 20, { kind: 'square' })] }))
      .toThrow(/Leakage is modelled/);
  });
});

describe('leakage in physical simulation mode', () => {
  const run = (envelope: ControlPulse['envelope'], duration = 6, profile = transmon) => {
    const physical: PhysicalRunOptions = {
      system: { defaultProfile: profile, frame: 'rotating', approximation: 'rwa' },
      timing: { defaultGateDuration: duration },
      gates: 'drive',
      envelope,
      decoherence: false,
    };
    return executeCircuit(2, [gate('x', 'X', 0, [0]), gate('cx', 'CNOT', 1, [1], [0])], [], undefined, { physical });
  };

  it('records the leaked population, logs it, and returns it to |1⟩', () => {
    const result = run({ kind: 'gaussian', sigma: 1.5 });
    const unitary = transmonPropagator(transmon, piPulse(transmon, 6, { kind: 'gaussian', sigma: 1.5 }), 0, 6);
    const leaked = probability(unitary[2][0]);
    expect(result.leakage?.[0]).toBeCloseTo(leaked, 9);
    expect(leaked).toBeGreaterThan(1e-3);
    expect(result.log.some((line) => line.includes('q0 leaked'))).toBe(true);
    expect(result.state.kind).toBe('densityMatrix');
    // A 6 ns pulse also under-rotates; leaked population reads as 1 and still controls the CNOT.
    expect(physics.probabilityOfOne(result.state, 0)).toBeCloseTo(probability(unitary[1][0]) + leaked, 9);
    expect(physics.probabilityOfOne(result.state, 1)).toBeCloseTo(probability(unitary[1][0]) + leaked, 9);
  });

  it('a leakage-cancelling DRAG pulse makes the drive-mode X nearly ideal', () => {
    const gaussian = run({ kind: 'gaussian', sigma: 5 }, 20);
    const beta = physics.frequency.leakageDiagnostics(transmon, piPulse(transmon, 20, { kind: 'gaussian', sigma: 5 })).leakageDragBeta;
    const drag = run({ kind: 'drag', sigma: 5, beta }, 20);
    expect(drag.leakage?.[0] ?? 1).toBeLessThan((gaussian.leakage?.[0] ?? 0) / 1000);
  });

  it('two-level profiles never leak', () => {
    const result = run({ kind: 'gaussian', sigma: 1.5 }, 6, { transitionFrequency: 5 });
    expect(result.leakage).toBeUndefined();
    expect(result.state.kind).toBe('stateVector');
  });
});
