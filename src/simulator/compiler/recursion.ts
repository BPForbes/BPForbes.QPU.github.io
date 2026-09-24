/**
 * Compile-time bounded child-process recursion helpers.
 *
 * REC / RECUR / DEPTH / EXIT WHEN expand during compilation only. The simulator
 * still receives a flat finite gate list — never a runtime loop or recursive
 * execution edge.
 */

export const MAX_COMPILER_RECURSION_DEPTH = 64;

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
};

export type WhenOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type WhenClause = {
  left: 'DEPTH' | 'LEVEL' | 'ROOTDEPTH';
  operator: WhenOperator;
  right: number;
};

export type RecursionMeta = {
  allowsRecursion: boolean;
  maxDepth?: number;
};

type ProcessLike = {
  name: string;
  lines: string[];
};

const WHEN_OPS: WhenOperator[] = ['==', '!=', '<=', '>=', '<', '>'];

export const parseWhenClause = (tokens: string[]): WhenClause => {
  // EXIT WHEN DEPTH == 0  → tokens after EXIT (or including WHEN…)
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
  context: ProcessExecutionContext | undefined,
): boolean => {
  const depth = context?.recursionDepth;
  const rootDepth = context?.rootDepth;
  const level = context?.level ?? (
    rootDepth !== undefined && depth !== undefined ? rootDepth - depth : undefined
  );
  const value = clause.left === 'DEPTH'
    ? depth
    : clause.left === 'LEVEL'
      ? level
      : rootDepth;
  if (value === undefined) {
    // Outside a recursive child frame these metadata values are unset. Treat the
    // comparison as false so EXIT WHEN DEPTH == 0 does not fire when a recursive
    // process file is compiled as the root (RECUR still rejects at the root).
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
  // REC  or  REC MAXDEPTH 16
  const upper = tokens.map((token) => token.toUpperCase());
  const maxAt = upper.indexOf('MAXDEPTH');
  if (maxAt === -1) return { allowsRecursion: true };
  const raw = tokens[maxAt + 1];
  const maxDepth = Number(raw);
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`REC MAXDEPTH requires a positive integer (got '${raw ?? ''}')`);
  }
  if (maxDepth > MAX_COMPILER_RECURSION_DEPTH) {
    throw new Error(`REC MAXDEPTH ${maxDepth} exceeds compiler limit ${MAX_COMPILER_RECURSION_DEPTH}`);
  }
  return { allowsRecursion: true, maxDepth };
};

/** True when the process body declares REC or contains RECUR. */
export const processDeclaresRecursion = (process: ProcessLike): boolean =>
  process.lines.some((line) => {
    const head = line.trim().split(/\s+/)[0]?.toUpperCase();
    return head === 'REC' || head === 'RECUR';
  });

export const processMaxDepth = (process: ProcessLike): number | undefined => {
  for (const line of process.lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0]?.toUpperCase() !== 'REC') continue;
    return parseRecDeclaration(tokens).maxDepth;
  }
  return undefined;
};

export type RecursionExpansionPlan =
  | { kind: 'compose' }
  | { kind: 'stop'; reason: string }
  | {
      kind: 'expand';
      recursionProcess: string;
      recursionDepth: number;
      rootDepth: number;
      level: number;
    };

/**
 * Decide how to expand a child / RECUR under the recursion rules.
 * - Root cannot appear as a recursive target.
 * - Only self-recursion of one child chain is allowed (no mutual recursion).
 * - First entry into a recursive child requires -DEPTH.
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
}: {
  childName: string;
  currentProcessName: string;
  context: ProcessExecutionContext;
  requestedDepth?: number;
  childIsRecursive: boolean;
  childMaxDepth?: number;
  isExplicitRecur: boolean;
  frameAllowsRecursion: boolean;
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
      `RECUR requires REC in process '${currentProcessName}'.`,
    );
  }

  // Mutual recursion: calling a different process that is already on the stack.
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
    };
  }

  if (!childIsRecursive) {
    return { kind: 'compose' };
  }

  if (requestedDepth === undefined) {
    throw new Error(
      `RUNCHILD ${childName} requires -DEPTH because '${childName}' is recursive (REC/RECUR).`,
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
  };
};
