import { describe, expect, it } from 'vitest';
import type { CircuitGate } from '../../../simulator/types';
import {
  applyGateToWireKind,
  circuitColumnCount,
  connectorEndInset,
  gateSpanQubits,
  glyphKindFor,
  glyphLabelFor,
  initialWireKind,
  MAX_SLOT_REM,
  MIN_SLOT_REM,
  needsConnector,
  playDelayMs,
  startStateKet,
  wireKindSegments,
} from '../../circuitLayout';

const gate = (overrides: Partial<CircuitGate> = {}): CircuitGate => ({
  id: 'g',
  type: 'H',
  step: 0,
  targets: [0],
  controls: [],
  ...overrides,
});

describe('circuit layout helpers', () => {
  it('grows equal-length columns so every lane can hold the full gate list', () => {
    expect(circuitColumnCount(0)).toBe(6);
    expect(circuitColumnCount(2, 1)).toBe(6);
    expect(circuitColumnCount(8, 7)).toBe(10);
    expect(circuitColumnCount(12, 20)).toBe(23);
    expect(MAX_SLOT_REM).toBeGreaterThan(MIN_SLOT_REM);
  });

  it('maps start states to textbook kets', () => {
    expect(startStateKet('0p')).toBe('|0⟩');
    expect(startStateKet('1p')).toBe('|1⟩');
    expect(startStateKet('sp')).toBe('|+⟩');
    expect(startStateKet()).toBe('|0⟩');
  });

  it('uses standard circuit glyphs for controls, plus targets, swap, and measure', () => {
    expect(glyphKindFor(gate({ type: 'CNOT', targets: [1], controls: [0] }), 0)).toBe('control');
    expect(glyphKindFor(gate({ type: 'CNOT', targets: [1], controls: [0] }), 1)).toBe('plus');
    expect(glyphKindFor(gate({ type: 'SWAP', targets: [0, 2] }), 2)).toBe('swap');
    expect(glyphKindFor(gate({ type: 'MEASURE', targets: [1] }), 1)).toBe('measure');
    expect(glyphKindFor(gate({ type: 'H', targets: [0] }), 0)).toBe('box');
  });

  it('draws CCNOT as a boxed X on the target, not a Z box or CNOT plus', () => {
    const ccnot = gate({ type: 'CCNOT', targets: [2], controls: [0, 1] });
    expect(glyphKindFor(ccnot, 0)).toBe('control');
    expect(glyphKindFor(ccnot, 1)).toBe('control');
    expect(glyphKindFor(ccnot, 2)).toBe('box');
    expect(glyphLabelFor(ccnot, 2, 'CCX')).toBe('X');
    expect(glyphLabelFor(ccnot, 2, 'Z')).toBe('X');
    expect(glyphKindFor(gate({ type: 'CNOT', targets: [1], controls: [0] }), 1)).toBe('plus');
  });

  it('draws a connector only when a gate spans more than one wire', () => {
    expect(needsConnector(gate({ type: 'H', targets: [1] }))).toBe(false);
    expect(needsConnector(gate({ type: 'CNOT', targets: [2], controls: [0] }))).toBe(true);
    expect(gateSpanQubits(gate({ type: 'CCNOT', targets: [2], controls: [0, 1] }))).toEqual({ min: 0, max: 2 });
    expect(connectorEndInset(3.45)).toBeCloseTo(1.725);
  });

  it('speeds up frame-by-frame playback as the speed meter increases', () => {
    expect(playDelayMs(1, 800)).toBe(800);
    expect(playDelayMs(2, 800)).toBe(400);
    expect(playDelayMs(0.25, 800)).toBe(3200);
    expect(playDelayMs(4, 800)).toBe(playDelayMs(3, 800));
  });

  it('uses double-line classical wires for 0p/1p and single-line wires for superposition', () => {
    expect(initialWireKind('0p')).toBe('classical');
    expect(initialWireKind('1p')).toBe('classical');
    expect(initialWireKind('sp')).toBe('quantum');
    expect(applyGateToWireKind(['classical'], gate({ type: 'H', targets: [0] }))).toEqual(['quantum']);
    expect(applyGateToWireKind(['quantum'], gate({ type: 'MEASURE', targets: [0] }))).toEqual(['classical']);

    const afterH = wireKindSegments(1, [gate({ type: 'H', step: 0, targets: [0] })], ['0p'], 4);
    expect(afterH[0][0]).toBe('classical');
    expect(afterH[0][1]).toBe('quantum');

    const afterMeasure = wireKindSegments(
      1,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'm', type: 'MEASURE', step: 1, targets: [0] })],
      ['0p'],
      4,
    );
    expect(afterMeasure[0][1]).toBe('quantum');
    expect(afterMeasure[0][2]).toBe('classical');

    const runtimeMeasured = wireKindSegments(1, [gate({ type: 'H', step: 0, targets: [0] })], ['0p'], 4, { 0: 1 });
    expect(runtimeMeasured[0].every((kind) => kind === 'classical')).toBe(true);
  });
});
