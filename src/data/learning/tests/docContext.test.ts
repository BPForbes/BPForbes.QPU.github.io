import { describe, expect, it } from 'vitest';
import { createInitialState, runCircuit } from '../../../simulator/engine';
import type { CircuitGate } from '../../../simulator/types';
import {
  columnWires,
  describeRow,
  matchingRows,
  rowStartStates,
  wireHeader,
  wireValuesFromState,
  type WireValue,
} from '../docContext';
import { catalogProcessDocEntry, gateDocEntry } from '../docEntries';

const values = (entries: Record<number, WireValue>) => (qubit: number) => entries[qubit];

describe('workbench doc context', () => {
  it('maps CCNOT columns onto the chosen wires', () => {
    const entry = gateDocEntry('CCNOT')!;
    const wires = columnWires(entry, entry.table!, [0, 1], [2]);
    expect(wires).toEqual([[0], [1], [2], [0], [1], [2]]);
    expect(entry.table!.columns.map((column, index) => wireHeader(column, wires[index]))).toEqual([
      'A · q0', 'B · q1', 't · q2', 'A · q0', 'B · q1', "t' · q2",
    ]);
  });

  it('uses the second target as B for SWAP and spans two wires for CZ', () => {
    const swap = gateDocEntry('SWAP')!;
    expect(columnWires(swap, swap.table!, [], [2, 0])).toEqual([[2], [0], [2], [0]]);
    const cz = gateDocEntry('CZ')!;
    expect(columnWires(cz, cz.table!, [1], [0])[0]).toEqual([1, 0]);
  });

  it('finds and reads the row for definite wire values', () => {
    const entry = gateDocEntry('CCNOT')!;
    const wires = columnWires(entry, entry.table!, [0, 1], [2]);
    const rows = matchingRows(entry.table!, wires, values({ 0: '1', 1: '1', 2: '0' }));
    expect(rows).toEqual([6]);
    expect(describeRow(entry.table!, wires, 6)).toBe('q2: 0 → 1. q0 and q1 unchanged.');
    expect(describeRow(entry.table!, wires, 2)).toBe('Nothing changes. q0 and q1 and q2 unchanged.');
  });

  it('matches every row a superposed wire feeds, unless the table has a |+⟩ row', () => {
    const cnot = gateDocEntry('CNOT')!;
    const cnotWires = columnWires(cnot, cnot.table!, [0], [1]);
    expect(matchingRows(cnot.table!, cnotWires, values({ 0: 'sp', 1: '0' }))).toEqual([0, 2]);

    const h = gateDocEntry('H')!;
    const hWires = columnWires(h, h.table!, [], [0]);
    // Probabilities alone cannot tell |+⟩ from |−⟩, so both ket rows match.
    expect(matchingRows(h.table!, hWires, values({ 0: 'sp' }))).toEqual([2, 3]);
    const z = gateDocEntry('Z')!;
    expect(matchingRows(z.table!, columnWires(z, z.table!, [], [0]), values({ 0: 'sp' }))).toEqual([2]);
    expect(matchingRows(h.table!, hWires, values({ 0: '1' }))).toEqual([1]);
  });

  it('maps process PARAMS and RETURNVALS by name order', () => {
    const entry = catalogProcessDocEntry('SingleBitFullAdder')!;
    const wires = columnWires(entry, entry.table!, [4, 5, 6], [7, 8]);
    expect(wires).toEqual([[4], [5], [6], [7], [8]]);
    const rows = matchingRows(entry.table!, wires, values({ 4: '1', 5: '1', 6: '0' }));
    expect(rows.map((row) => entry.table!.rows[row])).toEqual([['1', '1', '0', '1', '0']]);
    expect(describeRow(entry.table!, wires, rows[0])).toBe('Cout (q7) = 1, Sum (q8) = 0.');
  });

  it('turns a row into start states for Try', () => {
    const entry = gateDocEntry('CNOT')!;
    const wires = columnWires(entry, entry.table!, [2], [0]);
    expect(rowStartStates(entry.table!, wires, 3)).toEqual(new Map([[2, '1p'], [0, '1p']]));
    const h = gateDocEntry('H')!;
    expect(rowStartStates(h.table!, columnWires(h, h.table!, [], [1]), 2)).toEqual(new Map([[1, 'sp']]));
  });

  it('reads wire values from a state vector', () => {
    const gates: CircuitGate[] = [{ id: 'h', type: 'H', step: 0, controls: [], targets: [0] }];
    const state = runCircuit(3, gates, ['0p', '0p', '1p']).state;
    expect(wireValuesFromState(state, 3, [0, 1, 2])).toEqual(new Map([[0, 'sp'], [1, '0'], [2, '1']]));
    expect(wireValuesFromState(createInitialState(2), 2, [0, 5])).toEqual(new Map([[0, '0']]));
  });
});
