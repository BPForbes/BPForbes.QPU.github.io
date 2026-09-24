import { describe, expect, it } from 'vitest';
import type { CircuitGate } from '../../../simulator/types';
import {
  buildVisualCircuitColumns,
  recursionDepthForColumn,
  recursionDepthLabel,
} from '../recursionVisuals';

const gate = (overrides: Partial<CircuitGate> = {}): CircuitGate => ({
  id: 'g',
  type: 'H',
  step: 0,
  targets: [0],
  controls: [],
  ...overrides,
});

const recursiveHExpansion = (): CircuitGate[] => ([
  gate({
    id: 'h0',
    step: 0,
    recursion: { process: 'RecursiveH', depth: 4, level: 0, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'c0',
    type: 'CYCLE',
    step: 1,
    targets: [],
    cycle: 1,
    recursion: { process: 'RecursiveH', depth: 4, level: 0, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'h1',
    step: 2,
    recursion: { process: 'RecursiveH', depth: 3, level: 1, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'c1',
    type: 'CYCLE',
    step: 3,
    targets: [],
    cycle: 2,
    recursion: { process: 'RecursiveH', depth: 3, level: 1, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'h2',
    step: 4,
    recursion: { process: 'RecursiveH', depth: 2, level: 2, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'c2',
    type: 'CYCLE',
    step: 5,
    targets: [],
    cycle: 3,
    recursion: { process: 'RecursiveH', depth: 2, level: 2, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'h3',
    step: 6,
    recursion: { process: 'RecursiveH', depth: 1, level: 3, rootDepth: 4, mode: 'tco' },
  }),
  gate({
    id: 'c3',
    type: 'CYCLE',
    step: 7,
    targets: [],
    cycle: 4,
    recursion: { process: 'RecursiveH', depth: 1, level: 3, rootDepth: 4, mode: 'tco' },
  }),
]);

describe('recursion canvas visuals', () => {
  it('collapses a DEPTH-4 recursive expansion to one gate column', () => {
    const columns = buildVisualCircuitColumns(recursiveHExpansion());
    expect(columns).toHaveLength(1);
    expect(columns[0].displayGates).toHaveLength(1);
    expect(columns[0].displayGates[0].type).toBe('H');
    expect(columns[0].cycleGate).toBeUndefined();
    expect(columns[0].recursion?.rootDepth).toBe(4);
    expect(columns[0].coveredSteps).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('counts D{n} down while traversing, then hides the badge', () => {
    const [column] = buildVisualCircuitColumns(recursiveHExpansion());
    expect(recursionDepthLabel(4)).toBe('D4');
    expect(recursionDepthForColumn(column, -1)).toBe(4);
    expect(recursionDepthForColumn(column, 0)).toBe(4);
    expect(recursionDepthForColumn(column, 1)).toBe(4);
    expect(recursionDepthForColumn(column, 2)).toBe(3);
    expect(recursionDepthForColumn(column, 4)).toBe(2);
    expect(recursionDepthForColumn(column, 6)).toBe(1);
    expect(recursionDepthForColumn(column, 7)).toBe(1);
    expect(recursionDepthForColumn(column, 8)).toBeUndefined();
  });

  it('keeps ordinary INCREASECYCLE slices and non-recursive gates as separate columns', () => {
    const columns = buildVisualCircuitColumns([
      gate({ id: 'x', type: 'X', step: 0 }),
      gate({ id: 'c', type: 'CYCLE', step: 1, targets: [], cycle: 1 }),
      gate({ id: 'h', type: 'H', step: 2 }),
    ]);
    expect(columns).toHaveLength(3);
    expect(columns[1].cycleGate?.type).toBe('CYCLE');
    expect(columns[0].recursion).toBeUndefined();
  });
});
