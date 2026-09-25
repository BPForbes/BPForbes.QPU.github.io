/**
 * Quantum-state representations owned by the Physics Engine.
 *
 * Pure circuits keep the O(2^n) state vector. A density matrix (O(4^n)) is only
 * instantiated when open-system physics (noise, decoherence) or mixed inputs
 * require it; the engine never silently upgrades an ideal run.
 */
import type { Complex } from '../../complex';

/** Row-major square density matrix ρ. */
export type DensityMatrix = Complex[][];

export type StateVectorState = {
  kind: 'stateVector';
  qubitCount: number;
  amplitudes: Complex[];
};

export type DensityMatrixState = {
  kind: 'densityMatrix';
  qubitCount: number;
  rho: DensityMatrix;
};

export type QuantumState = StateVectorState | DensityMatrixState;

/** Density matrices past this width cost 4^n complex entries and are refused rather than risk freezing the tab. */
export const MAX_DENSITY_QUBITS = 10;

export const qubitCountForDimension = (dimension: number): number => {
  const width = Math.round(Math.log2(dimension));
  if (!Number.isFinite(width) || 2 ** width !== dimension) {
    throw new RangeError(`State dimension ${dimension} is not a power of two.`);
  }
  return width;
};

/** Wraps an existing amplitude array without copying it. */
export const stateVector = (amplitudes: Complex[], qubitCount = qubitCountForDimension(amplitudes.length)): StateVectorState => ({
  kind: 'stateVector',
  qubitCount,
  amplitudes,
});

/** Wraps an existing density matrix without copying it. */
export const densityState = (rho: DensityMatrix, qubitCount = qubitCountForDimension(rho.length)): DensityMatrixState => ({
  kind: 'densityMatrix',
  qubitCount,
  rho,
});

export const assertDensityWidth = (qubitCount: number) => {
  if (qubitCount > MAX_DENSITY_QUBITS) {
    throw new RangeError(
      `Density-matrix simulation is limited to ${MAX_DENSITY_QUBITS} qubits (requested ${qubitCount}); it needs 4^n entries.`,
    );
  }
};
