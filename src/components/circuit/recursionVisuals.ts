/**
 * Canvas visuals for compile-time REC/TREC expansion.
 *
 * The simulator still holds the fully unrolled gate list. The canvas collapses
 * each recursive call to a single gate glyph with a light-green D{n} badge;
 * n counts down as the playhead traverses the expansion, then the badge hides.
 */
import type { CircuitGate, RecursionFrameMeta } from '../../simulator/types';

export type VisualCircuitColumn = {
  /** 0-based canvas column index (not the simulator step). */
  column: number;
  /** Gate(s) drawn in this column (template from the first recursion level). */
  displayGates: CircuitGate[];
  /** Every simulator step covered by this visual column. */
  coveredSteps: number[];
  /** Non-recursive INCREASECYCLE marker drawn as a dashed slice. */
  cycleGate?: CircuitGate;
  /** Present when this column is a collapsed recursive call. */
  recursion?: {
    process: string;
    rootDepth: number;
    /** Depth to show for each covered simulator step. */
    depthByStep: Record<number, number>;
  };
};

const isRecursiveCycle = (gate: CircuitGate) => gate.type === 'CYCLE' && Boolean(gate.recursion);

const sameExpansion = (a: RecursionFrameMeta, b: RecursionFrameMeta) =>
  a.process === b.process && a.rootDepth === b.rootDepth && a.mode === b.mode;

/**
 * Collapse contiguous unrolled REC/TREC frames into one visual column per
 * recursive call (body gates from the first level only; recursive CYCLE hidden).
 */
export const buildVisualCircuitColumns = (gates: readonly CircuitGate[]): VisualCircuitColumn[] => {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const columns: VisualCircuitColumn[] = [];
  let index = 0;
  let column = 0;

  while (index < sorted.length) {
    const gate = sorted[index];
    if (gate.recursion && !isRecursiveCycle(gate)) {
      const meta = gate.recursion;
      const group: CircuitGate[] = [];
      while (index < sorted.length) {
        const next = sorted[index];
        if (!next.recursion || !sameExpansion(next.recursion, meta)) break;
        group.push(next);
        index += 1;
      }
      const levels = [...new Set(group.map((entry) => entry.recursion!.level))].sort((a, b) => a - b);
      const firstLevel = levels[0] ?? 0;
      const template = group.filter(
        (entry) => entry.recursion!.level === firstLevel && entry.type !== 'CYCLE',
      );
      // One visual gate for the recursive call: prefer the first body gate.
      const displayGates = template.length > 0 ? [template[0]] : [group.find((entry) => entry.type !== 'CYCLE') ?? group[0]];
      const depthByStep: Record<number, number> = {};
      group.forEach((entry) => {
        if (entry.recursion) depthByStep[entry.step] = entry.recursion.depth;
      });
      columns.push({
        column,
        displayGates,
        coveredSteps: group.map((entry) => entry.step),
        recursion: {
          process: meta.process,
          rootDepth: meta.rootDepth,
          depthByStep,
        },
      });
      column += 1;
      continue;
    }

    if (isRecursiveCycle(gate)) {
      // Absorbed into the recursive call column; never drawn as a hash mark.
      index += 1;
      continue;
    }

    if (gate.type === 'CYCLE') {
      columns.push({
        column,
        displayGates: [],
        coveredSteps: [gate.step],
        cycleGate: gate,
      });
      column += 1;
      index += 1;
      continue;
    }

    columns.push({
      column,
      displayGates: [gate],
      coveredSteps: [gate.step],
    });
    column += 1;
    index += 1;
  }

  return columns;
};

/**
 * Depth badge for a collapsed recursive column.
 * Shows D{root} before/during the call; counts down while traversing; hides after.
 */
export const recursionDepthForColumn = (
  visual: VisualCircuitColumn,
  activeStep: number,
): number | undefined => {
  if (!visual.recursion) return undefined;
  const maxStep = Math.max(...visual.coveredSteps);
  const minStep = Math.min(...visual.coveredSteps);
  if (activeStep > maxStep) return undefined;
  if (activeStep < minStep) return visual.recursion.rootDepth;
  if (visual.recursion.depthByStep[activeStep] !== undefined) {
    return visual.recursion.depthByStep[activeStep];
  }
  // Playhead on a covered step without its own stamp — use nearest prior depth.
  const prior = visual.coveredSteps
    .filter((step) => step <= activeStep)
    .sort((a, b) => b - a);
  for (const step of prior) {
    const depth = visual.recursion.depthByStep[step];
    if (depth !== undefined) return depth;
  }
  return visual.recursion.rootDepth;
};

export const recursionDepthLabel = (depth: number) => `D${depth}`;

export const recursionDepthTitle = (visual: VisualCircuitColumn, depth: number) => {
  if (!visual.recursion) return '';
  return (
    `${visual.recursion.process} recursive call · DEPTH ${depth} of ${visual.recursion.rootDepth}. `
    + 'One gate on the canvas; DEPTH counts down as you step through the expansion.'
  );
};

export const columnContainsStep = (visual: VisualCircuitColumn, step: number) =>
  visual.coveredSteps.includes(step);

export const columnIsActive = (visual: VisualCircuitColumn, activeStep: number) =>
  activeStep >= 0 && columnContainsStep(visual, activeStep);

export const columnIsDone = (visual: VisualCircuitColumn, activeStep: number) => {
  if (activeStep < 0) return false;
  return Math.max(...visual.coveredSteps) <= activeStep;
};

/** Map a simulator step to its visual column index. */
export const visualColumnIndexForStep = (
  columns: readonly VisualCircuitColumn[],
  step: number,
): number | undefined => {
  const found = columns.find((column) => columnContainsStep(column, step));
  return found?.column;
};
