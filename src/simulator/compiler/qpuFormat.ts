// Protocol text editing and canvas serialization — separate from qpuAst compilation.
import { CircuitGate, ParticleStartState } from '../types';

export type ProtocolParamEntry = { name: string; type: string };
// MAIN-PROCESS names become filesystem-safe .qpucir stems for catalog entries and uploads.
const sanitizeProcessName = (name: string) => {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, ' ').trim().replace(/\s+(\w)/g, (_, letter: string) => letter.toUpperCase());
  return cleaned.replace(/^[^A-Za-z_]+/, '') || 'CircuitProcess';
};

// First MAIN-PROCESS line names the catalog entry and default .qpucir filename.
export const extractMainProcessName = (source: string): string | null => {
  const line = source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => /^MAIN-PROCESS\s+/i.test(candidate));
  return line?.split(/\s+/)[1] ?? null;
};

export const qpucirFileNameForSource = (source: string, fallbackName = 'CurrentCircuit') => {
  const processName = sanitizeProcessName(extractMainProcessName(source) ?? fallbackName);
  return `${processName}.qpucir`;
};

// Strip $ aliases and :bit suffixes so SET/RETURNVALS tokens compare by register name.
const stripProtocolRef = (token: string) => token.replace(/^\$/, '').split(':')[0];
const isMainProcessLine = (line: string) => /^\s*MAIN-PROCESS\s+/i.test(line);
const isParamsLine = (line: string) => /^\s*PARAMS:/i.test(line);
const isSetLine = (line: string) => /^\s*SET\s+/i.test(line);
const isCreateTokenLine = (line: string) => /^\s*CREATETOKEN\b/i.test(line);
type ProtocolLineBlock = { start: number; end: number; logicalLine: string };

// Continued-line blocks let PARAMS and generated gate rows round-trip without losing source formatting.
const findContinuedLineBlock = (lines: string[], start: number): ProtocolLineBlock => {
  let logicalLine = '';
  let end = start;

  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];
    const continued = raw.endsWith('\\');
    const line = continued ? raw.slice(0, -1).trimEnd() : raw;
    logicalLine += continued ? `${line} ` : line;
    end = index;
    if (!continued) break;
  }

  return { start, end, logicalLine };
};

const findParamsBlock = (lines: string[]): ProtocolLineBlock | null => {
  const start = lines.findIndex(isParamsLine);
  return start >= 0 ? findContinuedLineBlock(lines, start) : null;
};

const parseProtocolParamParts = (paramsBody: string): ProtocolParamEntry[] => paramsBody
  .trim()
  .split(/\s+/)
  .filter((part) => part.includes(':'))
  .map((part) => {
    const [name, type] = part.split(':', 2);
    return { name, type: type || 'state' };
  });

export const getProtocolParameterEntries = (source: string): ProtocolParamEntry[] => {
  const block = findParamsBlock(source.replace(/\r\n/g, '\n').split('\n'));
  if (!block) return [];
  return parseProtocolParamParts(block.logicalLine.slice(block.logicalLine.indexOf(':') + 1));
};

// Auto-generated Q0/Q1 param names must not collide with existing identifiers in the source.
const reservedProtocolNames = (source: string) => new Set(
  Array.from(source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g), ([name]) => name)
    .filter((name) => !['PARAMS', 'MAIN', 'PROCESS', 'state', 'int', 'float'].includes(name)),
);

const nextProtocolParamName = (reserved: Set<string>, index: number) => {
  for (let candidateIndex = index; ; candidateIndex += 1) {
    const candidate = `Q${candidateIndex}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
};

// Rewrites the RETURNVALS block (including backslash continuations) when output columns change.
export const updateProtocolReturnValTokens = (source: string, outputNames: string[]) => {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const returnLine = `RETURNVALS ${outputNames.join(' ')}`.trimEnd();
  const returnIndex = lines.findIndex((line) => /^\s*RETURNVALS\b/i.test(line));

  if (returnIndex >= 0) {
    const block = findContinuedLineBlock(lines, returnIndex);
    const indent = lines[block.start].match(/^\s*/)?.[0] ?? '';
    lines.splice(block.start, block.end - block.start + 1, `${indent}${returnLine}`);
  } else {
    lines.push(returnLine);
  }

  return lines.join(newline);
};

// Scaffold for a new Correction Lab process: PARAMS, CREATETOKEN outputs, zeroed SET lines, RETURNVALS.
export const createBlankProtocol = (inputNames: string[], outputNames: string[]) => {
  const inputs = inputNames.length > 0 ? inputNames : ['A', 'B'];
  const outputs = outputNames.length > 0 ? outputNames : ['Y'];
  const processName = 'UntitledCircuit';
  return [
    `PARAMS: ${inputs.map((name) => `${name}:state`).join(' ')}`,
    '',
    `MAIN-PROCESS ${processName}`,
    `CREATETOKEN -I ${outputs.join(' ')}`,
    ...outputs.map((name) => `SET ${name}:0 0p`),
    `RETURNVALS ${outputs.map((name) => `${name}:0`).join(' ')}`,
  ].join('\n');
};

// Ensure CREATETOKEN -I and SET 0p lines exist for every declared output column.
const syncProtocolOutputRegisters = (source: string, outputColumns: string[]) => {
  const outputNames = outputColumns.map((name) => stripProtocolRef(name));
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const createIndex = lines.findIndex(isCreateTokenLine);

  if (createIndex >= 0) {
    const block = findContinuedLineBlock(lines, createIndex);
    const match = block.logicalLine.match(/\bCREATETOKEN\b\s+-I\s+(.+)/i);
    const existingTokens = match
      ? match[1].trim().split(/\s+/).map(stripProtocolRef).filter(Boolean)
      : [];
    const missingTokens = outputNames.filter((name) => !existingTokens.includes(name));
    if (missingTokens.length > 0) {
      const indent = lines[block.start].match(/^\s*/)?.[0] ?? '';
      lines.splice(
        block.start,
        block.end - block.start + 1,
        `${indent}CREATETOKEN -I ${[...existingTokens, ...missingTokens].join(' ')}`,
      );
    }
  } else {
    const mainIndex = lines.findIndex(isMainProcessLine);
    const insertAt = mainIndex >= 0 ? mainIndex + 1 : 0;
    lines.splice(insertAt, 0, `CREATETOKEN -I ${outputNames.join(' ')}`);
  }

  const existingSets = new Set<string>();
  lines.forEach((line) => {
    if (!isSetLine(line)) return;
    const parts = line.trim().split(/\s+/);
    const target = parts[1];
    if (target) existingSets.add(stripProtocolRef(target));
  });

  const missingSets = outputNames.filter((name) => !existingSets.has(name));
  if (missingSets.length > 0) {
    const anchorIndex = lines.findIndex((line) => /^\s*(MEASURE|RETURNVALS)\b/i.test(line));
    const insertAt = anchorIndex >= 0 ? anchorIndex : lines.length;
    lines.splice(insertAt, 0, ...missingSets.map((name) => `SET ${name}:0 0p`));
  }

  return lines.join(newline);
};

// Truth-table sync adjusts PARAMS/RETURNVALS around table columns without rewriting unrelated protocol commands.
export const syncProtocolToTruthTable = (source: string, inputColumns: string[], outputColumns: string[]) => {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let next = updateProtocolParameterCount(source, inputColumns.length);
  const lines = next.replace(/\r\n/g, '\n').split('\n');
  const paramsBlock = findParamsBlock(lines);
  if (paramsBlock) {
    const paramsLine = `PARAMS: ${inputColumns.map((name) => `${name}:state`).join(' ')}`.trimEnd();
    const indent = lines[paramsBlock.start].match(/^\s*/)?.[0] ?? '';
    lines.splice(paramsBlock.start, paramsBlock.end - paramsBlock.start + 1, `${indent}${paramsLine}`);
    next = lines.join(newline);
  }
  next = syncProtocolOutputRegisters(next, outputColumns);
  const outputTokens = outputColumns.map((name) => (name.includes(':') ? name : `${name}:0`));
  return updateProtocolReturnValTokens(next, outputTokens);
};

// Parameter-count edits preserve existing names/types where possible so UI resizing does not discard user labels.
export const updateProtocolParameterCount = (source: string, paramCount: number) => {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const paramsBlock = findParamsBlock(lines);
  const currentParams = paramsBlock
    ? parseProtocolParamParts(paramsBlock.logicalLine.slice(paramsBlock.logicalLine.indexOf(':') + 1))
    : [];
  const reservedNames = reservedProtocolNames(source);
  currentParams.forEach((param) => reservedNames.add(param.name));
  const nextParams = currentParams.slice(0, Math.max(0, paramCount));

  while (nextParams.length < paramCount) {
    nextParams.push({ name: nextProtocolParamName(reservedNames, nextParams.length), type: 'state' });
  }

  const paramsLine = `PARAMS: ${nextParams.map((param) => `${param.name}:${param.type}`).join(' ')}`.trimEnd();
  if (paramsBlock) {
    const indent = lines[paramsBlock.start].match(/^\s*/)?.[0] ?? '';
    lines.splice(paramsBlock.start, paramsBlock.end - paramsBlock.start + 1, `${indent}${paramsLine}`);
  } else {
    lines.unshift(paramsLine, '');
  }

  return lines.join(newline);
};

// Map a particle start state (0p/1p/sp) onto the SET line for a PARAMS register, inserting one if missing.
export const updateProtocolStartStateSet = (source: string, paramName: string, startState: ParticleStartState) => {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let updated = false;

  const nextLines = lines.map((line) => {
    if (!isSetLine(line)) return line;
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const commentMatch = line.match(/(\s+#.*)$/);
    const comment = commentMatch?.[1] ?? '';
    const body = commentMatch ? line.slice(0, -comment.length) : line;
    const parts = body.trim().split(/\s+/);
    const [, target, value] = parts;
    if (!target || !value) return line;
    if (stripProtocolRef(target) !== paramName && stripProtocolRef(value) !== paramName) return line;
    updated = true;
    return `${indent}SET ${target} ${startState}${comment}`;
  });

  if (!updated) {
    const mainIndex = nextLines.findIndex(isMainProcessLine);
    const paramsBlock = findParamsBlock(nextLines);
    const insertAt = mainIndex >= 0 ? mainIndex + 1 : paramsBlock ? paramsBlock.end + 1 : 0;
    nextLines.splice(insertAt, 0, `SET $${paramName} ${startState}`);
  }

  return nextLines.join(newline);
};

// Canvas wires use $Qn refs so serialized protocols do not clash with user-named PARAMS registers.
const canvasParamRef = (qubit: number) => `$Q${qubit}`;

const PARAMETERIZED_ANGLE_GATES = new Set(['PHASE', 'RX', 'RY', 'RZ', 'CPHASE', 'CP']);

const serializeGateOpcode = (gate: CircuitGate) => {
  if (PARAMETERIZED_ANGLE_GATES.has(String(gate.type))) {
    const angle = gate.inverse ? -(gate.phase ?? 0) : gate.phase ?? 0;
    return `${gate.type}${gate.inverse ? 'dg' : ''}=${angle}`;
  }
  if (!gate.inverse) return String(gate.type);
  // Self-inverse gates still emit dg so canvas inverse mode round-trips through the protocol text.
  return `${gate.type}dg`;
};

// Canvas serialization emits a minimal MAIN-PROCESS that the parser/compiler can immediately load again.
export const serializeCircuitToQpuProtocol = (
  gates: CircuitGate[],
  qubitCount: number,
  startStates: ParticleStartState[] = [],
  processName = 'CanvasCircuit',
) => {
  const lines = [
    `PARAMS: ${Array.from({ length: qubitCount }, (_, qubit) => `Q${qubit}:1`).join(' ')}`,
    '',
    `MAIN-PROCESS ${sanitizeProcessName(processName)}`,
  ];

  Array.from({ length: qubitCount }, (_, qubit) => {
    const startState = startStates[qubit] ?? '0p';
    if (startState !== '0p') {
      lines.push(`SET ${canvasParamRef(qubit)} ${startState}`);
    }
  });

  let cycle = 0;
  gates
    .slice()
    .sort((a, b) => a.step - b.step)
    .forEach((gate) => {
      // RESET on the canvas becomes explicit SET 0p lines because the protocol has no RESET opcode.
      if (gate.type === 'CYCLE') {
        lines.push('INCREASECYCLE');
        cycle += 1;
        return;
      }
      if (gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE') {
        lines.push(`${gate.type} ${gate.checkpoint ?? 'checkpoint'}`);
        return;
      }
      if (gate.type === 'RESET') {
        gate.targets.forEach((qubit) => {
          lines.push(`SET ${canvasParamRef(qubit)} 0p`);
        });
        return;
      }

      const target = `${canvasParamRef(gate.targets[0])}:${cycle}`;
      const controls = gate.controls.map((control) => `${canvasParamRef(control)}:${cycle}`);
      const op = serializeGateOpcode(gate);
      if (gate.type === 'MEASURE') {
        lines.push(`MEASURE -I ${canvasParamRef(gate.targets[0])}`);
        return;
      }
      const conditionSuffix = gate.condition
        ? ` -IF ${canvasParamRef(gate.condition.qubit).replace(/^\$/, '')}=${gate.condition.equals}`
        : '';
      if (gate.type === 'SWAP') {
        if (gate.targets.length < 2) return;
        const [first, second] = gate.targets;
        lines.push(`${op} -I ${canvasParamRef(first)}:${cycle} ${canvasParamRef(second)}:${cycle} -O ${canvasParamRef(first)}:${cycle} ${canvasParamRef(second)}:${cycle}${conditionSuffix}`);
        return;
      }
      if (
        gate.type === 'X'
        || gate.type === 'Y'
        || gate.type === 'Z'
        || gate.type === 'H'
        || gate.type === 'S'
        || gate.type === 'T'
        || gate.type === 'PHASE'
        || gate.type === 'NOT'
        || gate.type === 'RX'
        || gate.type === 'RY'
        || gate.type === 'RZ'
      ) {
        lines.push(`${op} -I ${target} -O ${target}${conditionSuffix}`);
        return;
      }
      lines.push(`${op} -I ${controls.join(' ')} -O ${target}${conditionSuffix}`);
    });

  lines.push(`RETURNVALS ${Array.from({ length: qubitCount }, (_, qubit) => canvasParamRef(qubit)).join(' ')}`);
  return lines.join('\n');
};
