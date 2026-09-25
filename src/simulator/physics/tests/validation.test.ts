import { afterEach, describe, expect, it } from 'vitest';
import { complex } from '../../complex';
import { MATRIX_H, MATRIX_X } from '../../gates/matrices';
import { physics } from '../PhysicsEngine';
import { densityState, stateVector } from '../state/QuantumState';
import { PhysicsValidationError } from '../validation/Validation';

const INV_SQRT2 = 1 / Math.sqrt(2);

afterEach(() => physics.setValidation(true));

describe('PhysicsEngine boundary validation', () => {
  it('is on by default in development and tests', () => {
    expect(physics.validating).toBe(true);
  });

  it('rejects unnormalized state vectors and wrong dimensions', () => {
    expect(() => physics.probabilities(stateVector([complex(1), complex(1)]))).toThrow(/not normalized/);
    expect(() => physics.probabilities(stateVector([complex(1), complex(), complex()], 2))).toThrow(/amplitudes/);
    expect(() => physics.probabilities(stateVector([complex(1), complex(1)]))).toThrow(PhysicsValidationError);
  });

  it('rejects density matrices that are not Hermitian, trace 1, or positive', () => {
    const notHermitian = densityState([[complex(0.5), complex(0.2)], [complex(0.1), complex(0.5)]]);
    expect(() => physics.probabilities(notHermitian)).toThrow(/Hermitian/);
    const badTrace = densityState([[complex(0.7), complex()], [complex(), complex(0.7)]]);
    expect(() => physics.probabilities(badTrace)).toThrow(/trace/);
    // Trace 1 and Hermitian, but eigenvalues 1.2 and −0.2.
    const notPositive = densityState([[complex(0.5), complex(0.7)], [complex(0.7), complex(0.5)]]);
    expect(() => physics.probabilities(notPositive)).toThrow(/positive semidefinite/);
  });

  it('rejects non-unitary operators and shape mismatches', () => {
    const state = physics.createState(2);
    const notUnitary = [[complex(1), complex(1)], [complex(0), complex(1)]];
    expect(() => physics.applyUnitary(state, [0], notUnitary)).toThrow(/not unitary/);
    expect(() => physics.applyUnitary(state, [0, 1], MATRIX_H)).toThrow(/4×4/);
  });

  it('rejects invalid and duplicate qubit indices', () => {
    const state = physics.createState(2);
    expect(() => physics.applyUnitary(state, [2], MATRIX_X)).toThrow(/Invalid/);
    expect(() => physics.applyControlledUnitary(state, [0], [0], MATRIX_X)).toThrow(/Duplicate/);
    expect(() => physics.measure(state, -1)).toThrow(/Invalid/);
    expect(() => physics.reducedState(state, [0, 0])).toThrow(/Duplicate/);
    expect(() => physics.marginalProbabilities(state, [1.5])).toThrow(/Invalid/);
  });

  it('rejects channels that are not trace preserving', () => {
    const leaky = { name: 'leaky', parameter: 0.5, kraus: [[[complex(0.5), complex()], [complex(), complex(0.5)]]] };
    expect(() => physics.applyChannel(physics.createState(1), leaky, [0])).toThrow(/not trace preserving/);
    expect(() => physics.validateChannel(physics.channels.depolarizing(0.3))).not.toThrow();
  });

  it('validates bare density matrices passed to diagnostics', () => {
    expect(() => physics.purity([[complex(2), complex()], [complex(), complex()]])).toThrow(/trace/);
  });

  it('lets gate kernels run on unnormalized density-matrix columns inside the engine', () => {
    const bell = physics.toDensityMatrix(stateVector([complex(INV_SQRT2), complex(), complex(), complex(INV_SQRT2)]));
    const flipped = physics.applyLinearKernel(bell, (column) =>
      physics.applyUnitary(physics.fromAmplitudes(column, 2), [0], MATRIX_X).amplitudes);
    expect(physics.probabilities(flipped)[1]).toBeCloseTo(0.5, 12);
  });

  it('explicit validation always runs, and automatic validation can be turned off', () => {
    physics.setValidation(false);
    expect(() => physics.probabilities(stateVector([complex(1), complex(1)]))).not.toThrow();
    expect(() => physics.validateState(stateVector([complex(1), complex(1)]))).toThrow(/not normalized/);
    expect(() => physics.validateUnitary([[complex(2)]])).toThrow(/not unitary/);
  });
});
