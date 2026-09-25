/**
 * Small dense complex linear algebra used by physics diagnostics.
 *
 * Matrices are row-major `Complex[][]`, matching the gate-matrix convention in
 * `gates/matrices.ts`. Sizes stay tiny (reduced states, 2^k-qubit operators), so
 * clarity wins over blocked or typed-array kernels here.
 */
import { add, complex, type Complex, mul, ONE, ZERO } from '../../complex';

export type ComplexMatrix = readonly (readonly Complex[])[];

export const conj = (value: Complex): Complex => complex(value.re, -value.im);

export const zeroMatrix = (size: number): Complex[][] =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => ZERO));

export const identityMatrix = (size: number): Complex[][] =>
  Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (row === col ? ONE : ZERO)));

export const matMul = (a: ComplexMatrix, b: ComplexMatrix): Complex[][] => {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0]?.length ?? 0;
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ZERO));
  for (let i = 0; i < rows; i += 1) {
    for (let k = 0; k < inner; k += 1) {
      const aik = a[i][k];
      if (aik.re === 0 && aik.im === 0) continue;
      for (let j = 0; j < cols; j += 1) {
        out[i][j] = add(out[i][j], mul(aik, b[k][j]));
      }
    }
  }
  return out;
};

export const dagger = (matrix: ComplexMatrix): Complex[][] =>
  Array.from({ length: matrix[0]?.length ?? 0 }, (_, row) =>
    Array.from({ length: matrix.length }, (_, col) => conj(matrix[col][row])));

export const trace = (matrix: ComplexMatrix): Complex =>
  matrix.reduce((sum, row, index) => add(sum, row[index]), ZERO);

/** Kronecker product; the left operand occupies the more significant index bits. */
export const kron = (a: ComplexMatrix, b: ComplexMatrix): Complex[][] => {
  const bRows = b.length;
  const bCols = b[0]?.length ?? 0;
  return Array.from({ length: a.length * bRows }, (_, row) =>
    Array.from({ length: (a[0]?.length ?? 0) * bCols }, (_, col) =>
      mul(a[Math.floor(row / bRows)][Math.floor(col / bCols)], b[row % bRows][col % bCols])));
};

/** |v⟩⟨v| for a column vector. */
export const outerProduct = (vector: readonly Complex[]): Complex[][] =>
  vector.map((left) => vector.map((right) => mul(left, conj(right))));

export const isUnitary = (matrix: ComplexMatrix, tolerance = 1e-9): boolean => {
  const product = matMul(dagger(matrix), matrix);
  return product.every((row, i) =>
    row.every((value, j) => Math.abs(value.re - (i === j ? 1 : 0)) < tolerance && Math.abs(value.im) < tolerance));
};

// Cyclic Jacobi on a real symmetric matrix; returns eigenvalues and column eigenvectors.
const jacobiSymmetric = (input: number[][]): { values: number[]; vectors: number[][] } => {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) off += a[p][q] * a[p][q];
    }
    if (off < 1e-30) break;

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return { values: a.map((row, index) => row[index]), vectors: v };
};

// A Hermitian H = A + iB has the real symmetric embedding [[A, -B], [B, A]], whose spectrum is H's spectrum doubled.
const realEmbedding = (matrix: ComplexMatrix): number[][] => {
  const n = matrix.length;
  return Array.from({ length: 2 * n }, (_, row) =>
    Array.from({ length: 2 * n }, (_, col) => {
      const entry = matrix[row % n][col % n];
      const top = row < n;
      const left = col < n;
      if (top === left) return entry.re;
      return top ? -entry.im : entry.im;
    }));
};

/** Eigenvalues of a Hermitian matrix, ascending. */
export const hermitianEigenvalues = (matrix: ComplexMatrix): number[] => {
  const doubled = jacobiSymmetric(realEmbedding(matrix)).values.sort((x, y) => x - y);
  return doubled.filter((_, index) => index % 2 === 0);
};

/**
 * Apply a real scalar function to a Hermitian matrix: f(H) = V f(Λ) V†.
 * Computed through the real embedding so degenerate spectra need no special handling.
 */
export const hermitianFunction = (matrix: ComplexMatrix, fn: (eigenvalue: number) => number): Complex[][] => {
  const n = matrix.length;
  const { values, vectors } = jacobiSymmetric(realEmbedding(matrix));
  const mapped = values.map(fn);
  // f(M)[row][col] for the top-left (real part) and bottom-left (imaginary part) blocks.
  const block = (row: number, col: number) =>
    mapped.reduce((sum, value, k) => sum + value * vectors[row][k] * vectors[col][k], 0);
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => complex(block(row, col), block(row + n, col))));
};

/** exp(-i H t) for Hermitian H, built from cos(Ht) - i sin(Ht). */
export const unitaryFromHermitian = (hamiltonian: ComplexMatrix, time: number): Complex[][] => {
  const cosPart = hermitianFunction(hamiltonian, (value) => Math.cos(value * time));
  const sinPart = hermitianFunction(hamiltonian, (value) => Math.sin(value * time));
  return cosPart.map((row, i) =>
    row.map((value, j) => complex(value.re + sinPart[i][j].im, value.im - sinPart[i][j].re)));
};
