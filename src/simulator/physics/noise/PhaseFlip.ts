import { ONE, ZERO } from '../../complex';
import { MATRIX_Z } from '../../gates/matrices';
import { assertProbability, type NoiseChannel, scaledMatrix } from './NoiseModel';

const IDENTITY = [[ONE, ZERO], [ZERO, ONE]] as const;

/** ρ' = (1 − p)ρ + p ZρZ */
export const phaseFlip = (p: number): NoiseChannel => {
  assertProbability('Phase-flip probability', p);
  return { name: 'phaseFlip', parameter: p, kraus: [scaledMatrix(IDENTITY, Math.sqrt(1 - p)), scaledMatrix(MATRIX_Z, Math.sqrt(p))] };
};
