/**
 * Physics validation at the PhysicsEngine boundary.
 *
 * Every check throws PhysicsValidationError with a specific message, so misuse
 * (an unnormalized state, a non-unitary "gate", a leaky channel, a duplicate
 * wire) fails at the call that introduced it instead of surfacing later as a
 * wrong probability. The engine runs these automatically in development and
 * tests; production builds skip them.
 */
import { magnitudeSquared } from '../../complex';
import { type ComplexMatrix, dagger, hermitianEigenvalues, matMul } from '../numerics/linearAlgebra';
import type { NoiseChannel } from '../noise/NoiseModel';
import type { DensityMatrix, QuantumState } from '../state/QuantumState';

export class PhysicsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhysicsValidationError';
  }
}

export type ValidationTolerances = {
  /** |‖ψ‖² − 1| and |Tr ρ − 1|. */
  normalization: number;
  /** Entry-wise error allowed in U†U = I, ΣK†K = I, and ρ = ρ†. */
  operator: number;
  /** Most negative eigenvalue tolerated in ρ (numerical noise). */
  positivity: number;
};

export const DEFAULT_TOLERANCES: ValidationTolerances = {
  normalization: 1e-6,
  operator: 1e-9,
  positivity: 1e-9,
};

/**
 * Positive semidefiniteness needs an eigendecomposition (O(8^n)), so automatic
 * checks stop here; validateState(state, { fullPositivity: true }) forces it.
 */
export const AUTO_POSITIVITY_MAX_QUBITS = 4;

const fail = (message: string): never => {
  throw new PhysicsValidationError(message);
};

const identityError = (product: ComplexMatrix): number =>
  product.reduce((worst, row, i) => row.reduce(
    (rowWorst, value, j) => Math.max(rowWorst, Math.hypot(value.re - (i === j ? 1 : 0), value.im)),
    worst,
  ), 0);

/** Qubit indices must be integers inside the register and, within one operation, distinct. */
export const validateQubits = (qubitCount: number, qubits: readonly number[], label = 'qubits') => {
  qubits.forEach((qubit) => {
    if (!Number.isInteger(qubit) || qubit < 0 || qubit >= qubitCount) {
      fail(`Invalid ${label} index ${qubit} for a ${qubitCount}-qubit register.`);
    }
  });
  if (new Set(qubits).size !== qubits.length) fail(`Duplicate ${label} in [${qubits.join(', ')}].`);
};

export const validateOperatorShape = (matrix: ComplexMatrix, targets: readonly number[]) => {
  const dimension = 2 ** targets.length;
  if (matrix.length !== dimension || matrix.some((row) => row.length !== dimension)) {
    fail(`An operator on ${targets.length} target(s) must be ${dimension}×${dimension} (got ${matrix.length}×${matrix[0]?.length ?? 0}).`);
  }
};

/** U†U ≈ I. Unitarity of a square matrix implies UU† ≈ I as well. */
export const validateUnitary = (matrix: ComplexMatrix, tolerances: ValidationTolerances = DEFAULT_TOLERANCES) => {
  const error = identityError(matMul(dagger(matrix), matrix));
  if (error > tolerances.operator) fail(`Operator is not unitary: ‖U†U − I‖∞ = ${error.toExponential(2)}.`);
};

/** Single-qubit Kraus channel: 2×2 operators with ΣK†K ≈ I (trace preserving). */
export const validateChannel = (channel: NoiseChannel, tolerances: ValidationTolerances = DEFAULT_TOLERANCES) => {
  if (channel.kraus.length === 0) fail(`Channel ${channel.name} has no Kraus operators.`);
  channel.kraus.forEach((operator) => validateOperatorShape(operator, [0]));
  const sum = channel.kraus
    .map((operator) => matMul(dagger(operator), operator))
    .reduce((total, term) => total.map((row, i) => row.map((value, j) => ({
      re: value.re + term[i][j].re,
      im: value.im + term[i][j].im,
    }))));
  const error = identityError(sum);
  if (error > tolerances.operator) {
    fail(`Channel ${channel.name} is not trace preserving: ‖ΣK†K − I‖∞ = ${error.toExponential(2)}.`);
  }
};

export const validateHermitian = (matrix: ComplexMatrix, tolerances: ValidationTolerances = DEFAULT_TOLERANCES, label = 'Matrix') => {
  let worst = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = i; j < matrix.length; j += 1) {
      worst = Math.max(worst, Math.hypot(matrix[i][j].re - matrix[j][i].re, matrix[i][j].im + matrix[j][i].im));
    }
  }
  if (worst > tolerances.operator) fail(`${label} is not Hermitian: max |ρij − conj(ρji)| = ${worst.toExponential(2)}.`);
};

const validateDensity = (rho: DensityMatrix, fullPositivity: boolean, tolerances: ValidationTolerances) => {
  validateHermitian(rho, tolerances, 'Density matrix');
  const trace = rho.reduce((sum, row, index) => sum + row[index].re, 0);
  if (Math.abs(trace - 1) > tolerances.normalization) fail(`Density matrix trace is ${trace}, not 1.`);
  const negativeDiagonal = rho.findIndex((row, index) => row[index].re < -tolerances.positivity);
  if (negativeDiagonal >= 0) fail(`Density matrix has a negative population at index ${negativeDiagonal}.`);
  if (fullPositivity || rho.length <= 2 ** AUTO_POSITIVITY_MAX_QUBITS) {
    const smallest = hermitianEigenvalues(rho)[0] ?? 0;
    if (smallest < -tolerances.positivity) fail(`Density matrix is not positive semidefinite (eigenvalue ${smallest}).`);
  }
};

export type StateValidationOptions = {
  /** Diagonalize ρ even past AUTO_POSITIVITY_MAX_QUBITS. */
  fullPositivity?: boolean;
  tolerances?: ValidationTolerances;
};

/**
 * A valid register: correct dimension for its qubit count; a normalized state
 * vector; or a Hermitian, trace-1, positive-semidefinite density matrix.
 */
export const validateState = (state: QuantumState, options: StateValidationOptions = {}) => {
  const tolerances = options.tolerances ?? DEFAULT_TOLERANCES;
  if (!Number.isInteger(state.qubitCount) || state.qubitCount < 0) fail(`Invalid qubit count ${state.qubitCount}.`);
  const dimension = 2 ** state.qubitCount;
  if (state.kind === 'stateVector') {
    if (state.amplitudes.length !== dimension) {
      fail(`State vector has ${state.amplitudes.length} amplitudes; ${state.qubitCount} qubits need ${dimension}.`);
    }
    const normSquared = state.amplitudes.reduce((sum, amplitude) => sum + magnitudeSquared(amplitude), 0);
    if (!Number.isFinite(normSquared) || Math.abs(normSquared - 1) > tolerances.normalization) {
      fail(`State vector is not normalized: ‖ψ‖² = ${normSquared}.`);
    }
    return;
  }
  if (state.rho.length !== dimension || state.rho.some((row) => row.length !== dimension)) {
    fail(`Density matrix must be ${dimension}×${dimension} for ${state.qubitCount} qubits.`);
  }
  validateDensity(state.rho, options.fullPositivity ?? false, tolerances);
};

/** Density matrices handed in as bare matrices (purity, entropy, …) get the same checks. */
export const validateDensityMatrix = (rho: DensityMatrix, options: StateValidationOptions = {}) => {
  const dimension = rho.length;
  if (dimension === 0 || (dimension & (dimension - 1)) !== 0 || rho.some((row) => row.length !== dimension)) {
    fail(`Density matrix must be square with a power-of-two dimension (got ${dimension}).`);
  }
  validateDensity(rho, options.fullPositivity ?? false, options.tolerances ?? DEFAULT_TOLERANCES);
};

/** Development/test builds validate by default; production skips the checks for speed. */
export const defaultValidationEnabled = (): boolean => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
};
