import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileQpuProtocol } from '../qpuAst';
import { serializeCircuitToQpuProtocol } from '../qpuFormat';
import { runCircuit } from '../../engine';
import { registerCustomGate } from '../../gates/customGateEngine';
import { refreshCustomGateRegistry } from '../../gates/registry';
import type { ParticleStartState } from '../../types';

// AndOut returns A AND B in a fresh output; HalfSum returns A XOR B and A AND B.
const AND_OUT = `PARAMS: A:1 B:1
MAIN-PROCESS AndOut
CREATETOKEN -I O
SET O 0p
AND -I A B -O O
RETURNVALS O`;
const FLIP = `PARAMS: Q:1
MAIN-PROCESS Flip
X -I Q -O Q
RETURNVALS Q`;
const SPREAD = `PARAMS: Q:1
MAIN-PROCESS Spread
H -I Q -O Q
RETURNVALS Q`;

const run = (source: string, starts: ParticleStartState[]) => {
  const compiled = compileQpuProtocol(source);
  const executed = runCircuit(
    compiled.qubitCount,
    compiled.gates,
    starts,
    compiled.processParams.map((param) => param.qubitIndex),
  );
  const bit = (name: string) => executed.measurements[
    compiled.returnValues.find((value) => value.name === name)?.qubitIndex
      ?? compiled.processParams.find((param) => param.name === name)!.qubitIndex
  ];
  return { compiled, executed, bit };
};

describe('custom gates in IF / ELSE chains', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) { this.storage[key] = value; },
      getItem(key: string) { return this.storage[key] ?? null; },
      removeItem(key: string) { delete this.storage[key]; },
    });
    registerCustomGate({ id: 'AndOut', source: AND_OUT });
    registerCustomGate({ id: 'Flip', source: FLIP });
    registerCustomGate({ id: 'Spread', source: SPREAD });
    refreshCustomGateRegistry();
  });

  it('accepts a registered custom gate as an ordinary protocol line', () => {
    const { compiled, bit } = run(`PARAMS: A:state B:state C:state
MAIN-PROCESS UseAnd
AndOut -I A B -O C
MEASURE -I C
RETURNVALS A B C`, ['1p', '1p', '0p']);
    const gate = compiled.gates.find((entry) => entry.customGateId === 'AndOut')!;
    expect(gate.controls).toHaveLength(2);
    expect(gate.targets).toHaveLength(1);
    expect(bit('C')).toBe(1);
  });

  it('runs or skips custom gates inside IF / ELSE bodies', () => {
    const source = `PARAMS: A:state C:state
MAIN-PROCESS Body
MEASURE -I A
IF A=1
Flip -I C -O C
ELSE
Spread -I C -O C
ENDIF
MEASURE -I C
RETURNVALS A C`;
    expect(run(source, ['1p', '0p']).bit('C')).toBe(1);
    const { compiled, executed } = run(source, ['0p', '0p']);
    const flip = compiled.gates.find((gate) => gate.customGateId === 'Flip')!;
    const spread = compiled.gates.find((gate) => gate.customGateId === 'Spread')!;
    expect(executed.conditionOutcomes?.[flip.id]).toBe(false);
    expect(executed.conditionOutcomes?.[spread.id]).toBe(true);
  });

  it('uses a custom gate as the IF expression', () => {
    const source = (header: string) => `PARAMS: A:state B:state C:state
MAIN-PROCESS CustomTest
CREATETOKEN -I Out
SET Out 0p
${header}
X -I Out -O Out
ENDIF
MEASURE -I Out
RETURNVALS A B C Out`;
    expect(run(source('IF (AndOut -I A B -O C) = 1'), ['1p', '1p', '0p']).bit('Out')).toBe(1);
    expect(run(source('IF (AndOut -I A B -O C) = 1'), ['1p', '0p', '0p']).bit('Out')).toBe(0);
    expect(run(source('IF (AndOut -I A B -O C) != 1p'), ['0p', '1p', '0p']).bit('Out')).toBe(1);
    expect(run(source('IF (Spread -I A -O A) = S'), ['0p', '0p', '0p']).bit('Out')).toBe(1);
    expect(run(source('IF (Flip -I A -O A) = 1'), ['0p', '0p', '0p']).bit('Out')).toBe(1);
    // The expression runs on a scratch copy: C is still 0 afterwards.
    const { compiled, executed } = run(`${source('IF (AndOut -I A B -O C) = 1')}\nMEASURE -I C`.replace('RETURNVALS A B C Out\nMEASURE -I C', 'MEASURE -I C\nRETURNVALS A B C Out'), ['1p', '1p', '0p']);
    const c = compiled.processParams.find((param) => param.name === 'C')!.qubitIndex;
    expect(executed.measurements[c]).toBe(0);
  });

  it('accepts the dg / inv marker on reversible custom gates', () => {
    const { compiled } = run(`PARAMS: C:state
MAIN-PROCESS Inverse
Flipdg -I C -O C
invFlip -I C -O C
RETURNVALS C`, ['0p']);
    const flips = compiled.gates.filter((gate) => gate.customGateId === 'Flip');
    expect(flips).toHaveLength(2);
    expect(flips.every((gate) => gate.inverse)).toBe(true);
  });

  it('checks custom gate arity and single-value IF expressions', () => {
    expect(() => compileQpuProtocol(`PARAMS: A:state C:state
MAIN-PROCESS Bad
AndOut -I A -O C
RETURNVALS C`)).toThrow(/AndOut takes 2 -I input/);
    registerCustomGate({ id: 'Pair', source: 'PARAMS: A:1 B:1\nMAIN-PROCESS Pair\nX -I A -O A\nRETURNVALS A B' });
    expect(() => compileQpuProtocol(`PARAMS: A:state B:state C:state
MAIN-PROCESS BadIf
IF (Pair -I A B -O A B) = 1
X -I C -O C
ENDIF
RETURNVALS C`)).toThrow(/must return exactly one value/);
  });

  it('round-trips custom gates and custom IF expressions through canvas serialization', () => {
    const { compiled } = run(`PARAMS: A:state B:state C:state
MAIN-PROCESS Trip
IF (AndOut -I A B -O C) = 1
Flip -I C -O C
ENDIF
RETURNVALS A B C`, ['1p', '1p', '0p']);
    const text = serializeCircuitToQpuProtocol(compiled.gates, compiled.qubitCount, ['1p', '1p', '0p']);
    expect(text).toMatch(/IF \(AndOut -I \$Q0 \$Q1 -O \$Q2\) = 1p/);
    expect(text).toMatch(/Flip -I \$Q2:0 -O \$Q2:0/);
    const again = compileQpuProtocol(text);
    const flip = again.gates.find((gate) => gate.customGateId === 'Flip')!;
    expect(flip.condition?.predicate).toMatchObject({ type: 'AndOut', expect: 1 });
  });

  it('refuses a custom gate whose source uses itself', () => {
    registerCustomGate({ id: 'Loop', source: FLIP.replace('Flip', 'Loop') });
    registerCustomGate({ id: 'Loop', source: 'PARAMS: Q:1\nMAIN-PROCESS Loop\nLoop -I Q -O Q\nRETURNVALS Q' });
    refreshCustomGateRegistry();
    expect(() => run(`PARAMS: Q:state
MAIN-PROCESS UseLoop
Loop -I Q -O Q
RETURNVALS Q`, ['0p'])).toThrow(/uses itself/);
  });
});
