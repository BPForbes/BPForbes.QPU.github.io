/**
 * Canvas / workbench helpers for compile-time REC/TREC expansion.
 * Recursion never becomes a runtime loop — these badges annotate the unrolled gate list.
 */
import type { CircuitGate, RecursionFrameMeta } from '../../simulator/types';

export type RecursionExpansionSummary = {
  process: string;
  rootDepth: number;
  mode: 'tco' | 'stack';
  stages: number;
  levels: number[];
};

/** First recursive frame on the gate list wins for the process/mode banner. */
export const recursionExpansionSummary = (
  gates: readonly CircuitGate[],
): RecursionExpansionSummary | undefined => {
  const frames = gates
    .map((gate) => gate.recursion)
    .filter((frame): frame is RecursionFrameMeta => Boolean(frame));
  if (frames.length === 0) return undefined;
  const first = frames[0];
  const levels = [...new Set(frames.map((frame) => frame.level))].sort((a, b) => a - b);
  return {
    process: first.process,
    rootDepth: first.rootDepth,
    mode: first.mode,
    stages: levels.length,
    levels,
  };
};

export const recursionCycleLabel = (gate: CircuitGate): string => {
  const cycle = gate.cycle ?? '';
  const frame = gate.recursion;
  if (!frame) return String(cycle);
  const mode = frame.mode === 'tco' ? 'TCO' : 'REC';
  return `${cycle}\nL${frame.level} · ${mode}`;
};

export const recursionCycleTitle = (gate: CircuitGate): string => {
  const frame = gate.recursion;
  if (!frame) {
    return gate.cycle === undefined
      ? 'Logical cycle boundary (INCREASECYCLE)'
      : `Logical cycle ${gate.cycle} (INCREASECYCLE advances the stage; it does not loop)`;
  }
  const mode = frame.mode === 'tco'
    ? 'TCO iterative expansion (F#-style frame rewind)'
    : 'stacked recursive expansion';
  return (
    `${frame.process} frame: DEPTH=${frame.depth} LEVEL=${frame.level} of ROOTDEPTH=${frame.rootDepth}`
    + ` via ${mode}. Compile-time only — the canvas shows the unrolled gates.`
  );
};

export const describeRecursionExpansion = (summary: RecursionExpansionSummary): string => {
  const mode = summary.mode === 'tco'
    ? 'TCO (tail REC auto-converted or TREC; one compile frame rewound)'
    : 'stacked REC (nested compile frames)';
  return (
    `Expanded ${summary.process} −DEPTH ${summary.rootDepth} into ${summary.stages} stage`
    + `${summary.stages === 1 ? '' : 's'} with ${mode}. `
    + 'Dashed columns mark INCREASECYCLE; L# is the recursion LEVEL. Nothing loops at run time.'
  );
};
