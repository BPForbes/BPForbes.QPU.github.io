import { describe, expect, it } from 'vitest';
import { applyGateToState, executeCircuit, type PhysicalRunOptions } from '../engine';
import { physics } from '../physics/PhysicsEngine';
import type { QubitPhysicsProfile } from '../physics/frequency/QubitProfile';
import type { CircuitGate } from '../types';
import { randomCircuit, seededRandom } from './support/randomCircuits';

// Frequencies in GHz, durations in ns.
const qubit: QubitPhysicsProfile = { transitionFrequency: 5 };
const gate = (id: string, type: string, step: number, targets: number[], controls: number[] = [], extra: Partial<CircuitGate> = {}): CircuitGate => ({
  id,
  type,
  step,
  targets,
  controls,
  ...extra,
});
const physical = (extra: Partial<PhysicalRunOptions> = {}, system: Partial<PhysicalRunOptions['system']> = {}): PhysicalRunOptions => ({
  system: { defaultProfile: qubit, frame: 'rotating', approximation: 'rwa', ...system },
  timing: { defaultGateDuration: 20 },
  ...extra,
});

describe('physical simulation mode', () => {
  it('an ideal, calibrated rotating-frame run reproduces the ideal circuit and advances the clock', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 3, maxDepth: 12 });
      const ideal = executeCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const run = executeCircuit(circuit.qubitCount, circuit.gates, circuit.startStates, undefined, { physical: physical() });
      expect(physics.fidelity(run.state, ideal.state)).toBeCloseTo(1, 9);
      expect(run.physicalTime).toBeCloseTo(20 * circuit.gates.length, 9);
    }
  });

  it('drive-pulse gates implement X, Y, RX, RY as calibrated microwave pulses', () => {
    const gates = [
      gate('x', 'X', 0, [0]),
      gate('ry', 'RY', 1, [1], [], { phase: 0.7 }),
      gate('h', 'H', 2, [2]),
      gate('cx', 'CNOT', 3, [2], [0]),
      gate('rx', 'RX', 4, [1], [], { phase: -1.3 }),
      gate('y', 'Y', 5, [0]),
    ];
    const ideal = executeCircuit(3, gates);
    for (const envelope of [{ kind: 'square' as const }, { kind: 'gaussian' as const, sigma: 4 }]) {
      const run = executeCircuit(3, gates, [], undefined, { physical: physical({ gates: 'drive', envelope }) });
      expect(physics.fidelity(run.state, ideal.state)).toBeCloseTo(1, 7);
      expect(run.log.some((line) => line.includes('drive pulse'))).toBe(true);
    }
  });

  it('in the lab frame an idle qubit keeps precessing at f01 between gates', () => {
    const run = executeCircuit(2, [gate('h', 'H', 0, [0]), gate('x', 'X', 1, [1])], [], undefined, {
      physical: physical({ timing: { defaultGateDuration: 0.03 } }, { frame: 'lab' }),
    });
    const phi = physics.inspectQubit(run.state, 0).spherical.phi;
    const expected = -2 * Math.PI * 5 * 0.06;
    expect(Math.cos(phi)).toBeCloseTo(Math.cos(expected), 9);
    expect(Math.sin(phi)).toBeCloseTo(Math.sin(expected), 9);
  });

  it('logical cycles take no physical time; skipped conditional gates still use their slot', () => {
    const run = executeCircuit(2, [
      gate('x', 'X', 0, [0]),
      gate('c1', 'CYCLE', 1, [], [], { cycle: 1 }),
      gate('m', 'MEASURE', 2, [0]),
      gate('skip', 'X', 3, [1], [], { condition: { qubit: 0, equals: 0 } }),
    ], [], undefined, { physical: physical({ timing: { defaultGateDuration: 20, gateDurations: { MEASURE: 300 } } }) });
    expect(run.physicalTime).toBeCloseTo(20 + 300 + 20, 9);
    expect(run.conditionOutcomes).toEqual({ skip: false });
  });

  it('a mistuned qubit turns idle time into phase error and pulses into over/under-rotation', () => {
    const detuned: QubitPhysicsProfile = { transitionFrequency: 5, frequencyOffset: 0.002 };
    const phaseGates = [gate('h', 'H', 0, [0]), gate('idle', 'X', 1, [1]), gate('h2', 'H', 2, [0])];
    const ideal = executeCircuit(2, phaseGates);
    const drifting = executeCircuit(2, phaseGates, [], undefined, { physical: physical({}, { defaultProfile: detuned }) });
    // H at t = 0, then 40 ns of detuned precession before the second H: F = cos²(φ/2), φ = 2π·δf·40.
    const phaseError = 2 * Math.PI * 0.002 * 40;
    expect(physics.fidelity(drifting.state, ideal.state)).toBeCloseTo(Math.cos(phaseError / 2) ** 2, 9);
    const pulsed = executeCircuit(1, [gate('x', 'X', 0, [0])], [], undefined, { physical: physical({ gates: 'drive' }, { defaultProfile: { transitionFrequency: 5, frequencyOffset: 0.02 } }) });
    expect(physics.probabilityOfOne(pulsed.state, 0)).toBeLessThan(0.9);
  });

  it('profile T1 relaxes toward the thermal population over physical time', () => {
    const warm: QubitPhysicsProfile = { transitionFrequency: 1, t1: 100, temperature: 0.1 };
    const idles = Array.from({ length: 40 }, (_, step) => gate(`i${step}`, 'Z', step + 1, [1]));
    const run = executeCircuit(2, [gate('x', 'X', 0, [0]), ...idles], [], undefined, {
      physical: physical({ timing: { defaultGateDuration: 50 } }, { defaultProfile: warm }),
    });
    expect(run.state.kind).toBe('densityMatrix');
    const thermal = physics.frequency.thermalExcitedPopulation(physics.frequency.toHertz(1), 0.1);
    expect(physics.probabilityOfOne(run.state, 0)).toBeCloseTo(thermal, 6);
  });

  it('always-on ZZ coupling entangles idle neighbours (crosstalk), with no two-qubit gate', () => {
    const J = 0.001;
    const run = executeCircuit(2, [gate('h0', 'H', 0, [0]), gate('h1', 'H', 1, [1])], [], undefined, {
      physical: physical(
        { timing: { defaultGateDuration: 1 / (4 * J) }, decoherence: false },
        { couplings: [{ qubits: [0, 1], kind: 'zz', strength: J }] },
      ),
    });
    expect(physics.assessEntanglement(run.state, [0]).status).toBe('entangled');
    const quiet = executeCircuit(2, [gate('h0', 'H', 0, [0]), gate('h1', 'H', 1, [1])], [], undefined, { physical: physical() });
    expect(physics.assessEntanglement(quiet.state, [0]).status).toBe('separable');
  });

  it('stepping threads the physical clock', () => {
    const options = { physical: physical() };
    const first = applyGateToState(physics.createState(1), gate('h', 'H', 0, [0]), {}, options);
    const second = applyGateToState(first.state, gate('x', 'X', 1, [0]), first.measurements, { ...options, physicalTime: first.physicalTime });
    expect(first.physicalTime).toBe(20);
    expect(second.physicalTime).toBe(40);
  });

  it('leaves the ideal path untouched when physical mode is off', () => {
    const run = executeCircuit(1, [gate('h', 'H', 0, [0])]);
    expect(run.physicalTime).toBeUndefined();
  });
});
