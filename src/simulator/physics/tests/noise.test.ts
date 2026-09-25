import { describe, expect, it } from 'vitest';
import { complex } from '../../complex';
import { runCircuit, runNoisyCircuit } from '../../engine';
import { MATRIX_H } from '../../gates/matrices';
import type { CircuitGate } from '../../types';
import { physics } from '../PhysicsEngine';
import { amplitudeDamping } from '../noise/AmplitudeDamping';
import { bitFlip } from '../noise/BitFlip';
import { decoherenceChannels } from '../noise/Decoherence';
import { phaseDamping } from '../noise/Dephasing';
import { depolarizing } from '../noise/Depolarizing';
import { isTracePreserving } from '../noise/NoiseModel';
import { phaseFlip } from '../noise/PhaseFlip';
import { stateVector } from '../state/QuantumState';

const INV_SQRT2 = 1 / Math.sqrt(2);
const plus = () => stateVector([complex(INV_SQRT2), complex(INV_SQRT2)]);
const one = () => physics.prepare(physics.createState(1), 0, '1p');

const gate = (id: string, type: string, step: number, targets: number[], controls: number[] = [], extra: Partial<CircuitGate> = {}): CircuitGate => ({
  id,
  type,
  step,
  targets,
  controls,
  ...extra,
});

describe('noise channels', () => {
  it('are trace preserving', () => {
    [bitFlip(0.2), phaseFlip(0.3), depolarizing(0.4), amplitudeDamping(0.5), phaseDamping(0.6)].forEach((channel) => {
      expect(isTracePreserving(channel)).toBe(true);
    });
  });

  it('bit flip mixes populations; phase flip shrinks X coherence', () => {
    const flipped = physics.applyChannel(physics.createState(1), bitFlip(0.25), [0]);
    expect(physics.probabilities(flipped)[1]).toBeCloseTo(0.25, 12);
    const dephased = physics.applyChannel(plus(), phaseFlip(0.25), [0]);
    expect(physics.blochVector(dephased, 0).x).toBeCloseTo(0.5, 12);
    expect(physics.probabilities(dephased)[0]).toBeCloseTo(0.5, 12);
  });

  it('depolarizing shrinks the Bloch vector by 1 − p', () => {
    const noisy = physics.applyChannel(plus(), depolarizing(0.3), [0]);
    expect(physics.blochVector(noisy, 0).x).toBeCloseTo(0.7, 12);
    const full = physics.applyChannel(plus(), depolarizing(1), [0]);
    expect(physics.inspectQubit(full, 0).purity).toBeCloseTo(0.5, 12);
  });

  it('amplitude damping relaxes |1⟩ toward |0⟩; phase damping keeps populations', () => {
    const relaxed = physics.applyChannel(one(), amplitudeDamping(0.4), [0]);
    expect(physics.probabilities(relaxed)[0]).toBeCloseTo(0.4, 12);
    const damped = physics.applyChannel(plus(), phaseDamping(0.75), [0]);
    expect(physics.probabilities(damped)[1]).toBeCloseTo(0.5, 12);
    expect(physics.blochVector(damped, 0).x).toBeCloseTo(0.5, 12);
  });

  it('rejects out-of-range strengths', () => {
    expect(() => bitFlip(1.2)).toThrow(RangeError);
    expect(() => amplitudeDamping(-0.1)).toThrow(RangeError);
  });

  it('zero-strength noise leaves pure states on the state-vector backend', () => {
    const untouched = physics.applyNoise(plus(), { gate: [bitFlip(0)] }, { touched: [0] });
    expect(untouched.kind).toBe('stateVector');
  });
});

describe('T1/T2 decoherence', () => {
  it('T1 sets population decay and T2 sets coherence decay', () => {
    const t1 = 50;
    const t2 = 30;
    const duration = 10;
    const model = { decoherence: { t1, t2 }, timing: { defaultGateDuration: duration } };
    const relaxed = physics.applyNoise(one(), model, { operation: 'X' });
    expect(physics.probabilities(relaxed)[1]).toBeCloseTo(Math.exp(-duration / t1), 12);
    const decohered = physics.applyNoise(plus(), model, { operation: 'X' });
    expect(physics.blochVector(decohered, 0).x).toBeCloseTo(Math.exp(-duration / t2), 12);
  });

  it('rejects T2 > 2·T1 and uses per-gate durations', () => {
    expect(() => decoherenceChannels({ t1: 10, t2: 25 }, 1)).toThrow(RangeError);
    const model = { decoherence: { t2: 10 }, timing: { defaultGateDuration: 1, gateDurations: { CNOT: 5 } } };
    const slow = physics.applyNoise(plus(), model, { operation: 'CNOT' });
    expect(physics.blochVector(slow, 0).x).toBeCloseTo(Math.exp(-5 / 10), 12);
  });

  it('fidelity against the target drops as decoherence accumulates', () => {
    const model = { decoherence: { t1: 100, t2: 80 }, timing: { defaultGateDuration: 5 } };
    const once = physics.applyNoise(plus(), model);
    const twice = physics.applyNoise(once, model);
    const f1 = physics.fidelity(once, plus());
    const f2 = physics.fidelity(twice, plus());
    expect(f1).toBeLessThan(1);
    expect(f2).toBeLessThan(f1);
  });
});

describe('runNoisyCircuit', () => {
  const bellGates = [gate('h', 'H', 0, [0]), gate('cx', 'CNOT', 1, [1], [0])];

  it('matches the ideal run when the noise model is empty', () => {
    const ideal = runCircuit(2, bellGates);
    const noisy = runNoisyCircuit(2, bellGates, [], undefined, { noise: {} });
    expect(physics.fidelity(noisy.state, stateVector(ideal.state, 2))).toBeCloseTo(1, 12);
    expect(noisy.log.slice(1)).toEqual(ideal.log.slice(1));
  });

  it('lowers Bell-state fidelity and purity under depolarizing gate noise', () => {
    const ideal = stateVector(runCircuit(2, bellGates).state, 2);
    const noisy = runNoisyCircuit(2, bellGates, [], undefined, { noise: { gate: [depolarizing(0.05)] } });
    const fidelity = physics.fidelity(noisy.state, ideal);
    expect(fidelity).toBeLessThan(1);
    expect(fidelity).toBeGreaterThan(0.85);
    expect(physics.inspectGlobal(noisy.state).purity).toBeLessThan(1);
    expect(physics.assessEntanglement(noisy.state, [0]).status).toBe('entangled');
  });

  it('corrects a single injected bit flip with the 3-qubit repetition code', () => {
    // Encode |1⟩ into |111⟩, flip q1 with certainty, decode with majority vote (Toffoli).
    const gates = [
      gate('x', 'X', 0, [0]),
      gate('e1', 'CNOT', 1, [1], [0]),
      gate('e2', 'CNOT', 2, [2], [0]),
      gate('err', 'X', 3, [1]),
      gate('d1', 'CNOT', 4, [1], [0]),
      gate('d2', 'CNOT', 5, [2], [0]),
      gate('fix', 'CCNOT', 6, [0], [1, 2]),
    ];
    const result = runNoisyCircuit(3, gates, [], undefined, { noise: {} });
    expect(physics.inspectQubit(result.state, 0).probabilities.one).toBeCloseTo(1, 12);
  });

  it('keeps logical cycles noise-free and supports measurement feed-forward', () => {
    const noise = { decoherence: { t1: 10 }, timing: { defaultGateDuration: 1 } };
    const withCycles = runNoisyCircuit(1, [
      gate('x', 'X', 0, [0]),
      gate('c1', 'CYCLE', 1, [], [], { cycle: 1 }),
      gate('c2', 'CYCLE', 2, [], [], { cycle: 2 }),
    ], [], undefined, { noise });
    const withoutCycles = runNoisyCircuit(1, [gate('x', 'X', 0, [0])], [], undefined, { noise });
    expect(physics.probabilities(withCycles.state)[1]).toBeCloseTo(physics.probabilities(withoutCycles.state)[1], 12);

    const feedForward = runNoisyCircuit(2, [
      gate('x', 'X', 0, [0]),
      gate('m', 'MEASURE', 1, [0]),
      gate('fix', 'X', 2, [1], [], { condition: { qubit: 0, equals: 1 } }),
    ], [], undefined, { noise: {}, random: () => 0.5 });
    expect(feedForward.measurements[0]).toBe(1);
    expect(feedForward.conditionOutcomes).toEqual({ fix: true });
    expect(physics.probabilities(feedForward.state)[3]).toBeCloseTo(1, 12);
  });

  it('applies X-basis measurement to density matrices', () => {
    const result = runNoisyCircuit(1, [
      gate('h', 'H', 0, [0]),
      gate('m', 'MEASURE', 1, [0], [], { basis: 'X' }),
    ], [], undefined, { noise: {}, random: () => 0.2 });
    expect(result.measurements[0]).toBe(0);
    expect(physics.fidelity(result.state, physics.applyUnitary(physics.createState(1), [0], MATRIX_H))).toBeCloseTo(1, 12);
  });
});
