/**
 * Single-qubit measurement bases. Outcome 0 is the +1 eigenstate of the
 * observable (|0⟩, |+⟩, |+i⟩) and outcome 1 the -1 eigenstate (|1⟩, |−⟩, |−i⟩).
 *
 * Non-Z measurements rotate the eigenbasis onto Z, measure, and rotate back so
 * the post-measurement state is the observed eigenstate.
 */
import { complex, ONE, ZERO } from '../../complex';
import { MATRIX_H } from '../../gates/matrices';
import { type ComplexMatrix, matMul } from '../numerics/linearAlgebra';

export type MeasurementBasis = 'X' | 'Y' | 'Z';

export const MEASUREMENT_BASES: readonly MeasurementBasis[] = ['Z', 'X', 'Y'];

export const isMeasurementBasis = (value: unknown): value is MeasurementBasis =>
  value === 'X' || value === 'Y' || value === 'Z';

const S_DAGGER: ComplexMatrix = [[ONE, ZERO], [ZERO, complex(0, -1)]];
const S: ComplexMatrix = [[ONE, ZERO], [ZERO, complex(0, 1)]];

/** Unitaries mapping the basis eigenstates onto |0⟩/|1⟩ and back; undefined for Z. */
export const basisRotation = (basis: MeasurementBasis): { toZ: ComplexMatrix; fromZ: ComplexMatrix } | undefined => {
  if (basis === 'X') return { toZ: MATRIX_H, fromZ: MATRIX_H };
  if (basis === 'Y') return { toZ: matMul(MATRIX_H, S_DAGGER), fromZ: matMul(S, MATRIX_H) };
  return undefined;
};

export const basisStateLabel = (basis: MeasurementBasis, outcome: 0 | 1): string => {
  if (basis === 'X') return outcome === 0 ? '|+⟩' : '|−⟩';
  if (basis === 'Y') return outcome === 0 ? '|+i⟩' : '|−i⟩';
  return outcome === 0 ? '|0⟩' : '|1⟩';
};
