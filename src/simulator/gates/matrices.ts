/**
 * Standard single-qubit matrices used by preconfigured quantum gates.
 *
 * Matrix definitions are isolated from application code so gate behavior can be
 * reviewed against conventional quantum-computing notation. Reference:
 * https://en.wikipedia.org/wiki/Quantum_logic_gate
 */
import { complex, ONE, ZERO } from '../complex';

const INV_SQRT2 = 1 / Math.sqrt(2);

// Standard single-qubit matrices: Pauli-X/Y/Z and Hadamard.
export const MATRIX_X = [[ZERO, ONE], [ONE, ZERO]] as const;
export const MATRIX_Y = [[ZERO, complex(0, -1)], [complex(0, 1), ZERO]] as const;
export const MATRIX_Z = [[ONE, ZERO], [ZERO, complex(-1, 0)]] as const;
export const MATRIX_H = [
  [complex(INV_SQRT2), complex(INV_SQRT2)],
  [complex(INV_SQRT2), complex(-INV_SQRT2)],
] as const;

// Phase-family matrices apply fixed or arbitrary rotations to the |1⟩ component.
export const MATRIX_S = [[ONE, ZERO], [ZERO, complex(0, 1)]] as const;
export const MATRIX_T = [[ONE, ZERO], [ZERO, complex(INV_SQRT2, INV_SQRT2)]] as const;
export const phaseMatrix = (angle: number) => [[ONE, ZERO], [ZERO, complex(Math.cos(angle), Math.sin(angle))]];

export const rotationXMatrix = (theta: number) => [
  [complex(Math.cos(theta / 2), 0), complex(0, -Math.sin(theta / 2))],
  [complex(0, -Math.sin(theta / 2)), complex(Math.cos(theta / 2), 0)],
];

export const rotationYMatrix = (theta: number) => [
  [complex(Math.cos(theta / 2), 0), complex(-Math.sin(theta / 2), 0)],
  [complex(Math.sin(theta / 2), 0), complex(Math.cos(theta / 2), 0)],
];

export const rotationZMatrix = (theta: number) => [
  [complex(Math.cos(-theta / 2), Math.sin(-theta / 2)), ZERO],
  [ZERO, complex(Math.cos(theta / 2), Math.sin(theta / 2))],
];

export const PHASE_PI = Math.PI;
export const PHASE_PI_2 = Math.PI / 2;
export const PHASE_PI_4 = Math.PI / 4;

export const MATRIX_SWAP = [
  [ONE, ZERO, ZERO, ZERO],
  [ZERO, ZERO, ONE, ZERO],
  [ZERO, ONE, ZERO, ZERO],
  [ZERO, ZERO, ZERO, ONE],
] as const;

/** Unitary sending basis column c to row permutation[c]. */
export const permutationMatrix = (permutation: readonly number[]) =>
  permutation.map((_, row) => permutation.map((image) => (image === row ? ONE : ZERO)));
