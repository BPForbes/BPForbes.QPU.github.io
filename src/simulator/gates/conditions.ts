import { magnitudeSquared, type Complex } from '../complex';
import type { CircuitGate, ConditionPredicate, ConditionValue, ExecutionResult, GateType, MeasurementMap } from '../types';
import { applyInverseAwareDefinition } from './inverse';
import { hasBit, padStateVector } from './operations';
import { preconfiguredGateMap } from './preconfigured';

/** P(1) within this tolerance of 0 or 1 reads as a definite bit; anything else is S. */
const DEFINITE_TOLERANCE = 1e-9;

/**
 * Build a `ConditionPredicate` from explicit wires and a value test. Shared by
 * the compiler (parsing `IF (GATE -I … -O …) = V`) and the wrapper dialog's
 * "Joined" gate picker, so a protocol-text predicate and a GUI-built one are
 * the same shape.
 */
export const buildConditionPredicate = (params: {
  type: GateType;
  /** Every -I wire, in order (may include the output wire). */
  inputs: number[];
  /** The -O wire the result is read from. */
  output: number;
  /** AND/NAND/OR/XOR-style gates: true when -O may alias one of the -I wires (the fresh-|0⟩-wire rule). */
  isBooleanJoin: boolean;
  phase?: number;
  inverse?: boolean;
  expect: ConditionValue;
  /** `!=` in source, or the ELSE half of the block. */
  negate: boolean;
  /** Wire label used to build `text`, e.g. the resolved token name or `q{n}`. */
  inputNames: string[];
  outputName: string;
}): ConditionPredicate => {
  const { type, inputs, output, isBooleanJoin, phase, inverse, expect, negate, inputNames, outputName } = params;
  return {
    type,
    inputs,
    output,
    scratch: isBooleanJoin && inputs.length >= 2 && inputs.includes(output),
    ...(phase !== undefined ? { phase } : {}),
    ...(inverse ? { inverse: true } : {}),
    expect,
    negate,
    text: `${type}${inverse ? '†' : ''}(${inputNames.join(',')})${inputNames.includes(outputName) ? '' : `→${outputName}`}`,
  };
};

export const classifyWire = (state: Complex[], qubitCount: number, qubit: number): ConditionValue => {
  const probabilityOne = state.reduce(
    (sum, amplitude, basis) => sum + (hasBit(basis, qubit, qubitCount) ? magnitudeSquared(amplitude) : 0),
    0,
  );
  if (probabilityOne <= DEFINITE_TOLERANCE) return 0;
  if (probabilityOne >= 1 - DEFINITE_TOLERANCE) return 1;
  return 's';
};

/**
 * Applies one gate for predicate evaluation. The engine supplies a runner that
 * also knows custom gates; this module only knows the built-in ones, which
 * keeps it free of the custom-gate engine (and its compiler import).
 */
export type PredicateGateRunner = (
  gate: CircuitGate,
  state: Complex[],
  qubitCount: number,
  measurements: MeasurementMap,
) => ExecutionResult;

const runBuiltInGate: PredicateGateRunner = (gate, state, qubitCount, measurements) => {
  const definition = preconfiguredGateMap[String(gate.type)];
  if (!definition) throw new Error(`IF predicate uses unknown gate '${gate.type}'.`);
  return applyInverseAwareDefinition(definition, state, qubitCount, gate, measurements, {});
};

/**
 * Run a predicate gate on a scratch copy of the state and classify its result
 * wire. The live state is never modified. This reads amplitudes directly, which
 * a simulator can do but real hardware cannot (see the Language Reference).
 */
export const evaluatePredicate = (
  predicate: ConditionPredicate,
  state: Complex[],
  qubitCount: number,
  measurements: MeasurementMap,
  runGate: PredicateGateRunner = runBuiltInGate,
): ConditionValue => {
  // Custom gates bind every -I wire to a PARAM in order, so none are dropped as the target.
  const isCustom = !preconfiguredGateMap[String(predicate.type)];
  let scratchState = state;
  let scratchCount = qubitCount;
  let target = predicate.output;
  let controls = isCustom ? predicate.inputs : predicate.inputs.filter((qubit) => qubit !== predicate.output);
  if (predicate.scratch) {
    scratchState = padStateVector(state, qubitCount, qubitCount + 1);
    scratchCount = qubitCount + 1;
    target = qubitCount;
    controls = predicate.inputs;
  }
  const probe: CircuitGate = {
    id: 'if-predicate',
    type: predicate.type,
    step: -1,
    targets: [target],
    controls,
    phase: predicate.phase,
    inverse: predicate.inverse,
  };
  const result = runGate(probe, scratchState, scratchCount, measurements);
  // Custom gates may add workspace wires, so read the width from the result.
  const resultCount = Math.max(scratchCount, Math.round(Math.log2(result.state.length)));
  return classifyWire(result.state, resultCount, target);
};

/**
 * Classical feed-forward check shared by the engine and custom-gate expansion.
 * A measured-bit condition needs its MEASURE first (an unmeasured bit is an
 * authoring error, not a silent skip). A gate-predicate condition needs the
 * live state and compares the result wire with 0, 1, or S.
 */
export const conditionSatisfied = (
  gate: CircuitGate,
  measurements: MeasurementMap,
  state?: Complex[],
  qubitCount?: number,
  runGate?: PredicateGateRunner,
): boolean => {
  if (!gate.condition) return true;
  const { predicate } = gate.condition;
  if (predicate) {
    if (!state || qubitCount === undefined) {
      throw new Error('A gate-expression IF needs the current state to evaluate.');
    }
    const matches = evaluatePredicate(predicate, state, qubitCount, measurements, runGate) === predicate.expect;
    return predicate.negate ? !matches : matches;
  }
  const value = measurements[gate.condition.qubit];
  if (value === undefined) {
    throw new Error(
      `Conditional gate requires q${gate.condition.qubit} to be measured first.`,
    );
  }
  return value === gate.condition.equals;
};

/** Apply a wire renumbering (compaction, custom-gate binding) to a condition and its predicate. */
export const remapConditionWires = (
  condition: NonNullable<CircuitGate['condition']>,
  map: (qubit: number) => number,
): NonNullable<CircuitGate['condition']> => ({
  ...condition,
  qubit: map(condition.qubit),
  ...(condition.predicate
    ? {
        predicate: {
          ...condition.predicate,
          inputs: condition.predicate.inputs.map(map),
          output: map(condition.predicate.output),
        },
      }
    : {}),
});
