import { ONE, ZERO } from '../../complex';
import { MATRIX_X, MATRIX_Y, MATRIX_Z } from '../../gates/matrices';
import { assertProbability, type NoiseChannel, scaledMatrix } from './NoiseModel';

const IDENTITY = [[ONE, ZERO], [ZERO, ONE]] as const;

/**
 * ρ' = (1 − p)ρ + p I/2: with probability p the qubit is replaced by the
 * maximally mixed state (Bloch vector shrinks by 1 − p).
 */
export const depolarizing = (p: number): NoiseChannel => {
  assertProbability('Depolarizing probability', p);
  const pauliWeight = Math.sqrt(p / 4);
  return {
    name: 'depolarizing',
    parameter: p,
    kraus: [
      scaledMatrix(IDENTITY, Math.sqrt(1 - (3 * p) / 4)),
      scaledMatrix(MATRIX_X, pauliWeight),
      scaledMatrix(MATRIX_Y, pauliWeight),
      scaledMatrix(MATRIX_Z, pauliWeight),
    ],
  };
};
