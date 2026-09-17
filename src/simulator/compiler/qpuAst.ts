// QPU protocol compiler: child processes and cycles expand into flat gates so the simulator and UI share one execution model.
import { assertGateArity } from '../gates/arity';
import { astDerivedGateIds, astPrimitiveGateIds } from '../gates/metadata';
import { CircuitGate, GateType, QpuOperation } from '../types';

export type ParsedCommand = {
  op: QpuOperation;
  raw: string;
  inputs: string[];
  outputs: string[];
  args: string[];
  phase?: number;
  reverse: boolean;
  noParameterSubstitution: boolean;
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

// Compile output separates physical simulator width from user-facing PARAMS/RETURNVALS mappings.
export type CompileResult = {
  gates: CircuitGate[];
  qubitCount: number;
  logicalQubitCount: number;
  parsed: ParsedCommand[];
  log: string[];
  tokenMap: Record<string, number>;
  processParams: ProcessParam[];
  returnValues: ReturnValue[];
};

const NUMERIC_PARAM_TYPES = ['int', 'float'] as const;

const primitiveGates = new Set(astPrimitiveGateIds());
const derivedGates = new Set(astDerivedGateIds());

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
  'CNOT',
  'CCNOT',
  'CZ',
  'CY',
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
const splitFlagArgs = (tokens: string[], flag: '-I' | '-O') => {
  const upper = tokens.map((token) => token.toUpperCase());
  const start = upper.indexOf(flag);
  if (start === -1) return [];
  const end = upper.findIndex((token, index) => index > start && token.startsWith('-'));
  return tokens.slice(start + 1, end === -1 ? tokens.length : end);
};

export const parseCommand = (line: string): ParsedCommand => {
  let tokens = line.trim().split(/\s+/);
  if (!tokens.length) throw new Error('Empty command');
  if (tokens[0].endsWith('=') && tokens[1]) tokens = [`${tokens[0]}${tokens[1]}`, ...tokens.slice(2)];

  const rawOp = tokens[0];
  const upperTokens = tokens.map((token) => token.toUpperCase());
  const noParameterSubstitution = upperTokens.includes('-$R');
  let reverse = false;
  let normalized = rawOp.toUpperCase();
  let phase: number | undefined;

  // Backward gate spellings prefix primitives with B, while PHASE embeds its rotation in the opcode token.
  if (normalized.startsWith('B')) {
    const candidate = normalized.slice(1).split('=', 1)[0];
    if (primitiveGates.has(candidate)) {
      reverse = true;
      normalized = normalized.slice(1);
    }
  }

  if (normalized.startsWith('BPHASE=')) {
    reverse = true;
    normalized = normalized.slice(1);
  }

  if (normalized.includes('=')) {
    const [gate, value] = normalized.split('=', 2);
    normalized = gate;
    phase = parseRotationParameter(value, gate);
    if (reverse && normalized === 'PHASE') phase *= -1;
  }

  const inputs = splitFlagArgs(tokens, '-I');
  const outputs = splitFlagArgs(tokens, '-O');
  const op = normalized as QpuOperation;

  if (!supportedQpuOperations.includes(op)) throw new Error(`Unknown command: ${normalized}`);
  if ((primitiveGates.has(op) || derivedGates.has(op)) && !inputs.length && op !== 'MEASURE') {
    throw new Error(`${op} requires -I inputs`);
  }
  if ((primitiveGates.has(op) || derivedGates.has(op)) && op !== 'MEASURE' && !outputs.length) {
    throw new Error(`${op} requires -O output`);
  }
  if (primitiveGates.has(op) || derivedGates.has(op)) {
    assertGateArity(op, inputs.length, outputs.length);
  }

  return { op, raw: line, inputs, outputs, args: tokens.slice(1), phase, reverse, noParameterSubstitution };
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
};

type CompilerState = {
  gates: CircuitGate[];
  parsed: ParsedCommand[];
  log: string[];
  tokenToQubit: Map<string, number>;
  resetQubits: Set<number>;
  pendingCycleZeros: Set<number>;
  lastReturns: string[];
  currentCycle: number;
  processRuns: number;
  rootScope: string;
};

// Gates shown in the circuit UI; cycle workspace prep is compiler-internal and never rendered.
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

// Scoped token names keep child-process registers isolated, except PARAMS, aliases, constants, and numeric workspace wires.
const scopedName = (frame: Frame, token: string, parentFrame?: Frame) => {
  const base = stripCycle(token);
  if (frame.params.has(base)) return frame.params.get(base)!;
  if (frame.aliases.has(base)) return frame.aliases.get(base)!;
  if (isConstant(base)) return base.toLowerCase();
  if (parentFrame && /^\d+$/.test(base)) return childWorkspaceKey(parentFrame, base);
  return `${frame.scope}/${base}`;
};

// Symbolic tokens lazily claim the next simulator wire; constants share keyed slots so 0p/1p/sp init once.
const ensureQubit = (state: CompilerState, canonical: string) => {
  const key = isConstant(canonical) ? `const/${canonical.toLowerCase()}` : canonical;
  const existing = state.tokenToQubit.get(key);
  if (existing !== undefined) return existing;
  const next = state.tokenToQubit.size;
  state.tokenToQubit.set(key, next);
  if (key === 'const/1p') emitGate(state, 'X', [next], [], 'initialize constant 1p');
  if (key === 'const/sp') emitGate(state, 'H', [next], [], 'initialize superposition sp');
  return next;
};

const emitGate = (state: CompilerState, type: GateType, targets: number[], controls: number[], source: string, phase?: number) => {
  state.gates.push({
    id: `${type}-${state.gates.length}-${targets.join('-')}`,
    type,
    step: state.gates.length,
    targets,
    controls,
    phase,
    source,
  });
};

// Zero initialization is batched until the next real operation so internal workspace RESET gates stay off the rendered canvas.
const scheduleCycleZero = (state: CompilerState, qubit: number) => {
  state.resetQubits.add(qubit);
  state.pendingCycleZeros.add(qubit);
};

const flushCycleZeros = (state: CompilerState, source: string) => {
  if (state.pendingCycleZeros.size === 0) return;
  const targets = [...state.pendingCycleZeros];
  state.pendingCycleZeros.clear();
  emitGate(state, 'RESET', targets, [], source);
};

const resolveInputQubit = (state: CompilerState, frame: Frame, token: string, parentFrame?: Frame) =>
  ensureQubit(state, scopedName(frame, token, parentFrame));

const returnRegistersForProcess = (process: ProtocolProcess): string[] => {
  for (const line of process.lines) {
    try {
      const command = parseCommand(line);
      if (command.op === 'RETURNVALS') return command.args.map(stripCycle);
    } catch {
      // Ignore malformed lines while scanning for the child's return register list.
    }
  }
  return [];
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
): string[] => {
  const scope = `${process.name}#${state.processRuns}`;
  if (!state.rootScope) state.rootScope = scope;
  state.processRuns += 1;
  const params = new Map<string, string>();
  process.params.forEach((param, index) => {
    const provided = passedParams[index];
    let resolved: string;
    // RUNCHILD -I tokens re-scope through the parent frame; top-level PARAMS keep their declared names.
    if (provided !== undefined && parentFrame) {
      resolved = scopedName(parentFrame, provided, parentFrame);
    } else {
      resolved = param.name;
    }
    params.set(param.name, resolved);
  });
  const frame: Frame = { process, scope, aliases: new Map(), params, declaredChildren: new Map() };
  outputBindings.forEach((parentToken, childRegister) => {
    frame.aliases.set(childRegister, parentToken);
  });
  process.params.forEach((param) => ensureQubit(state, params.get(param.name)!));
  let returns: string[] = [];

  state.log.push(`MAIN-PROCESS ${process.name} compiled in scope ${scope}.`);

  // Line dispatch is ordered: workspace/cycle ops run before gates so pending RESETs flush at INCREASECYCLE and primitives.
  for (const line of process.lines) {
    const command = parseCommand(line);
    state.parsed.push(command);

    if (command.op === 'MAIN-PROCESS') {
      // Body entry marker only; compilation already started from parseProtocol's MAIN-PROCESS name.
      state.log.push(`Main process '${command.args[0]}' started.`);
      continue;
    }

    if (command.op === 'INCREASECYCLE') {
      flushCycleZeros(state, `INCREASECYCLE end of cycle ${state.currentCycle}`);
      state.currentCycle += 1;
      state.log.push(`Cycle increased to ${state.currentCycle}; workspace registers prepared for the new cycle.`);
      continue;
    }

    if (command.op === 'SET') {
      const [target, value] = command.args;
      const targetName = scopedName(frame, target, parentFrame);
      const targetBase = stripCycle(target);
      if (!value) throw new Error(`SET requires a value in '${line}'`);
      // State-typed PARAM defaults are runtime controls; non-param constants lower to initializer gates during compile.
      if (isConstant(value)) {
        const declaredParam = frame.process.params.find((param) => param.name === targetBase);
        if (declaredParam?.type === 'state') {
          ensureQubit(state, targetName);
          state.log.push(`SET ${targetBase} default ${value} at cycle ${state.currentCycle} (parametric default; runtime start state).`);
          continue;
        }
        const qubit = ensureQubit(state, targetName);
        const normalizedValue = value.replace(/^\$/, '').toLowerCase();
        if (normalizedValue.startsWith('0p')) scheduleCycleZero(state, qubit);
        if (normalizedValue.startsWith('1p')) emitGate(state, 'X', [qubit], [], line);
        if (normalizedValue.startsWith('sp')) emitGate(state, 'H', [qubit], [], line);
        state.log.push(`SET ${stripCycle(target)} to ${value} at cycle ${state.currentCycle}.`);
      } else {
        const valueName = scopedName(frame, value, parentFrame);
        frame.aliases.set(stripCycle(target), valueName);
        state.log.push(`SET ${stripCycle(target)} as alias of ${stripCycle(value)}.`);
      }
      continue;
    }

    if (command.op === 'CREATETOKEN') {
      // CREATETOKEN must claim wires up front so later gate rows resolve stable indices during the same compile pass.
      command.inputs.forEach((token) => {
        ensureQubit(state, scopedName(frame, token, parentFrame));
      });
      state.log.push(`CREATETOKEN created ${command.inputs.join(', ')}.`);
      continue;
    }

    if (command.op === 'DELETETOKEN' || command.op === 'FREE') {
      // Lifetime hints are logged for parity; compaction drops unused wires after expansion.
      state.log.push(`${command.op} acknowledged for ${command.inputs.join(', ')}.`);
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

    if (command.op === 'RUNCHILD' || command.op === 'CALL') {
      const childName = command.args[0];
      if (!childName) throw new Error(`${command.op} requires a process name`);
      const child = frame.declaredChildren.get(childName) ?? library.get(childName);
      if (!child) throw new Error(`Unknown child process '${childName}'`);
      const childReturnRegisters = returnRegistersForProcess(child);
      const childOutputBindings = new Map<string, string>();
      const preparedOutputQubits = new Set<number>();
      // Child RETURNVALS bind directly onto parent outputs, with each output reset once before expansion.
      command.outputs.forEach((output, index) => {
        const childRegister = childReturnRegisters[index];
        if (!childRegister) return;
        const parentToken = scopedName(frame, stripCycle(output), parentFrame);
        const qubit = ensureQubit(state, parentToken);
        if (!preparedOutputQubits.has(qubit)) {
          preparedOutputQubits.add(qubit);
          scheduleCycleZero(state, qubit);
        }
        childOutputBindings.set(childRegister, parentToken);
      });
      flushCycleZeros(state, `prepare outputs before RUNCHILD ${childName} at cycle ${state.currentCycle}`);
      const childReturns = executeProcess(child, state, library, command.inputs, frame, childOutputBindings);
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
      returns = command.args.map((token) => scopedName(frame, token, parentFrame));
      state.log.push(`RETURNVALS ${command.args.join(', ')}.`);
      continue;
    }

    if (command.op === 'MEASURE') {
      // Protocols omit -I on MEASURE to collapse all wires before RETURNVALS reads classical bits.
      if (command.inputs.length) {
        command.inputs.forEach((token) => emitGate(state, 'MEASURE', [resolveInputQubit(state, frame, token, parentFrame)], [], line));
      } else {
        state.tokenToQubit.forEach((qubit) => emitGate(state, 'MEASURE', [qubit], [], line));
      }
      continue;
    }

    if (command.op === 'SAVE_STATE' || command.op === 'LOAD_STATE' || command.op === 'MASTERVAL' || command.op === 'COMPILEPROCESS') {
      // Checkpoint/process-control opcodes are accepted for source fidelity but not lowered to gates yet.
      state.log.push(`${command.op} parsed: ${command.args.join(' ')}.`);
      continue;
    }

    if (command.op === 'JOIN' || command.op === 'SPLIT') {
      state.log.push(`${command.op} parsed for register memory; visual lowering is deferred.`);
      continue;
    }

    if (primitiveGates.has(command.op)) {
      flushCycleZeros(state, `prepare workspace before gate at cycle ${state.currentCycle}`);
      if (command.op === 'SWAP') {
        const swapQubits = command.inputs
          .slice(0, 2)
          .map((input) => resolveInputQubit(state, frame, input, parentFrame));
        if (swapQubits.length < 2) throw new Error('SWAP requires two input qubits.');
        if (command.outputs.length > 0) {
          if (command.outputs.length !== command.inputs.length) {
            throw new Error('SWAP outputs must match inputs.');
          }
          const swapOutputs = command.outputs.map((output) => resolveInputQubit(state, frame, output, parentFrame));
          swapQubits.forEach((inputQubit, index) => {
            if (swapOutputs[index] !== inputQubit) {
              throw new Error('SWAP outputs must match inputs.');
            }
          });
        }
        emitGate(state, 'SWAP', swapQubits, [], line);
        continue;
      }
      // For primitive and derived AST gates, -O names the mutated target and -I names controls/inputs.
      const targetToken = command.outputs[0] ?? command.inputs[0];
      const target = resolveInputQubit(state, frame, targetToken, parentFrame);
      const controls = command.inputs
        .map((input) => resolveInputQubit(state, frame, input, parentFrame))
        // When -O names the mutated wire, drop it from the control list so self-controlled ops do not deadlock.
        .filter((qubit) => qubit !== target);
      emitGate(state, command.op as GateType, [target], controls, line, command.op === 'PHASE' ? command.phase ?? 0 : undefined);
      continue;
    }

    // Derived gates share the same -I/-O lowering as primitives but never carry PHASE metadata.
    if (derivedGates.has(command.op)) {
      flushCycleZeros(state, `prepare workspace before gate at cycle ${state.currentCycle}`);
      const target = resolveInputQubit(state, frame, command.outputs[0], parentFrame);
      const controls = command.inputs
        .map((input) => resolveInputQubit(state, frame, input, parentFrame))
        .filter((qubit) => qubit !== target);
      emitGate(state, command.op as GateType, [target], controls, line);
      continue;
    }
  }

  flushCycleZeros(state, `end of process ${process.name}`);
  return returns;
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
  });
  processParams.forEach((param) => used.add(param.qubitIndex));

  const sorted = [...used].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { gates, tokenMap, processParams, qubitCount: 0 };
  }

  // Remap compacts holes left by unused symbolic registers while preserving gate step order.
  const remap = new Map(sorted.map((old, index) => [old, index]));
  return {
    gates: gates.map((gate) => ({
      ...gate,
      targets: gate.targets.map((qubit) => remap.get(qubit)!),
      controls: gate.controls.map((qubit) => remap.get(qubit)!),
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
  };
};

// The compiler returns both renderable gates and logical I/O mappings so the UI can display only process-facing qubits.
export const compileQpuProtocol = (source: string, librarySources: Record<string, string> = {}): CompileResult => {
  const main = parseProtocol(source);
  const library = processLibraryFromSources(librarySources);
  // The file being compiled is always addressable as a child of itself (e.g. recursive RUNCHILD tests).
  library.set(main.name, main);
  const state: CompilerState = {
    gates: [],
    parsed: [],
    log: [],
    tokenToQubit: new Map(),
    resetQubits: new Set(),
    pendingCycleZeros: new Set(),
    lastReturns: [],
    currentCycle: 0,
    processRuns: 0,
    rootScope: '',
  };

  executeProcess(main, state, library);

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
    const entry = Object.entries(compacted.tokenMap).find(([token]) => token === name || token.endsWith(`/${name}`));
    if (entry === undefined) return [];
    return [{ name, qubitIndex: entry[1] }];
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
    tokenMap: compacted.tokenMap,
    processParams: compacted.processParams,
    returnValues,
  };
};
