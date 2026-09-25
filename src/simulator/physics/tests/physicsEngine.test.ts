import { describe, expect, it } from 'vitest';
import { complex, type Complex } from '../../complex';
import { createInitialState, runCircuit } from '../../engine';
import { MATRIX_H, MATRIX_S, MATRIX_X, MATRIX_Z } from '../../gates/matrices';
import { applyControlledX, applySwap } from '../../gates/operations';
import { snapshotParticle } from '../particleTracking';
import { physics } from '../PhysicsEngine';
import { hermitianEigenvalues, hermitianFunction, isUnitary, kron, matMul } from '../numerics/linearAlgebra';
import { densityState, stateVector } from '../state/QuantumState';

const INV_SQRT2 = 1 / Math.sqrt(2);
const plus = () => stateVector([complex(INV_SQRT2), complex(INV_SQRT2)]);
const plusI = () => stateVector([complex(INV_SQRT2), complex(0, INV_SQRT2)]);
const bell = () => stateVector([complex(INV_SQRT2), complex(), complex(), complex(INV_SQRT2)]);

const expectComplexClose = (actual: Complex, expected: Complex, digits = 9) => {
  expect(actual.re).toBeCloseTo(expected.re, digits);
  expect(actual.im).toBeCloseTo(expected.im, digits);
};

describe('PhysicsEngine state creation and evolution', () => {
  it('creates |0…0⟩ registers in either representation', () => {
    const vector = physics.createState(2);
    expect(vector.kind).toBe('stateVector');
    expect(physics.probabilities(vector)).toEqual([1, 0, 0, 0]);
    const density = physics.createState(2, 'densityMatrix');
    expect(density.kind).toBe('densityMatrix');
    expect(physics.probabilities(density)).toEqual([1, 0, 0, 0]);
  });

  it('prepares 1p and sp start states and matches createInitialState', () => {
    let state = physics.createState(2);
    state = physics.prepare(state, 0, '1p');
    state = physics.prepare(state, 1, 'sp');
    const legacy = createInitialState(2, ['1p', 'sp']);
    expect(state.kind === 'stateVector' && state.amplitudes).toEqual(legacy);
  });

  it('expands registers by appending |0⟩ wires in both representations', () => {
    const expanded = physics.expandRegister(plus(), 2);
    expect(expanded.qubitCount).toBe(2);
    expect(physics.probabilities(expanded).map((p) => Number(p.toFixed(12)))).toEqual([0.5, 0, 0.5, 0]);
    const expandedDensity = physics.expandRegister(physics.toDensityMatrix(plus()), 2);
    expect(physics.probabilities(expandedDensity).map((p) => Number(p.toFixed(12)))).toEqual([0.5, 0, 0.5, 0]);
  });

  it('applies multi-qubit unitaries identically to the gate fast paths', () => {
    const cnot = [
      [complex(1), complex(), complex(), complex()],
      [complex(), complex(1), complex(), complex()],
      [complex(), complex(), complex(), complex(1)],
      [complex(), complex(), complex(1), complex()],
    ];
    const start = runCircuit(3, [
      { id: 'a', type: 'RY', step: 0, targets: [0], controls: [], phase: 0.4 },
      { id: 'b', type: 'RX', step: 1, targets: [2], controls: [], phase: 1.3 },
    ]).state;
    // targets [2, 0]: q2 is the control bit of this 4×4 CNOT, q0 the target.
    const viaMatrix = physics.applyUnitary(stateVector(start, 3), [2, 0], cnot);
    const viaFastPath = applyControlledX(start, 3, [2], 0);
    viaFastPath.forEach((amplitude, index) => {
      expectComplexClose((viaMatrix as { amplitudes: Complex[] }).amplitudes[index], amplitude, 12);
    });
    const swapMatrix = [cnot[0], cnot[2], cnot[1], cnot[3]].map((row) => [...row]);
    swapMatrix[2] = [complex(), complex(1), complex(), complex()];
    swapMatrix[1] = [complex(), complex(), complex(1), complex()];
    swapMatrix[3] = [complex(), complex(), complex(), complex(1)];
    const viaSwap = physics.applyUnitary(stateVector(start, 3), [0, 2], swapMatrix);
    applySwap(start, 3, 0, 2).forEach((amplitude, index) => {
      expectComplexClose((viaSwap as { amplitudes: Complex[] }).amplitudes[index], amplitude, 12);
    });
  });

  it('applies controlled unitaries only where every control is |1⟩', () => {
    const state = physics.applyControlledUnitary(physics.createState(2), [0], [1], MATRIX_X);
    expect(physics.probabilities(state)[0]).toBe(1);
    const flipped = physics.applyControlledUnitary(physics.prepare(physics.createState(2), 0, '1p'), [0], [1], MATRIX_X);
    expect(physics.probabilities(flipped)[3]).toBe(1);
  });

  it('keeps density-matrix evolution consistent with state-vector evolution', () => {
    const vector = physics.applyControlledUnitary(physics.applyUnitary(physics.createState(2), [0], MATRIX_H), [0], [1], MATRIX_X);
    const density = physics.applyControlledUnitary(
      physics.applyUnitary(physics.createState(2, 'densityMatrix'), [0], MATRIX_H),
      [0],
      [1],
      MATRIX_X,
    );
    expect(physics.fidelity(density, vector)).toBeCloseTo(1, 12);
    expect(physics.entanglementEntropy(density, [0])).toBeCloseTo(1, 9);
  });
});

describe('PhysicsEngine measurement bases', () => {
  it('|+⟩ is random in Z but definite in X', () => {
    expect(physics.measurementDiagnostics(plus(), 0, 'Z').probabilities[1]).toBeCloseTo(0.5, 12);
    const x = physics.measurementDiagnostics(plus(), 0, 'X');
    expect(x.deterministic).toBe(true);
    expect(x.expectation).toBeCloseTo(1, 12);
    const measured = physics.measure(plus(), 0, 'X', 0.999);
    expect(measured.outcome).toBe(0);
    expect(measured.probability).toBeCloseTo(1, 12);
    expect(physics.fidelity(measured.state, plus())).toBeCloseTo(1, 12);
  });

  it('|+i⟩ is definite in Y, and a Y measurement leaves the observed eigenstate', () => {
    expect(physics.measurementDiagnostics(plusI(), 0, 'Y').expectation).toBeCloseTo(1, 12);
    const measured = physics.measure(plus(), 0, 'Y', 0.1);
    expect(measured.outcome).toBe(1);
    expect(measured.probability).toBeCloseTo(0.5, 12);
    expect(physics.measurementDiagnostics(measured.state, 0, 'Y').expectation).toBeCloseTo(-1, 12);
  });

  it('Z measurement matches the legacy collapse exactly', () => {
    const state = runCircuit(2, [{ id: 'h', type: 'H', step: 0, targets: [0], controls: [] }]).state;
    const measured = physics.measure(stateVector(state, 2), 0, 'Z', 0.25);
    expect(measured.outcome).toBe(1);
    expect(measured.probabilityOne).toBeCloseTo(0.5, 12);
    expect(physics.probabilities(measured.state)[2]).toBeCloseTo(1, 12);
  });

  it('measures density matrices and renormalizes the kept branch', () => {
    const rho = physics.toDensityMatrix(bell());
    const measured = physics.measure(rho, 0, 'Z', 0.9);
    expect(measured.outcome).toBe(0);
    expect(physics.probabilities(measured.state)[0]).toBeCloseTo(1, 12);
    expect(physics.inspectGlobal(measured.state).normalization).toBeCloseTo(1, 12);
  });

  it('MEASURE gates honor an explicit basis and default to Z', () => {
    const gates = [
      { id: 'h', type: 'H', step: 0, targets: [0], controls: [] },
      { id: 'm', type: 'MEASURE', step: 1, targets: [0], controls: [], basis: 'X' as const },
    ];
    const result = runCircuit(1, gates);
    expect(result.measurements[0]).toBe(0);
    expect(result.log.at(-1)).toContain('in X basis');
  });
});

describe('PhysicsEngine reduced states and diagnostics', () => {
  it('reduces Bell pairs to I/2 and keeps the joint state pure', () => {
    const rho = physics.reducedState(bell(), [0]);
    expectComplexClose(rho[0][0], complex(0.5));
    expectComplexClose(rho[0][1], complex());
    expect(physics.purity(rho)).toBeCloseTo(0.5, 12);
    expect(physics.linearEntropy(rho)).toBeCloseTo(0.5, 12);
    expect(physics.vonNeumannEntropy(rho)).toBeCloseTo(1, 12);
    const joint = physics.reducedState(bell(), [0, 1]);
    expect(physics.purity(joint)).toBeCloseTo(1, 12);
  });

  it('orders reduced subsystems by the requested qubit order', () => {
    // |01⟩: reducing onto [1, 0] must read as |10⟩.
    const state = physics.prepare(physics.createState(2), 1, '1p');
    const swapped = physics.reducedState(state, [1, 0]);
    expect(swapped[2][2].re).toBeCloseTo(1, 12);
    const traced = physics.reducedState(physics.toDensityMatrix(state), [1, 0]);
    expect(traced[2][2].re).toBeCloseTo(1, 12);
  });

  it('partial trace of a density matrix matches the pure-state reduction', () => {
    const state = runCircuit(3, [
      { id: 'a', type: 'H', step: 0, targets: [0], controls: [] },
      { id: 'b', type: 'CNOT', step: 1, targets: [2], controls: [0] },
      { id: 'c', type: 'RY', step: 2, targets: [1], controls: [], phase: 0.8 },
      { id: 'd', type: 'CNOT', step: 3, targets: [2], controls: [1] },
    ]).state;
    const vector = stateVector(state, 3);
    const density = physics.toDensityMatrix(vector);
    [[0], [2, 0], [1, 2]].forEach((subsystem) => {
      const a = physics.reducedState(vector, subsystem);
      const b = physics.reducedState(density, subsystem);
      a.forEach((row, i) => row.forEach((value, j) => expectComplexClose(value, b[i][j], 12)));
    });
  });

  it('reports Bloch y = +1 for S|+⟩ = |+i⟩', () => {
    const state = physics.applyUnitary(plus(), [0], MATRIX_S);
    const bloch = physics.blochVector(state, 0);
    expect(bloch.x).toBeCloseTo(0, 12);
    expect(bloch.y).toBeCloseTo(1, 12);
    const snapshot = snapshotParticle((state as { amplitudes: Complex[] }).amplitudes, 1, 0);
    expect(snapshot.spherical.phi).toBeCloseTo(Math.PI / 2, 12);
    expect(snapshot.ket.beta.im).toBeCloseTo(INV_SQRT2, 12);
  });

  it('separates mixed-but-unentangled from entangled mixed states with the PPT test', () => {
    const classical = densityState([
      [complex(0.5), complex(), complex(), complex()],
      [complex(), complex(), complex(), complex()],
      [complex(), complex(), complex(), complex()],
      [complex(), complex(), complex(), complex(0.5)],
    ]);
    expect(physics.inspectQubit(classical, 0).entangledWithRest).toBeUndefined();
    expect(physics.isEntangled(classical, [0])).toBe(false);
    expect(() => physics.entanglementEntropy(classical, [0])).toThrow(RangeError);
    const bellRho = physics.toDensityMatrix(bell());
    expect(physics.negativity(bellRho, [0])).toBeCloseTo(0.5, 9);
    expect(physics.isEntangled(bellRho, [0])).toBe(true);
  });

  it('computes fidelity across representations', () => {
    const zero = physics.createState(1);
    expect(physics.fidelity(plus(), zero)).toBeCloseTo(0.5, 12);
    const maximallyMixed = densityState([[complex(0.5), complex()], [complex(), complex(0.5)]]);
    expect(physics.fidelity(zero, maximallyMixed)).toBeCloseTo(0.5, 12);
    expect(physics.fidelity(maximallyMixed, maximallyMixed)).toBeCloseTo(1, 9);
    expect(physics.fidelity(physics.toDensityMatrix(plus()), physics.toDensityMatrix(zero))).toBeCloseTo(0.5, 9);
  });
});

describe('PhysicsEngine interference and phase', () => {
  it('shows +½ + +½ into |0⟩ and +½ − ½ into |1⟩ for the second H', () => {
    const analysis = physics.analyzeInterference(plus(), { targets: [0], matrix: MATRIX_H });
    const [zero, one] = analysis.terms;
    expect(zero.contributions.map((c) => Number(c.amplitude.re.toFixed(6)))).toEqual([0.5, 0.5]);
    expect(zero.kind).toBe('constructive');
    expect(zero.probability).toBeCloseTo(1, 12);
    expect(one.contributions.map((c) => Number(c.amplitude.re.toFixed(6)))).toEqual([0.5, -0.5]);
    expect(one.kind).toBe('destructive');
    expect(one.probability).toBeCloseTo(0, 12);
    expect(analysis.interferes).toBe(true);
  });

  it('reports no interference when only one path feeds each output', () => {
    const analysis = physics.analyzeInterference(physics.createState(1), { targets: [0], matrix: MATRIX_H });
    expect(analysis.interferes).toBe(false);
  });

  it('distinguishes global phase, relative phase, and population differences', () => {
    const minus = stateVector([complex(INV_SQRT2), complex(-INV_SQRT2)]);
    const globalShift = stateVector([complex(0, INV_SQRT2), complex(0, INV_SQRT2)]);
    expect(physics.comparePhase(plus(), plus()).relation).toBe('identical');
    const global = physics.comparePhase(plus(), globalShift);
    expect(global.relation).toBe('global-phase');
    expect(global.globalPhase).toBeCloseTo(Math.PI / 2, 12);
    expect(global.observablyDifferent).toBe(false);
    expect(physics.comparePhase(plus(), minus).relation).toBe('relative-phase');
    expect(physics.comparePhase(plus(), physics.createState(1)).relation).toBe('different-populations');
    expect(physics.relativePhases(minus).map((entry) => entry.phase)).toEqual([0, Math.PI]);
    // Z turns |+⟩ into |−⟩: same Z populations, opposite X outcome.
    const zPlus = physics.applyUnitary(plus(), [0], MATRIX_Z);
    expect(physics.measurementDiagnostics(zPlus, 0, 'X').expectation).toBeCloseTo(-1, 12);
  });
});

describe('numerics', () => {
  it('diagonalizes Hermitian matrices with complex entries', () => {
    const pauliY = [[complex(), complex(0, -1)], [complex(0, 1), complex()]];
    expect(hermitianEigenvalues(pauliY).map((v) => Number(v.toFixed(9)))).toEqual([-1, 1]);
    const degenerate = kron(pauliY, pauliY);
    expect(hermitianEigenvalues(degenerate).map((v) => Number(v.toFixed(9)))).toEqual([-1, -1, 1, 1]);
  });

  it('squares back from a matrix square root', () => {
    const rho = physics.toDensityMatrix(stateVector([complex(0.6), complex(0, 0.8)])).rho;
    const mixed = rho.map((row, i) => row.map((value, j) => complex(0.7 * value.re + (i === j ? 0.15 : 0), 0.7 * value.im)));
    const root = hermitianFunction(mixed, Math.sqrt);
    matMul(root, root).forEach((row, i) => row.forEach((value, j) => expectComplexClose(value, mixed[i][j], 9)));
  });
});

describe('Hamiltonian evolution', () => {
  it('H = (ω/2)X for t = π/ω reproduces X up to global phase', () => {
    const omega = 2;
    const hamiltonian = { matrix: MATRIX_X.map((row) => row.map((value) => complex(value.re * omega / 2, 0))), targets: [0] };
    const evolved = physics.evolve(physics.createState(1), hamiltonian, Math.PI / omega);
    expect(physics.comparePhase(evolved, stateVector([complex(), complex(1)])).observablyDifferent).toBe(false);
    const half = physics.evolve(physics.createState(1), hamiltonian, Math.PI / (2 * omega));
    expect(physics.probabilities(half)[1]).toBeCloseTo(0.5, 9);
  });

  it('produces unitary propagators and rejects non-Hermitian generators', () => {
    const zz = kron(MATRIX_Z, MATRIX_Z);
    const evolved = physics.evolve(physics.applyUnitary(physics.createState(2), [0], MATRIX_H), { matrix: zz, targets: [0, 1] }, 0.3);
    expect(physics.inspectGlobal(evolved).normalization).toBeCloseTo(1, 12);
    expect(isUnitary(kron(MATRIX_H, MATRIX_H))).toBe(true);
    expect(() => physics.evolve(physics.createState(1), { matrix: [[complex(), complex(1)], [complex(), complex()]], targets: [0] }, 1))
      .toThrow(RangeError);
  });
});

describe('RESET through the Physics Engine', () => {
  it('matches the density-matrix reset channel on average', () => {
    const bellVector = bell();
    const branches = [0.2, 0.8].map((draw) => physics.reset(bellVector, 0, () => draw));
    const averaged = densityState(
      physics.toDensityMatrix(branches[0]).rho.map((row, i) => row.map((value, j) => {
        const other = physics.toDensityMatrix(branches[1]).rho[i][j];
        return complex((value.re + other.re) / 2, (value.im + other.im) / 2);
      })),
    );
    const channel = physics.reset(physics.toDensityMatrix(bellVector), 0);
    expect(physics.fidelity(averaged, channel)).toBeCloseTo(1, 9);
    expect(physics.inspectQubit(channel, 0).probabilities.zero).toBeCloseTo(1, 12);
    expect(physics.isEntangled(channel, [0])).toBe(false);
  });

  it('consumes no randomness when the wire is already definite', () => {
    let draws = 0;
    const random = () => {
      draws += 1;
      return 0.5;
    };
    physics.reset(physics.prepare(physics.createState(2), 0, '1p'), 0, random);
    physics.reset(physics.createState(2), 1, random);
    expect(draws).toBe(0);
  });

  it('runs compiled RESET gates through physics.reset', () => {
    const result = runCircuit(2, [
      { id: 'x', type: 'X', step: 0, targets: [0], controls: [] },
      { id: 'r', type: 'RESET', step: 1, targets: [0], controls: [] },
    ]);
    expect(physics.probabilities(stateVector(result.state, 2))[0]).toBeCloseTo(1, 12);
  });
});

describe('gate operators go through the Physics Engine', () => {
  it('builds classical logic as permutation operators', async () => {
    const { predicateXOperator, anyControlIsActive } = await import('../../gates/operations');
    const or = predicateXOperator(3, [0, 1], 2, anyControlIsActive);
    expect(or.targets).toEqual([0, 1, 2]);
    expect(isUnitary(or.matrix)).toBe(true);
    // |000⟩ stays, |010⟩ → |011⟩.
    expect(or.matrix[0][0].re).toBe(1);
    expect(or.matrix[3][2].re).toBe(1);
  });

  it('keeps legacy semantics when a target is also listed as a control', () => {
    const state = [complex(), complex(1), complex(), complex()];
    expect(applyControlledX(state, 2, [1], 1)).toEqual(state);
  });
});
