import { describe, expect, it } from 'vitest';
import { analyzeQpuProtocol } from '../protocolDiagnostics';

const validProtocol = `PARAMS: A:state
MAIN-PROCESS Valid
X -I A -O A
MEASURE -I A
RETURNVALS A`;

describe('protocol diagnostics', () => {
  it('accepts a complete runnable protocol without diagnostics', () => {
    expect(analyzeQpuProtocol(validProtocol)).toEqual({
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      canCompile: true,
      correctionLabRecommended: false,
    });
  });

  it('reports unknown instructions with their physical source line', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS Broken
SET Q 0p
FLIP -I Q -O Q
RETURNVALS Q`);

    expect(report.canCompile).toBe(false);
    expect(report.correctionLabRecommended).toBe(true);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'UNKNOWN_INSTRUCTION',
      line: 3,
      source: 'FLIP -I Q -O Q',
    }));
  });

  it('reports gate arity errors with correction guidance', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS Broken
H -I Q
RETURNVALS Q`);

    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'INVALID_GATE_ARITY',
      line: 2,
      suggestion: expect.stringContaining('-O target count'),
    }));
  });

  it('warns about accepted-only and inactive compatibility syntax', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS Compatibility
JOIN -I A B -O AB
PHASE=pi/2 -I A -O A -$R
BT -I B -O B
RETURNVALS A B`);

    expect(report.canCompile).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'ACCEPTED_ONLY_OPERATION',
      'INACTIVE_PARAMETER_FLAG',
      'INACTIVE_REVERSE_PREFIX',
    ]);
  });

  it('recommends names and outputs without blocking compilation', () => {
    const report = analyzeQpuProtocol('SET Q 0p');

    expect(report.canCompile).toBe(true);
    expect(report.warningCount).toBe(2);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'MISSING_MAIN_PROCESS',
      'MISSING_RETURN_VALUES',
    ]);
  });

  it('catches semantic child lookup errors after syntax validation', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS Parent
RUNCHILD MissingChild -I A -O Result
RETURNVALS Result`);

    expect(report.canCompile).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'COMPILE_ERROR',
      line: 2,
      source: 'RUNCHILD MissingChild -I A -O Result',
      suggestion: expect.stringContaining('register'),
    }));
  });

  it('retains the first physical line for continued instructions', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS Continued
CCNOT -I A B \\
  -O
RETURNVALS A`);

    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'INVALID_GATE_ARITY',
      line: 2,
    }));
  });
});
