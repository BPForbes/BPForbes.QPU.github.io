import { describe, expect, it } from 'vitest';
import { applyGateToState, executeCircuit, type QuantumCheckpoint, runCircuit } from '../engine';
import { physics } from '../physics/PhysicsEngine';
import type { CircuitGate } from '../types';

const gate = (id: string, type: string, step: number, targets: number[], controls: number[] = [], extra: Partial<CircuitGate> = {}): CircuitGate => ({
  id,
  type,
  step,
  targets,
  controls,
  ...extra,
});

const bellGates = [gate('h', 'H', 0, [0]), gate('cx', 'CNOT', 1, [1], [0])];

describe('engine-native QuantumState execution', () => {
  it('ideal runs stay state vectors and match the Complex[] adapter exactly', () => {
    const native = executeCircuit(2, bellGates);
    expect(native.state.kind).toBe('stateVector');
    expect(native.state.kind === 'stateVector' && native.state.amplitudes).toEqual(runCircuit(2, bellGates).state);
    expect(native.log).toEqual(runCircuit(2, bellGates).log);
  });

  it('noise keeps the result a density matrix instead of squeezing it into amplitudes', () => {
    const noisy = executeCircuit(2, bellGates, [], undefined, { noise: { gate: [physics.channels.depolarizing(0.1)] } });
    expect(noisy.state.kind).toBe('densityMatrix');
    expect(physics.inspectGlobal(noisy.state).purity).toBeLessThan(1);
    expect(physics.assessEntanglement(noisy.state, [0]).status).toBe('entangled');
  });

  it('a noise model that cannot change the state never allocates a density matrix', () => {
    const run = executeCircuit(2, bellGates, [], undefined, { noise: { gate: [physics.channels.bitFlip(0)] } });
    expect(run.state.kind).toBe('stateVector');
  });

  it('can start from a density matrix on request', () => {
    const run = executeCircuit(2, bellGates, [], undefined, { representation: 'densityMatrix' });
    expect(run.state.kind).toBe('densityMatrix');
    expect(physics.entanglementEntropy(run.state, [0])).toBeCloseTo(1, 9);
  });

  it('tracks particles from mixed states, including the entanglement assessment', () => {
    const run = executeCircuit(2, bellGates, [], undefined, {
      trackParticles: true,
      noise: { gate: [physics.channels.depolarizing(0.05)] },
    });
    expect(run.particles).toHaveLength(2);
    expect(run.particles?.[0].mixed.purity).toBeLessThan(1);
    expect(run.particles?.[0].entanglement?.status).toBe('entangled');
    expect(run.transitions).toHaveLength(2);
  });

  it('saves and restores density-matrix checkpoints', () => {
    const checkpoints: Record<string, QuantumCheckpoint> = {};
    const run = executeCircuit(1, [
      gate('h', 'H', 0, [0]),
      gate('save', 'SAVE_STATE', 1, [], [], { checkpoint: 'plus' }),
      gate('x', 'X', 2, [0]),
      gate('load', 'LOAD_STATE', 3, [], [], { checkpoint: 'plus' }),
    ], [], undefined, { representation: 'densityMatrix', checkpoints });
    expect(checkpoints.plus.state.kind).toBe('densityMatrix');
    expect(physics.measurementDiagnostics(run.state, 0, 'X').expectation).toBeCloseTo(1, 12);
  });

  it('grows the register when a gate names a new wire, padding the before-snapshot to match', () => {
    const result = applyGateToState(physics.createState(1), gate('x', 'X', 0, [1]), {}, { trackParticles: true });
    expect(result.state.qubitCount).toBe(2);
    expect(physics.probabilities(result.state)[1]).toBeCloseTo(1, 12);
    expect(result.transitions?.[0].before).toHaveLength(2);
    expect(result.transitions?.[0].after).toHaveLength(2);
  });

  it('honours the injected sampler for MEASURE in both representations', () => {
    const gates = [gate('h', 'H', 0, [0]), gate('m', 'MEASURE', 1, [0])];
    expect(executeCircuit(1, gates, [], undefined, { random: () => 0.1 }).measurements[0]).toBe(1);
    expect(executeCircuit(1, gates, [], undefined, { random: () => 0.9, representation: 'densityMatrix' }).measurements[0]).toBe(0);
  });

  it('rejects gate-expression predicates on a density matrix', () => {
    const predicated = gate('x', 'X', 1, [1], [], {
      condition: {
        qubit: 0,
        equals: 1,
        predicate: { type: 'X', inputs: [0], output: 0, scratch: false, expect: 1, negate: false, text: 'X(q0)' },
      },
    });
    expect(() => executeCircuit(2, [predicated], [], undefined, { representation: 'densityMatrix' }))
      .toThrow(/density matrix/);
  });
});
