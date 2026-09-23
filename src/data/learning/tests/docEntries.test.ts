import { describe, expect, it } from 'vitest';
import { getCatalogEntry, getCatalogLibrarySources } from '../../catalog';
import { measureAll, runCircuit } from '../../../simulator/engine';
import type { CustomGateRecord } from '../../../simulator/gates/customGateEngine';
import { preconfiguredPaletteGates } from '../../../simulator/gates/registry';
import type { CircuitGate, ParticleStartState } from '../../../simulator/types';
import {
  childProcessNames,
  customGateDocEntry,
  gateDocs,
  resolveDocEntry,
} from '../docEntries';
import { uiTips } from '../learningHelp';

// Wire layout matching each boolean table's column order (inputs and outputs list the same wires).
const wiring: Record<string, Pick<CircuitGate, 'controls' | 'targets'>> = {
  NOT: { controls: [], targets: [0] },
  CNOT: { controls: [0], targets: [1] },
  CCNOT: { controls: [0, 1], targets: [2] },
  AND: { controls: [0, 1], targets: [2] },
  NAND: { controls: [0, 1], targets: [2] },
  OR: { controls: [0, 1], targets: [2] },
  XOR: { controls: [0, 1], targets: [2] },
  SWAP: { controls: [], targets: [0, 1] },
};

describe('hover documentation entries', () => {
  it('documents every palette gate with a truth table, syntax, and target notes', () => {
    preconfiguredPaletteGates().forEach((gate) => {
      const entry = resolveDocEntry(`gate:${gate.id}`);
      expect(entry, gate.id).toBeDefined();
      expect(entry?.table?.rows.length, gate.id).toBeGreaterThan(0);
      expect(entry?.syntax?.[0].startsWith(gate.id), gate.id).toBe(true);
      expect(entry?.sections.map((section) => section.heading)).toContain('The target (t)');
    });
  });

  it('lists boolean truth tables that match the simulator', () => {
    Object.entries(wiring).forEach(([type, wires]) => {
      const table = gateDocs[type].table;
      const wireCount = table.inputCount;
      table.rows.forEach((row) => {
        const startStates = row.slice(0, wireCount).map((bit) => (bit === '1' ? '1p' : '0p') as ParticleStartState);
        const gate: CircuitGate = { id: 'g', type, step: 0, ...wires };
        const executed = runCircuit(wireCount, [gate], startStates);
        const measured = measureAll(executed.state, wireCount, executed.measurements).measurements;
        const actual = Array.from({ length: wireCount }, (_, qubit) => String(measured[qubit]));
        expect(actual, `${type} ${row.join('')}`).toEqual(row.slice(wireCount));
      });
    });
  });

  it('finds child processes and opens them from the catalog', () => {
    const twoBit = getCatalogEntry('TwoBitFullAdder');
    expect(twoBit).toBeDefined();
    expect(childProcessNames(twoBit!.source)).toEqual(['SingleBitFullAdder']);

    const entry = resolveDocEntry('process:TwoBitFullAdder');
    expect(entry?.children).toEqual(['SingleBitFullAdder']);
    expect(entry?.table?.rows).toHaveLength(32);
    expect(entry?.sections.find((section) => section.heading === 'Main process or child process?')?.body).toContain('main process');

    const child = resolveDocEntry('process:SingleBitFullAdder');
    expect(child?.children).toEqual([]);
    expect(child?.table?.columns).toEqual(['A', 'B', 'Cin', 'Cout', 'Sum']);
    expect(resolveDocEntry('process:NoSuchProcess')).toBeUndefined();
  });

  it('builds a custom gate entry with a simulated truth table and usage syntax', () => {
    const source = [
      'PARAMS: A:state B:state',
      'MAIN-PROCESS AndOut',
      'CREATETOKEN -I Out',
      'SET Out 0p',
      'AND -I A B -O Out',
      'MEASURE -I Out',
      'RETURNVALS Out',
    ].join('\n');
    const record: CustomGateRecord = {
      id: 'ANDM',
      label: 'ANDM',
      color: '#8b5cf6',
      source,
      processName: 'AndOut',
      librarySources: getCatalogLibrarySources(),
      inputParamNames: ['A', 'B'],
      outputParamNames: ['Out'],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const entry = customGateDocEntry(record);
    expect(entry.kind).toBe('custom');
    expect(entry.table?.rows).toEqual([
      ['0', '0', '0'],
      ['0', '1', '0'],
      ['1', '0', '0'],
      ['1', '1', '1'],
    ]);
    expect(entry.syntax).toContain('RUNCHILD AndOut -I A B -O Out');
    expect(entry.sections.find((section) => section.heading === 'Using it on the canvas')?.body)
      .toContain('A ← Control A; B ← Control B; Out → Target particle');
  });

  it('documents every builder control that has a tooltip', () => {
    Object.keys(uiTips).forEach((key) => {
      expect(resolveDocEntry(`ui:${key}`)?.summary, key).toBe(uiTips[key as keyof typeof uiTips]);
    });
  });
});
