import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { runCircuit } from '../../engine';
import { magnitudeSquared } from '../../complex';
import { MAX_COMPILER_RECURSION_DEPTH } from '../recursion';

const recursiveH = `PARAMS: Q:state
MAIN-PROCESS RecursiveH
REC MAXDEPTH 16
EXIT WHEN DEPTH == 0
H -I Q -O Q
INCREASECYCLE
RECUR -I Q
RETURNVALS Q`;

const parent = `PARAMS: Q:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -DEPTH 3 -I Q
RETURNVALS Q`;

describe('bounded child-process recursion', () => {
  it('expands RecursiveH -DEPTH 3 into three H + CYCLE stages', () => {
    const compiled = compileQpuProtocol(parent, { RecursiveH: recursiveH });
    const visible = visibleCircuitGates(compiled.gates);
    expect(visible.filter((gate) => gate.type === 'H')).toHaveLength(3);
    expect(visible.filter((gate) => gate.type === 'CYCLE')).toHaveLength(3);
    expect(compiled.log.some((line) => /reached its base depth/i.test(line))).toBe(true);
    expect(compiled.gates.every((gate) => gate.type !== 'REC' && gate.type !== 'RECUR' && gate.type !== 'EXIT')).toBe(true);
  });

  it('applies the expanded H gates to the qubit', () => {
    const compiled = compileQpuProtocol(parent, { RecursiveH: recursiveH });
    // Three Hadamards: H³ = H, so |0⟩ → |+⟩.
    const executed = runCircuit(compiled.qubitCount, compiled.gates, ['0p']);
    expect(magnitudeSquared(executed.state[0])).toBeCloseTo(0.5, 8);
    expect(magnitudeSquared(executed.state[1])).toBeCloseTo(0.5, 8);
  });

  it('rejects root self-recursion', () => {
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Rooty
REC
RUNCHILD Rooty -DEPTH 2 -I Q
RETURNVALS Q`)).toThrow(/cannot recursively expand itself|child-process frame/i);
  });

  it('rejects RECUR on the compilation root', () => {
    expect(() => compileQpuProtocol(recursiveH)).toThrow(/child-process frame|cannot recursively expand itself/i);
  });

  it('requires -DEPTH when invoking a recursive child', () => {
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -I Q
RETURNVALS Q`, { RecursiveH: recursiveH })).toThrow(/requires -DEPTH/i);
  });

  it('rejects mutual recursion', () => {
    const a = `PARAMS: Q:state
MAIN-PROCESS ProcA
REC
RUNCHILD ProcB -DEPTH 2 -I Q
RETURNVALS Q`;
    const b = `PARAMS: Q:state
MAIN-PROCESS ProcB
REC
RUNCHILD ProcA -DEPTH 2 -I Q
RETURNVALS Q`;
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Root
DECLARECHILD ProcA
RUNCHILD ProcA -DEPTH 2 -I Q
RETURNVALS Q`, { ProcA: a, ProcB: b })).toThrow(/Mutual recursion|cannot recursively expand itself/i);
  });

  it('rejects depth above process MAXDEPTH', () => {
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -DEPTH 32 -I Q
RETURNVALS Q`, { RecursiveH: recursiveH })).toThrow(/MAXDEPTH 16/i);
  });

  it('rejects depth above the compiler safety limit', () => {
    const loose = `PARAMS: Q:state
MAIN-PROCESS RecursiveH
REC
EXIT WHEN DEPTH == 0
H -I Q -O Q
RECUR -I Q
RETURNVALS Q`;
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -DEPTH ${MAX_COMPILER_RECURSION_DEPTH + 1} -I Q
RETURNVALS Q`, { RecursiveH: loose })).toThrow(/compiler limit/i);
  });

  it('supports self-RUNCHILD as an alternate spelling of RECUR', () => {
    const selfRun = `PARAMS: Q:state
MAIN-PROCESS ProcessB
REC
EXIT WHEN DEPTH == 0
H -I Q -O Q
INCREASECYCLE
RUNCHILD ProcessB -I Q
RETURNVALS Q`;
    const compiled = compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS ProcessA
DECLARECHILD ProcessB
RUNCHILD ProcessB -DEPTH 2 -I Q
RETURNVALS Q`, { ProcessB: selfRun });
    expect(visibleCircuitGates(compiled.gates).filter((gate) => gate.type === 'H')).toHaveLength(2);
  });

  it('does not zero-prepare in-place recursive outputs', () => {
    const compiled = compileQpuProtocol(parent, { RecursiveH: recursiveH });
    // Parent passes Q in place; expansion must not RESET the PARAM wire before the H chain.
    const paramQubit = compiled.processParams.find((param) => param.name === 'Q')?.qubitIndex;
    expect(paramQubit).toBeDefined();
    const resetTouchesParam = compiled.gates.some(
      (gate) => gate.type === 'RESET' && gate.targets.includes(paramQubit!),
    );
    expect(resetTouchesParam).toBe(false);
  });

  it('rejects mutating DEPTH with SET', () => {
    expect(() => compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -DEPTH 2 -I Q
RETURNVALS Q`, {
      RecursiveH: `PARAMS: Q:state
MAIN-PROCESS RecursiveH
REC
SET DEPTH 99
RECUR -I Q
RETURNVALS Q`,
    })).toThrow(/read-only/i);
  });
});
