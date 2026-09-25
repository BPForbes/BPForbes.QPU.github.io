import { ONE, ZERO } from '../../complex';
import { MATRIX_X } from '../../gates/matrices';
import { assertProbability, type NoiseChannel, scaledMatrix } from './NoiseModel';

const IDENTITY = [[ONE, ZERO], [ZERO, ONE]] as const;

/** ρ' = (1 − p)ρ + p XρX */
export const bitFlip = (p: number): NoiseChannel => {
  assertProbability('Bit-flip probability', p);
  return { name: 'bitFlip', parameter: p, kraus: [scaledMatrix(IDENTITY, Math.sqrt(1 - p)), scaledMatrix(MATRIX_X, Math.sqrt(p))] };
};
