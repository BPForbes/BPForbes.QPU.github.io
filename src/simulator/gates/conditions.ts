import { magnitudeSquared, type Complex } from '../complex';
import type { CircuitGate, ConditionPredicate, ConditionValue, MeasurementMap } from '../types';
import { applyInverseAwareDefinition } from './inverse';
import { hasBit, padStateVector } from './operations';
import { preconfiguredGateMap } from './preconfigured';

/** P(1) within this tolerance of 0 or 1 reads as a definite bit; anything else is S. */
const DEFINITE_TOLERANCE = 1e-9;

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
 * Run a predicate gate on a scratch copy of the state and classify its result
 * wire. The live state is never modified. This reads amplitudes directly, which
 * a simulator can do but real hardware cannot (see the Language Reference).
 */
export const evaluatePredicate = (
  predicate: ConditionPredicate,
  state: Complex[],
  qubitCount: number,
  measurements: MeasurementMap,
): ConditionValue => {
  const definition = preconfiguredGateMap[predicate.type];
  if (!definition) throw new Error(`IF predicate uses unknown gate '${predicate.type}'.`);
  let scratchState = state;
  let scratchCount = qubitCount;
  let target = predicate.output;
  let controls = predicate.inputs.filter((qubit) => qubit !== predicate.output);
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
  const result = applyInverseAwareDefinition(definition, scratchState, scratchCount, probe, measurements, {});
  return classifyWire(result.state, scratchCount, target);
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
): boolean => {
  if (!gate.condition) return true;
  const { predicate } = gate.condition;
  if (predicate) {
    if (!state || qubitCount === undefined) {
      throw new Error('A gate-expression IF needs the current state to evaluate.');
    }
    const matches = evaluatePredicate(predicate, state, qubitCount, measurements) === predicate.expect;
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
