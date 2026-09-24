import { describe, expect, it } from 'vitest';
import type { CircuitGate } from '../../../simulator/types';
import {
  applyGateToWireKind,
  circuitColumnCount,
  classicalWireQubits,
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
  wireKindHalves,
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

  it('draws CZ and CY as boxed Pauli letters, leaving CX as a plus', () => {
    const cz = gate({ type: 'CZ', targets: [1], controls: [0] });
    expect(glyphKindFor(cz, 0)).toBe('control');
    expect(glyphKindFor(cz, 1)).toBe('box');
    expect(glyphLabelFor(cz, 1, 'CZ')).toBe('Z');

    const cy = gate({ type: 'CY', targets: [1], controls: [0] });
    expect(glyphKindFor(cy, 0)).toBe('control');
    expect(glyphKindFor(cy, 1)).toBe('box');
    expect(glyphLabelFor(cy, 1, 'CY')).toBe('Y');

    expect(glyphKindFor(gate({ type: 'CNOT', targets: [1], controls: [0] }), 1)).toBe('plus');
    expect(glyphKindFor(gate({ type: 'CCNOT', targets: [2], controls: [0, 1] }), 2)).toBe('plus');
  });

  it('adds one classical wire per measured qubit and none when nothing is measured', () => {
    expect(classicalWireQubits(3, [gate({ type: 'H', targets: [0] })])).toEqual([]);
    expect(classicalWireQubits(3, [
      gate({ id: 'm2', type: 'MEASURE', step: 1, targets: [2] }),
      gate({ id: 'm0', type: 'MEASURE', step: 2, targets: [0] }),
    ])).toEqual([0, 2]);
    expect(classicalWireQubits(2, [], { 1: 0 })).toEqual([1]);
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
    expect(applyGateToWireKind(['quantum'], gate({ type: 'H', targets: [0] }))).toEqual(['classical']);
    expect(applyGateToWireKind(['quantum'], gate({ type: 'MEASURE', targets: [0] }))).toEqual(['classical']);
    expect(applyGateToWireKind(['quantum'], gate({ type: 'RESET', targets: [0] }))).toEqual(['classical']);

    const afterH = wireKindSegments(1, [gate({ type: 'H', step: 0, targets: [0] })], ['0p'], 4);
    expect(afterH[0][0]).toBe('classical');
    expect(afterH[0][1]).toBe('quantum');

    const afterTwoH = wireKindSegments(
      1,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'h2', type: 'H', step: 1, targets: [0] })],
      ['0p'],
      4,
    );
    expect(afterTwoH[0][1]).toBe('quantum');
    expect(afterTwoH[0][2]).toBe('classical');

    const spThenH = wireKindSegments(1, [gate({ type: 'H', step: 0, targets: [0] })], ['sp'], 4);
    expect(spThenH[0][0]).toBe('quantum');
    expect(spThenH[0][1]).toBe('classical');

    const afterMeasure = wireKindSegments(
      1,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'm', type: 'MEASURE', step: 1, targets: [0] })],
      ['0p'],
      4,
    );
    expect(afterMeasure[0][1]).toBe('quantum');
    expect(afterMeasure[0][2]).toBe('classical');

    const measureThenH = wireKindSegments(
      1,
      [
        gate({ type: 'H', step: 0, targets: [0] }),
        gate({ id: 'm', type: 'MEASURE', step: 1, targets: [0] }),
        gate({ id: 'h2', type: 'H', step: 2, targets: [0] }),
      ],
      ['0p'],
      5,
      { 0: 1 },
    );
    expect(measureThenH[0][2]).toBe('classical');
    expect(measureThenH[0][3]).toBe('quantum');

    const runtimeMeasured = wireKindSegments(1, [gate({ type: 'H', step: 0, targets: [0] })], ['0p'], 4, { 0: 1 });
    expect(runtimeMeasured[0].every((kind) => kind === 'classical')).toBe(true);

    const hiddenReset = wireKindSegments(
      1,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'r', type: 'RESET', step: 1, targets: [0] })],
      ['0p'],
      4,
    );
    expect(hiddenReset[0][1]).toBe('quantum');
    expect(hiddenReset[0][2]).toBe('classical');
  });

  it('switches wire style at the gate glyph instead of one column later', () => {
    const measured = wireKindHalves(
      1,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'm', type: 'MEASURE', step: 1, targets: [0] })],
      ['0p'],
      4,
    );
    expect(measured[0][0]).toEqual({ incoming: 'classical', outgoing: 'quantum' });
    expect(measured[0][1]).toEqual({ incoming: 'quantum', outgoing: 'classical' });
    expect(measured[0][2]).toEqual({ incoming: 'classical', outgoing: 'classical' });

    const entangled = wireKindHalves(
      2,
      [gate({ type: 'H', step: 0, targets: [0] }), gate({ id: 'cx', type: 'CNOT', step: 1, controls: [0], targets: [1] })],
      ['0p', '0p'],
      4,
    );
    expect(entangled[1][0]).toEqual({ incoming: 'classical', outgoing: 'classical' });
    expect(entangled[1][1]).toEqual({ incoming: 'classical', outgoing: 'quantum' });
    expect(entangled[1][2]).toEqual({ incoming: 'quantum', outgoing: 'quantum' });
  });
});
