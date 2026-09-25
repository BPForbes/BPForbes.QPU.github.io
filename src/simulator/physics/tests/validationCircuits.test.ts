import { afterEach, describe, expect, it, vi } from 'vitest';
import { complex } from '../../complex';
import { runCircuit } from '../../engine';
import type { CircuitGate, GateCondition } from '../../types';
import { physics } from '../PhysicsEngine';
import { densityState, stateVector } from '../state/QuantumState';

// Canonical physics circuits, run through the real simulator engine and checked with the Physics Engine.
let step = 0;
const gate = (type: string, targets: number[], controls: number[] = [], extra: Partial<CircuitGate> = {}): CircuitGate => ({
  id: `${type}-${step}`,
  type,
  step: step++,
  targets,
  controls,
  ...extra,
});

const run = (qubitCount: number, gates: CircuitGate[]) => {
  const result = runCircuit(qubitCount, gates);
  return { result, state: stateVector(result.state, qubitCount) };
};

const INV_SQRT2 = 1 / Math.sqrt(2);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('physics validation circuits', () => {
  it('superposition: H|0⟩ gives P(0) = P(1) = 0.5', () => {
    const { state } = run(1, [gate('H', [0])]);
    const [p0, p1] = physics.probabilities(state);
    expect(p0).toBeCloseTo(0.5, 12);
    expect(p1).toBeCloseTo(0.5, 12);
  });

  it('interference: H H|0⟩ returns to |0⟩ through amplitude cancellation', () => {
    const { state } = run(1, [gate('H', [0]), gate('H', [0])]);
    expect(physics.probabilities(state)[0]).toBeCloseTo(1, 12);
  });

  it('Bell: H q0; CNOT q0→q1 gives (|00⟩+|11⟩)/√2 with purity ½ and S = 1 per qubit', () => {
    const { state } = run(2, [gate('H', [0]), gate('CNOT', [1], [0])]);
    const bell = stateVector([complex(INV_SQRT2), complex(), complex(), complex(INV_SQRT2)]);
    expect(physics.fidelity(state, bell)).toBeCloseTo(1, 12);
    expect(physics.globalPurity(state)).toBeCloseTo(1, 12);
    [0, 1].forEach((qubit) => {
      const inspection = physics.inspectQubit(state, qubit);
      expect(inspection.purity).toBeCloseTo(0.5, 12);
      expect(inspection.entropy).toBeCloseTo(1, 9);
      expect(inspection.entanglement).toEqual({ status: 'entangled', method: 'pure-state-reduction', conclusive: true });
      expect(physics.entanglementEntropy(state, [qubit])).toBeCloseTo(1, 9);
    });
    expect(physics.assessEntanglement(state, [0]).status).toBe('entangled');
    expect(physics.inspectSubsystem(state, [0, 1]).purity).toBeCloseTo(1, 12);
  });

  it('GHZ: (|000⟩+|111⟩)/√2, every single qubit and pair is mixed, the whole is pure', () => {
    const { state } = run(3, [gate('H', [0]), gate('CNOT', [1], [0]), gate('CNOT', [2], [1])]);
    const probabilities = physics.probabilities(state);
    expect(probabilities[0]).toBeCloseTo(0.5, 12);
    expect(probabilities[7]).toBeCloseTo(0.5, 12);
    [[0], [1], [2]].forEach((subsystem) => {
      expect(physics.entanglementEntropy(state, subsystem)).toBeCloseTo(1, 9);
    });
    // A GHZ pair is classically correlated (purity ½), not a Bell pair (which would be pure).
    const pair = physics.inspectSubsystem(state, [0, 1]);
    expect(pair.purity).toBeCloseTo(0.5, 9);
    expect(pair.vonNeumannEntropy).toBeCloseTo(1, 9);
    expect(pair.entanglement.status).toBe('entangled');
    expect(physics.negativity(densityState(pair.densityMatrix), [0])).toBeCloseTo(0, 9);
    const whole = physics.inspectSubsystem(state, [0, 1, 2]);
    expect(whole.purity).toBeCloseTo(1, 12);
    expect(whole.entanglement).toMatchObject({ status: 'separable', conclusive: true });
  });

  it('SWAP moves an arbitrary state between wires without cloning it', () => {
    const prepare = [gate('RY', [0], [], { phase: 1.1 }), gate('RZ', [0], [], { phase: 0.7 })];
    const { state: before } = run(2, prepare);
    const { state: after } = run(2, [...prepare, gate('SWAP', [0, 1])]);
    const original = densityState(physics.reducedState(before, [0]));
    expect(physics.fidelity(densityState(physics.reducedState(after, [1])), original)).toBeCloseTo(1, 9);
    expect(physics.inspectQubit(after, 0).bloch.z).toBeCloseTo(1, 12);
    expect(physics.assessEntanglement(after, [0]).status).toBe('separable');
  });

  it('measurement collapse: measuring |+⟩ leaves the state that matches the recorded bit', () => {
    [0.1, 0.9].forEach((draw) => {
      vi.spyOn(Math, 'random').mockReturnValue(draw);
      const { result, state } = run(1, [gate('H', [0]), gate('MEASURE', [0])]);
      const bit = result.measurements[0];
      expect(bit).toBe(draw < 0.5 ? 1 : 0);
      expect(physics.probabilities(state)[bit]).toBeCloseTo(1, 12);
      vi.restoreAllMocks();
    });
  });

  it('no-cloning: CNOT on |+⟩|0⟩ entangles instead of producing |+⟩|+⟩', () => {
    const { state } = run(2, [gate('H', [0]), gate('CNOT', [1], [0])]);
    const plusPlus = stateVector([complex(0.5), complex(0.5), complex(0.5), complex(0.5)]);
    expect(physics.fidelity(state, plusPlus)).toBeCloseTo(0.5, 12);
    expect(physics.assessEntanglement(state, [1]).status).toBe('entangled');
    expect(physics.measurementDiagnostics(state, 1, 'X').deterministic).toBe(false);

    // Basis states copy fine, which is why CNOT looks like a copier classically.
    const { state: copied } = run(2, [gate('X', [0]), gate('CNOT', [1], [0])]);
    expect(physics.probabilities(copied)[3]).toBeCloseTo(1, 12);
    expect(physics.assessEntanglement(copied, [1]).status).toBe('separable');
  });

  it('teleportation: H, CNOT, MEASURE and classical X/Z feed-forward move an arbitrary state', () => {
    const theta = 0.9;
    const phi = 2.3;
    const target = densityState(physics.reducedState(
      run(1, [gate('RY', [0], [], { phase: theta }), gate('RZ', [0], [], { phase: phi })]).state,
      [0],
    ));
    const when = (qubit: number, equals: 0 | 1): GateCondition => ({ qubit, equals });

    [[0.9, 0.9], [0.9, 0.1], [0.1, 0.9], [0.1, 0.1]].forEach(([first, second]) => {
      const draws = [first, second];
      vi.spyOn(Math, 'random').mockImplementation(() => draws.shift() ?? 0.5);
      const { result, state } = run(3, [
        gate('RY', [0], [], { phase: theta }),
        gate('RZ', [0], [], { phase: phi }),
        gate('H', [1]),
        gate('CNOT', [2], [1]),
        gate('CNOT', [1], [0]),
        gate('H', [0]),
        gate('MEASURE', [0]),
        gate('MEASURE', [1]),
        gate('X', [2], [], { condition: when(1, 1) }),
        gate('Z', [2], [], { condition: when(0, 1) }),
      ]);
      vi.restoreAllMocks();
      const received = densityState(physics.reducedState(state, [2]));
      expect(physics.fidelity(received, target)).toBeCloseTo(1, 9);
      expect(physics.assessEntanglement(state, [2]).status).toBe('separable');
      expect(result.measurements[0]).toBe(first < 0.5 ? 1 : 0);
    });
  });
});
