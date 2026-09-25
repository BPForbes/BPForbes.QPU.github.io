import { complex, ONE, ZERO } from '../../complex';
import { assertProbability, type NoiseChannel } from './NoiseModel';

/**
 * Phase damping: off-diagonal coherences shrink by √(1 − λ) while
 * computational-basis populations are unchanged.
 */
export const phaseDamping = (lambda: number): NoiseChannel => {
  assertProbability('Phase-damping λ', lambda);
  return {
    name: 'phaseDamping',
    parameter: lambda,
    kraus: [
      [[ONE, ZERO], [ZERO, complex(Math.sqrt(1 - lambda), 0)]],
      [[ZERO, ZERO], [ZERO, complex(Math.sqrt(lambda), 0)]],
    ],
  };
};
