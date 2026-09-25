/**
 * Gate-specific state-vector fast paths (controlled-X families, CZ, CPHASE, SWAP).
 *
 * Generic physics (unitary application, preparation, expansion, reset, and
 * measurement) lives in the Physics Engine; it is re-exported here so existing
 * gate modules and call sites keep their imports.
 */
import { Complex, complex, mul, scale } from '../complex';
import { bitMask, controlsAreActive, hasBit } from '../physics/state/StateVector';

export {
  applyControlledSingleQubit,
  applySingleQubitGate,
  applyStartState,
  controlsAreActive,
  hasBit,
  padStateVector,
  prepareZeroQubit,
} from '../physics/state/StateVector';
export { measureQubit } from '../physics/measurement/Measurement';

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
