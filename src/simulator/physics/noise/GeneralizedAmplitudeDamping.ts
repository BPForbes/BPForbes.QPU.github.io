import { complex, ZERO } from '../../complex';
import { assertProbability, type NoiseChannel } from './NoiseModel';

/**
 * Relaxation toward a thermal state: with probability γ the qubit exchanges
 * energy with a bath whose excited population is p (Boltzmann, from f₀₁ and T).
 * p = 0 is ordinary amplitude damping; the fixed point has P(|1⟩) = p.
 */
export const generalizedAmplitudeDamping = (gamma: number, excitedPopulation: number): NoiseChannel => {
  assertProbability('Generalized amplitude-damping γ', gamma);
  assertProbability('Thermal excited population', excitedPopulation);
  const ground = Math.sqrt(1 - excitedPopulation);
  const excited = Math.sqrt(excitedPopulation);
  const keep = Math.sqrt(1 - gamma);
  const jump = Math.sqrt(gamma);
  return {
    name: 'generalizedAmplitudeDamping',
    parameter: gamma,
    kraus: [
      [[complex(ground), ZERO], [ZERO, complex(ground * keep)]],
      [[ZERO, complex(ground * jump)], [ZERO, ZERO]],
      [[complex(excited * keep), ZERO], [ZERO, complex(excited)]],
      [[ZERO, ZERO], [complex(excited * jump), ZERO]],
    ],
  };
};
