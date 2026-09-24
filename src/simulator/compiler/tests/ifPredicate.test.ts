import { describe, expect, it } from 'vitest';
import { compileQpuProtocol } from '../qpuAst';
import { runCircuit } from '../../engine';
import { serializeCircuitToQpuProtocol } from '../qpuFormat';
import { conditionFeedTest } from '../../../components/circuit/branchVisuals';
import type { ParticleStartState } from '../../types';

const run = (source: string, starts: ParticleStartState[]) => {
  const compiled = compileQpuProtocol(source);
  const executed = runCircuit(compiled.qubitCount, compiled.gates, starts, compiled.processParams.map((param) => param.qubitIndex));
  return { compiled, executed };
};

// Flip Out when the predicate holds, otherwise leave it; measure Out to read the branch.
const branchProgram = (header: string, withElse = false) => `PARAMS: A:state B:state
MAIN-PROCESS Pred
CREATETOKEN -I Out
SET Out 0p
${header}
X -I Out -O Out
${withElse ? 'ELSE\nZ -I Out -O Out\n' : ''}ENDIF
MEASURE -I Out
RETURNVALS A B Out`;

const outBit = (source: string, starts: ParticleStartState[]) => {
  const { compiled, executed } = run(source, starts);
  const out = compiled.returnValues.find((value) => value.name === 'Out')!.qubitIndex;
  return executed.measurements[out];
};

describe('IF (gate expression) = value', () => {
  it('AND -I A B -O B tests A AND B without changing A or B', () => {
    const source = branchProgram('IF (AND -I A B -O B) = 1p');
    expect(outBit(source, ['1p', '1p'])).toBe(1);
    expect(outBit(source, ['1p', '0p'])).toBe(0);
    expect(outBit(source, ['0p', '1p'])).toBe(0);
    // The predicate runs on a scratch copy: B is still 1 afterwards.
    const { compiled, executed } = run(source.replace('MEASURE -I Out', 'MEASURE -I Out\nMEASURE -I B'), ['1p', '1p']);
    const b = compiled.processParams.find((param) => param.name === 'B')!.qubitIndex;
    expect(executed.measurements[b]).toBe(1);
  });

  it('accepts bare 1 / 0 / S as well as 1p / 0p / sp', () => {
    expect(outBit(branchProgram('IF (AND -I A B -O B) = 1'), ['1p', '1p'])).toBe(1);
    expect(outBit(branchProgram('IF (OR -I A B -O B) = 0'), ['0p', '0p'])).toBe(1);
    expect(outBit(branchProgram('IF (OR -I A B -O B) = 0p'), ['1p', '0p'])).toBe(0);
  });

  it('OR, XOR, NAND, and CNOT -I A -O B (A XOR B) follow their truth tables', () => {
    const table: [string, ParticleStartState[], 0 | 1][] = [
      ['IF (OR -I A B -O B) = 1', ['0p', '1p'], 1],
      ['IF (OR -I A B -O B) = 1', ['0p', '0p'], 0],
      ['IF (XOR -I A B -O B) = 1', ['1p', '1p'], 0],
      ['IF (XOR -I A B -O B) = 1', ['1p', '0p'], 1],
      ['IF (NAND -I A B -O B) = 1', ['1p', '1p'], 0],
      ['IF (NAND -I A B -O B) = 1', ['0p', '1p'], 1],
      ['IF (CNOT -I A -O B) = 1', ['1p', '0p'], 1],
      ['IF (CNOT -I A -O B) = 1', ['1p', '1p'], 0],
    ];
    table.forEach(([header, starts, expected]) => {
      expect(outBit(branchProgram(header), starts), `${header} with ${starts.join(',')}`).toBe(expected);
    });
  });

  it('S / sp matches a superposed result wire', () => {
    expect(outBit(branchProgram('IF (H -I A -O A) = S'), ['0p', '0p'])).toBe(1);
    expect(outBit(branchProgram('IF (H -I A -O A) = Sp'), ['0p', '0p'])).toBe(1);
    expect(outBit(branchProgram('IF (X -I A -O A) = S'), ['0p', '0p'])).toBe(0);
    // A start state in superposition makes AND's result superposed too.
    expect(outBit(branchProgram('IF (AND -I A B -O B) = S'), ['sp', '1p'])).toBe(1);
  });

  it('single-input gates act on the -O wire, as in a circuit line', () => {
    // X -I A -O C flips C (the -O wire), so the test reads NOT C.
    const source = `PARAMS: A:state C:state
MAIN-PROCESS Single
CREATETOKEN -I Out
SET Out 0p
IF (X -I A -O C) = 1
X -I Out -O Out
ENDIF
MEASURE -I Out
RETURNVALS A C Out`;
    expect(outBit(source, ['0p', '0p'])).toBe(1);
    expect(outBit(source, ['0p', '1p'])).toBe(0);
  });

  it('ELSE and != negate the test', () => {
    const withElse = branchProgram('IF (AND -I A B -O B) = 1', true);
    const { compiled } = run(withElse, ['1p', '0p']);
    const x = compiled.gates.find((gate) => gate.type === 'X' && gate.branch?.kind === 'if')!;
    const z = compiled.gates.find((gate) => gate.type === 'Z' && gate.branch?.kind === 'else')!;
    expect(x.condition?.predicate?.negate).toBe(false);
    expect(z.condition?.predicate?.negate).toBe(true);
    expect(outBit(branchProgram('IF (AND -I A B -O B) != 1'), ['1p', '0p'])).toBe(1);
    expect(outBit(branchProgram('IF (AND -I A B -O B) != 1'), ['1p', '1p'])).toBe(0);
  });

  it('records taken/skipped outcomes per gate for the canvas', () => {
    const { compiled, executed } = run(branchProgram('IF (AND -I A B -O B) = 1', true), ['1p', '0p']);
    const x = compiled.gates.find((gate) => gate.branch?.kind === 'if')!;
    const z = compiled.gates.find((gate) => gate.branch?.kind === 'else')!;
    expect(executed.conditionOutcomes?.[x.id]).toBe(false);
    expect(executed.conditionOutcomes?.[z.id]).toBe(true);
  });

  it('rejects malformed expressions and non-predicate gates', () => {
    expect(() => compileQpuProtocol(branchProgram('IF (AND -I A B -O B) = 2'))).toThrow(/Invalid IF expression/);
    expect(() => compileQpuProtocol(branchProgram('IF (MEASURE -I A) = 1'))).toThrow(/single-result gate/);
    expect(() => compileQpuProtocol(branchProgram('IF (SWAP -I A B -O A B) = 1'))).toThrow(/single-result gate/);
  });

  it('keeps plain IF Token=0|1 on measured bits', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state C:state
MAIN-PROCESS Bit
MEASURE -I A
IF A=1
X -I C -O C
ENDIF
RETURNVALS A C`);
    const x = compiled.gates.find((gate) => gate.type === 'X')!;
    expect(x.condition).toEqual({ qubit: 0, equals: 1 });
  });

  it('labels the canvas test and round-trips through canvas serialization', () => {
    const { compiled } = run(branchProgram('IF (AND -I A B -O B) = 1', true), ['1p', '1p']);
    const x = compiled.gates.find((gate) => gate.branch?.kind === 'if')!;
    const z = compiled.gates.find((gate) => gate.branch?.kind === 'else')!;
    expect(conditionFeedTest(x)).toBe('AND(A,B)=1');
    expect(conditionFeedTest(z)).toBe('AND(A,B)≠1');

    const text = serializeCircuitToQpuProtocol(compiled.gates, compiled.qubitCount, ['1p', '1p', '0p']);
    expect(text).toMatch(/IF \(AND -I \$Q0 \$Q1 -O \$Q1\) = 1p/);
    expect(text).toMatch(/IF \(AND -I \$Q0 \$Q1 -O \$Q1\) != 1p/);
    const again = compileQpuProtocol(text);
    const againX = again.gates.find((gate) => gate.type === 'X' && gate.condition?.predicate)!;
    expect(againX.condition?.predicate).toMatchObject({ type: 'AND', scratch: true, expect: 1, negate: false });
  });
});
