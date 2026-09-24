import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { runCircuit } from '../../engine';
import { magnitudeSquared } from '../../complex';
import recursiveEcho from '../../../data/processes/recursive-reversible-echo.qpucir?raw';
import recursiveEchoHarness from '../../../data/processes/recursive-reversible-echo-harness.qpucir?raw';
import { branchOutcomeFor } from '../../../components/circuit/branchVisuals';

describe('RecursiveReversibleEcho stress circuit', () => {
  const library = { RecursiveReversibleEcho: recursiveEcho };

  it('expands TREC -DEPTH 5 with TCO and five cycle boundaries', () => {
    const compiled = compileQpuProtocol(recursiveEchoHarness, library);
    const visible = visibleCircuitGates(compiled.gates);
    const recursive = compiled.gates.filter((gate) => gate.recursion);
    expect(recursive.length).toBeGreaterThan(0);
    expect(recursive.every((gate) => gate.recursion?.mode === 'tco')).toBe(true);
    expect(new Set(recursive.map((gate) => gate.recursion!.level))).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(visible.filter((gate) => gate.type === 'CYCLE')).toHaveLength(5);
    // 5 frames × 16 reversible ops (8 forward + 8 adjoint).
    const bodyOps = recursive.filter((gate) => gate.type !== 'CYCLE');
    expect(bodyOps).toHaveLength(80);
    expect(compiled.log.filter((line) => /MAIN-PROCESS RecursiveReversibleEcho compiled in scope/.test(line))).toHaveLength(1);
    expect(compiled.log.some((line) => /TCO:/i.test(line))).toBe(true);
    expect(compiled.gates.every((gate) => !['REC', 'TREC', 'RECUR', 'EXIT', 'IF', 'ELSE', 'ENDIF'].includes(String(gate.type)))).toBe(true);
  });

  it('returns |101⟩ after the echo and finishes classically as 100', () => {
    const compiled = compileQpuProtocol(recursiveEchoHarness, library);
    // Canvas/UI start from |000⟩; the harness prepares |101⟩ with explicit X gates.
    const executed = runCircuit(compiled.qubitCount, compiled.gates, ['0p', '0p', '0p']);
    expect(executed.measurements[0]).toBe(1);
    expect(executed.measurements[1]).toBe(0);
    expect(executed.measurements[2]).toBe(0);
    // Final state collapses to |100⟩ after measuring all three qubits.
    expect(magnitudeSquared(executed.state[0b100])).toBeCloseTo(1, 8);

    const x = compiled.gates.find((gate) => gate.type === 'X' && gate.branch?.kind === 'if')!;
    const z = compiled.gates.find((gate) => gate.type === 'Z' && gate.branch?.kind === 'else')!;
    expect(x).toBeDefined();
    expect(z).toBeDefined();
    expect(branchOutcomeFor(x, executed.measurements)).toBe('taken');
    expect(branchOutcomeFor(z, executed.measurements)).toBe('skipped');
  });

  it('mixes dg/inv inverse markers across the recursive body', () => {
    const compiled = compileQpuProtocol(`PARAMS: A:state B:state C:state
MAIN-PROCESS Parent
DECLARECHILD RecursiveReversibleEcho
RUNCHILD RecursiveReversibleEcho -DEPTH 1 -I A B C -O A B C
RETURNVALS A B C`, library);
    const body = compiled.gates.filter((gate) => gate.recursion && gate.type !== 'CYCLE');
    expect(body.some((gate) => gate.type === 'SWAP' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'AND' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'PHASE' && (gate.phase ?? 0) < 0)).toBe(true); // Tdg → PHASE(-π/4)
    expect(body.some((gate) => gate.type === 'CPHASE' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'CNOT' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'RY' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'RX' && gate.inverse)).toBe(true);
    expect(body.some((gate) => gate.type === 'H' && gate.inverse)).toBe(true);
  });
});
