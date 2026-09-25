/**
 * Mixed-state (density-matrix) kernels: ρ = |ψ⟩⟨ψ| conversion, unitary
 * evolution UρU†, Kraus channels Σ KρK†, and register expansion.
 *
 * Every map is built from the linear state-vector kernels applied to columns,
 * so the two backends share one definition of how an operator touches a wire.
 */
import { type Complex, ZERO } from '../../complex';
import { conj, type ComplexMatrix, outerProduct } from '../numerics/linearAlgebra';
import { assertDensityWidth, type DensityMatrix } from './QuantumState';
import { applyMultiQubitUnitary, applySingleQubitGate } from './StateVector';

export const densityFromStateVector = (amplitudes: readonly Complex[]): DensityMatrix => {
  assertDensityWidth(Math.round(Math.log2(amplitudes.length)));
  return outerProduct(amplitudes);
};

const conjugateTranspose = (matrix: DensityMatrix): DensityMatrix =>
  matrix.map((_, row) => matrix.map((column) => conj(column[row])));

const mapColumns = (matrix: DensityMatrix, linearMap: (column: Complex[]) => Complex[]): DensityMatrix => {
  const size = matrix.length;
  const out = Array.from({ length: size }, () => new Array<Complex>(size));
  for (let col = 0; col < size; col += 1) {
    const mapped = linearMap(matrix.map((row) => row[col]));
    for (let row = 0; row < size; row += 1) out[row][col] = mapped[row];
  }
  return out;
};

/**
 * ρ → A ρ A† for any linear map A given as a state-vector kernel.
 * A ρ A† = (A (A ρ)†)†, so the kernel only ever sees column vectors.
 */
export const conjugateByLinearMap = (rho: DensityMatrix, linearMap: (column: Complex[]) => Complex[]): DensityMatrix =>
  conjugateTranspose(mapColumns(conjugateTranspose(mapColumns(rho, linearMap)), linearMap));

export const applyUnitaryToDensity = (
  rho: DensityMatrix,
  qubitCount: number,
  targets: number[],
  matrix: ComplexMatrix,
  controls: number[] = [],
): DensityMatrix =>
  conjugateByLinearMap(rho, (column) => applyMultiQubitUnitary(column, qubitCount, targets, matrix, controls));

/** Completely positive map ρ → Σ_k K_k ρ K_k† for single-qubit Kraus operators on `qubit`. */
export const applySingleQubitKraus = (
  rho: DensityMatrix,
  qubitCount: number,
  qubit: number,
  kraus: readonly ComplexMatrix[],
): DensityMatrix => {
  const size = rho.length;
  const out = Array.from({ length: size }, () => Array.from({ length: size }, () => ZERO));
  kraus.forEach((operator) => {
    const term = conjugateByLinearMap(rho, (column) => applySingleQubitGate(column, qubitCount, qubit, operator));
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const value = term[row][col];
        out[row][col] = { re: out[row][col].re + value.re, im: out[row][col].im + value.im };
      }
    }
  });
  return out;
};

/** ρ ⊗ |0…0⟩⟨0…0| on newly appended wires. */
export const padDensityMatrix = (rho: DensityMatrix, fromCount: number, toCount: number): DensityMatrix => {
  if (toCount <= fromCount) return rho;
  assertDensityWidth(toCount);
  const shift = toCount - fromCount;
  const size = 2 ** toCount;
  const out = Array.from({ length: size }, () => Array.from({ length: size }, () => ZERO));
  rho.forEach((row, i) => row.forEach((value, j) => {
    out[i << shift][j << shift] = value;
  }));
  return out;
};

const RESET_KRAUS: readonly ComplexMatrix[] = [
  [[{ re: 1, im: 0 }, ZERO], [ZERO, ZERO]],
  [[ZERO, { re: 1, im: 0 }], [ZERO, ZERO]],
];

/**
 * Physical reset channel (|0⟩⟨0|, |0⟩⟨1|): the wire ends in |0⟩ and any
 * entanglement with it is traced out. The state-vector RESET instead
 * post-selects and renormalizes; both agree on product states.
 */
export const resetQubitDensity = (rho: DensityMatrix, qubitCount: number, qubit: number): DensityMatrix =>
  applySingleQubitKraus(rho, qubitCount, qubit, RESET_KRAUS);

export const densityProbabilities = (rho: DensityMatrix): number[] => rho.map((row, index) => row[index].re);
