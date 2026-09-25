/**
 * Gate → Physics Engine bridge.
 *
 * Gates decide WHAT operator runs on which wires; every state change is applied
 * by the Physics Engine. Classical reversible logic (CNOT, CCNOT, AND/OR/XOR…)
 * is expressed as a permutation operator so it takes the same path as any
 * other unitary.
 */
import type { Complex } from '../complex';
import { physics } from '../physics/PhysicsEngine';
import { resetStateVector } from '../physics/measurement/Reset';
import type { ComplexMatrix } from '../physics/numerics/linearAlgebra';
import { stateVector } from '../physics/state/QuantumState';
import { bitMask, controlsAreActive, hasBit } from '../physics/state/StateVector';
import { MATRIX_SWAP, MATRIX_Z, permutationMatrix, phaseMatrix } from './matrices';

export { applyStartState, controlsAreActive, hasBit, padStateVector } from '../physics/state/StateVector';
export { measureQubit } from '../physics/measurement/Measurement';

/** Apply operator `matrix` on `targets`, gated on `controls`, through the Physics Engine. */
export const evolveState = (
  state: Complex[],
  qubitCount: number,
  targets: number[],
  matrix: ComplexMatrix,
  controls: number[] = [],
): Complex[] => physics.applyControlledUnitary(stateVector(state, qubitCount), controls, targets, matrix).amplitudes;

export const applySingleQubitGate = (
  state: Complex[],
  qubitCount: number,
  target: number,
  matrix: ComplexMatrix,
): Complex[] => evolveState(state, qubitCount, [target], matrix);

export const applyControlledSingleQubit = (
  state: Complex[],
  qubitCount: number,
  controls: number[],
  target: number,
  matrix: ComplexMatrix,
): Complex[] => evolveState(state, qubitCount, [target], matrix, controls);

export type ControlPredicate = (basisIndex: number, qubitCount: number, controls: number[]) => boolean;

export const controlsHaveParity: ControlPredicate = (basisIndex, qubitCount, controls) =>
  controls.filter((control) => hasBit(basisIndex, control, qubitCount)).length % 2 === 1;

export const anyControlIsActive: ControlPredicate = (basisIndex, qubitCount, controls) =>
  controls.some((control) => hasBit(basisIndex, control, qubitCount));

/**
 * Permutation operator on [distinct controls…, target] that flips the target
 * wherever `predicate` holds for the control bits. The predicate is read with
 * the target bit at 0, so a target that also appears as a control behaves as
 * it always has.
 */
export const predicateXOperator = (
  qubitCount: number,
  controls: number[],
  target: number,
  predicate: ControlPredicate,
): { targets: number[]; matrix: ComplexMatrix } => {
  const wires = [...new Set(controls.filter((control) => control !== target)), target];
  const permutation = Array.from({ length: 2 ** wires.length }, (_, local) => local);
  for (let local = 0; local < permutation.length; local += 2) {
    const basisIndex = wires.reduce(
      (index, wire, position) => ((local >> (wires.length - position - 1)) & 1 ? index | bitMask(wire, qubitCount) : index),
      0,
    );
    if (predicate(basisIndex, qubitCount, controls)) {
      permutation[local] = local + 1;
      permutation[local + 1] = local;
    }
  }
  return { targets: wires, matrix: permutationMatrix(permutation) };
};

export const applyControlledPredicateX = (
  state: Complex[],
  qubitCount: number,
  controls: number[],
  target: number,
  predicate: ControlPredicate,
): Complex[] => {
  const { targets, matrix } = predicateXOperator(qubitCount, controls, target, predicate);
  return evolveState(state, qubitCount, targets, matrix);
};

export const applyControlledX = (state: Complex[], qubitCount: number, controls: number[], target: number): Complex[] =>
  applyControlledPredicateX(state, qubitCount, controls, target, controlsAreActive);

// A target listed among its own controls adds no condition beyond "target is |1⟩", which Z/phase already imply.
export const applyControlledZ = (state: Complex[], qubitCount: number, controls: number[], target: number): Complex[] =>
  evolveState(state, qubitCount, [target], MATRIX_Z, controls.filter((control) => control !== target));

export const applyControlledPhase = (
  state: Complex[],
  qubitCount: number,
  control: number,
  target: number,
  theta: number,
): Complex[] =>
  evolveState(state, qubitCount, [target], phaseMatrix(theta), control === target ? [] : [control]);

export const applySwap = (state: Complex[], qubitCount: number, qubitA: number, qubitB: number): Complex[] =>
  (qubitA === qubitB ? state : evolveState(state, qubitCount, [qubitA, qubitB], MATRIX_SWAP));

/** RESET one wire to |0⟩ through the Physics Engine (measure-and-flip trajectory of the reset channel). */
export const prepareZeroQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  random: () => number = Math.random,
): Complex[] => resetStateVector(state, qubitCount, qubit, random);
