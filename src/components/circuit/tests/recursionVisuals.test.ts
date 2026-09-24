import { describe, expect, it } from 'vitest';
import type { CircuitGate } from '../../../simulator/types';
import {
  describeRecursionExpansion,
  recursionCycleLabel,
  recursionCycleTitle,
  recursionExpansionSummary,
} from '../recursionVisuals';

const gate = (overrides: Partial<CircuitGate> = {}): CircuitGate => ({
  id: 'g',
  type: 'H',
  step: 0,
  targets: [0],
  controls: [],
  ...overrides,
});

describe('recursion canvas visuals', () => {
  it('summarizes TCO expansion from gate metadata', () => {
    const gates = [
      gate({
        id: 'h0',
        recursion: { process: 'RecursiveH', depth: 3, level: 0, rootDepth: 3, mode: 'tco' },
      }),
      gate({
        id: 'c0',
        type: 'CYCLE',
        step: 1,
        targets: [],
        cycle: 1,
        recursion: { process: 'RecursiveH', depth: 3, level: 0, rootDepth: 3, mode: 'tco' },
      }),
      gate({
        id: 'h1',
        step: 2,
        recursion: { process: 'RecursiveH', depth: 2, level: 1, rootDepth: 3, mode: 'tco' },
      }),
    ];
    const summary = recursionExpansionSummary(gates);
    expect(summary).toEqual({
      process: 'RecursiveH',
      rootDepth: 3,
      mode: 'tco',
      stages: 2,
      levels: [0, 1],
    });
    expect(describeRecursionExpansion(summary!)).toMatch(/TCO/);
    expect(recursionCycleLabel(gates[1])).toContain('L0');
    expect(recursionCycleLabel(gates[1])).toContain('TCO');
    expect(recursionCycleTitle(gates[1])).toMatch(/DEPTH=3/);
  });

  it('returns undefined when no recursion metadata is present', () => {
    expect(recursionExpansionSummary([gate({ type: 'CYCLE', cycle: 1, targets: [] })])).toBeUndefined();
    expect(recursionCycleLabel(gate({ type: 'CYCLE', cycle: 2, targets: [] }))).toBe('2');
  });
});
