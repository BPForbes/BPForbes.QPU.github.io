/**
 * Canvas visuals for compile-time REC/TREC expansion.
 *
 * The simulator still holds the fully unrolled gate list. The canvas collapses
 * each recursive call to a single gate glyph with a teal D{n} badge;
 * n counts down as the playhead traverses the expansion, then the badge hides.
 */
import type { CircuitGate, RecursionFrameMeta } from '../../simulator/types';

export type VisualCircuitColumn = {
  /** 0-based canvas column index (not the simulator step). */
  column: number;
  /** Gate(s) drawn in this column (template from the first recursion level). */
  displayGates: CircuitGate[];
  /** Optional canvas label override (e.g. REC for multi-op recursive frames). */
  displayLabel?: string;
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
    /** Every wire the recursive body touches; a collapsed REC box spans these. */
    qubits: number[];
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
        // Multi-op frames collapse to a REC box; single-op frames keep the gate letter (e.g. H).
        displayLabel: template.length > 1 ? 'REC' : undefined,
        coveredSteps: group.map((entry) => entry.step),
        recursion: {
          process: meta.process,
          rootDepth: meta.rootDepth,
          depthByStep,
          qubits: [...new Set(group.flatMap((entry) => [...entry.controls, ...entry.targets]))].sort((a, b) => a - b),
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
 * Shows D{root} before the call; counts down while traversing; hides when past
 * the expansion or when the circuit run has finished.
 */
export const recursionDepthForColumn = (
  visual: VisualCircuitColumn,
  activeStep: number,
  options?: { circuitComplete?: boolean },
): number | undefined => {
  if (!visual.recursion) return undefined;
  if (options?.circuitComplete) return undefined;
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

/** One unrolled level of a collapsed recursive call, for the expanded detail view. */
export type RecursionFrame = {
  process: string;
  depth: number;
  level: number;
  rootDepth: number;
  mode: RecursionFrameMeta['mode'];
  /** Body gates of this level in step order (the recursive CYCLE is split out). */
  body: CircuitGate[];
  /** INCREASECYCLE that closes this level before the tail call. */
  cycleGate?: CircuitGate;
  /** Index in `body` where the adjoint (uncompute) region starts; body.length when none. */
  inverseStart: number;
  /** Wires touched anywhere in the recursive call. */
  qubits: number[];
};

/**
 * Extract one level of the recursive call drawn by `visual`.
 * `level` defaults to the first level; out-of-range levels return undefined.
 */
export const recursionFrameForColumn = (
  gates: readonly CircuitGate[],
  visual: VisualCircuitColumn,
  level?: number,
): RecursionFrame | undefined => {
  if (!visual.recursion) return undefined;
  const covered = new Set(visual.coveredSteps);
  const group = gates
    .filter((gate) => covered.has(gate.step) && gate.recursion)
    .sort((a, b) => a.step - b.step);
  const targetLevel = level ?? Math.min(...group.map((gate) => gate.recursion!.level));
  const frameGates = group.filter((gate) => gate.recursion!.level === targetLevel);
  if (frameGates.length === 0) return undefined;
  const meta = frameGates[0].recursion!;
  const body = frameGates.filter((gate) => gate.type !== 'CYCLE');
  const firstInverse = body.findIndex((gate) => gate.inverse);
  return {
    process: meta.process,
    depth: meta.depth,
    level: meta.level,
    rootDepth: meta.rootDepth,
    mode: meta.mode,
    body,
    cycleGate: frameGates.find((gate) => gate.type === 'CYCLE'),
    inverseStart: firstInverse < 0 ? body.length : firstInverse,
    qubits: visual.recursion.qubits,
  };
};

/** Frame containing the playhead, or undefined when the step is outside every recursive call. */
export const recursionFrameForStep = (
  gates: readonly CircuitGate[],
  step: number,
): RecursionFrame | undefined => {
  const active = gates.find((gate) => gate.step === step);
  if (!active?.recursion) return undefined;
  const visual = buildVisualCircuitColumns(gates).find((column) => column.recursion && columnContainsStep(column, step));
  return visual ? recursionFrameForColumn(gates, visual, active.recursion.level) : undefined;
};

/**
 * Forward gate name recovered from protocol source when lowering renamed it
 * (e.g. `Tdg` lowers to PHASE(-π/4) but should still read as T†).
 */
export const sourceGateLabel = (gate: CircuitGate): string | undefined => {
  const token = gate.source?.trim().split(/\s+/)[0]?.split('=')[0];
  if (!token || gate.type !== 'PHASE') return undefined;
  const base = token.replace(/^(dg|inv)(?=[A-Z])/, '').replace(/(dg|inv)$/, '');
  return /^[A-Z]{1,2}$/.test(base) && base !== 'P' ? base : undefined;
};
