import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../../../simulator/compiler/qpuAst';
import recursiveEcho from '../../../data/processes/recursive-reversible-echo.qpucir?raw';
import recursiveEchoHarness from '../../../data/processes/recursive-reversible-echo-harness.qpucir?raw';
import {
  branchOutcomeNote,
  conditionFeedLabel,
} from '../branchVisuals';
import {
  buildVisualCircuitColumns,
  recursionFrameForColumn,
  recursionFrameForStep,
  sourceGateLabel,
} from '../recursionVisuals';

const compiledEcho = () => visibleCircuitGates(
  compileQpuProtocol(recursiveEchoHarness, { RecursiveReversibleEcho: recursiveEcho }).gates,
);

describe('expanded recursion frame', () => {
  it('collapsed REC column spans every wire the body touches', () => {
    const rec = buildVisualCircuitColumns(compiledEcho()).find((column) => column.recursion);
    expect(rec?.displayLabel).toBe('REC');
    expect(rec?.recursion?.qubits).toEqual([0, 1, 2]);
  });

  it('splits one level into forward, inverse, and its cycle boundary', () => {
    const gates = compiledEcho();
    const rec = buildVisualCircuitColumns(gates).find((column) => column.recursion)!;
    const frame = recursionFrameForColumn(gates, rec, 2)!;
    expect(frame).toMatchObject({ depth: 3, level: 2, rootDepth: 5, mode: 'tco', inverseStart: 8 });
    expect(frame.body).toHaveLength(16);
    expect(frame.body.slice(0, 8).every((gate) => !gate.inverse)).toBe(true);
    expect(frame.body.slice(8).every((gate) => gate.inverse)).toBe(true);
    // Adjoints run in reverse order of the forward region.
    expect(frame.body.slice(8).map((gate) => gate.type)).toEqual(
      frame.body.slice(0, 8).map((gate) => gate.type).reverse().map((type) => (type === 'T' ? 'PHASE' : type)),
    );
    expect(frame.cycleGate?.type).toBe('CYCLE');
  });

  it('defaults to the first level and follows the playhead', () => {
    const gates = compiledEcho();
    const rec = buildVisualCircuitColumns(gates).find((column) => column.recursion)!;
    expect(recursionFrameForColumn(gates, rec)?.depth).toBe(5);
    const deep = gates.find((gate) => gate.recursion?.level === 3 && gate.type === 'CNOT')!;
    expect(recursionFrameForStep(gates, deep.step)?.depth).toBe(2);
    const measure = gates.find((gate) => gate.type === 'MEASURE')!;
    expect(recursionFrameForStep(gates, measure.step)).toBeUndefined();
  });

  it('keeps the T name for a lowered Tdg', () => {
    const tdg = compiledEcho().find((gate) => gate.type === 'PHASE' && gate.inverse)!;
    expect(sourceGateLabel(tdg)).toBe('T');
    const h = compiledEcho().find((gate) => gate.type === 'H')!;
    expect(sourceGateLabel(h)).toBeUndefined();
  });
});

describe('IF/ELSE c-row labels', () => {
  it('names the measured parameter and reports the outcome', () => {
    const gates = compiledEcho();
    const x = gates.find((gate) => gate.branch?.kind === 'if')!;
    const z = gates.find((gate) => gate.branch?.kind === 'else')!;
    expect(conditionFeedLabel(x, 'A')).toBe('IF · A=1');
    expect(conditionFeedLabel(z, 'A')).toBe('ELSE · A=0');
    expect(conditionFeedLabel(x)).toBe('IF · q0=1');
    expect(branchOutcomeNote('taken')).toBe('✓ taken');
    expect(branchOutcomeNote('skipped')).toBe('⊘ skipped');
    expect(branchOutcomeNote('pending')).toBeUndefined();
  });
});
