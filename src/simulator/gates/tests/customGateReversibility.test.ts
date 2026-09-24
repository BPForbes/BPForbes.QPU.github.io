import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileQpuProtocol } from '../../compiler/qpuAst';
import { checkCustomGateReversibility } from '../customGateReversibility';
import { getCustomGateRecord, registerCustomGate } from '../customGateEngine';
import { writeStore } from '../customGateStore';
import { refreshCustomGateRegistry } from '../registry';

const check = (body: string, params = 'A:1', returns = 'A') =>
  checkCustomGateReversibility(compileQpuProtocol(`PARAMS: ${params}\nMAIN-PROCESS G\n${body}\nRETURNVALS ${returns}`));

const reasonOf = (result: ReturnType<typeof checkCustomGateReversibility>) => (result.reversible ? '' : result.reason);

describe('checkCustomGateReversibility', () => {
  it('accepts unitary gates, including phases, rotations and out-of-place XOR targets', () => {
    expect(check('X -I A -O A').reversible).toBe(true);
    expect(check('H -I A -O A\nT -I A -O A\nRX=pi/3 -I B -O B\nCPHASE=pi/7 -I A -O B', 'A:1 B:1', 'A B').reversible).toBe(true);
    expect(check('OR -I A B -O Out\nX -I Out -O Out', 'A:1 B:1', 'A B Out').reversible).toBe(true);
  });

  it('accepts workspace that is uncomputed back to |0⟩', () => {
    expect(check('CNOT -I A -O Tmp\nCNOT -I Tmp -O B\nCNOT -I A -O Tmp', 'A:1 B:1', 'A B').reversible).toBe(true);
  });

  it('rejects non-unitary steps (criterion 1)', () => {
    expect(reasonOf(check('MEASURE -I A'))).toMatch(/MEASURE is not unitary.*criterion 1/);
    // SET on the output lowers to a hidden RESET, which overwrites the target.
    expect(reasonOf(check('SET Out 0p\nCNOT -I A -O Out', 'A:1', 'A Out'))).toMatch(/RESET is not unitary/);
  });

  it('rejects classically conditioned steps, which are not a fixed matrix (criterion 1)', () => {
    expect(reasonOf(check('X -I B -O B -IF A=1', 'A:1 B:1', 'A B'))).toMatch(/IF\/ELSE condition.*criterion 1/);
  });

  it('rejects workspace left away from |0⟩ (criterion 2)', () => {
    expect(reasonOf(check('CNOT -I A -O Tmp\nCNOT -I Tmp -O A'))).toMatch(/internal wire.*criterion 2/);
  });

  it('varies output-only wires too, not just PARAMS (criterion 2)', () => {
    // Tmp is clean only when Out starts at 0; the gate's target may hold 1 at run time.
    expect(reasonOf(check('CNOT -I Out -O Tmp\nCNOT -I A -O Out', 'A:1', 'A Out'))).toMatch(/criterion 2/);
  });
});

describe('custom gate records', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
    });
    refreshCustomGateRegistry();
  });

  it('stores the failure reason and reports it when a dagger is attempted', () => {
    const record = registerCustomGate({ id: 'Dirty', source: 'PARAMS: A:1\nMAIN-PROCESS Dirty\nCNOT -I A -O Tmp\nCNOT -I Tmp -O A\nRETURNVALS A' });
    expect(record.reversible).toBe(false);
    expect(record.reversibilityIssue).toMatch(/criterion 2/);
    refreshCustomGateRegistry();
    expect(() => compileQpuProtocol('PARAMS: Q:1\nMAIN-PROCESS P\nDirtydg -I Q -O Q\nRETURNVALS Q')).toThrow(/criterion 2/);
  });

  it('re-checks records saved under older rules', () => {
    writeStore([{
      id: 'Stale',
      label: 'Stale',
      color: 'red',
      source: 'PARAMS: A:1\nMAIN-PROCESS Stale\nCNOT -I A -O Tmp\nCNOT -I Tmp -O A\nRETURNVALS A',
      processName: 'Stale',
      librarySources: {},
      inputParamNames: ['A'],
      outputParamNames: ['A'],
      createdAt: '2026-01-01T00:00:00.000Z',
      reversible: true,
    }]);
    refreshCustomGateRegistry();
    expect(getCustomGateRecord('Stale')?.reversible).toBe(false);
  });
});
