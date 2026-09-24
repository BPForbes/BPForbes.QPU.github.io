import { describe, expect, it } from 'vitest';
import type { CircuitGate } from '../../../simulator/types';
import {
  applyWrappersToGateList,
  draftFromGate,
  gateHasWrappers,
  stripWrappersFromGateList,
} from '../gateWrappers';

const gate = (overrides: Partial<CircuitGate> = {}): CircuitGate => ({
  id: 'g1',
  type: 'X',
  step: 0,
  targets: [1],
  controls: [],
  ...overrides,
});

describe('gateWrappers', () => {
  it('builds an IF draft when the IF tool is selected', () => {
    const draft = draftFromGate(gate(), { tool: 'if', qubitCount: 3 });
    expect(draft.branchEnabled).toBe(true);
    expect(draft.branchKind).toBe('if');
    expect(draft.conditionEquals).toBe(1);
    expect(draft.recursionEnabled).toBe(false);
  });

  it('builds a recursive draft with DEPTH when the REC tool is selected', () => {
    const draft = draftFromGate(gate(), { tool: 'rec', qubitCount: 2 });
    expect(draft.recursionEnabled).toBe(true);
    expect(draft.depth).toBe(4);
  });

  it('applies recursion and IF wrappers together on save', () => {
    const next = applyWrappersToGateList([gate()], 'g1', {
      recursionEnabled: true,
      depth: 3,
      branchEnabled: true,
      branchKind: 'if',
      conditionQubit: 0,
      conditionEquals: 1,
    });
    expect(next[0].recursion).toMatchObject({ depth: 3, rootDepth: 3, process: 'Canvas' });
    expect(next[0].condition).toEqual({ qubit: 0, equals: 1 });
    expect(next[0].branch).toMatchObject({ kind: 'if', equals: 1, sourceQubit: 0 });
    expect(gateHasWrappers(next[0])).toBe(true);
  });

  it('updates rootDepth across a recursive expansion group', () => {
    const gates: CircuitGate[] = [
      gate({
        id: 'a',
        step: 0,
        recursion: { process: 'P', depth: 2, level: 0, rootDepth: 2, mode: 'stack' },
      }),
      gate({
        id: 'b',
        step: 1,
        recursion: { process: 'P', depth: 1, level: 1, rootDepth: 2, mode: 'stack' },
      }),
    ];
    const next = applyWrappersToGateList(gates, 'a', {
      recursionEnabled: true,
      depth: 5,
      branchEnabled: false,
      branchKind: 'if',
      conditionQubit: 0,
      conditionEquals: 1,
    });
    expect(next[0].recursion?.rootDepth).toBe(5);
    expect(next[1].recursion?.rootDepth).toBe(5);
    expect(next[1].recursion?.depth).toBe(1);
  });

  it('strips recursion and IF/ELSE wrappers without deleting the gate', () => {
    const wrapped = applyWrappersToGateList([gate()], 'g1', {
      recursionEnabled: true,
      depth: 2,
      branchEnabled: true,
      branchKind: 'else',
      conditionQubit: 0,
      conditionEquals: 0,
    });
    const cleared = stripWrappersFromGateList(wrapped, 'g1');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].type).toBe('X');
    expect(cleared[0].condition).toBeUndefined();
    expect(cleared[0].branch).toBeUndefined();
    expect(cleared[0].recursion).toBeUndefined();
    expect(gateHasWrappers(cleared[0])).toBe(false);
  });
});
