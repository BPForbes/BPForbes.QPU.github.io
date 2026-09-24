/**
 * Compile-time bounded child-process recursion helpers.
 *
 * REC / TREC / RECUR / DEPTH / EXIT WHEN expand during compilation only.
 * Tail-position REC (and explicit TREC) use TCO: iterative frame reuse, O(1)
 * compiler stack — like F# converting tail recursion into a loop.
 */

export const MAX_COMPILER_RECURSION_DEPTH = 64;

export type RecursionMode = 'tco' | 'stack';

export type ProcessExecutionContext = {
  rootProcess: string;
  /** Process name allowed to self-expand under the current recursion chain. */
  recursionProcess?: string;
  /** Remaining expansions for the current recursive child. */
  recursionDepth?: number;
  /** Original depth requested by the parent invocation. */
  rootDepth?: number;
  /** 0-based recursion level (LEVEL ≈ ROOTDEPTH - DEPTH). */
  level?: number;
  /** Active process names from root to current frame (for mutual-recursion checks). */
  callStack: string[];
  /** How this recursive child expands: TCO loop vs stacked frames. */
  recursionMode?: RecursionMode;
  /** Identity of the call site that started this recursion chain. */
  recursionInvocation?: string;
};

export type WhenOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type WhenClause = {
  left: 'DEPTH' | 'LEVEL' | 'ROOTDEPTH';
  operator: WhenOperator;
  right: number;
};

export type RecursionMeta = {
  allowsRecursion: boolean;
  /** Explicit TREC declaration (must be tail form). */
  requiresTail: boolean;
  maxDepth?: number;
};

export type RecursionFormAnalysis = {
  allowsRecursion: boolean;
  declaredRec: boolean;
  declaredTrec: boolean;
  hasRecur: boolean;
  /** Every RECUR / self-RUNCHILD is followed only by RETURNVALS. */
  isTail: boolean;
  maxDepth?: number;
  /** Reason when isTail is false (for TREC diagnostics). */
  nonTailReason?: string;
};

type ProcessLike = {
  name: string;
  lines: string[];
};

const WHEN_OPS: WhenOperator[] = ['==', '!=', '<=', '>=', '<', '>'];

const lineOpcode = (line: string) => line.trim().split(/\s+/)[0]?.toUpperCase() ?? '';

export const parseWhenClause = (tokens: string[]): WhenClause => {
  const upper = tokens.map((token) => token.toUpperCase());
  const whenAt = upper.indexOf('WHEN');
  if (whenAt === -1) {
    throw new Error('EXIT requires WHEN <DEPTH|LEVEL|ROOTDEPTH> <op> <number>');
  }
  const left = upper[whenAt + 1];
  const operator = tokens[whenAt + 2] as WhenOperator;
  const rightRaw = tokens[whenAt + 3];
  if (left !== 'DEPTH' && left !== 'LEVEL' && left !== 'ROOTDEPTH') {
    throw new Error(`EXIT WHEN left-hand side must be DEPTH, LEVEL, or ROOTDEPTH (got '${tokens[whenAt + 1] ?? ''}')`);
  }
  if (!WHEN_OPS.includes(operator)) {
    throw new Error(`Unsupported WHEN operator '${operator ?? ''}'`);
  }
  const right = Number(rightRaw);
  if (!Number.isInteger(right)) {
    throw new Error(`WHEN comparison requires an integer (got '${rightRaw ?? ''}')`);
  }
  return { left, operator, right };
};

export const evaluateWhenClause = (
  clause: WhenClause,
  values: { depth?: number; rootDepth?: number; level?: number },
): boolean => {
  const depth = values.depth;
  const rootDepth = values.rootDepth;
  const level = values.level ?? (
    rootDepth !== undefined && depth !== undefined ? rootDepth - depth : undefined
  );
  const value = clause.left === 'DEPTH'
    ? depth
    : clause.left === 'LEVEL'
      ? level
      : rootDepth;
  if (value === undefined) {
    // Outside a recursive child frame these metadata values are unset.
    return false;
  }
  switch (clause.operator) {
    case '==': return value === clause.right;
    case '!=': return value !== clause.right;
    case '<': return value < clause.right;
    case '<=': return value <= clause.right;
    case '>': return value > clause.right;
    case '>=': return value >= clause.right;
    default: return false;
  }
};

export const parseDepthFlag = (tokens: string[]): number | undefined => {
  const upper = tokens.map((token) => token.toUpperCase());
  const index = upper.findIndex((token) => token === '-DEPTH' || token.startsWith('-DEPTH='));
  if (index === -1) return undefined;
  const token = tokens[index];
  const inline = token.includes('=') ? token.split('=')[1] : tokens[index + 1];
  if (inline === undefined) throw new Error('-DEPTH requires a positive integer');
  const depth = Number(inline);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`-DEPTH must be a positive integer (got '${inline}')`);
  }
  return depth;
};

export const parseRecDeclaration = (tokens: string[]): RecursionMeta => {
  // REC | TREC  or  REC MAXDEPTH 16 | TREC MAXDEPTH 16
  const head = tokens[0]?.toUpperCase();
  const requiresTail = head === 'TREC';
  if (head !== 'REC' && head !== 'TREC') {
    throw new Error(`Expected REC or TREC (got '${tokens[0] ?? ''}')`);
  }
  const upper = tokens.map((token) => token.toUpperCase());
  const maxAt = upper.indexOf('MAXDEPTH');
  if (maxAt === -1) return { allowsRecursion: true, requiresTail };
  const raw = tokens[maxAt + 1];
  const maxDepth = Number(raw);
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`${head} MAXDEPTH requires a positive integer (got '${raw ?? ''}')`);
  }
  if (maxDepth > MAX_COMPILER_RECURSION_DEPTH) {
    throw new Error(`${head} MAXDEPTH ${maxDepth} exceeds compiler limit ${MAX_COMPILER_RECURSION_DEPTH}`);
  }
  return { allowsRecursion: true, requiresTail, maxDepth };
};

const isSelfRecurLine = (line: string, processName: string) => {
  const tokens = line.trim().split(/\s+/);
  const op = tokens[0]?.toUpperCase();
  if (op === 'RECUR') return true;
  if (op === 'RUNCHILD' || op === 'CALL') {
    return tokens[1] === processName;
  }
  return false;
};

const isTailFollower = (line: string) => {
  const op = lineOpcode(line);
  return op === 'RETURNVALS' || op === '';
};

/**
 * F#-style analysis: REC may auto-TCO when every recursive call is in tail position.
 * TREC requires that form and errors if it is not.
 */
export const analyzeRecursionForm = (process: ProcessLike): RecursionFormAnalysis => {
  let declaredRec = false;
  let declaredTrec = false;
  let maxDepth: number | undefined;
  let hasRecur = false;
  let isTail = true;
  let nonTailReason: string | undefined;

  for (const line of process.lines) {
    const op = lineOpcode(line);
    if (op === 'REC' || op === 'TREC') {
      const meta = parseRecDeclaration(line.trim().split(/\s+/));
      if (op === 'TREC') declaredTrec = true;
      else declaredRec = true;
      if (meta.maxDepth !== undefined) maxDepth = meta.maxDepth;
    }
  }

  process.lines.forEach((line, index) => {
    if (!isSelfRecurLine(line, process.name)) return;
    hasRecur = true;
    const followers = process.lines.slice(index + 1).filter((entry) => lineOpcode(entry) !== '');
    const bad = followers.find((entry) => !isTailFollower(entry));
    if (bad) {
      isTail = false;
      nonTailReason = `operations appear after recursive call before RETURNVALS ('${bad.trim()}')`;
    }
  });

  if (!hasRecur) {
    isTail = false;
  }

  const allowsRecursion = declaredRec || declaredTrec || hasRecur;
  return {
    allowsRecursion,
    declaredRec,
    declaredTrec,
    hasRecur,
    isTail: Boolean(hasRecur && isTail),
    maxDepth,
    nonTailReason,
  };
};

/** Prefer TCO when tail (REC auto or TREC). Non-tail REC stays stacked. */
export const resolveRecursionMode = (analysis: RecursionFormAnalysis): RecursionMode | undefined => {
  if (!analysis.allowsRecursion || !analysis.hasRecur) return undefined;
  if (analysis.declaredTrec && !analysis.isTail) {
    throw new Error(
      `TREC process requires tail form: ${analysis.nonTailReason ?? 'RECUR is not in tail position'}. `
      + 'Use REC for non-tail recursion, or move post-RECUR work into the next frame.',
    );
  }
  if (analysis.isTail) return 'tco';
  return 'stack';
};

/** True when the process body declares REC/TREC or contains RECUR. */
export const processDeclaresRecursion = (process: ProcessLike): boolean =>
  analyzeRecursionForm(process).allowsRecursion;

export const processMaxDepth = (process: ProcessLike): number | undefined =>
  analyzeRecursionForm(process).maxDepth;

export type RecursionExpansionPlan =
  | { kind: 'compose' }
  | { kind: 'stop'; reason: string }
  | {
      kind: 'expand';
      recursionProcess: string;
      recursionDepth: number;
      rootDepth: number;
      level: number;
      recursionMode: RecursionMode;
    };

/**
 * Decide how to expand a child / RECUR under the recursion rules.
 * - Root cannot appear as a recursive target.
 * - Only self-recursion of one child chain is allowed (no mutual recursion).
 * - First entry into a recursive child requires -DEPTH.
 * - Tail REC/TREC expand with recursionMode: 'tco'.
 */
export const planRecursionExpansion = ({
  childName,
  currentProcessName,
  context,
  requestedDepth,
  childIsRecursive,
  childMaxDepth,
  isExplicitRecur,
  frameAllowsRecursion,
  childRecursionMode,
}: {
  childName: string;
  currentProcessName: string;
  context: ProcessExecutionContext;
  requestedDepth?: number;
  childIsRecursive: boolean;
  childMaxDepth?: number;
  isExplicitRecur: boolean;
  frameAllowsRecursion: boolean;
  childRecursionMode?: RecursionMode;
}): RecursionExpansionPlan => {
  const selfRecursive = isExplicitRecur || childName === currentProcessName;

  if (selfRecursive && currentProcessName === context.rootProcess) {
    throw new Error(
      `RECUR is only valid from a child-process frame. '${currentProcessName}' is currently the compilation root.`,
    );
  }

  if (childName === context.rootProcess) {
    throw new Error(
      `MAIN-PROCESS '${context.rootProcess}' cannot recursively expand itself.`,
    );
  }

  if (selfRecursive && !frameAllowsRecursion) {
    throw new Error(
      `RECUR requires REC or TREC in process '${currentProcessName}'.`,
    );
  }

  if (
    context.callStack.includes(childName)
    && !(selfRecursive && (context.recursionProcess === childName || context.recursionProcess === currentProcessName))
  ) {
    throw new Error(
      `Mutual recursion is not allowed ('${context.callStack.join(' → ')} → ${childName}'). Only a single child may self-expand.`,
    );
  }

  if (selfRecursive) {
    const remaining = (context.recursionDepth ?? 1) - 1;
    if (remaining <= 0) {
      return {
        kind: 'stop',
        reason: `Recursive expansion of ${childName} reached its base depth.`,
      };
    }
    const rootDepth = context.rootDepth ?? (context.recursionDepth ?? remaining);
    return {
      kind: 'expand',
      recursionProcess: childName,
      recursionDepth: remaining,
      rootDepth,
      level: (context.level ?? 0) + 1,
      recursionMode: context.recursionMode ?? childRecursionMode ?? 'stack',
    };
  }

  if (!childIsRecursive) {
    return { kind: 'compose' };
  }

  if (requestedDepth === undefined) {
    throw new Error(
      `RUNCHILD ${childName} requires -DEPTH because '${childName}' is recursive (REC/TREC/RECUR).`,
    );
  }
  if (requestedDepth > MAX_COMPILER_RECURSION_DEPTH) {
    throw new Error(
      `Requested recursion depth ${requestedDepth} exceeds compiler limit ${MAX_COMPILER_RECURSION_DEPTH}.`,
    );
  }
  if (childMaxDepth !== undefined && requestedDepth > childMaxDepth) {
    throw new Error(
      `Requested recursion depth ${requestedDepth} exceeds ${childName} MAXDEPTH ${childMaxDepth}.`,
    );
  }

  return {
    kind: 'expand',
    recursionProcess: childName,
    recursionDepth: requestedDepth,
    rootDepth: requestedDepth,
    level: 0,
    recursionMode: childRecursionMode ?? 'stack',
  };
};
