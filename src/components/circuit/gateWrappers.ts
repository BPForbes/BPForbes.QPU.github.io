/**
 * Canvas helpers for tagging gates with recursive DEPTH and IF/ELSE wrappers.
 * These mutate CircuitGate metadata the same way the compiler attaches it;
 * the simulator still only evaluates `condition`, and the canvas reads `branch`
 * / `recursion` for labels and badges.
 */
import { buildConditionPredicate } from '../../simulator/gates/conditions';
import { astDerivedGateIds, getGateDefinition } from '../../simulator/gates/registry';
import type {
  CircuitGate,
  ClassicalBranchMeta,
  ConditionPredicate,
  ConditionValue,
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

/** Editable "Joined" gate-expression condition: pick a gate, wire it up, and test its result. */
export type PredicateDraft = {
  gateType: string;
  /** Every -I wire, in order; its length tracks the selected gate's input arity. */
  inputs: number[];
  /** The -O wire the result is read from. */
  output: number;
  /** dg/inv, for reversible gates only. */
  inverse: boolean;
  /** 0–360°, for PHASE/RX/RY/RZ/CPHASE only. */
  phaseDegrees: number;
  expect: ConditionValue;
  /** = vs != . */
  negate: boolean;
};

export type WrapperDraft = {
  recursionEnabled: boolean;
  depth: number;
  branchEnabled: boolean;
  branchKind: 'if' | 'else';
  /** false/undefined (default) = plain measured-bit condition ("A=1"); true = "Joined" gate-expression condition. */
  joined?: boolean;
  conditionQubit: number;
  conditionEquals: 0 | 1;
  /** Draft for the "Joined" condition. Populated (with defaults) whenever a branch is enabled, so toggling `joined` on has something to show. */
  predicateDraft?: PredicateDraft;
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

/** Gate ids eligible as a "Joined" predicate test: exactly one result wire (excludes MEASURE, RESET, SWAP). */
export const predicateGateIds = (allGateIds: readonly string[]): string[] =>
  allGateIds.filter((id) => getGateDefinition(id)?.ioArity.minOutputs === 1);

/** Number of -I wires a gate expects (its arity), falling back to 1 for an unknown id. */
export const predicateInputCount = (gateType: string): number =>
  Math.max(1, getGateDefinition(gateType)?.ioArity.minInputs ?? 1);

const DEFAULT_PREDICATE_GATE = 'X';

/** Starting draft when "Joined" is first turned on: the wrapped gate's own wire, tested with X. */
export const defaultPredicateDraft = (outputQubit: number): PredicateDraft => ({
  gateType: DEFAULT_PREDICATE_GATE,
  inputs: [outputQubit],
  output: outputQubit,
  inverse: false,
  phaseDegrees: 90,
  expect: 1,
  negate: false,
});

/** Resize `inputs` to match a newly picked gate's arity, keeping existing wire choices where possible. */
export const resizePredicateInputs = (
  draft: PredicateDraft,
  gateType: string,
  qubitCount: number,
): PredicateDraft => {
  const count = predicateInputCount(gateType);
  const maxQubit = Math.max(0, qubitCount - 1);
  const inputs = Array.from({ length: count }, (_, index) => {
    const existing = draft.inputs[index];
    return existing !== undefined ? Math.min(existing, maxQubit) : Math.min(index, maxQubit);
  });
  return { ...draft, gateType, inputs };
};

/** Reconstruct an editable draft from a compiled/GUI-built predicate. */
export const predicateDraftFromPredicate = (predicate: ConditionPredicate): PredicateDraft => ({
  gateType: String(predicate.type),
  inputs: [...predicate.inputs],
  output: predicate.output,
  inverse: Boolean(predicate.inverse),
  // Reversed rotations store a negated phase (see buildConditionPredicate); the slider shows the magnitude.
  phaseDegrees: predicate.phase !== undefined ? Math.round((Math.abs(predicate.phase) * 180) / Math.PI) : 90,
  expect: predicate.expect,
  negate: predicate.negate,
});

/** Build a ConditionPredicate from a "Joined" draft, using the gate registry for arity/phase support. */
export const predicateFromDraft = (
  draft: PredicateDraft,
  qubitNames: readonly (string | undefined)[] = [],
): ConditionPredicate => {
  const definition = getGateDefinition(draft.gateType);
  const isBooleanJoin = astDerivedGateIds().includes(draft.gateType);
  const supportsPhase = definition?.supportsPhase ?? false;
  const nameFor = (qubit: number) => qubitNames[qubit] ?? `q${qubit}`;
  const phaseRadians = supportsPhase
    ? ((draft.phaseDegrees * Math.PI) / 180) * (draft.inverse ? -1 : 1)
    : undefined;
  return buildConditionPredicate({
    type: draft.gateType,
    inputs: draft.inputs,
    output: draft.output,
    isBooleanJoin,
    phase: phaseRadians,
    inverse: draft.inverse && (definition?.supportsReverse ?? false),
    expect: draft.expect,
    negate: draft.negate,
    inputNames: draft.inputs.map(nameFor),
    outputName: nameFor(draft.output),
  });
};

export const draftFromGate = (
  gate: CircuitGate,
  options?: { tool?: GateWrapperTool; qubitCount?: number },
): WrapperDraft => {
  const tool = options?.tool;
  const maxQubit = Math.max(0, (options?.qubitCount ?? 1) - 1);
  const existingQubit = gate.condition?.qubit ?? gate.branch?.sourceQubit ?? 0;
  const conditionQubit = Math.min(Math.max(0, existingQubit), maxQubit);
  const outputQubit = Math.min(gate.targets[0] ?? 0, maxQubit);

  if (tool === 'rec') {
    return {
      recursionEnabled: true,
      depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
      branchEnabled: Boolean(gate.condition || gate.branch),
      branchKind: gate.branch?.kind ?? 'if',
      joined: Boolean(gate.condition?.predicate),
      conditionQubit,
      conditionEquals: gate.condition?.equals ?? gate.branch?.equals ?? 1,
      predicateDraft: gate.condition?.predicate
        ? predicateDraftFromPredicate(gate.condition.predicate)
        : defaultPredicateDraft(outputQubit),
    };
  }

  if (tool === 'if' || tool === 'else') {
    return {
      recursionEnabled: Boolean(gate.recursion),
      depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
      branchEnabled: true,
      branchKind: tool,
      joined: false,
      conditionQubit,
      conditionEquals: tool === 'else' ? 0 : 1,
      predicateDraft: defaultPredicateDraft(outputQubit),
    };
  }

  return {
    recursionEnabled: Boolean(gate.recursion),
    depth: gate.recursion?.rootDepth ?? gate.recursion?.depth ?? 4,
    branchEnabled: Boolean(gate.condition || gate.branch),
    branchKind: gate.branch?.kind ?? (gate.condition?.equals === 0 ? 'else' : 'if'),
    joined: Boolean(gate.condition?.predicate),
    conditionQubit,
    conditionEquals: gate.condition?.equals ?? gate.branch?.equals ?? 1,
    predicateDraft: gate.condition?.predicate
      ? predicateDraftFromPredicate(gate.condition.predicate)
      : defaultPredicateDraft(outputQubit),
  };
};

const applyDraftToGate = (
  gate: CircuitGate,
  draft: WrapperDraft,
  qubitNames: readonly (string | undefined)[] = [],
): CircuitGate => {
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

  if (draft.branchEnabled && draft.joined && draft.predicateDraft) {
    const predicate = predicateFromDraft(draft.predicateDraft, qubitNames);
    const equals = draft.branchKind === 'else' ? 0 : 1;
    const condition: GateCondition = { qubit: predicate.output, equals, predicate };
    next.condition = condition;
    next.branch = createBranchMeta(draft.branchKind, predicate.output, equals, gate.branch?.groupId);
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
  qubitNames: readonly (string | undefined)[] = [],
): CircuitGate[] => {
  const target = gates.find((gate) => gate.id === gateId);
  if (!target) return [...gates];

  const updatedTarget = applyDraftToGate(target, draft, qubitNames);
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
