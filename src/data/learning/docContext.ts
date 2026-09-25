/**
 * Ties a documentation table to the wires being examined in the workbench:
 * which wire each column describes, which rows match the wires' current
 * values, and a one-line reading of a row.
 */
import type { Complex } from '../../simulator/complex';
import { physics } from '../../simulator/physics/PhysicsEngine';
import type { ParticleStartState } from '../../simulator/types';
import type { DocEntry, DocTable } from './docEntries';

/** '0'/'1' for a definite basis value, 'sp' when both are possible. */
export type WireValue = '0' | '1' | 'sp';

export const startStateWireValue = (state: ParticleStartState | undefined): WireValue =>
  state === '1p' ? '1' : state === 'sp' ? 'sp' : '0';

const EPSILON = 1e-9;

/** Reads each wire's basis value from a state vector (wire q is bit n−1−q of the index). */
export const wireValuesFromState = (state: Complex[], qubitCount: number, qubits: number[]): Map<number, WireValue> => {
  const values = new Map<number, WireValue>();
  qubits.forEach((qubit) => {
    if (qubit < 0 || qubit >= qubitCount) return;
    const probabilityOne = physics.probabilityOfOne(physics.fromAmplitudes(state, qubitCount), qubit);
    values.set(qubit, probabilityOne < EPSILON ? '0' : probabilityOne > 1 - EPSILON ? '1' : 'sp');
  });
  return values;
};

export type ColumnWires = (number | undefined)[][];

/**
 * Built-in gates use roles A, B, t (Out for logic gates): A and B are the
 * controls, t the first target, and for SWAP B is the second target.
 * Processes map PARAMS to controls and RETURNVALS to targets, in order.
 */
export const columnWires = (
  entry: DocEntry,
  table: DocTable,
  controls: readonly (number | undefined)[],
  targets: readonly (number | undefined)[],
): ColumnWires => {
  const swaps = entry.key === 'gate:SWAP';
  const gateRole = (role: string) => {
    if (role === 'A') return controls[0];
    if (role === 'B') return swaps ? targets[1] : controls[1];
    if (role === 't' || role === 'Out') return targets[0];
    return undefined;
  };
  return table.roles.map((roles, column) => roles.split(' ').map((role) => {
    if (entry.kind === 'gate') return gateRole(role);
    const names = column < table.inputCount ? entry.inputs ?? [] : entry.outputs ?? [];
    const index = names.indexOf(role);
    return index < 0 ? undefined : (column < table.inputCount ? controls : targets)[index];
  }));
};

export const wireHeader = (column: string, wires: (number | undefined)[]) =>
  wires.every((wire) => wire !== undefined) ? `${column} · ${wires.map((wire) => `q${wire}`).join(' ')}` : column;

// "0"/"1" cells, or kets such as "|01⟩", "−|11⟩", "|+⟩"; anything else is not tied to wire values.
const cellSymbols = (cell: string, width: number): string[] | undefined => {
  if (/^[01]+$/.test(cell) && cell.length === width) return cell.split('');
  const ket = cell.match(/\|([01+−]+)⟩/);
  return ket && ket[1].length === width ? ket[1].split('') : undefined;
};

/**
 * Rows whose inputs agree with the wires' values. A wire in superposition
 * matches both 0 and 1 rows, unless the table has a |+⟩/|−⟩ row for it.
 */
export const matchingRows = (
  table: DocTable,
  wires: ColumnWires,
  valueOf: (qubit: number) => WireValue | undefined,
): number[] => {
  const scored = table.rows.map((row, rowIndex) => {
    let exactSuperposition = false;
    const matches = row.slice(0, table.inputCount).every((cell, column) => {
      const symbols = cellSymbols(cell, wires[column].length);
      if (!symbols) return true;
      return symbols.every((symbol, position) => {
        const wire = wires[column][position];
        const value = wire === undefined ? undefined : valueOf(wire);
        if (value === undefined) return true;
        if (symbol === '+' || symbol === '−') {
          exactSuperposition ||= value === 'sp';
          return value === 'sp';
        }
        return value === 'sp' || value === symbol;
      });
    });
    return { rowIndex, matches, exactSuperposition };
  }).filter((row) => row.matches);
  const exact = scored.filter((row) => row.exactSuperposition);
  return (exact.length > 0 ? exact : scored).map((row) => row.rowIndex);
};

const wireKey = (wires: (number | undefined)[]) => wires.map((wire) => `q${wire}`).join(' ');

/** Plain reading of a row on the mapped wires, e.g. "q2: 0 → 1. q0 and q1 unchanged." */
export const describeRow = (table: DocTable, wires: ColumnWires, rowIndex: number): string => {
  const row = table.rows[rowIndex];
  const inputs = new Map<string, string>();
  row.slice(0, table.inputCount).forEach((cell, column) => {
    if (wires[column].every((wire) => wire !== undefined)) inputs.set(wireKey(wires[column]), cell);
  });
  const changed: string[] = [];
  const unchanged: string[] = [];
  row.slice(table.inputCount).forEach((cell, offset) => {
    const columnWireList = wires[table.inputCount + offset];
    const label = table.columns[table.inputCount + offset];
    if (!columnWireList.every((wire) => wire !== undefined)) return;
    const key = wireKey(columnWireList);
    const before = inputs.get(key);
    if (before === undefined) changed.push(`${label} (${key}) = ${cell}`);
    else if (before === cell) unchanged.push(key);
    else changed.push(`${key}: ${before} → ${cell}`);
  });
  const parts = [
    changed.length > 0 ? changed.join(', ') : 'Nothing changes',
    unchanged.length > 0 ? `${unchanged.join(' and ')} unchanged` : '',
  ].filter(Boolean);
  return `${parts.join('. ')}.`;
};

const cellStartState = (symbol: string): ParticleStartState | undefined =>
  symbol === '0' ? '0p' : symbol === '1' ? '1p' : symbol === '+' ? 'sp' : undefined;

/** Start states that would feed a row's inputs, for clicking a row to try it. */
export const rowStartStates = (table: DocTable, wires: ColumnWires, rowIndex: number): Map<number, ParticleStartState> => {
  const assignments = new Map<number, ParticleStartState>();
  table.rows[rowIndex].slice(0, table.inputCount).forEach((cell, column) => {
    const symbols = cellSymbols(cell, wires[column].length);
    symbols?.forEach((symbol, position) => {
      const wire = wires[column][position];
      const state = cellStartState(symbol);
      if (wire !== undefined && state) assignments.set(wire, state);
    });
  });
  return assignments;
};
