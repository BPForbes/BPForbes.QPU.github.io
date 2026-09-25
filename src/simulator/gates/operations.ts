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
import type { ComplexMatrix } from '../physics/numerics/linearAlgebra';
import { MATRIX_SWAP, MATRIX_Z, permutationMatrix, phaseMatrix } from './matrices';

// Legacy helper names kept for existing callers; each delegates to the PhysicsEngine class.
export const hasBit = (basisIndex: number, qubit: number, qubitCount: number) =>
  physics.hasBit(basisIndex, qubit, qubitCount);

export const controlsAreActive = (basisIndex: number, qubitCount: number, controls: number[]) =>
  physics.controlsActive(basisIndex, qubitCount, controls);

export const padStateVector = (state: Complex[], fromCount: number, toCount: number): Complex[] =>
  physics.expandRegister(physics.fromAmplitudes(state, fromCount), toCount).amplitudes;

export const applyStartState = (state: Complex[], qubitCount: number, qubit: number, startState: '1p' | 'sp'): Complex[] =>
  physics.prepare(physics.fromAmplitudes(state, qubitCount), qubit, startState).amplitudes;

/** Z-basis collapse in the legacy result shape. */
export const measureQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  random = Math.random(),
): { state: Complex[]; value: 0 | 1; probabilityOne: number } => {
  const measured = physics.measure(physics.fromAmplitudes(state, qubitCount), qubit, 'Z', random);
  return { state: measured.state.amplitudes, value: measured.outcome, probabilityOne: measured.probabilityOne };
};

/** Apply operator `matrix` on `targets`, gated on `controls`, through the Physics Engine. */
export const evolveState = (
  state: Complex[],
  qubitCount: number,
  targets: number[],
  matrix: ComplexMatrix,
  controls: number[] = [],
): Complex[] => physics.applyControlledUnitary(physics.fromAmplitudes(state, qubitCount), controls, targets, matrix).amplitudes;

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
      (index, wire, position) => ((local >> (wires.length - position - 1)) & 1 ? index | physics.qubitMask(wire, qubitCount) : index),
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
): Complex[] => physics.reset(physics.fromAmplitudes(state, qubitCount), qubit, random).amplitudes;
