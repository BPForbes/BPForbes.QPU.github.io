import { add, Complex, complex, magnitudeSquared, mul, ONE, scale, ZERO } from '../complex';
import { MATRIX_H, MATRIX_X } from './matrices';
const bitMask = (qubit: number, qubitCount: number) => 1 << (qubitCount - qubit - 1);

export const hasBit = (basisIndex: number, qubit: number, qubitCount: number) =>
  (basisIndex & bitMask(qubit, qubitCount)) !== 0;

// Matrix application walks zero/one basis pairs once, preserving amplitudes outside the target pair.
export const applySingleQubitGate = (
  state: Complex[],
  qubitCount: number,
  target: number,
  matrix: readonly (readonly Complex[])[],
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

export const controlsAreActive = (basisIndex: number, qubitCount: number, controls: number[]) =>
  controls.every((control) => hasBit(basisIndex, control, qubitCount));

export const controlsHaveParity = (basisIndex: number, qubitCount: number, controls: number[]) =>
  controls.filter((control) => hasBit(basisIndex, control, qubitCount)).length % 2 === 1;

export const anyControlIsActive = (basisIndex: number, qubitCount: number, controls: number[]) =>
  controls.some((control) => hasBit(basisIndex, control, qubitCount));

// Predicate-controlled X is shared by AND/OR/XOR-style derived gates whose controls are not all-active checks.
export const applyControlledPredicateX = (
  state: Complex[],
  qubitCount: number,
  controls: number[],
  target: number,
  predicate: (basisIndex: number, qubitCount: number, controls: number[]) => boolean,
): Complex[] => {
  const next = [...state];
  const mask = bitMask(target, qubitCount);

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) === 0 && predicate(index, qubitCount, controls)) {
      const pair = index | mask;
      next[index] = state[pair];
      next[pair] = state[index];
    }
  }

  return next;
};

export const applyControlledX = (state: Complex[], qubitCount: number, controls: number[], target: number): Complex[] =>
  applyControlledPredicateX(state, qubitCount, controls, target, controlsAreActive);

export const applyControlledZ = (state: Complex[], qubitCount: number, controls: number[], target: number): Complex[] => {
  const next = [...state];
  const targetMask = bitMask(target, qubitCount);

  for (let index = 0; index < state.length; index += 1) {
    if ((index & targetMask) !== 0 && controlsAreActive(index, qubitCount, controls)) {
      next[index] = scale(state[index], -1);
    }
  }

  return next;
};

export const applyControlledPhase = (
  state: Complex[],
  qubitCount: number,
  control: number,
  target: number,
  theta: number,
): Complex[] => {
  const multiplier = complex(Math.cos(theta), Math.sin(theta));
  return state.map((amplitude, index) => {
    if (hasBit(index, control, qubitCount) && hasBit(index, target, qubitCount)) {
      return mul(amplitude, multiplier);
    }
    return amplitude;
  });
};

export const applyControlledSingleQubit = (
  state: Complex[],
  qubitCount: number,
  controls: number[],
  target: number,
  matrix: readonly (readonly Complex[])[],
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

export const applySwap = (state: Complex[], qubitCount: number, qubitA: number, qubitB: number): Complex[] => {
  if (qubitA === qubitB) return state;
  const next = [...state];
  const maskA = bitMask(qubitA, qubitCount);
  const maskB = bitMask(qubitB, qubitCount);

  for (let index = 0; index < state.length; index += 1) {
    if (hasBit(index, qubitA, qubitCount) !== hasBit(index, qubitB, qubitCount)) {
      const partner = index ^ maskA ^ maskB;
      if (index < partner) {
        next[index] = state[partner];
        next[partner] = state[index];
      }
    }
  }

  return next;
};

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

// Measurements collapse and renormalize the vector while accepting an injectable random value for deterministic tests.
export const measureQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  random = Math.random(),
): { state: Complex[]; value: 0 | 1; probabilityOne: number } => {
  const probabilityOne = state.reduce(
    (sum, amplitude, index) => sum + (hasBit(index, qubit, qubitCount) ? magnitudeSquared(amplitude) : 0),
    0,
  );
  const sample = Math.min(Math.max(random, 0), 1 - Number.EPSILON);
  const value: 0 | 1 = sample < probabilityOne ? 1 : 0;
  const keptProbability = value === 1 ? probabilityOne : 1 - probabilityOne;
  const normalizer = keptProbability > 0 ? 1 / Math.sqrt(keptProbability) : 0;

  const collapsed = state.map((amplitude, index) =>
    hasBit(index, qubit, qubitCount) === Boolean(value) ? scale(amplitude, normalizer) : ZERO,
  );

  return { state: collapsed, value, probabilityOne };
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

export const applyStartState = (state: Complex[], qubitCount: number, qubit: number, startState: '1p' | 'sp'): Complex[] => {
  if (startState === '1p') return applySingleQubitGate(state, qubitCount, qubit, MATRIX_X);
  return applySingleQubitGate(state, qubitCount, qubit, MATRIX_H);
};
