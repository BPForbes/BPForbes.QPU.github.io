/**
 * Canvas helpers for structured IF/ELSE classical feed-forward.
 * Simulator evaluates only `condition`; these helpers drive IF/ELSE labels
 * and taken/skipped styling from measurement outcomes.
 */
import type { CircuitGate, MeasurementMap } from '../../simulator/types';

export type BranchOutcome = 'taken' | 'skipped' | 'pending';

export const branchOutcomeFor = (
  gate: CircuitGate,
  measurements: MeasurementMap = {},
): BranchOutcome => {
  if (!gate.condition) return 'pending';
  const measured = measurements[gate.condition.qubit];
  if (measured === undefined) return 'pending';
  return measured === gate.condition.equals ? 'taken' : 'skipped';
};

/** Label used by IF/ELSE black pills on the classical c row. */
export const conditionFeedLabel = (gate: CircuitGate): string => {
  if (gate.branch?.kind === 'else') return `ELSE =${gate.condition?.equals ?? 0}`;
  if (gate.branch?.kind === 'if') return `IF =${gate.condition?.equals ?? 1}`;
  return `c=${gate.condition?.equals ?? ''}`;
};

/** @deprecated Prefer conditionFeedLabel; kept for tests / title text. */
export const conditionBadgeLabel = (gate: CircuitGate): string | undefined => {
  if (!gate.condition) return undefined;
  if (gate.branch?.kind === 'if') return `IF · c=${gate.condition.equals}`;
  if (gate.branch?.kind === 'else') return `ELSE · c=${gate.condition.equals}`;
  return `c=${gate.condition.equals}`;
};
