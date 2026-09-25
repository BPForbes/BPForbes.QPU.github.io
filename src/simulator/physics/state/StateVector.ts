/**
 * Pure-state (state-vector) kernels: register creation, preparation, expansion,
 * and generic unitary evolution |ψ'⟩ = U|ψ⟩.
 *
 * Qubit 0 is the most significant bit of a basis index. Kernels are linear and
 * never renormalize, so they also act correctly on unnormalized columns (the
 * density-matrix backend relies on that).
 */
import { add, type Complex, magnitudeSquared, mul, ONE, scale, ZERO } from '../../complex';
import { MATRIX_H, MATRIX_X } from '../../gates/matrices';
import type { ParticleStartState } from '../../types';
import type { ComplexMatrix } from '../numerics/linearAlgebra';

export const bitMask = (qubit: number, qubitCount: number) => 1 << (qubitCount - qubit - 1);

export const hasBit = (basisIndex: number, qubit: number, qubitCount: number) =>
  (basisIndex & bitMask(qubit, qubitCount)) !== 0;

export const controlsAreActive = (basisIndex: number, qubitCount: number, controls: number[]) =>
  controls.every((control) => hasBit(basisIndex, control, qubitCount));

/** |0…0⟩ on `qubitCount` wires. */
export const createRegister = (qubitCount: number): Complex[] => {
  const state = Array.from({ length: 2 ** qubitCount }, () => ZERO);
  state[0] = ONE;
  return state;
};

// Custom/child gates may pad the state vector beyond the UI qubit count; trust vector width when it is larger.
export const resolveStateQubitCount = (state: Complex[], qubitCount: number): number => {
  const vectorWidth = Math.round(Math.log2(state.length));
  if (Number.isFinite(vectorWidth) && vectorWidth > 0 && vectorWidth > qubitCount) {
    return vectorWidth;
  }
  return qubitCount;
};

// Matrix application walks zero/one basis pairs once, preserving amplitudes outside the target pair.
export const applySingleQubitGate = (
  state: Complex[],
  qubitCount: number,
  target: number,
  matrix: ComplexMatrix,
): Complex[] => {
  const next = [...state];
  const mask = bitMask(target, qubitCount);

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) === 0) {
      const zeroIndex = index;
      const oneIndex = index | mask;
      const zeroAmplitude = state[zeroIndex];
      const oneAmplitude = state[oneIndex];
      next[zeroIndex] = add(mul(matrix[0][0], zeroAmplitude), mul(matrix[0][1], oneAmplitude));
      next[oneIndex] = add(mul(matrix[1][0], zeroAmplitude), mul(matrix[1][1], oneAmplitude));
    }
  }

  return next;
};

export const applyControlledSingleQubit = (
  state: Complex[],
  qubitCount: number,
  controls: number[],
  target: number,
  matrix: ComplexMatrix,
): Complex[] => {
  const next = [...state];
  const mask = bitMask(target, qubitCount);

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) === 0 && controlsAreActive(index, qubitCount, controls)) {
      const zeroIndex = index;
      const oneIndex = index | mask;
      const zeroAmplitude = state[zeroIndex];
      const oneAmplitude = state[oneIndex];
      next[zeroIndex] = add(mul(matrix[0][0], zeroAmplitude), mul(matrix[0][1], oneAmplitude));
      next[oneIndex] = add(mul(matrix[1][0], zeroAmplitude), mul(matrix[1][1], oneAmplitude));
    }
  }

  return next;
};

/**
 * Apply a 2^k × 2^k operator to `targets` (targets[0] is the operator's most
 * significant bit), optionally gated on all `controls` being |1⟩.
 */
export const applyMultiQubitUnitary = (
  state: Complex[],
  qubitCount: number,
  targets: number[],
  matrix: ComplexMatrix,
  controls: number[] = [],
): Complex[] => {
  const dimension = 2 ** targets.length;
  if (matrix.length !== dimension || matrix.some((row) => row.length !== dimension)) {
    throw new RangeError(`Operator on ${targets.length} qubit(s) must be ${dimension}×${dimension}.`);
  }
  if (new Set([...targets, ...controls]).size !== targets.length + controls.length) {
    throw new RangeError('Targets and controls must be distinct qubits.');
  }
  if (targets.length === 1) {
    return controls.length > 0
      ? applyControlledSingleQubit(state, qubitCount, controls, targets[0], matrix)
      : applySingleQubitGate(state, qubitCount, targets[0], matrix);
  }

  const masks = targets.map((target) => bitMask(target, qubitCount));
  const targetMask = masks.reduce((all, mask) => all | mask, 0);
  const offsets = Array.from({ length: dimension }, (_, local) =>
    masks.reduce((offset, mask, bit) => ((local >> (targets.length - bit - 1)) & 1 ? offset | mask : offset), 0));
  const next = [...state];
  const local = new Array<Complex>(dimension);

  for (let base = 0; base < state.length; base += 1) {
    if ((base & targetMask) !== 0 || !controlsAreActive(base, qubitCount, controls)) continue;
    for (let column = 0; column < dimension; column += 1) local[column] = state[base | offsets[column]];
    for (let row = 0; row < dimension; row += 1) {
      let sum = ZERO;
      for (let column = 0; column < dimension; column += 1) {
        sum = add(sum, mul(matrix[row][column], local[column]));
      }
      next[base | offsets[row]] = sum;
    }
  }

  return next;
};

export const padStateVector = (state: Complex[], fromCount: number, toCount: number): Complex[] => {
  if (toCount <= fromCount) return state;
  const shift = toCount - fromCount;
  const next = Array.from({ length: 2 ** toCount }, () => ZERO);
  state.forEach((amplitude, index) => {
    next[index << shift] = amplitude;
  });
  return next;
};

// Preparation assumes the wire starts in |0⟩, which holds for fresh registers.
export const applyStartState = (state: Complex[], qubitCount: number, qubit: number, startState: '1p' | 'sp'): Complex[] => {
  if (startState === '1p') return applySingleQubitGate(state, qubitCount, qubit, MATRIX_X);
  return applySingleQubitGate(state, qubitCount, qubit, MATRIX_H);
};

export const prepareStartState = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  preparation: ParticleStartState,
): Complex[] => (preparation === '0p' ? state : applyStartState(state, qubitCount, qubit, preparation));

// RESET projects onto |0⟩ when possible, but recovers a valid zero state if the branch had no amplitude.
export const prepareZeroQubit = (state: Complex[], qubitCount: number, qubit: number): Complex[] => {
  const mask = bitMask(qubit, qubitCount);
  const next = [...state];

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) !== 0) {
      next[index] = ZERO;
    }
  }

  let keptProbability = next.reduce((sum, amplitude) => sum + magnitudeSquared(amplitude), 0);
  if (keptProbability < 1e-12) {
    const recovered = Array.from({ length: state.length }, () => ZERO);
    for (let index = 0; index < state.length; index += 1) {
      if ((index & mask) !== 0) {
        recovered[index & ~mask] = state[index];
      }
    }
    next.splice(0, next.length, ...recovered);
    keptProbability = next.reduce((sum, amplitude) => sum + magnitudeSquared(amplitude), 0);
    if (keptProbability < 1e-12) {
      const zeroState = Array.from({ length: state.length }, () => ZERO);
      zeroState[0] = ONE;
      return zeroState;
    }
  }

  const normalizer = 1 / Math.sqrt(keptProbability);
  return next.map((amplitude) => scale(amplitude, normalizer));
};

export const basisProbabilities = (state: Complex[]): number[] => state.map(magnitudeSquared);

export const probabilityOfOne = (state: Complex[], qubitCount: number, qubit: number): number =>
  state.reduce((sum, amplitude, index) => sum + (hasBit(index, qubit, qubitCount) ? magnitudeSquared(amplitude) : 0), 0);

/** Joint computational-basis distribution of `qubits` (qubits[0] is the most significant bit). */
export const marginalProbabilities = (state: Complex[], qubitCount: number, qubits: number[]): number[] => {
  const probabilities = Array.from({ length: 2 ** qubits.length }, () => 0);
  state.forEach((amplitude, sourceIndex) => {
    const probability = magnitudeSquared(amplitude);
    if (probability < 1e-20) return;
    let targetIndex = 0;
    qubits.forEach((sourceQubit) => {
      targetIndex = (targetIndex << 1) | (hasBit(sourceIndex, sourceQubit, qubitCount) ? 1 : 0);
    });
    probabilities[targetIndex] += probability;
  });
  return probabilities;
};

export const norm = (state: Complex[]): number => Math.sqrt(state.reduce((sum, amplitude) => sum + magnitudeSquared(amplitude), 0));

/** ⟨a|b⟩ */
export const innerProduct = (a: readonly Complex[], b: readonly Complex[]): Complex =>
  a.reduce((sum, amplitude, index) => add(sum, mul({ re: amplitude.re, im: -amplitude.im }, b[index])), ZERO);
