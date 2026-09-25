// QPU protocol compiler: child processes and logical cycles expand into flat gates so the simulator and UI share one execution model.
import { assertGateArity } from '../gates/arity';
import type { MeasurementBasis } from '../physics/measurement/MeasurementBasis';
import { astDerivedGateIds, astPrimitiveGateIds } from '../gates/metadata';
import { buildConditionPredicate, remapConditionWires } from '../gates/conditions';
import { getCustomGateRecord } from '../gates/customGateStore';
import {
  CircuitGate,
  ClassicalBranchMeta,
  conditionValueLabel,
  ConditionPredicate,
  ConditionValue,
  GateType,
  QpuOperation,
  RecursionFrameMeta,
} from '../types';
import {
  analyzeRecursionForm,
  evaluateWhenClause,
  parseDepthFlag,
  parseRecDeclaration,
  parseWhenClause,
  planRecursionExpansion,
  resolveRecursionMode,
  type ProcessExecutionContext,
} from './recursion';

export type ParsedCommand = {
  op: QpuOperation;
  raw: string;
  inputs: string[];
  outputs: string[];
  args: string[];
  phase?: number;
  reverse: boolean;
  noParameterSubstitution: boolean;
  /** Classical feed-forward: token name and required measurement value. */
  condition?: { token: string; equals: 0 | 1 };
  /** Compile-time recursion budget from RUNCHILD -DEPTH N. */
  depth?: number;
  /** Set when the opcode is a registered custom gate (its exact id). */
  customGateId?: string;
  /** MEASURE -BASIS X|Y|Z; omitted means the computational (Z) basis. */
  basis?: MeasurementBasis;
};

export type ProtocolProcess = {
  name: string;
  params: Array<{ name: string; type: string }>;
  lines: string[];
};

export type ProcessParam = {
  name: string;
  type: string;
  qubitIndex: number;
};

export type ReturnValue = {
  name: string;
  qubitIndex: number;
};

export type CompileWarning = {
  code: string;
  message: string;
  source?: string;
  suggestion?: string;
};

// Compile output separates physical simulator width from user-facing PARAMS/RETURNVALS mappings.
export type CompileResult = {
  gates: CircuitGate[];
  qubitCount: number;
  logicalQubitCount: number;
  parsed: ParsedCommand[];
  log: string[];
  warnings: CompileWarning[];
  tokenMap: Record<string, number>;
  processParams: ProcessParam[];
  returnValues: ReturnValue[];
};

const NUMERIC_PARAM_TYPES = ['int', 'float'] as const;

const primitiveGates = new Set(astPrimitiveGateIds());
const derivedGates = new Set(astDerivedGateIds());
const knownAstGates = new Set([...primitiveGates, ...derivedGates]);

export const supportedQpuOperations: QpuOperation[] = [
  'INCREASECYCLE',
  'COMPILEPROCESS',
  'FREE',
  'SET',
  'JOIN',
  'SPLIT',
  'CALL',
  'DECLARECHILD',
  'RUNCHILD',
  'REC',
  'TREC',
  'RECUR',
  'EXIT',
  'IF',
  'ELSE',
  'ENDIF',
  'AND',
  'NAND',
  'OR',
  'NOT',
  'XOR',
  'MEASURE',
  'RETURNVALS',
  'ACCEPTVALS',
  'MASTERVAL',
  'SAVE_STATE',
  'LOAD_STATE',
  'MAIN-PROCESS',
  'CREATETOKEN',
  'DELETETOKEN',
  'X',
  'Y',
  'Z',
  'H',
  'S',
  'T',
  'RX',
  'RY',
  'RZ',
  'CNOT',
  'CCNOT',
  'CZ',
  'CY',
  'CPHASE',
  'SWAP',
  'PHASE',
];

const rationalPattern = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\/([+-]?(?:\d+(?:\.\d+)?|\.\d+)))?$/;
const piPattern = /^([+-])?(?:(\d+)\*?)?pi(?:\/(\d+))?$/;

const parseRationalRotation = (value: string) => {
  const match = value.match(rationalPattern);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
};

// Authors write PHASE angles in degrees or pi fractions in protocol text; the compiler normalizes to simulator radians.
const parseRotationParameter = (value: string, gate: string) => {
  const normalized = value.trim().toLowerCase();

  if (normalized.endsWith('d')) {
    const degrees = parseRationalRotation(normalized.slice(0, -1));
    if (degrees !== undefined) return (degrees * Math.PI) / 180;
  }

  const piMatch = normalized.match(piPattern);
  if (piMatch) {
    const sign = piMatch[1] === '-' ? -1 : 1;
    const alpha = piMatch[2] === undefined ? 1 : Number(piMatch[2]);
    const beta = piMatch[3] === undefined ? 1 : Number(piMatch[3]);
    if (beta !== 0) return sign * (alpha * Math.PI) / beta;
  }

  const radians = parseRationalRotation(normalized);
  if (radians !== undefined) return radians;

  throw new Error(`Invalid ${gate} parameter '${value}'`);
};

const stripCycle = (token: string) => token.replace(/^\$/, '').split(':')[0];
const isConstant = (token: string) => /^(0p|1p|sp)(?:_dim\d+)?$/i.test(token.replace(/^\$/, ''));

// _dimN is a Hilbert-space dimension. Only powers of two fit this qubit register.
const isPowerOfTwoDimension = (dimension: number) =>
  Number.isInteger(dimension) && dimension >= 2 && (dimension & (dimension - 1)) === 0;

const preparedConstant = (token: string) => {
  const match = token.replace(/^\$/, '').match(/^(0p|1p|sp)(?:_dim(\d+))?$/i);
  if (!match) return undefined;
  return {
    kind: match[1].toLowerCase() as '0p' | '1p' | 'sp',
    dimension: match[2] === undefined ? 2 : Number(match[2]),
  };
};

const integerCycleSuffix = (token: string) => {
  const body = token.replace(/^\$/, '');
  const colon = body.indexOf(':');
  if (colon === -1) return undefined;
  const suffix = body.slice(colon + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
};

// Continuation-aware line reading keeps multi-line gate commands parseable without changing the protocol format.
export const readProtocolLines = (source: string): string[] => {
  const joined: string[] = [];
  let buffer = '';

  source.replace(/\r\n/g, '\n').split('\n').forEach((raw) => {
    const line = raw.endsWith('\\') ? raw.slice(0, -1).trimEnd() : raw;
    if (raw.endsWith('\\')) {
      buffer += `${line} `;
      return;
    }
    joined.push(`${buffer}${line}`);
    buffer = '';
  });
  if (buffer.trim()) joined.push(buffer);

  // Annotated protocol files must still round-trip; comment stripping runs after continuation joining so gate rows stay intact.
  let inBlockComment = false;
  return joined
    .map((raw) => {
      let line = raw.trim();
      if (!line) return '';
      if (inBlockComment) {
        if (!line.includes('*/')) return '';
        line = line.split('*/', 2)[1].trim();
        inBlockComment = false;
      }
      if (line.includes('/*')) {
        const [prefix, rest] = line.split('/*', 2);
        if (rest.includes('*/')) {
          line = `${prefix} ${rest.split('*/', 2)[1]}`.trim();
        } else {
          line = prefix.trim();
          inBlockComment = true;
        }
      }
      if (line.includes('#')) line = line.split('#', 1)[0].trim();
      return line;
    })
    .filter(Boolean);
};

export const parseParameters = (line: string): ProtocolProcess['params'] => {
  if (!line.toUpperCase().startsWith('PARAMS:')) return [];
  return line
    .slice(line.indexOf(':') + 1)
    .trim()
    .split(/\s+/)
    .filter((part) => part.includes(':'))
    .map((part) => {
      const [name, type] = part.split(':', 2);
      return { name, type };
    });
};

// Wrong -I/-O spans would mis-wire controls onto outputs, so each flag list ends at the next flag token.
const INVERSE_MARKERS = ['DG', 'INV'] as const;

const stripInverseMarker = (normalized: string): { opcode: string; reverse: boolean } => {
  const equalsAt = normalized.indexOf('=');
  const head = equalsAt === -1 ? normalized : normalized.slice(0, equalsAt);
  const tail = equalsAt === -1 ? '' : normalized.slice(equalsAt);

  for (const marker of INVERSE_MARKERS) {
    if (head.length > marker.length && head.endsWith(marker)) {
      const candidate = head.slice(0, -marker.length);
      // Strip on any known AST gate so MEASUREdg still parses and can warn as inactive.
      if (knownAstGates.has(candidate)) return { opcode: `${candidate}${tail}`, reverse: true };
    }
    if (head.length > marker.length && head.startsWith(marker)) {
      const candidate = head.slice(marker.length);
      if (knownAstGates.has(candidate)) return { opcode: `${candidate}${tail}`, reverse: true };
    }
  }

  return { opcode: normalized, reverse: false };
};

const splitFlagArgs = (tokens: string[], flag: '-I' | '-O') => {
  const upper = tokens.map((token) => token.toUpperCase());
  const start = upper.indexOf(flag);
  if (start === -1) return [];
  const end = upper.findIndex((token, index) => index > start && token.startsWith('-'));
  return tokens.slice(start + 1, end === -1 ? tokens.length : end);
};

/** Parse `-IF Token=0|1` classical feed-forward without introducing block control flow. */
const parseConditionFlag = (tokens: string[]): ParsedCommand['condition'] => {
  const upper = tokens.map((token) => token.toUpperCase());
  const start = upper.indexOf('-IF');
  if (start === -1) return undefined;
  const raw = tokens[start + 1];
  if (!raw) throw new Error('-IF requires Token=0 or Token=1');
  const match = raw.match(/^([A-Za-z_][\w]*)=(0|1)$/);
  if (!match) throw new Error(`Invalid -IF condition '${raw}' (expected Token=0 or Token=1)`);
  return { token: match[1], equals: Number(match[2]) as 0 | 1 };
};

/** Parse `MEASURE … -BASIS X|Y|Z`, the observable to measure. Only MEASURE accepts it. */
const parseBasisFlag = (tokens: string[], op: string): MeasurementBasis | undefined => {
  const upper = tokens.map((token) => token.toUpperCase());
  const start = upper.indexOf('-BASIS');
  if (start === -1) return undefined;
  if (op !== 'MEASURE') throw new Error(`-BASIS is only valid on MEASURE, not ${op}`);
  const value = upper[start + 1];
  if (value !== 'X' && value !== 'Y' && value !== 'Z') {
    throw new Error(`-BASIS requires X, Y, or Z${tokens[start + 1] ? ` (got '${tokens[start + 1]}')` : ''}`);
  }
  return value;
};

/** Parse `IF Token=0|1` structured classical branch header. */
type IfHeader =
  | { kind: 'bit'; token: string; equals: 0 | 1 }
  | { kind: 'predicate'; expression: string; negate: boolean; expect: ConditionValue };

const parseConditionValue = (raw: string): ConditionValue | undefined => {
  const value = raw.toLowerCase();
  if (value === '0' || value === '0p') return 0;
  if (value === '1' || value === '1p') return 1;
  if (value === 's' || value === 'sp') return 's';
  return undefined;
};

/**
 * `IF Token=0|1` tests a measured bit. `IF (GATE -I … -O …) = V` (or `!=`)
 * tests a gate expression, where V is 0/1/S or 0p/1p/sp.
 */
const parseIfHeader = (line: string): IfHeader => {
  const body = line.trim().replace(/^IF\b/i, '').trim();
  if (!body) throw new Error('IF requires Token=0|1 or (GATE -I … -O …) = 0|1|S');
  if (body.startsWith('(')) {
    const match = body.match(/^\((.+)\)\s*(!=|=)\s*(\S+)$/);
    const expect = match ? parseConditionValue(match[3]) : undefined;
    if (!match || expect === undefined) {
      throw new Error(`Invalid IF expression '${body}' (expected (GATE -I … -O …) = 0|1|S, or != )`);
    }
    return { kind: 'predicate', expression: match[1].trim(), negate: match[2] === '!=', expect };
  }
  const match = body.match(/^([A-Za-z_][\w]*)=(0|1)$/);
  if (!match) throw new Error(`Invalid IF condition '${body}' (expected Token=0 or Token=1)`);
  return { kind: 'bit', token: match[1], equals: Number(match[2]) as 0 | 1 };
};

/** Gates that make sense as IF predicates: one result wire, no measurement or reset. */
const PREDICATE_EXCLUDED = new Set(['MEASURE', 'RESET', 'SWAP']);

export const parseCommand = (line: string): ParsedCommand => {
  let tokens = line.trim().split(/\s+/);
  if (!tokens.length) throw new Error('Empty command');
  if (tokens[0].endsWith('=') && tokens[1]) tokens = [`${tokens[0]}${tokens[1]}`, ...tokens.slice(2)];

  const rawOp = tokens[0];
  const upperTokens = tokens.map((token) => token.toUpperCase());
  const noParameterSubstitution = upperTokens.includes('-$R');
  let phase: number | undefined;

  // dg (dagger) and inv (inverse) mark a reversible gate, either as a suffix (Sdg) or a prefix (dgS).
  // PHASE/RX/RY/RZ/CPHASE keep their angle on the opcode token: PHASEdg=pi/4 and dgPHASE=pi/4.
  const marked = stripInverseMarker(rawOp.toUpperCase());
  let normalized = marked.opcode;
  const reverse = marked.reverse;

  if (normalized.includes('=')) {
    const [gate, value] = normalized.split('=', 2);
    normalized = gate;
    phase = parseRotationParameter(value, gate);
    if (
      reverse
      && (normalized === 'PHASE' || normalized === 'RX' || normalized === 'RY' || normalized === 'RZ' || normalized === 'CPHASE')
    ) {
      phase *= -1;
    }
  }

  const inputs = splitFlagArgs(tokens, '-I');
  const outputs = splitFlagArgs(tokens, '-O');
  const condition = parseConditionFlag(tokens);
  const depth = parseDepthFlag(tokens);
  let op = normalized as QpuOperation;
  let customGateId: string | undefined;
  let customReverse = false;

  // A registered custom gate is written like any gate line: NAME -I params… -O returns…
  if (!supportedQpuOperations.includes(op)) {
    const bare = rawOp.split('=', 1)[0];
    const unmarked = bare.replace(/^(dg|inv)(?=[A-Za-z])/i, '').replace(/(dg|inv)$/i, '');
    const record = getCustomGateRecord(bare) ?? (unmarked !== bare ? getCustomGateRecord(unmarked) : undefined);
    if (!record) throw new Error(`Unknown command: ${normalized}`);
    customGateId = record.id;
    customReverse = record.id.toLowerCase() !== bare.toLowerCase();
    if (customReverse && !record.reversible) {
      throw new Error(`Custom gate '${record.id}' is not reversible and cannot be inverted in '${line}'.${record.reversibilityIssue ? ` ${record.reversibilityIssue}` : ''}`);
    }
    if (inputs.length !== record.inputParamNames.length) {
      throw new Error(`${record.id} takes ${record.inputParamNames.length} -I input(s) (${record.inputParamNames.join(' ')}), got ${inputs.length}`);
    }
    if (outputs.length !== record.outputParamNames.length) {
      throw new Error(`${record.id} returns ${record.outputParamNames.length} -O output(s) (${record.outputParamNames.join(' ')}), got ${outputs.length}`);
    }
    op = record.id as QpuOperation;
  }
  if ((primitiveGates.has(op) || derivedGates.has(op)) && !inputs.length && op !== 'MEASURE') {
    throw new Error(`${op} requires -I inputs`);
  }
  if ((primitiveGates.has(op) || derivedGates.has(op)) && op !== 'MEASURE' && !outputs.length) {
    throw new Error(`${op} requires -O output`);
  }
  if (primitiveGates.has(op) || derivedGates.has(op)) {
    assertGateArity(op, inputs.length, outputs.length);
  }
  if (op === 'RECUR' && !inputs.length) {
    throw new Error('RECUR requires -I inputs');
  }
  if (op === 'EXIT') {
    parseWhenClause(tokens.slice(1));
  }
  if (op === 'REC' || op === 'TREC') {
    parseRecDeclaration(tokens);
  }
  if (op === 'IF') {
    parseIfHeader(line);
  }
  const basis = parseBasisFlag(tokens, op);
  if (op === 'ELSE' || op === 'ENDIF') {
    if (tokens.length > 1) {
      throw new Error(`${op} does not take arguments`);
    }
  }

  return {
    op,
    raw: line,
    inputs,
    outputs,
    args: tokens.slice(1),
    phase,
    reverse,
    noParameterSubstitution,
    condition,
    depth,
    ...(basis ? { basis } : {}),
    ...(customGateId ? { customGateId, reverse: customReverse } : {}),
  };
};

export const parseProtocol = (source: string): ProtocolProcess => {
  const lines = readProtocolLines(source);
  const params = lines[0]?.toUpperCase().startsWith('PARAMS:') ? parseParameters(lines[0]) : [];
  const body = params.length ? lines.slice(1) : lines;
  const main = body.find((line) => line.toUpperCase().startsWith('MAIN-PROCESS '));
  return {
    name: main?.split(/\s+/)[1] ?? 'InlineProcess',
    params,
    lines: body,
  };
};

type Frame = {
  process: ProtocolProcess;
  scope: string;
  aliases: Map<string, string>;
  params: Map<string, string>;
  declaredChildren: Map<string, ProtocolProcess>;
  released: Set<string>;
  masterTokens: Array<{ name: string; line: string }>;
  returnBases: string[];
  /** Set by REC/TREC — required before RECUR / self-RUNCHILD expansion. */
  allowsRecursion: boolean;
  maxDepth?: number;
  /** Explicit TREC (or REC auto-TCO once analyzed). */
  prefersTco?: boolean;
};

type CompilerState = {
  gates: CircuitGate[];
  parsed: ParsedCommand[];
  log: string[];
  warnings: CompileWarning[];
  warningKeys: Set<string>;
  tokenToQubit: Map<string, number>;
  registers: Map<string, number[]>;
  resetQubits: Set<number>;
  pendingCycleZeros: Set<number>;
  knownZero: Set<number>;
  reusableQubits: number[];
  nextQubit: number;
  lastReturns: string[];
  frameCycle: number;
  timelineCycle: number;
  processRuns: number;
  rootScope: string;
  verifying: Set<string>;
  /** Active REC/TREC frame; stamped onto every gate emitted while set. */
  activeRecursion?: RecursionFrameMeta;
  /** Counter for RecursionFrameMeta.invocation ids. */
  nextRecursionInvocation: number;
};

const createCompilerState = (): CompilerState => ({
  gates: [],
  parsed: [],
  log: [],
  warnings: [],
  warningKeys: new Set(),
  tokenToQubit: new Map(),
  registers: new Map(),
  resetQubits: new Set(),
  pendingCycleZeros: new Set(),
  knownZero: new Set(),
  reusableQubits: [],
  nextQubit: 0,
  lastReturns: [],
  frameCycle: 0,
  timelineCycle: 0,
  processRuns: 0,
  rootScope: '',
  verifying: new Set(),
  nextRecursionInvocation: 0,
});

// Gates shown in the circuit UI; logical-cycle workspace prep is compiler-internal and never rendered.
export const visibleCircuitGates = (gates: CircuitGate[]) => gates.filter((gate) => gate.type !== 'RESET');

const processLibraryFromSources = (sources: Record<string, string>) => {
  const library = new Map<string, ProtocolProcess>();
  Object.values(sources).forEach((source) => {
    const process = parseProtocol(source);
    library.set(process.name, process);
  });
  return library;
};

const childWorkspaceKey = (parentFrame: Frame, base: string) => `${parentFrame.scope}/ws/${base}`;

const noteCycleSuffix = (state: CompilerState, token: string, line: string) => {
  const suffix = integerCycleSuffix(token);
  if (suffix === undefined || suffix === state.frameCycle) return;
  const key = `${line}|${stripCycle(token)}|${suffix}|${state.frameCycle}`;
  if (state.warningKeys.has(key)) return;
  state.warningKeys.add(key);
  state.warnings.push({
    code: 'CYCLE_SUFFIX_MISMATCH',
    message: `Token ${token} is marked as logical cycle ${suffix}, but this process is on logical cycle ${state.frameCycle}.`,
    source: line,
    suggestion: 'Use a suffix that matches the logical cycle, or move the reference next to the matching INCREASECYCLE.',
  });
};

// Scoped token names keep child-process registers isolated, except PARAMS, aliases, constants, and numeric workspace wires.
const scopedName = (
  state: CompilerState,
  frame: Frame,
  token: string,
  line: string,
  parentFrame?: Frame,
  skipParams = false,
) => {
  noteCycleSuffix(state, token, line);
  const base = stripCycle(token);
  if (frame.released.has(base)) {
    throw new Error(`Token '${base}' was released by FREE or DELETETOKEN in '${line}'`);
  }
  if (!skipParams && frame.params.has(base)) return frame.params.get(base)!;
  if (frame.aliases.has(base)) return frame.aliases.get(base)!;
  if (isConstant(base)) return base.toLowerCase();
  if (parentFrame && /^\d+$/.test(base)) return childWorkspaceKey(parentFrame, base);
  return `${frame.scope}/${base}`;
};

const emitGate = (
  state: CompilerState,
  type: GateType,
  targets: number[],
  controls: number[],
  source: string,
  phase?: number,
  checkpoint?: string,
  inverse?: boolean,
  condition?: CircuitGate['condition'],
  branch?: ClassicalBranchMeta,
) => {
  state.gates.push({
    id: `${type}-${state.gates.length}-${targets.join('-')}`,
    type,
    step: state.gates.length,
    targets,
    controls,
    phase,
    source,
    cycle: state.timelineCycle,
    checkpoint,
    inverse: inverse || undefined,
    condition,
    branch,
    recursion: state.activeRecursion ? { ...state.activeRecursion } : undefined,
  });
  if (type === 'RESET') {
    targets.forEach((qubit) => state.knownZero.add(qubit));
    return;
  }
  if (type === 'LOAD_STATE') {
    state.knownZero.clear();
    return;
  }
  if (type === 'CYCLE' || type === 'SAVE_STATE') return;
  targets.forEach((qubit) => state.knownZero.delete(qubit));
};

// Symbolic tokens lazily claim the next simulator wire; constants share keyed slots so 0p/1p/sp init once.
const ensureQubit = (state: CompilerState, canonical: string, knownZero = true) => {
  const key = isConstant(canonical) ? `const/${canonical.toLowerCase()}` : canonical;
  const existing = state.tokenToQubit.get(key);
  if (existing !== undefined) return existing;
  const recycled = !isConstant(canonical) && state.reusableQubits.length > 0;
  const next = recycled ? state.reusableQubits.pop()! : state.nextQubit++;
  state.tokenToQubit.set(key, next);
  if (knownZero) state.knownZero.add(next);
  if (key === 'const/1p') emitGate(state, 'X', [next], [], 'initialize constant 1p');
  if (key === 'const/sp') emitGate(state, 'H', [next], [], 'initialize superposition sp');
  return next;
};

// Zero initialization is batched until the next real operation so internal workspace RESET gates stay off the rendered canvas.
const scheduleCycleZero = (state: CompilerState, qubit: number) => {
  state.resetQubits.add(qubit);
  state.pendingCycleZeros.add(qubit);
  state.knownZero.add(qubit);
};

const flushCycleZeros = (state: CompilerState, source: string) => {
  if (state.pendingCycleZeros.size === 0) return;
  const targets = [...state.pendingCycleZeros];
  state.pendingCycleZeros.clear();
  emitGate(state, 'RESET', targets, [], source);
};

const resolveWires = (
  state: CompilerState,
  frame: Frame,
  token: string,
  line: string,
  parentFrame?: Frame,
  skipParams = false,
) => {
  const canonical = scopedName(state, frame, token, line, parentFrame, skipParams);
  return state.registers.get(canonical) ?? [ensureQubit(state, canonical)];
};

const resolveInputQubit = (
  state: CompilerState,
  frame: Frame,
  token: string,
  line: string,
  parentFrame?: Frame,
  skipParams = false,
) => {
  const canonical = scopedName(state, frame, token, line, parentFrame, skipParams);
  const register = state.registers.get(canonical);
  if (register) {
    if (register.length !== 1) {
      throw new Error(`Token '${stripCycle(token)}' is a ${register.length}-wire register in '${line}'`);
    }
    return register[0];
  }
  return ensureQubit(state, canonical);
};

const exclusivelyOwned = (state: CompilerState, qubit: number, canonical: string) => {
  const keys = [...state.tokenToQubit.entries()].filter(([, index]) => index === qubit).map(([key]) => key);
  const inOtherRegister = [...state.registers.entries()]
    .some(([name, wires]) => name !== canonical && wires.includes(qubit));
  return !inOtherRegister && keys.length > 0 && keys.every((key) => key === canonical || key.startsWith(`${canonical}[`));
};

const releaseToken = (
  state: CompilerState,
  frame: Frame,
  token: string,
  line: string,
  parentFrame?: Frame,
) => {
  const base = stripCycle(token);
  if (frame.released.has(base)) {
    throw new Error(`Token '${base}' was released by FREE or DELETETOKEN in '${line}'`);
  }
  if (frame.aliases.has(base)) {
    frame.aliases.delete(base);
    frame.released.add(base);
    state.log.push(`Released alias ${base}.`);
    return;
  }
  const canonical = scopedName(state, frame, token, line, parentFrame);
  frame.released.add(base);
  const register = state.registers.get(canonical);
  const wires = register ?? (state.tokenToQubit.has(canonical) ? [state.tokenToQubit.get(canonical)!] : []);
  if (register) {
    register.forEach((_, index) => frame.released.add(`${base}[${index}]`));
  }
  const reusable = wires.length > 0 && wires.every((qubit) => (
    state.knownZero.has(qubit) && exclusivelyOwned(state, qubit, canonical)
  ));
  if (reusable) {
    wires.forEach((qubit) => {
      [...state.tokenToQubit.entries()].forEach(([key, index]) => {
        if (index === qubit) state.tokenToQubit.delete(key);
      });
      state.knownZero.add(qubit);
      state.reusableQubits.push(qubit);
    });
    state.registers.delete(canonical);
    [...frame.aliases.entries()].forEach(([alias, target]) => {
      if (target === canonical || target.startsWith(`${canonical}[`)) {
        frame.aliases.delete(alias);
        frame.released.add(alias);
      }
    });
  }
  state.log.push(`Released ${base}${reusable ? ' and returned its |0⟩ wire for reuse' : ''}.`);
};

const returnRegistersForProcess = (process: ProtocolProcess): string[] => {
  let returns: string[] | undefined;
  const masters: string[] = [];
  for (const line of process.lines) {
    try {
      const command = parseCommand(line);
      if (command.op === 'RETURNVALS') returns = command.args.map(stripCycle);
      if (command.op === 'MASTERVAL') masters.push(...command.args.map(stripCycle));
    } catch {
      // Ignore malformed lines while scanning for the child's return register list.
    }
  }
  if (!returns) return masters;
  masters.forEach((name) => {
    if (!returns!.includes(name)) {
      throw new Error(`MASTERVAL '${name}' is not listed in RETURNVALS`);
    }
  });
  return returns;
};

export const getReturnValTokens = (source: string): string[] => returnRegistersForProcess(parseProtocol(source));

export const getReturnValToken = (source: string, index: number): string => {
  const token = getReturnValTokens(source)[index];
  if (!token) throw new Error(`RETURNVALS index ${index} is out of range for this protocol`);
  return token;
};

// Process execution expands child calls into a flat gate list while preserving scoped token names for descendants.
const executeProcess = (
  process: ProtocolProcess,
  state: CompilerState,
  library: Map<string, ProtocolProcess>,
  passedParams: string[] = [],
  parentFrame?: Frame,
  outputBindings: Map<string, string> = new Map(),
  callSite = '',
  skipCallParams = false,
  context: ProcessExecutionContext = { rootProcess: process.name, callStack: [] },
): string[] => {
  const enclosingFrameCycle = state.frameCycle;
  const scope = `${process.name}#${state.processRuns}`;
  if (!state.rootScope) state.rootScope = scope;
  state.processRuns += 1;
  const params = new Map<string, string>();
  process.params.forEach((param, index) => {
    const provided = passedParams[index];
    let resolved: string;
    // RUNCHILD -I tokens re-scope through the parent frame; top-level PARAMS keep their declared names.
    if (provided !== undefined && parentFrame) {
      resolved = scopedName(state, parentFrame, provided, callSite || process.name, parentFrame, skipCallParams);
    } else {
      resolved = param.name;
    }
    params.set(param.name, resolved);
  });
  const frame: Frame = {
    process,
    scope,
    aliases: new Map(),
    params,
    declaredChildren: new Map(),
    released: new Set(),
    masterTokens: [],
    returnBases: [],
    allowsRecursion: false,
  };
  outputBindings.forEach((parentToken, childRegister) => {
    frame.aliases.set(childRegister, parentToken);
  });
  process.params.forEach((param) => ensureQubit(state, params.get(param.name)!, false));
  let returns: string[] = [];
  const frameContext: ProcessExecutionContext = {
    ...context,
    callStack: [...context.callStack, process.name],
  };
  // Mutable recursion registers so TCO can rewind this frame like a loop (F#-style).
  const recursionState = {
    depth: frameContext.recursionDepth,
    rootDepth: frameContext.rootDepth,
    level: frameContext.level ?? 0,
    mode: frameContext.recursionMode,
    invocation: frameContext.recursionInvocation,
  };
  const enclosingRecursion = state.activeRecursion;
  const syncActiveRecursion = () => {
    if (recursionState.depth === undefined || recursionState.rootDepth === undefined) {
      state.activeRecursion = undefined;
      return;
    }
    state.activeRecursion = {
      process: process.name,
      depth: recursionState.depth,
      level: recursionState.level,
      rootDepth: recursionState.rootDepth,
      mode: recursionState.mode ?? 'stack',
      ...(recursionState.invocation ? { invocation: recursionState.invocation } : {}),
    };
  };
  syncActiveRecursion();

  type ActiveBranch = {
    groupId: string;
    kind: 'if' | 'else';
    token: string;
    equals: 0 | 1;
    /** Present for `IF (GATE …) = V`; ELSE flips `negate`. */
    predicate?: ConditionPredicate;
  };

  // Resolve `GATE -I … -O …` inside an IF header against this frame without emitting a gate.
  const compilePredicate = (
    header: Extract<IfHeader, { kind: 'predicate' }>,
    line: string,
  ): ConditionPredicate => {
    const inner = parseCommand(header.expression);
    const op = inner.op;
    if (inner.customGateId && inner.outputs.length !== 1) {
      throw new Error(`IF expression custom gate ${op} must return exactly one value to compare in '${line}'`);
    }
    if (!inner.customGateId && (!(primitiveGates.has(op) || derivedGates.has(op)) || PREDICATE_EXCLUDED.has(op))) {
      throw new Error(`IF expression must be a single-result gate (not '${op}') in '${line}'`);
    }
    if (inner.condition) throw new Error(`IF expression cannot carry its own -IF in '${line}'`);
    const inputs = inner.inputs.map((input) => resolveInputQubit(state, frame, input, line, parentFrame));
    const outputToken = inner.outputs[0] ?? inner.inputs[0];
    const output = resolveInputQubit(state, frame, outputToken, line, parentFrame);
    const loweredPhase = inner.op === 'PHASE' || inner.op === 'RX' || inner.op === 'RY'
      || inner.op === 'RZ' || inner.op === 'CPHASE'
      ? inner.phase ?? 0
      : undefined;
    return buildConditionPredicate({
      type: op as GateType,
      inputs,
      output,
      // AND -I A B -O B means "A AND B": keep both operands and write to a fresh |0⟩ wire.
      isBooleanJoin: derivedGates.has(op),
      phase: loweredPhase,
      inverse: inner.reverse,
      expect: header.expect,
      negate: header.negate,
      inputNames: inner.inputs.map(stripCycle),
      outputName: stripCycle(outputToken),
    });
  };
  const branchStack: ActiveBranch[] = [];
  let nextBranchGroup = 0;

  const resolveClassicalControl = (
    commandCondition: ParsedCommand['condition'] | undefined,
    line: string,
    skipParams: boolean,
  ): { condition?: CircuitGate['condition']; branch?: ClassicalBranchMeta } => {
    const active = branchStack[branchStack.length - 1];
    if (active) {
      // A gate holds one condition, so an inline -IF here would silently replace the block's test.
      if (commandCondition) {
        throw new Error(`-IF inside an IF block is not supported (a gate carries one condition) in '${line}'`);
      }
      if (active.predicate) {
        const { predicate } = active;
        return {
          condition: { qubit: predicate.output, equals: active.kind === 'else' ? 0 : 1, predicate: { ...predicate } },
          branch: {
            groupId: active.groupId,
            kind: active.kind,
            sourceQubit: predicate.output,
            equals: active.kind === 'else' ? 0 : 1,
          },
        };
      }
      const qubit = resolveInputQubit(state, frame, active.token, line, parentFrame, skipParams);
      return {
        condition: { qubit, equals: active.equals },
        branch: {
          groupId: active.groupId,
          kind: active.kind,
          sourceQubit: qubit,
          equals: active.equals,
        },
      };
    }
    if (!commandCondition) return {};
    return {
      condition: {
        qubit: resolveInputQubit(state, frame, commandCondition.token, line, parentFrame, skipParams),
        equals: commandCondition.equals,
      },
    };
  };

  const depthNote = recursionState.depth !== undefined
    ? ` DEPTH=${recursionState.depth} LEVEL=${recursionState.level}${recursionState.mode ? ` mode=${recursionState.mode}` : ''}`
    : '';
  state.log.push(`MAIN-PROCESS ${process.name} compiled in scope ${scope}.${depthNote}`);
  state.frameCycle = 0;

  // Line dispatch is ordered: workspace/cycle ops run before gates so pending RESETs flush at INCREASECYCLE and primitives.
  try {
  let lineIndex = 0;
  while (lineIndex < process.lines.length) {
    const line = process.lines[lineIndex];
    lineIndex += 1;
    const command = parseCommand(line);
    const skipParams = command.noParameterSubstitution;
    state.parsed.push(command);

    if (command.op === 'MAIN-PROCESS') {
      // Body entry marker only; compilation already started from parseProtocol's MAIN-PROCESS name.
      state.log.push(`Main process '${command.args[0]}' started.`);
      continue;
    }

    if (command.op === 'REC' || command.op === 'TREC') {
      if (process.name === frameContext.rootProcess && !parentFrame) {
        state.log.push(`${command.op} noted on '${process.name}' (valid when this process is expanded as a child).`);
      }
      const meta = parseRecDeclaration(line.trim().split(/\s+/));
      frame.allowsRecursion = true;
      frame.maxDepth = meta.maxDepth;
      frame.prefersTco = meta.requiresTail;
      state.log.push(
        meta.maxDepth === undefined
          ? `${command.op} enables bounded self-recursion for '${process.name}'.`
          : `${command.op} MAXDEPTH ${meta.maxDepth} enables bounded self-recursion for '${process.name}'.`,
      );
      continue;
    }

    if (command.op === 'EXIT') {
      const clause = parseWhenClause(command.args);
      if (evaluateWhenClause(clause, recursionState)) {
        state.log.push(`EXIT WHEN ${clause.left} ${clause.operator} ${clause.right} ended frame ${scope}.`);
        break;
      }
      state.log.push(`EXIT WHEN ${clause.left} ${clause.operator} ${clause.right} was false; continuing.`);
      continue;
    }

    if (command.op === 'IF') {
      // Nested blocks would need a conjunction of conditions; reject rather than drop the outer test.
      if (branchStack.length > 0) {
        throw new Error(`Nested IF blocks are not supported; close the outer IF with ENDIF first ('${line}')`);
      }
      const header = parseIfHeader(line);
      if (header.kind === 'predicate') {
        const predicate = compilePredicate(header, line);
        branchStack.push({
          groupId: `branch-${nextBranchGroup}`,
          kind: 'if',
          token: predicate.text,
          equals: 1,
          predicate,
        });
        state.log.push(`IF (${header.expression}) ${header.negate ? '!=' : '='} ${conditionValueLabel(header.expect)} opened gate-expression branch.`);
      } else {
        branchStack.push({
          groupId: `branch-${nextBranchGroup}`,
          kind: 'if',
          token: header.token,
          equals: header.equals,
        });
        state.log.push(`IF ${header.token}=${header.equals} opened classical branch.`);
      }
      nextBranchGroup += 1;
      continue;
    }

    if (command.op === 'ELSE') {
      const active = branchStack[branchStack.length - 1];
      if (!active || active.kind !== 'if') {
        throw new Error(`ELSE without matching IF in '${line}'`);
      }
      active.kind = 'else';
      if (active.predicate) {
        active.predicate = { ...active.predicate, negate: !active.predicate.negate };
        state.log.push(`ELSE ${active.token} ${active.predicate.negate ? '!=' : '='} ${conditionValueLabel(active.predicate.expect)} branch.`);
      } else {
        active.equals = active.equals === 1 ? 0 : 1;
        state.log.push(`ELSE ${active.token}=${active.equals} classical branch.`);
      }
      continue;
    }

    if (command.op === 'ENDIF') {
      const active = branchStack.pop();
      if (!active) throw new Error(`ENDIF without matching IF in '${line}'`);
      state.log.push(`ENDIF closed classical branch ${active.groupId}.`);
      continue;
    }

    if (command.op === 'INCREASECYCLE') {
      flushCycleZeros(state, `INCREASECYCLE end of logical cycle ${state.frameCycle}`);
      state.frameCycle += 1;
      state.timelineCycle += 1;
      emitGate(state, 'CYCLE', [], [], line);
      state.log.push(`Logical cycle increased to ${state.frameCycle}; workspace registers prepared for the new stage.`);
      continue;
    }

    if (command.op === 'SET') {
      const [target, value] = command.args;
      const targetBase = stripCycle(target);
      if (['DEPTH', 'LEVEL', 'ROOTDEPTH'].includes(targetBase.toUpperCase())) {
        throw new Error(`${targetBase} is read-only compile-time recursion metadata in '${line}'`);
      }
      if (!value) throw new Error(`SET requires a value in '${line}'`);
      const prepared = preparedConstant(value);
      if (prepared && !isPowerOfTwoDimension(prepared.dimension)) {
        throw new Error(`Dimension ${prepared.dimension} is not a power of two in '${line}'`);
      }
      const targetName = scopedName(state, frame, target, line, parentFrame, skipParams);
      // State-typed PARAM defaults are runtime controls; non-param constants lower to initializer gates during compile.
      if (prepared) {
        const width = Math.log2(prepared.dimension);
        const declaredParam = frame.process.params.find((param) => param.name === targetBase);
        if (declaredParam?.type === 'state') {
          if (width !== 1) {
            throw new Error(`SET cannot widen state parameter '${targetBase}' to dimension ${prepared.dimension} in '${line}'`);
          }
          ensureQubit(state, targetName, false);
          state.log.push(`SET ${targetBase} default ${value} at logical cycle ${state.frameCycle} (parametric default; runtime start state).`);
          continue;
        }
        if (width === 1) {
          const qubit = ensureQubit(state, targetName);
          if (prepared.kind === '0p') scheduleCycleZero(state, qubit);
          if (prepared.kind === '1p') emitGate(state, 'X', [qubit], [], line);
          if (prepared.kind === 'sp') emitGate(state, 'H', [qubit], [], line);
        } else {
          if (state.registers.has(targetName) || state.tokenToQubit.has(targetName)) {
            throw new Error(`Register '${targetBase}' already exists in '${line}'`);
          }
          // Register order is MSB first. |1⟩ is basis index 1, so only the last wire is flipped.
          const qubits = Array.from({ length: width }, (_, index) => ensureQubit(state, `${targetName}[${index}]`));
          state.registers.set(targetName, qubits);
          if (prepared.kind === '0p') qubits.forEach((qubit) => scheduleCycleZero(state, qubit));
          if (prepared.kind === '1p') {
            qubits.slice(0, -1).forEach((qubit) => scheduleCycleZero(state, qubit));
            emitGate(state, 'X', [qubits[width - 1]], [], line);
          }
          if (prepared.kind === 'sp') qubits.forEach((qubit) => emitGate(state, 'H', [qubit], [], line));
        }
        state.log.push(`SET ${targetBase} to ${value} at logical cycle ${state.frameCycle}.`);
      } else {
        const valueName = scopedName(state, frame, value, line, parentFrame, skipParams);
        frame.aliases.set(targetBase, valueName);
        state.log.push(`SET ${targetBase} as alias of ${stripCycle(value)}.`);
      }
      continue;
    }

    if (command.op === 'CREATETOKEN') {
      // CREATETOKEN must claim wires up front so later gate rows resolve stable indices during the same compile pass.
      command.inputs.forEach((token) => {
        ensureQubit(state, scopedName(state, frame, token, line, parentFrame, skipParams));
      });
      state.log.push(`CREATETOKEN created ${command.inputs.join(', ')}.`);
      continue;
    }

    if (command.op === 'DELETETOKEN' || command.op === 'FREE') {
      const names = command.inputs.length > 0
        ? command.inputs
        : command.args.filter((arg) => !arg.startsWith('-'));
      if (names.length === 0) throw new Error(`${command.op} requires a token in '${line}'`);
      names.forEach((token) => releaseToken(state, frame, token, line, parentFrame));
      continue;
    }

    if (command.op === 'DECLARECHILD') {
      const childName = command.args[0];
      if (!childName) throw new Error('DECLARECHILD requires a process name');
      const child = library.get(childName);
      if (!child) throw new Error(`Unknown child process '${childName}'`);
      // Bind the catalog/library body now so later RUNCHILD/CALL rows expand this process, not a later alias.
      frame.declaredChildren.set(childName, child);
      state.log.push(`Bound child process '${childName}' for RUNCHILD/CALL.`);
      continue;
    }

    if (command.op === 'RUNCHILD' || command.op === 'CALL' || command.op === 'RECUR') {
      // Child gates compile in their own frame and would not inherit this block's condition.
      if (branchStack.length > 0) {
        throw new Error(
          `${command.op} inside an IF block is not supported; its gates would run unconditionally. `
          + `Register the child as a custom gate and use that gate inside the block instead ('${line}')`,
        );
      }
      const isRecur = command.op === 'RECUR';
      const childName = isRecur ? process.name : command.args[0];
      if (!childName) throw new Error(`${command.op} requires a process name`);
      const child = isRecur
        ? process
        : frame.declaredChildren.get(childName) ?? library.get(childName);
      if (!child) throw new Error(`Unknown child process '${childName}'`);

      const childAnalysis = analyzeRecursionForm(child);
      const childRecursionMode = childAnalysis.allowsRecursion
        ? resolveRecursionMode(childAnalysis)
        : undefined;
      const liveContext: ProcessExecutionContext = {
        ...frameContext,
        recursionDepth: recursionState.depth,
        rootDepth: recursionState.rootDepth,
        level: recursionState.level,
        recursionMode: recursionState.mode,
      };
      const plan = planRecursionExpansion({
        childName,
        currentProcessName: process.name,
        context: liveContext,
        requestedDepth: command.depth,
        childIsRecursive: isRecur ? true : childAnalysis.allowsRecursion,
        childMaxDepth: childAnalysis.maxDepth ?? frame.maxDepth,
        isExplicitRecur: isRecur,
        frameAllowsRecursion: frame.allowsRecursion,
        childRecursionMode,
      });

      if (plan.kind === 'stop') {
        state.log.push(plan.reason);
        continue;
      }

      // Tail REC/TREC: rewind this frame (TCO) instead of nesting another executeProcess.
      const selfCall = isRecur || childName === process.name;
      if (selfCall && plan.kind === 'expand' && (recursionState.mode === 'tco' || plan.recursionMode === 'tco')) {
        command.inputs.forEach((input, index) => {
          const param = process.params[index];
          if (!param) return;
          const resolved = scopedName(state, frame, input, line, parentFrame, skipParams);
          params.set(param.name, resolved);
        });
        recursionState.depth = plan.recursionDepth;
        recursionState.rootDepth = plan.rootDepth;
        recursionState.level = plan.level;
        recursionState.mode = 'tco';
        syncActiveRecursion();
        // Each rewound iteration gets fresh locals, as a stacked call would: a new scope and only the call's output bindings.
        frame.scope = `${process.name}#${state.processRuns}`;
        state.processRuns += 1;
        frame.aliases = new Map(outputBindings);
        frame.released.clear();
        frame.returnBases = [];
        frame.masterTokens = [];
        state.frameCycle = 0;
        lineIndex = 0;
        state.log.push(
          `TCO rewind '${process.name}' → DEPTH=${plan.recursionDepth} LEVEL=${plan.level} (iterative expansion).`,
        );
        continue;
      }

      const childReturnRegisters = returnRegistersForProcess(child);
      const childOutputBindings = new Map<string, string>();
      const preparedOutputQubits = new Set<number>();
      const inputQubits = new Set(
        command.inputs.map((input) => {
          const parentToken = scopedName(state, frame, stripCycle(input), line, parentFrame, skipParams);
          return ensureQubit(state, parentToken, false);
        }),
      );
      // Child RETURNVALS bind onto parent outputs. Skip zero-prep when the output aliases an input (in-place).
      command.outputs.forEach((output, index) => {
        const childRegister = childReturnRegisters[index];
        if (!childRegister) return;
        const parentToken = scopedName(state, frame, stripCycle(output), line, parentFrame, skipParams);
        const qubit = ensureQubit(state, parentToken, false);
        if (!preparedOutputQubits.has(qubit) && !inputQubits.has(qubit)) {
          preparedOutputQubits.add(qubit);
          scheduleCycleZero(state, qubit);
        }
        childOutputBindings.set(childRegister, parentToken);
      });
      // RECUR / in-place RUNCHILD with only -I: map RETURNVALS onto the same PARAM wires.
      if (command.outputs.length === 0 && (isRecur || childName === process.name || plan.kind === 'expand')) {
        child.params.forEach((param, index) => {
          const input = command.inputs[index];
          if (!input) return;
          const childRegister = childReturnRegisters.find((name) => name === param.name);
          if (!childRegister) return;
          const parentToken = scopedName(state, frame, stripCycle(input), line, parentFrame, skipParams);
          childOutputBindings.set(childRegister, parentToken);
        });
      }
      flushCycleZeros(state, `prepare outputs before ${command.op} ${childName} at logical cycle ${state.frameCycle}`);

      const nextContext: ProcessExecutionContext = plan.kind === 'expand'
        ? {
            rootProcess: frameContext.rootProcess,
            recursionProcess: plan.recursionProcess,
            recursionDepth: plan.recursionDepth,
            rootDepth: plan.rootDepth,
            level: plan.level,
            callStack: frameContext.callStack,
            recursionMode: plan.recursionMode,
            // Frames of one chain share the id; a fresh RUNCHILD starts a new one.
            recursionInvocation: selfCall && recursionState.invocation
              ? recursionState.invocation
              : `rec-${state.nextRecursionInvocation++}`,
          }
        : {
            rootProcess: frameContext.rootProcess,
            callStack: frameContext.callStack,
          };

      if (plan.kind === 'expand' && plan.recursionMode === 'tco') {
        state.log.push(
          `TCO: expanding '${childName}' iteratively (DEPTH=${plan.recursionDepth}`
          + `${childAnalysis.declaredTrec ? '; TREC' : '; REC auto-converted'}).`,
        );
      }

      const childReturns = executeProcess(
        child,
        state,
        library,
        command.inputs,
        frame,
        childOutputBindings,
        line,
        skipParams,
        nextContext,
      );
      command.outputs.forEach((output, index) => {
        const returned = childReturns[index];
        if (returned) frame.aliases.set(stripCycle(output), returned);
      });
      state.lastReturns = childReturns;
      state.log.push(`${command.op} ${childName} returned ${childReturns.length} value(s).`);
      continue;
    }

    if (command.op === 'ACCEPTVALS') {
      // Wire the most recent child RETURNVALS into local aliases without another RUNCHILD expansion.
      command.args.forEach((local, index) => {
        const returned = state.lastReturns[index];
        if (returned) frame.aliases.set(stripCycle(local), returned);
      });
      state.log.push(`ACCEPTVALS ${command.args.join(', ')}.`);
      continue;
    }

    if (command.op === 'RETURNVALS') {
      frame.returnBases = command.args.map(stripCycle);
      returns = frame.returnBases.map((token) => scopedName(state, frame, token, line, parentFrame, skipParams));
      state.log.push(`RETURNVALS ${command.args.join(', ')}.`);
      continue;
    }

    if (command.op === 'MASTERVAL') {
      command.args.forEach((token) => {
        frame.masterTokens.push({ name: stripCycle(token), line });
      });
      state.log.push(`MASTERVAL ${command.args.join(', ')}.`);
      continue;
    }

    if (command.op === 'COMPILEPROCESS') {
      const childName = command.args[0];
      if (!childName) throw new Error(`COMPILEPROCESS requires a process name in '${line}'`);
      const child = library.get(childName);
      if (!child) throw new Error(`Unknown child process '${childName}'`);
      if (state.verifying.has(childName)) {
        state.log.push(`COMPILEPROCESS ${childName} skipped because it is already being verified.`);
        continue;
      }
      state.verifying.add(childName);
      const scratch = createCompilerState();
      scratch.verifying = state.verifying;
      try {
        executeProcess(child, scratch, library, [], undefined, new Map(), '', false, {
          rootProcess: childName,
          callStack: [],
        });
        state.log.push(`COMPILEPROCESS verified '${childName}' (${scratch.gates.length} gate(s)) without inlining.`);
      } finally {
        state.verifying.delete(childName);
      }
      continue;
    }

    if (command.op === 'SAVE_STATE' || command.op === 'LOAD_STATE') {
      const checkpoint = command.args[0];
      if (!checkpoint) throw new Error(`${command.op} requires a checkpoint name in '${line}'`);
      flushCycleZeros(state, `prepare workspace before ${command.op} at logical cycle ${state.frameCycle}`);
      emitGate(state, command.op, [], [], line, undefined, checkpoint);
      state.log.push(`${command.op} ${checkpoint}.`);
      continue;
    }

    if (command.op === 'JOIN') {
      if (command.inputs.length < 2 || command.outputs.length !== 1) {
        throw new Error(`JOIN requires at least two inputs and one output in '${line}'`);
      }
      const wires = command.inputs.flatMap((token) => resolveWires(state, frame, token, line, parentFrame, skipParams));
      const outputName = scopedName(state, frame, command.outputs[0], line, parentFrame, skipParams);
      if (state.tokenToQubit.has(outputName)) {
        throw new Error(`JOIN output '${stripCycle(command.outputs[0])}' is already a wire in '${line}'`);
      }
      state.registers.set(outputName, wires);
      state.log.push(`JOIN ${command.inputs.join(', ')} into ${stripCycle(command.outputs[0])} (${wires.length} wires).`);
      continue;
    }

    if (command.op === 'SPLIT') {
      const positional = command.args.filter((arg) => !arg.startsWith('-'));
      const [compositeToken, componentToken, dimToken] = positional;
      if (!compositeToken || !componentToken || dimToken === undefined) {
        throw new Error(`SPLIT requires a register, a component name, and a dimension in '${line}'`);
      }
      const dimension = Number(dimToken);
      if (!isPowerOfTwoDimension(dimension)) {
        throw new Error(`Dimension ${dimToken} is not a power of two in '${line}'`);
      }
      const width = Math.log2(dimension);
      const compositeName = scopedName(state, frame, compositeToken, line, parentFrame, skipParams);
      const wires = state.registers.get(compositeName);
      if (!wires) throw new Error(`SPLIT register '${stripCycle(compositeToken)}' is not a joined register in '${line}'`);
      if (width > wires.length) {
        throw new Error(`SPLIT dimension ${dimension} exceeds register '${stripCycle(compositeToken)}' in '${line}'`);
      }
      const componentName = scopedName(state, frame, componentToken, line, parentFrame, skipParams);
      if (state.registers.has(componentName) || state.tokenToQubit.has(componentName)) {
        throw new Error(`SPLIT component '${stripCycle(componentToken)}' already exists in '${line}'`);
      }
      state.registers.set(componentName, wires.slice(0, width));
      const rest = wires.slice(width);
      if (rest.length === 0) state.registers.delete(compositeName);
      else state.registers.set(compositeName, rest);
      state.log.push(`SPLIT ${stripCycle(compositeToken)} into ${stripCycle(componentToken)} (dimension ${dimension}).`);
      continue;
    }

    if (command.op === 'MEASURE') {
      // Protocols omit -I on MEASURE to collapse all wires before RETURNVALS reads classical bits.
      const qubits = command.inputs.length
        ? command.inputs.map((token) => resolveInputQubit(state, frame, token, line, parentFrame, skipParams))
        : [...state.tokenToQubit.values()];
      qubits.forEach((qubit) => {
        emitGate(state, 'MEASURE', [qubit], [], line);
        // Z is the default observable, so only X/Y are recorded on the gate.
        if (command.basis && command.basis !== 'Z') state.gates[state.gates.length - 1].basis = command.basis;
      });
      continue;
    }

    // Custom gates keep their own wiring: -I wires bind the process PARAMS in order, -O wires its RETURNVALS.
    if (command.customGateId) {
      flushCycleZeros(state, `prepare workspace before gate at logical cycle ${state.frameCycle}`);
      const { condition, branch } = resolveClassicalControl(command.condition, line, skipParams);
      const controls = command.inputs.map((input) => resolveInputQubit(state, frame, input, line, parentFrame, skipParams));
      const targets = command.outputs.map((output) => resolveInputQubit(state, frame, output, line, parentFrame, skipParams));
      emitGate(state, command.customGateId, targets, controls, line, undefined, undefined, command.reverse, condition, branch);
      state.gates[state.gates.length - 1].customGateId = command.customGateId;
      continue;
    }

    if (primitiveGates.has(command.op)) {
      flushCycleZeros(state, `prepare workspace before gate at logical cycle ${state.frameCycle}`);
      const { condition, branch } = resolveClassicalControl(command.condition, line, skipParams);
      const loweredPhase = command.reverse && command.op === 'S'
        ? -Math.PI / 2
        : command.reverse && command.op === 'T'
          ? -Math.PI / 4
          : command.op === 'PHASE' || command.op === 'RX' || command.op === 'RY' || command.op === 'RZ' || command.op === 'CPHASE'
            ? command.phase ?? 0
            : undefined;
      const loweredType: GateType = loweredPhase !== undefined && (command.op === 'S' || command.op === 'T')
        ? 'PHASE'
        : command.op as GateType;
      if (command.op === 'SWAP') {
        const swapQubits = command.inputs
          .slice(0, 2)
          .map((input) => resolveInputQubit(state, frame, input, line, parentFrame, skipParams));
        if (swapQubits.length < 2) throw new Error('SWAP requires two input qubits.');
        if (command.outputs.length > 0) {
          if (command.outputs.length !== command.inputs.length) {
            throw new Error('SWAP outputs must match inputs.');
          }
          const swapOutputs = command.outputs.map((output) => resolveInputQubit(state, frame, output, line, parentFrame, skipParams));
          swapQubits.forEach((inputQubit, index) => {
            if (swapOutputs[index] !== inputQubit) {
              throw new Error('SWAP outputs must match inputs.');
            }
          });
        }
        emitGate(state, 'SWAP', swapQubits, [], line, undefined, undefined, command.reverse, condition, branch);
        continue;
      }
      // For primitive and derived AST gates, -O names the mutated target and -I names controls/inputs.
      const targetToken = command.outputs[0] ?? command.inputs[0];
      const target = resolveInputQubit(state, frame, targetToken, line, parentFrame, skipParams);
      const controls = command.inputs
        .map((input) => resolveInputQubit(state, frame, input, line, parentFrame, skipParams))
        // When -O names the mutated wire, drop it from the control list so self-controlled ops do not deadlock.
        .filter((qubit) => qubit !== target);
      emitGate(state, loweredType, [target], controls, line, loweredPhase, undefined, command.reverse, condition, branch);
      continue;
    }

    // Derived gates share the same -I/-O lowering as primitives; self-inverse ops keep reverse for dagger display.
    if (derivedGates.has(command.op)) {
      flushCycleZeros(state, `prepare workspace before gate at logical cycle ${state.frameCycle}`);
      const { condition, branch } = resolveClassicalControl(command.condition, line, skipParams);
      const target = resolveInputQubit(state, frame, command.outputs[0], line, parentFrame, skipParams);
      const controls = command.inputs
        .map((input) => resolveInputQubit(state, frame, input, line, parentFrame, skipParams))
        .filter((qubit) => qubit !== target);
      emitGate(state, command.op as GateType, [target], controls, line, undefined, undefined, command.reverse, condition, branch);
      continue;
    }
  }

  if (frame.returnBases.length === 0) {
    if (frame.masterTokens.length > 0) {
      returns = frame.masterTokens.map((entry) => scopedName(state, frame, entry.name, entry.line, parentFrame));
    } else if (returns.length === 0) {
      // Early EXIT before RETURNVALS: surface PARAM wires so in-place recursive callers keep bindings.
      returns = process.params
        .map((param) => params.get(param.name))
        .filter((token): token is string => Boolean(token));
    }
  } else {
    frame.masterTokens.forEach((entry) => {
      if (!frame.returnBases.includes(entry.name)) {
        throw new Error(`MASTERVAL '${entry.name}' is not listed in RETURNVALS in '${entry.line}'`);
      }
    });
  }

  flushCycleZeros(state, `end of process ${process.name}`);
  if (branchStack.length > 0) {
    throw new Error(`Unclosed IF in process '${process.name}' (missing ENDIF).`);
  }
  return returns;
  } finally {
    state.frameCycle = enclosingFrameCycle;
    state.activeRecursion = enclosingRecursion;
  }
};

// Compaction removes unused symbolic registers after expansion so UI labels and state vectors use dense indices.
const compactQubitLayout = (
  gates: CircuitGate[],
  tokenMap: Record<string, number>,
  processParams: ProcessParam[],
) => {
  const used = new Set<number>();
  gates.forEach((gate) => {
    gate.targets.forEach((qubit) => used.add(qubit));
    gate.controls.forEach((qubit) => used.add(qubit));
    // A wire read only by an IF predicate must survive compaction.
    gate.condition?.predicate?.inputs.forEach((qubit) => used.add(qubit));
    if (gate.condition?.predicate) used.add(gate.condition.predicate.output);
    // Measured-bit conditions and branches keep their wire so the "measured first" check sees the right index.
    if (gate.condition) used.add(gate.condition.qubit);
    if (gate.branch) used.add(gate.branch.sourceQubit);
  });
  processParams.forEach((param) => used.add(param.qubitIndex));

  const sorted = [...used].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { gates, tokenMap, processParams, qubitCount: 0, remap: new Map<number, number>() };
  }

  // Remap compacts holes left by unused symbolic registers while preserving gate step order.
  const remap = new Map(sorted.map((old, index) => [old, index]));
  return {
    gates: gates.map((gate) => ({
      ...gate,
      targets: gate.targets.map((qubit) => remap.get(qubit)!),
      controls: gate.controls.map((qubit) => remap.get(qubit)!),
      // Feed-forward reads a measured wire, so it must follow the same compaction.
      ...(gate.condition
        ? { condition: remapConditionWires(gate.condition, (qubit) => remap.get(qubit) ?? qubit) }
        : {}),
      ...(gate.branch
        ? { branch: { ...gate.branch, sourceQubit: remap.get(gate.branch.sourceQubit) ?? gate.branch.sourceQubit } }
        : {}),
    })),
    tokenMap: Object.fromEntries(
      Object.entries(tokenMap).flatMap(([token, qubit]) => {
        const mapped = remap.get(qubit);
        return mapped === undefined ? [] : [[token, mapped]];
      }),
    ),
    processParams: processParams.map((param) => ({
      ...param,
      qubitIndex: remap.get(param.qubitIndex)!,
    })),
    qubitCount: sorted.length,
    remap,
  };
};

// The compiler returns both renderable gates and logical I/O mappings so the UI can display only process-facing qubits.
export const compileQpuProtocol = (source: string, librarySources: Record<string, string> = {}): CompileResult => {
  const main = parseProtocol(source);
  const library = processLibraryFromSources(librarySources);
  // The file being compiled is always addressable as a child of itself (e.g. recursive RUNCHILD / RECUR).
  library.set(main.name, main);
  const state = createCompilerState();

  executeProcess(main, state, library, [], undefined, new Map(), '', false, {
    rootProcess: main.name,
    callStack: [],
  });

  const tokenMap: Record<string, number> = {};
  state.tokenToQubit.forEach((qubit, token) => {
    tokenMap[token] = qubit;
  });

  // Exposed PARAMS omit numeric-only registers and any wire used only as a cycle RESET target.
  const processParams: ProcessParam[] = main.params.flatMap((param) => {
    const qubitIndex = tokenMap[param.name];
    if (qubitIndex === undefined) return [];
    if (state.resetQubits.has(qubitIndex)) return [];
    if (NUMERIC_PARAM_TYPES.includes(param.type as (typeof NUMERIC_PARAM_TYPES)[number])) return [];
    return [{ name: param.name, type: param.type, qubitIndex }];
  });

  const compacted = compactQubitLayout(
    state.gates.map((gate, step) => ({ ...gate, step })),
    tokenMap,
    processParams,
  );

  // RETURNVALS names may be bare or scoped after child expansion; match by suffix when compacting.
  const returnValues: ReturnValue[] = returnRegistersForProcess(main).flatMap((name) => {
    const register = [...state.registers.entries()].find(([key]) => key === name || key.endsWith(`/${name}`));
    if (register) {
      const wires = register[1].flatMap((qubit) => {
        const qubitIndex = compacted.remap.get(qubit);
        return qubitIndex === undefined ? [] : [qubitIndex];
      });
      if (wires.length === 1) return [{ name, qubitIndex: wires[0] }];
      return wires.map((qubitIndex, index) => ({ name: `${name}[${index}]`, qubitIndex }));
    }
    const exact = Object.entries(compacted.tokenMap).find(([token]) => token === name || token.endsWith(`/${name}`));
    if (exact) return [{ name, qubitIndex: exact[1] }];
    const wires = Object.entries(compacted.tokenMap)
      .map(([token, qubitIndex]) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = token.match(new RegExp(`(?:^|/)${escaped}\\[(\\d+)\\]$`));
        return match ? { index: Number(match[1]), qubitIndex } : undefined;
      })
      .filter((wire): wire is { index: number; qubitIndex: number } => wire !== undefined)
      .sort((left, right) => left.index - right.index);
    return wires.map((wire) => ({ name: `${name}[${wire.index}]`, qubitIndex: wire.qubitIndex }));
  });

  return {
    gates: compacted.gates,
    qubitCount: compacted.qubitCount,
    // UI qubit rail prefers RETURNVALS width, then PARAMS width, then full simulator width.
    logicalQubitCount: returnValues.length > 0 ? returnValues.length : compacted.processParams.length > 0
      ? compacted.processParams.length
      : compacted.qubitCount,
    parsed: state.parsed,
    log: state.log,
    warnings: state.warnings,
    tokenMap: compacted.tokenMap,
    processParams: compacted.processParams,
    returnValues,
  };
};
