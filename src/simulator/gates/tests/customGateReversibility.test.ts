import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileQpuProtocol } from '../../compiler/qpuAst';
import { checkCustomGateReversibility } from '../customGateReversibility';
import { applyCustomGateProcess, getCustomGateRecord, registerCustomGate, removeCustomGateRecord } from '../customGateEngine';
import { applySingleQubitGate } from '../operations';
import { phaseMatrix } from '../matrices';
import { magnitudeSquared } from '../../complex';
import { runCircuit } from '../../engine';
import type { CircuitGate } from '../../types';
import { writeStore } from '../customGateStore';
import { refreshCustomGateRegistry } from '../registry';

const runNested = (state: Parameters<typeof applyCustomGateProcess>[0], qubitCount: number, gate: CircuitGate) =>
  applyCustomGateProcess(state, qubitCount, gate, {}, getCustomGateRecord(String(gate.type))!);

const check = (body: string, params = 'A:1', returns = 'A') => checkCustomGateReversibility(
  compileQpuProtocol(`PARAMS: ${params}\nMAIN-PROCESS G\n${body}\nRETURNVALS ${returns}`),
  runNested,
);

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

  it('lets a gate built from a reversible custom gate be inverted, and its dagger undoes it', () => {
    registerCustomGate({ id: 'Rot', source: 'PARAMS: A:1\nMAIN-PROCESS Rot\nRX=pi/5 -I A -O A\nT -I A -O A\nRETURNVALS A' });
    // CleanCopy borrows a workspace wire and uncomputes it, so nesting it exercises the workspace trim.
    registerCustomGate({ id: 'CleanCopy', source: 'PARAMS: A:1 B:1\nMAIN-PROCESS CleanCopy\nCNOT -I A -O Tmp\nCNOT -I Tmp -O B\nCNOT -I A -O Tmp\nRETURNVALS A B' });
    refreshCustomGateRegistry();
    const outer = registerCustomGate({
      id: 'Outer',
      source: 'PARAMS: A:1 B:1\nMAIN-PROCESS Outer\nH -I A -O A\nRot -I A -O A\nCleanCopy -I A B -O A B\nRETURNVALS A B',
    });
    expect(outer.reversibilityIssue).toBeUndefined();
    expect(outer.reversible).toBe(true);
    refreshCustomGateRegistry();

    const forward = runCircuit(2, [{ id: 'f', type: 'Outer', step: 0, controls: [0, 1], targets: [0, 1] }], ['1p', '0p']);
    const undone = applyCustomGateProcess(forward.state, Math.round(Math.log2(forward.state.length)), {
      id: 'b', type: 'Outer', step: 1, controls: [0, 1], targets: [0, 1], inverse: true,
    }, {}, getCustomGateRecord('Outer')!);
    // |10⟩ on the visible wires with every workspace wire back at 0: the highest-order bits are A and B.
    const width = Math.round(Math.log2(undone.state.length));
    expect(magnitudeSquared(undone.state[1 << (width - 1)])).toBeCloseTo(1, 8);
  });

  it('rejects a gate that uses a non-reversible custom gate and says which one', () => {
    registerCustomGate({ id: 'Peek', source: 'PARAMS: A:1\nMAIN-PROCESS Peek\nMEASURE -I A\nRETURNVALS A' });
    refreshCustomGateRegistry();
    const outer = registerCustomGate({ id: 'UsesPeek', source: 'PARAMS: A:1\nMAIN-PROCESS UsesPeek\nPeek -I A -O A\nRETURNVALS A' });
    expect(outer.reversible).toBe(false);
    expect(outer.reversibilityIssue).toMatch(/Custom gate Peek is not reversible.*MEASURE/);
  });

  it('re-checks a gate when a custom gate it uses is replaced or removed', () => {
    const inner = (body: string) => registerCustomGate({ id: 'Inner', source: `PARAMS: A:1\nMAIN-PROCESS Inner\n${body}\nRETURNVALS A` });
    const outerDagger = 'PARAMS: Q:1\nMAIN-PROCESS P\nOuterdg -I Q -O Q\nRETURNVALS Q';
    inner('X -I A -O A');
    refreshCustomGateRegistry();
    registerCustomGate({ id: 'Outer', source: 'PARAMS: A:1\nMAIN-PROCESS Outer\nInner -I A -O A\nRETURNVALS A' });
    expect(getCustomGateRecord('Outer')?.reversible).toBe(true);

    // Replacing Inner with a measuring version makes Outer non-unitary, so its dagger must be refused up front.
    inner('MEASURE -I A');
    refreshCustomGateRegistry();
    expect(getCustomGateRecord('Outer')?.reversible).toBe(false);
    expect(getCustomGateRecord('Outer')?.reversibilityIssue).toMatch(/Custom gate Inner is not reversible/);
    expect(() => compileQpuProtocol(outerDagger)).toThrow(/Outer' is not reversible/);

    inner('X -I A -O A');
    expect(getCustomGateRecord('Outer')?.reversible).toBe(true);

    removeCustomGateRecord('Inner');
    expect(getCustomGateRecord('Outer')?.reversible).toBe(false);
  });
});

describe('recovery compares amplitudes, not just probabilities', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
    });
    refreshCustomGateRegistry();
  });

  it('rejects a dagger that recovers each basis input only up to a different phase', () => {
    registerCustomGate({ id: 'PhaseS', source: 'PARAMS: A:1\nMAIN-PROCESS PhaseS\nS -I A -O A\nRETURNVALS A' });
    refreshCustomGateRegistry();
    const compiled = compileQpuProtocol('PARAMS: A:1\nMAIN-PROCESS W\nPhaseS -I A -O A\nRETURNVALS A');
    expect(checkCustomGateReversibility(compiled, runNested).reversible).toBe(true);

    // A broken dagger that re-applies S instead of S†: |0⟩ → |0⟩ but |1⟩ → −|1⟩, so |+⟩ would come back as |−⟩.
    const sBothWays = (state: Parameters<typeof applyCustomGateProcess>[0], qubitCount: number, gate: CircuitGate) => ({
      state: applySingleQubitGate(state, qubitCount, gate.targets[0], phaseMatrix(Math.PI / 2)),
      measurements: {},
      log: [],
    });
    expect(reasonOf(checkCustomGateReversibility(compiled, sBothWays))).toMatch(/different phase.*criterion 2/);
  });
});
