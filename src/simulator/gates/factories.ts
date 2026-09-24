/**
 * Gate-definition factories for common built-in operation families.
 *
 * Small factories keep simple preconfigured gates declarative while preserving a
 * single implementation path for matrix gates and controlled-X-derived logic.
 */
import type { ExecutionResult } from '../types';
import type { GateApplyContext, GateDefinition } from './types';
import { gateIoArity } from './types';
import { applySingleQubitGate, applyControlledX, applyControlledPredicateX, anyControlIsActive, controlsHaveParity } from './operations';
import { MATRIX_X, phaseMatrix } from './matrices';

type SingleQubitGateOptions = {
  id: string;
  label: string;
  matrix: readonly (readonly import('../complex').Complex[])[];
  cssClass: string;
  logMessage: (target: number) => string;
  isAstPrimitive?: boolean;
  inPalette?: boolean;
};

export const createSingleQubitMatrixGate = ({
  id,
  label,
  matrix,
  cssClass,
  logMessage,
  isAstPrimitive = true,
  inPalette = true,
}: SingleQubitGateOptions): GateDefinition => ({
  id,
  category: 'preconfigured',
  label,
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette,
  isAstPrimitive,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: false,
  cssClass,
  apply: ({ state, qubitCount, gate, measurements }): ExecutionResult => {
    const target = gate.targets[0];
    return {
      state: applySingleQubitGate(state, qubitCount, target, matrix),
      measurements,
      log: [logMessage(target)],
    };
  },
});

type FixedPhaseGateOptions = {
  id: string;
  label: string;
  angle: number;
  cssClass: string;
};

/** S, T, Z-style gates built from a fixed phase angle on |1⟩. */
export const createFixedPhaseGate = ({ id, label, angle, cssClass }: FixedPhaseGateOptions): GateDefinition => ({
  id,
  category: 'preconfigured',
  label,
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: false,
  cssClass,
  apply: ({ state, qubitCount, gate, measurements }): ExecutionResult => {
    const target = gate.targets[0];
    return {
      state: applySingleQubitGate(state, qubitCount, target, phaseMatrix(angle)),
      measurements,
      log: [`${id} applied phase ${angle.toFixed(3)} on q${target}.`],
    };
  },
});

type ControlledXFamilyOptions = {
  id: string;
  label: string;
  cssClass: string;
  astInputCount: number;
  controlKind: 'single' | 'double';
  predicate?: 'all' | 'any' | 'parity';
  invertTarget?: boolean;
  isAstDerived?: boolean;
  ioArity?: import('./types').GateIoArity;
};

export const createControlledXFamilyGate = ({
  id,
  label,
  cssClass,
  astInputCount,
  controlKind,
  predicate = 'all',
  invertTarget = false,
  isAstDerived = false,
  ioArity: arityOverride,
}: ControlledXFamilyOptions): GateDefinition => ({
  id,
  category: 'preconfigured',
  label,
  controlKind,
  ioArity: arityOverride ?? gateIoArity(astInputCount, 1),
  astInputCount,
  inPalette: true,
  isAstPrimitive: !isAstDerived,
  isAstDerived,
  supportsReverse: true,
  supportsPhase: false,
  cssClass,
  apply: ({ state, qubitCount, gate, measurements }): ExecutionResult => {
    const target = gate.targets[0];
    const predicateFn = predicate === 'any'
      ? anyControlIsActive
      : predicate === 'parity'
        ? controlsHaveParity
        : undefined;

    let nextState = predicateFn
      ? applyControlledPredicateX(state, qubitCount, gate.controls, target, predicateFn)
      : applyControlledX(state, qubitCount, gate.controls, target);

    if (invertTarget) {
      nextState = applySingleQubitGate(nextState, qubitCount, target, MATRIX_X);
    }

    return {
      state: nextState,
      measurements,
      log: [`${id} used q${gate.controls.join(', q')} as control${gate.controls.length > 1 ? 's' : ''} and q${target} as target.`],
    };
  },
});
