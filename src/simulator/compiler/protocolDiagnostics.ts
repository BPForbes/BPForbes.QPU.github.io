import {
  compileQpuProtocol,
  parseCommand,
  parseParameters,
} from './qpuAst';

export type ProtocolDiagnosticSeverity = 'error' | 'warning';

export type ProtocolDiagnostic = {
  severity: ProtocolDiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
  source?: string;
  suggestion: string;
};

export type ProtocolDiagnosticReport = {
  diagnostics: ProtocolDiagnostic[];
  errorCount: number;
  warningCount: number;
  canCompile: boolean;
  correctionLabRecommended: boolean;
};

type NumberedProtocolLine = {
  text: string;
  line: number;
};

const SELF_INVERSE_PRIMITIVES = new Set([
  'X',
  'Y',
  'Z',
  'H',
  'CNOT',
  'CCNOT',
  'CZ',
  'CY',
  'SWAP',
]);

// Diagnostics retain physical start lines while matching the compiler's continuation and comment rules.
const readNumberedProtocolLines = (source: string): NumberedProtocolLine[] => {
  const joined: NumberedProtocolLine[] = [];
  let buffer = '';
  let bufferStart = 1;

  source.replace(/\r\n/g, '\n').split('\n').forEach((raw, index) => {
    const physicalLine = index + 1;
    const continued = raw.endsWith('\\');
    const line = continued ? raw.slice(0, -1).trimEnd() : raw;
    if (!buffer) bufferStart = physicalLine;
    if (continued) {
      buffer += `${line} `;
      return;
    }
    joined.push({ text: `${buffer}${line}`, line: bufferStart });
    buffer = '';
  });
  if (buffer.trim()) joined.push({ text: buffer, line: bufferStart });

  let inBlockComment = false;
  return joined.flatMap(({ text, line }) => {
    let cleaned = text.trim();
    if (!cleaned) return [];
    if (inBlockComment) {
      if (!cleaned.includes('*/')) return [];
      cleaned = cleaned.split('*/', 2)[1].trim();
      inBlockComment = false;
    }
    if (cleaned.includes('/*')) {
      const [prefix, rest] = cleaned.split('/*', 2);
      if (rest.includes('*/')) {
        cleaned = `${prefix} ${rest.split('*/', 2)[1]}`.trim();
      } else {
        cleaned = prefix.trim();
        inBlockComment = true;
      }
    }
    if (cleaned.includes('#')) cleaned = cleaned.split('#', 1)[0].trim();
    return cleaned ? [{ text: cleaned, line }] : [];
  });
};

const diagnosticForParseError = (
  message: string,
  source: NumberedProtocolLine,
): ProtocolDiagnostic => {
  const code = message.startsWith('Unknown command:')
    ? 'UNKNOWN_INSTRUCTION'
    : message.startsWith('Invalid PHASE')
      ? 'INVALID_PHASE'
      : message.includes('input(s)') || message.includes('output(s)') || message.includes('requires -')
        ? 'INVALID_GATE_ARITY'
        : 'INVALID_SYNTAX';
  const suggestion = code === 'UNKNOWN_INSTRUCTION'
    ? 'Check the instruction spelling and the supported-operation reference.'
    : code === 'INVALID_PHASE'
      ? 'Use radians, degrees ending in d, or a pi expression such as pi/2.'
      : code === 'INVALID_GATE_ARITY'
        ? 'Match the gate’s documented -I input/control count and -O target count.'
        : 'Review this instruction’s syntax and required arguments.';
  return {
    severity: 'error',
    code,
    message,
    line: source.line,
    source: source.text,
    suggestion,
  };
};

const semanticErrorLine = (
  message: string,
  lines: NumberedProtocolLine[],
): NumberedProtocolLine | undefined => {
  const quotedSource = message.match(/'([^']+)'/)?.[1];
  if (quotedSource) {
    const exact = lines.find((line) => line.text === quotedSource);
    if (exact) return exact;
  }
  if (message.includes('Unknown child process') || message.includes('DECLARECHILD requires')) {
    const child = message.match(/Unknown child process '([^']+)'/)?.[1];
    return lines.find((line) => (
      /^(DECLARECHILD|RUNCHILD|CALL)\b/i.test(line.text)
      && (!child || line.text.split(/\s+/)[1] === child)
    ));
  }
  if (message.startsWith('SWAP')) {
    return lines.find((line) => /^B?SWAP\b/i.test(line.text));
  }
  return undefined;
};

export const analyzeQpuProtocol = (
  source: string,
  librarySources: Record<string, string> = {},
): ProtocolDiagnosticReport => {
  const lines = readNumberedProtocolLines(source);
  const diagnostics: ProtocolDiagnostic[] = [];

  if (lines.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'EMPTY_PROTOCOL',
      message: 'The protocol is empty.',
      suggestion: 'Start with MAIN-PROCESS, then add preparation, gates, and RETURNVALS.',
    });
  }

  const paramsLine = lines[0]?.text.toUpperCase().startsWith('PARAMS:')
    ? lines[0]
    : undefined;
  const params = paramsLine ? parseParameters(paramsLine.text) : [];
  if (paramsLine && params.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'EMPTY_PARAMS',
      message: 'PARAMS must declare at least one name:type entry when present.',
      line: paramsLine.line,
      source: paramsLine.text,
      suggestion: 'Remove the PARAMS line or add an entry such as Input:state.',
    });
  }

  lines.slice(params.length > 0 ? 1 : 0).forEach((line) => {
    if (line.text.toUpperCase().startsWith('PARAMS:')) {
      diagnostics.push({
        severity: 'error',
        code: 'MISPLACED_PARAMS',
        message: 'PARAMS is only recognized as the first non-comment instruction.',
        line: line.line,
        source: line.text,
        suggestion: 'Move PARAMS to the beginning of the protocol.',
      });
      return;
    }

    try {
      const command = parseCommand(line.text);
      if (command.reverse && command.op !== 'PHASE' && command.op !== 'S' && command.op !== 'T' && !SELF_INVERSE_PRIMITIVES.has(command.op)) {
        diagnostics.push({
          severity: 'warning',
          code: 'INACTIVE_REVERSE_PREFIX',
          message: `The B prefix on ${command.op} does not currently synthesize an inverse operation.`,
          line: line.line,
          source: line.text,
          suggestion: 'Remove the B prefix unless only compatibility metadata is intended.',
        });
      }
      if (command.op === 'RETURNVALS' && command.args.some((arg) => arg.startsWith('-'))) {
        diagnostics.push({
          severity: 'warning',
          code: 'RETURN_FLAGS_ARE_POSITIONAL',
          message: 'RETURNVALS treats flags as returned token names.',
          line: line.line,
          source: line.text,
          suggestion: 'List return tokens directly, for example RETURNVALS Carry Sum.',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(diagnosticForParseError(message, line));
    }
  });

  if (lines.length > 0 && !lines.some((line) => /^MAIN-PROCESS\s+\S+/i.test(line.text))) {
    diagnostics.push({
      severity: 'warning',
      code: 'MISSING_MAIN_PROCESS',
      message: 'No MAIN-PROCESS name is declared; the system will use InlineProcess.',
      suggestion: 'Add MAIN-PROCESS followed by a descriptive process name.',
    });
  }
  if (lines.length > 0 && !lines.some((line) => /^RETURNVALS(?:\s|$)/i.test(line.text))) {
    diagnostics.push({
      severity: 'warning',
      code: 'MISSING_RETURN_VALUES',
      message: 'No RETURNVALS instruction declares the process outputs.',
      suggestion: 'Add RETURNVALS followed by the output tokens in display order.',
    });
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    try {
      const compiled = compileQpuProtocol(source, librarySources);
      compiled.warnings.forEach((warning) => {
        const match = lines.find((entry) => entry.text === warning.source);
        diagnostics.push({
          severity: 'warning',
          code: warning.code,
          message: warning.message,
          line: match?.line,
          source: warning.source,
          suggestion: warning.suggestion ?? 'Match an integer cycle suffix to the current cycle.',
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line = semanticErrorLine(message, lines);
      diagnostics.push({
        severity: 'error',
        code: 'COMPILE_ERROR',
        message,
        line: line?.line,
        source: line?.text,
        suggestion: message.includes('Unknown child process')
          ? 'Load or register the named child process, or correct the child name.'
          : 'Review the referenced instruction and use the Correction Lab for guided repair.',
      });
    }
  }

  diagnostics.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
    return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  });
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;
  return {
    diagnostics,
    errorCount,
    warningCount,
    canCompile: errorCount === 0,
    correctionLabRecommended: errorCount > 0,
  };
};
