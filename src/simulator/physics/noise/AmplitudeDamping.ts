import { complex, ONE, ZERO } from '../../complex';
import { assertProbability, type NoiseChannel } from './NoiseModel';

/** Energy relaxation |1⟩ → |0⟩ with probability γ. */
export const amplitudeDamping = (gamma: number): NoiseChannel => {
  assertProbability('Amplitude-damping γ', gamma);
  return {
    name: 'amplitudeDamping',
    parameter: gamma,
    kraus: [
      [[ONE, ZERO], [ZERO, complex(Math.sqrt(1 - gamma), 0)]],
      [[ZERO, complex(Math.sqrt(gamma), 0)], [ZERO, ZERO]],
    ],
  };
};
