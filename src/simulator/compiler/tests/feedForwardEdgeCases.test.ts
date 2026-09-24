import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { createInitialState, runCircuit } from '../../engine';
import { magnitudeSquared } from '../../complex';
import { applyCustomGateProcess, registerCustomGate } from '../../gates/customGateEngine';
import { buildVisualCircuitColumns } from '../../../components/circuit/recursionVisuals';
import recursiveH from '../../../data/processes/recursive-h.qpucir?raw';

describe('feed-forward and recursion identity edge cases', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) { this.storage[key] = value; },
      getItem(key: string) { return this.storage[key] ?? null; },
      removeItem(key: string) { delete this.storage[key]; },
    });
  });

  it('evaluates -IF conditions on gates inside a custom gate', () => {
    const record = registerCustomGate({
      id: 'CondFlip',
      source: 'PARAMS: A:1 C:1\nMAIN-PROCESS CondFlip\nMEASURE -I A\nX -I C -O C -IF A=1\nRETURNVALS C',
    });
    // A (control) starts 0, so the conditioned X on C must be skipped.
    const result = applyCustomGateProcess(createInitialState(2), 2, {
      id: 'g', type: 'CondFlip', step: 0, targets: [1], controls: [0, 1],
    }, {}, record);
    expect(magnitudeSquared(result.state[0])).toBeCloseTo(1, 10);
    expect(result.log.some((line) => /skipped because classical condition was false/i.test(line))).toBe(true);
  });

  it('remaps condition qubits when compaction removes an unused wire', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state
MAIN-PROCESS Holes
CREATETOKEN -I Scratch C
SET C 1p
MEASURE -I C
X -I A -O A -IF C=1
RETURNVALS A`);
    const measure = compiled.gates.find((gate) => gate.type === 'MEASURE')!;
    const conditioned = compiled.gates.find((gate) => gate.condition)!;
    expect(conditioned.condition!.qubit).toBe(measure.targets[0]);
    expect(conditioned.condition!.qubit).toBeLessThan(compiled.qubitCount);
    const executed = runCircuit(compiled.qubitCount, compiled.gates, ['0p']);
    expect(executed.measurements[measure.targets[0]]).toBe(1);
  });

  it('remaps IF/ELSE branch source qubits during compaction', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state
MAIN-PROCESS HolesBranch
CREATETOKEN -I Scratch C
SET C 1p
MEASURE -I C
IF C=1
X -I A -O A
ENDIF
RETURNVALS A`);
    const measure = compiled.gates.find((gate) => gate.type === 'MEASURE')!;
    const conditioned = compiled.gates.find((gate) => gate.branch)!;
    expect(conditioned.branch!.sourceQubit).toBe(measure.targets[0]);
    expect(conditioned.condition!.qubit).toBe(measure.targets[0]);
  });

  it('rejects nested IF blocks and -IF inside an IF block instead of dropping the outer condition', () => {
    expect(() => compileQpuProtocol(`PARAMS: A:state B:state C:state
MAIN-PROCESS Nested
MEASURE -I A
MEASURE -I B
IF A=1
IF B=1
X -I C -O C
ENDIF
ENDIF
RETURNVALS C`)).toThrow(/nested IF/i);
    expect(() => compileQpuProtocol(`PARAMS: A:state B:state C:state
MAIN-PROCESS InlineInside
MEASURE -I A
MEASURE -I B
IF A=1
X -I C -O C -IF B=1
ENDIF
RETURNVALS C`)).toThrow(/-IF inside an IF block/i);
    // Child gates compile in their own frame and would otherwise lose the block's condition.
    expect(() => compileQpuProtocol(`PARAMS: A:state Q:state
MAIN-PROCESS ChildInside
DECLARECHILD RecursiveH
MEASURE -I A
IF A=1
RUNCHILD RecursiveH -DEPTH 2 -I Q
ENDIF
RETURNVALS Q`, { RecursiveH: recursiveH })).toThrow(/RUNCHILD inside an IF block/i);
  });

  it('keeps two calls to the same recursive child as separate canvas columns', () => {
    const compiled = compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS TwoCalls
DECLARECHILD RecursiveH
RUNCHILD RecursiveH -DEPTH 2 -I Q
RUNCHILD RecursiveH -DEPTH 2 -I Q
RETURNVALS Q`, { RecursiveH: recursiveH });
    const columns = buildVisualCircuitColumns(visibleCircuitGates(compiled.gates)).filter((column) => column.recursion);
    expect(columns).toHaveLength(2);
    const ids = new Set(compiled.gates.filter((gate) => gate.recursion).map((gate) => gate.recursion!.invocation));
    expect(ids.size).toBe(2);
  });
});
