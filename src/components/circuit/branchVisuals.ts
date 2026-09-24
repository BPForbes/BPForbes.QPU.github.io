/**
 * Canvas helpers for structured IF/ELSE classical feed-forward.
 * Simulator evaluates only `condition`; these helpers drive IF/ELSE labels
 * and taken/skipped styling from measurement outcomes.
 */
import { conditionValueLabel, type CircuitGate, type MeasurementMap } from '../../simulator/types';

export type BranchOutcome = 'taken' | 'skipped' | 'pending';

export const branchOutcomeFor = (
  gate: CircuitGate,
  measurements: MeasurementMap = {},
  conditionOutcomes: Record<string, boolean> = {},
): BranchOutcome => {
  if (!gate.condition) return 'pending';
  // Gate-expression tests are only known once the engine has evaluated them.
  if (gate.condition.predicate) {
    const ran = conditionOutcomes[gate.id];
    if (ran === undefined) return 'pending';
    return ran ? 'taken' : 'skipped';
  }
  const measured = measurements[gate.condition.qubit];
  if (measured === undefined) return 'pending';
  return measured === gate.condition.equals ? 'taken' : 'skipped';
};

/** Keyword for the IF/ELSE label under the classical c row. */
export const conditionFeedKeyword = (gate: CircuitGate): string => {
  if (gate.branch?.kind === 'else') return 'ELSE';
  if (gate.branch?.kind === 'if') return 'IF';
  return 'IF';
};

/** Condition text for the c-row label, e.g. `A=1` (falls back to `q0=1`). */
export const conditionFeedTest = (gate: CircuitGate, sourceName?: string): string => {
  const predicate = gate.condition?.predicate;
  if (predicate) {
    return `${predicate.text}${predicate.negate ? '≠' : '='}${conditionValueLabel(predicate.expect)}`;
  }
  const qubit = gate.condition?.qubit;
  const name = sourceName ?? (qubit !== undefined ? `q${qubit}` : 'c');
  return `${name}=${gate.condition?.equals ?? ''}`;
};

/** Single-line IF/ELSE label, e.g. `IF · A=1`. */
export const conditionFeedLabel = (gate: CircuitGate, sourceName?: string): string =>
  `${conditionFeedKeyword(gate)} · ${conditionFeedTest(gate, sourceName)}`;

/** Status line under a resolved branch label. Pending branches show none. */
export const branchOutcomeNote = (outcome: BranchOutcome): string | undefined => {
  if (outcome === 'taken') return '✓ taken';
  if (outcome === 'skipped') return '⊘ skipped';
  return undefined;
};

/** @deprecated Prefer conditionFeedLabel; kept for tests / title text. */
export const conditionBadgeLabel = (gate: CircuitGate): string | undefined => {
  if (!gate.condition) return undefined;
  if (gate.branch?.kind === 'if') return `IF · c=${gate.condition.equals}`;
  if (gate.branch?.kind === 'else') return `ELSE · c=${gate.condition.equals}`;
  return `c=${gate.condition.equals}`;
};
