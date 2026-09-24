import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { runCircuit } from '../../engine';
import { branchOutcomeFor, conditionBadgeLabel } from '../../../components/circuit/branchVisuals';

describe('IF / ELSE classical feed-forward', () => {
  it('lowers IF/ELSE/ENDIF into conditioned gates with branch metadata', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state C:state
MAIN-PROCESS BranchDemo
MEASURE -I A
IF A=1
X -I C -O C
ELSE
Z -I C -O C
ENDIF
RETURNVALS A C`);
    const visible = visibleCircuitGates(compiled.gates);
    expect(visible.every((gate) => !['IF', 'ELSE', 'ENDIF'].includes(String(gate.type)))).toBe(true);
    const x = visible.find((gate) => gate.type === 'X');
    const z = visible.find((gate) => gate.type === 'Z');
    expect(x?.condition).toEqual({ qubit: 0, equals: 1 });
    expect(z?.condition).toEqual({ qubit: 0, equals: 0 });
    expect(x?.branch).toMatchObject({ kind: 'if', equals: 1, groupId: 'branch-0' });
    expect(z?.branch).toMatchObject({ kind: 'else', equals: 0, groupId: 'branch-0' });
    expect(x?.branch?.groupId).toBe(z?.branch?.groupId);
    expect(conditionBadgeLabel(x!)).toBe('IF · c=1');
    expect(conditionBadgeLabel(z!)).toBe('ELSE · c=0');
  });

  it('takes the IF branch when A=1 and skips ELSE', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state C:state
MAIN-PROCESS BranchDemo
SET A 1p
SET C 1p
MEASURE -I A
IF A=1
X -I C -O C
ELSE
Z -I C -O C
ENDIF
MEASURE -I C
RETURNVALS A C`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates, ['1p', '1p']);
    expect(executed.measurements[0]).toBe(1);
    expect(executed.measurements[1]).toBe(0);
    const x = compiled.gates.find((gate) => gate.type === 'X')!;
    const z = compiled.gates.find((gate) => gate.type === 'Z')!;
    expect(branchOutcomeFor(x, executed.measurements)).toBe('taken');
    expect(branchOutcomeFor(z, executed.measurements)).toBe('skipped');
    expect(executed.log.some((line) => /skipped because classical condition was false/i.test(line))).toBe(true);
  });

  it('keeps bare -IF without branch metadata', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state C:state
MAIN-PROCESS BareIf
MEASURE -I A
X -I C -O C -IF A=1
RETURNVALS A C`);
    const x = compiled.gates.find((gate) => gate.type === 'X')!;
    expect(x.condition).toEqual({ qubit: 0, equals: 1 });
    expect(x.branch).toBeUndefined();
    expect(conditionBadgeLabel(x)).toBe('c=1');
  });

  it('rejects ELSE / ENDIF without IF and unclosed IF', () => {
    expect(() => compileQpuProtocol(`PARAMS: A:state
MAIN-PROCESS Bad
ELSE
RETURNVALS A`)).toThrow(/ELSE without matching IF/i);
    expect(() => compileQpuProtocol(`PARAMS: A:state
MAIN-PROCESS Bad
IF A=1
X -I A -O A
RETURNVALS A`)).toThrow(/Unclosed IF/i);
  });
});
