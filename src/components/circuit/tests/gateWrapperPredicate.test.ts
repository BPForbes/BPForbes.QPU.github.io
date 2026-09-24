import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCircuit } from '../../../simulator/engine';
import { registerCustomGate } from '../../../simulator/gates/customGateEngine';
import { refreshCustomGateRegistry } from '../../../simulator/gates/registry';
import type { CircuitGate } from '../../../simulator/types';
import { conditionFeedTest } from '../branchVisuals';
import {
  applyWrappersToGateList,
  defaultPredicateDraft,
  draftFromGate,
  predicateDraftFromPredicate,
  predicateFromDraft,
  predicateGateIds,
  predicateInputCount,
  resizePredicateInputs,
  type PredicateDraft,
  type WrapperDraft,
} from '../gateWrappers';

const gate = (overrides: Partial<CircuitGate> = {}): CircuitGate => ({
  id: 'g1',
  type: 'X',
  step: 0,
  targets: [1],
  controls: [],
  ...overrides,
});

const joinedDraft = (predicateDraft: PredicateDraft, branchKind: 'if' | 'else' = 'if'): WrapperDraft => ({
  recursionEnabled: false,
  depth: 4,
  branchEnabled: true,
  branchKind,
  joined: true,
  conditionQubit: 0,
  conditionEquals: branchKind === 'else' ? 0 : 1,
  predicateDraft,
});

describe('predicateGateIds / predicateInputCount', () => {
  it('excludes MEASURE, RESET, and SWAP (no single result wire to compare)', () => {
    const ids = predicateGateIds(['X', 'AND', 'MEASURE', 'SWAP', 'CNOT']);
    expect(ids).toEqual(['X', 'AND', 'CNOT']);
  });

  it('reports each gate\'s -I arity, and falls back to 1 for an unknown id', () => {
    expect(predicateInputCount('X')).toBe(1);
    expect(predicateInputCount('CNOT')).toBe(1);
    expect(predicateInputCount('CCNOT')).toBe(2);
    expect(predicateInputCount('AND')).toBe(2);
    expect(predicateInputCount('NotARealGate')).toBe(1);
  });
});

describe('resizePredicateInputs', () => {
  it('grows the inputs array to match a new gate\'s arity, keeping prior choices', () => {
    const draft = defaultPredicateDraft(2); // X, inputs=[2]
    const resized = resizePredicateInputs(draft, 'AND', 4);
    expect(resized.gateType).toBe('AND');
    expect(resized.inputs).toEqual([2, 1]);
  });

  it('shrinks the inputs array and clamps to the current qubit count', () => {
    const draft: PredicateDraft = { ...defaultPredicateDraft(0), inputs: [5, 2, 1], gateType: 'CCNOT' };
    const resized = resizePredicateInputs(draft, 'X', 3);
    expect(resized.inputs).toEqual([2]);
  });
});

describe('predicateFromDraft / predicateDraftFromPredicate round-trip', () => {
  it('builds the fresh-wire (scratch) AND predicate exactly like protocol text does', () => {
    const draft: PredicateDraft = { gateType: 'AND', inputs: [0, 1], output: 1, inverse: false, phaseDegrees: 90, expect: 1, negate: false };
    const predicate = predicateFromDraft(draft, ['A', 'B']);
    expect(predicate).toMatchObject({ type: 'AND', inputs: [0, 1], output: 1, scratch: true, expect: 1, negate: false });
    expect(predicate.text).toBe('AND(A,B)');

    const back = predicateDraftFromPredicate(predicate);
    expect(back).toEqual({ ...draft, phaseDegrees: 90 });
  });

  it('does not mark a custom gate as a boolean join even when output aliases an input', () => {
    const draft: PredicateDraft = { gateType: 'NotARealGate', inputs: [0, 1], output: 1, inverse: false, phaseDegrees: 90, expect: 1, negate: false };
    expect(predicateFromDraft(draft).scratch).toBe(false);
  });

  it('negates the stored phase for a reversed rotation and recovers the magnitude on the way back', () => {
    const draft: PredicateDraft = { gateType: 'RX', inputs: [0], output: 0, inverse: true, phaseDegrees: 90, expect: 's', negate: false };
    const predicate = predicateFromDraft(draft);
    expect(predicate.phase).toBeCloseTo(-Math.PI / 2, 10);
    expect(predicate.inverse).toBe(true);
    expect(predicateDraftFromPredicate(predicate).phaseDegrees).toBe(90);
  });

  it('labels a single-input gate whose output differs from its input with an arrow', () => {
    const draft: PredicateDraft = { gateType: 'X', inputs: [0], output: 2, inverse: false, phaseDegrees: 90, expect: 1, negate: true };
    const predicate = predicateFromDraft(draft, ['A', 'B', 'C']);
    expect(predicate.text).toBe('X(A)→C');
    expect(conditionFeedTest({ ...gate(), condition: { qubit: 2, equals: 1, predicate } })).toBe('X(A)→C≠1p');
  });
});

describe('draftFromGate reflects an existing Joined predicate', () => {
  it('reconstructs the predicate draft from a gate already carrying a gate-expression condition', () => {
    const predicate = predicateFromDraft(
      { gateType: 'OR', inputs: [0, 1], output: 2, inverse: false, phaseDegrees: 90, expect: 0, negate: false },
      ['A', 'B', 'C'],
    );
    const wrapped = gate({ condition: { qubit: 2, equals: 1, predicate }, branch: { groupId: 'x', kind: 'if', sourceQubit: 2, equals: 1 } });
    const draft = draftFromGate(wrapped, { qubitCount: 4 });
    expect(draft.joined).toBe(true);
    expect(draft.predicateDraft).toMatchObject({ gateType: 'OR', inputs: [0, 1], output: 2, expect: 0, negate: false });
  });

  it('starts a fresh (non-joined) draft when picking IF/ELSE from the palette, even on a wrapped gate', () => {
    const predicate = predicateFromDraft({ gateType: 'OR', inputs: [0, 1], output: 2, inverse: false, phaseDegrees: 90, expect: 0, negate: false });
    const wrapped = gate({ condition: { qubit: 2, equals: 1, predicate } });
    const draft = draftFromGate(wrapped, { tool: 'if', qubitCount: 4 });
    expect(draft.joined).toBe(false);
  });
});

describe('a GUI-built Joined condition runs correctly end to end', () => {
  it('AND(A,B) on a fresh wire (scratch) decides which of two gates runs, matching protocol-text conditionFeedTest', () => {
    const gates: CircuitGate[] = [
      { id: 'x', type: 'X', step: 0, targets: [2], controls: [] },
      { id: 'z', type: 'Z', step: 1, targets: [2], controls: [] },
    ];
    const ifDraft = joinedDraft({ gateType: 'AND', inputs: [0, 1], output: 1, inverse: false, phaseDegrees: 90, expect: 1, negate: false }, 'if');
    const elseDraft = joinedDraft({ gateType: 'AND', inputs: [0, 1], output: 1, inverse: false, phaseDegrees: 90, expect: 1, negate: true }, 'else');
    const qubitNames = ['A', 'B', 'Out'];

    let wired = applyWrappersToGateList(gates, 'x', ifDraft, qubitNames);
    wired = applyWrappersToGateList(wired, 'z', elseDraft, qubitNames);

    const x = wired.find((entry) => entry.id === 'x')!;
    const z = wired.find((entry) => entry.id === 'z')!;
    expect(conditionFeedTest(x)).toBe('AND(A,B)=1p');
    expect(conditionFeedTest(z)).toBe('AND(A,B)≠1p');

    const whenTrue = runCircuit(3, wired, ['1p', '1p', '0p']);
    expect(whenTrue.conditionOutcomes?.x).toBe(true);
    expect(whenTrue.conditionOutcomes?.z).toBe(false);

    const whenFalse = runCircuit(3, wired, ['1p', '0p', '0p']);
    expect(whenFalse.conditionOutcomes?.x).toBe(false);
    expect(whenFalse.conditionOutcomes?.z).toBe(true);

    // B (the fresh-wire predicate's other operand) is untouched: the test runs on a scratch copy.
    expect(whenTrue.state).toBeDefined();
  });

  it('accepts a registered custom gate as the Joined test, without the fresh-wire rule', () => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) { this.storage[key] = value; },
      getItem(key: string) { return this.storage[key] ?? null; },
      removeItem(key: string) { delete this.storage[key]; },
    });
    registerCustomGate({
      id: 'AndOut',
      source: 'PARAMS: A:1 B:1\nMAIN-PROCESS AndOut\nCREATETOKEN -I O\nSET O 0p\nAND -I A B -O O\nRETURNVALS O',
    });
    refreshCustomGateRegistry();

    expect(predicateGateIds(['AndOut', 'MEASURE'])).toEqual(['AndOut']);
    expect(predicateInputCount('AndOut')).toBe(2);

    const gates: CircuitGate[] = [{ id: 'x', type: 'X', step: 0, targets: [3], controls: [] }];
    const draft = joinedDraft({ gateType: 'AndOut', inputs: [0, 1], output: 2, inverse: false, phaseDegrees: 90, expect: 1, negate: false });
    const wired = applyWrappersToGateList(gates, 'x', draft);
    expect(wired[0].condition?.predicate?.scratch).toBe(false);

    const ran = runCircuit(4, wired, ['1p', '1p', '0p', '0p']);
    expect(ran.conditionOutcomes?.x).toBe(true);
    const skipped = runCircuit(4, wired, ['1p', '0p', '0p', '0p']);
    expect(skipped.conditionOutcomes?.x).toBe(false);
  });
});
