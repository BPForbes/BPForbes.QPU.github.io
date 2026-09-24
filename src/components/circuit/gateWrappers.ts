/**
 * Canvas helpers for tagging gates with recursive DEPTH and IF/ELSE wrappers.
 * These mutate CircuitGate metadata the same way the compiler attaches it;
 * the simulator still only evaluates `condition`, and the canvas reads `branch`
 * / `recursion` for labels and badges.
 */
import type {
  CircuitGate,
  ClassicalBranchMeta,
  ConditionPredicate,
  GateCondition,
  RecursionFrameMeta,
} from '../../simulator/types';
import { sameExpansion } from './recursionVisuals';

export type GateWrapperTool = 'rec' | 'if' | 'else';

export const GATE_WRAPPER_TOOLS: ReadonlyArray<{
  id: GateWrapperTool;
  label: string;
  title: string;
}> = [
  { id: 'rec', label: 'REC', title: 'Recursive wrapper · set DEPTH, then click a gate' },
  { id: 'if', label: 'IF', title: 'IF wrapper · set classical condition, then click a gate' },
  { id: 'else', label: 'ELSE', title: 'ELSE wrapper · set classical condition, then click a gate' },
];

export type WrapperDraft = {
  recursionEnabled: boolean;
  depth: number;
  branchEnabled: boolean;
  branchKind: 'if' | 'else';
  conditionQubit: number;
  conditionEquals: 0 | 1;
  /** Gate-expression IF from protocol text; kept as-is (edited in the protocol, not the dialog). */
  predicate?: ConditionPredicate;
};

export const gateHasWrappers = (gate: CircuitGate): boolean =>
  Boolean(gate.condition || gate.branch || gate.recursion);

const sameRecursionGroup = sameExpansion;

export const createBranchMeta = (
  kind: 'if' | 'else',
  qubit: number,
  equals: 0 | 1,
  groupId = `branch-gui-${crypto.randomUUID()}`,
): ClassicalBranchMeta => ({
  groupId,
  kind,
  sourceQubit: qubit,
  equals,
});

export const createRecursionMeta = (depth: number, process = 'Canvas'): RecursionFrameMeta => {
  const clamped = Math.max(1, Math.floor(depth));
  return {
    process,
    depth: clamped,
    level: 0,
    rootDepth: clamped,
    mode: 'stack',
    invocation: `canvas-${crypto.randomUUID()}`,
  };
};

export const draftFromGate = (
  gate: CircuitGate,
  options?: { tool?: GateWrapperTool; qubitCount?: number },
): WrapperDraft => {
  const tool = options?.tool;
  const maxQubit = Math.max(0, (options?.qubitCount ?? 1) - 1);
  const existingQubit = gate.condition?.qubit ?? gate.branch?.sourceQubit ?? 0;
  const conditionQubit = Math.min(Math.max(0, existingQubit), maxQubit);

  if (tool === 'rec') {
    return {
      recursionEnabled: true,
      depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
      branchEnabled: Boolean(gate.condition || gate.branch),
      branchKind: gate.branch?.kind ?? 'if',
      conditionQubit,
      conditionEquals: gate.condition?.equals ?? gate.branch?.equals ?? 1,
    };
  }

  if (tool === 'if' || tool === 'else') {
    return {
      recursionEnabled: Boolean(gate.recursion),
      depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
      branchEnabled: true,
      branchKind: tool,
      conditionQubit,
      conditionEquals: tool === 'else' ? 0 : 1,
    };
  }

  return {
    recursionEnabled: Boolean(gate.recursion),
    depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
    branchEnabled: Boolean(gate.condition || gate.branch),
    branchKind: gate.branch?.kind ?? (gate.condition?.equals === 0 ? 'else' : 'if'),
    conditionQubit,
    conditionEquals: gate.condition?.equals ?? gate.branch?.equals ?? 1,
    ...(gate.condition?.predicate ? { predicate: gate.condition.predicate } : {}),
  };
};

const applyDraftToGate = (gate: CircuitGate, draft: WrapperDraft): CircuitGate => {
  const next: CircuitGate = { ...gate };
  delete next.condition;
  delete next.branch;
  delete next.recursion;

  if (draft.recursionEnabled) {
    const prior = gate.recursion;
    const depth = Math.max(1, Math.floor(draft.depth));
    next.recursion = prior
      ? {
          ...prior,
          depth: Math.min(prior.depth, depth),
          rootDepth: depth,
        }
      : createRecursionMeta(depth);
  }

  if (draft.branchEnabled && draft.predicate && gate.condition?.predicate) {
    next.condition = gate.condition;
    if (gate.branch) next.branch = gate.branch;
  } else if (draft.branchEnabled) {
    const qubit = Math.max(0, Math.floor(draft.conditionQubit));
    const equals = draft.conditionEquals === 0 ? 0 : 1;
    const condition: GateCondition = { qubit, equals };
    next.condition = condition;
    next.branch = createBranchMeta(
      draft.branchKind,
      qubit,
      equals,
      gate.branch?.groupId,
    );
  }

  return next;
};

/** Strip recursion / condition / branch wrappers, leaving the underlying gate. */
export const stripGateWrappers = (gate: CircuitGate): CircuitGate => {
  const next: CircuitGate = { ...gate };
  delete next.condition;
  delete next.branch;
  delete next.recursion;
  return next;
};

/**
 * Apply a wrapper draft to one gate. When the gate belongs to a recursive
 * expansion group, recursion fields update across the whole group so the
 * collapsed D{n} badge stays consistent.
 */
export const applyWrappersToGateList = (
  gates: readonly CircuitGate[],
  gateId: string,
  draft: WrapperDraft,
): CircuitGate[] => {
  const target = gates.find((gate) => gate.id === gateId);
  if (!target) return [...gates];

  const updatedTarget = applyDraftToGate(target, draft);
  const priorRecursion = target.recursion;

  return gates.map((gate) => {
    if (gate.id === gateId) return updatedTarget;
    if (
      priorRecursion
      && gate.recursion
      && sameRecursionGroup(gate.recursion, priorRecursion)
    ) {
      if (!draft.recursionEnabled) {
        const withoutRecursion: CircuitGate = { ...gate };
        delete withoutRecursion.recursion;
        return withoutRecursion;
      }
      const depth = Math.max(1, Math.floor(draft.depth));
      return {
        ...gate,
        recursion: {
          ...gate.recursion,
          depth: Math.min(gate.recursion.depth, depth),
          rootDepth: depth,
        },
      };
    }
    return gate;
  });
};

/** Remove wrappers from a gate (and its recursive expansion siblings). */
export const stripWrappersFromGateList = (
  gates: readonly CircuitGate[],
  gateId: string,
): CircuitGate[] => {
  const target = gates.find((gate) => gate.id === gateId);
  if (!target) return [...gates];
  const priorRecursion = target.recursion;

  return gates.map((gate) => {
    if (gate.id === gateId) return stripGateWrappers(gate);
    if (
      priorRecursion
      && gate.recursion
      && sameRecursionGroup(gate.recursion, priorRecursion)
    ) {
      return stripGateWrappers(gate);
    }
    return gate;
  });
};
