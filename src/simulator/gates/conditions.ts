import type { CircuitGate, MeasurementMap } from '../types';

/**
 * Classical feed-forward check shared by the engine and custom-gate expansion.
 * A conditioned gate runs only when its measured bit matches; an unmeasured
 * bit is an authoring error rather than a silent skip.
 */
export const conditionSatisfied = (
  gate: CircuitGate,
  measurements: MeasurementMap,
): boolean => {
  if (!gate.condition) return true;
  const value = measurements[gate.condition.qubit];
  if (value === undefined) {
    throw new Error(
      `Conditional gate requires q${gate.condition.qubit} to be measured first.`,
    );
  }
  return value === gate.condition.equals;
};
