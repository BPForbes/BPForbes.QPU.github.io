import { readdirSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, extractMainProcessName } from '../../../simulator/compiler';
import { simulateTruthTableOutputs } from '../../../simulator/moduleTestApi';
import { protocolLibrary } from '../protocolExamples';

const sectionsDirectory = new URL('../../../../docs/latex/sections/', import.meta.url);

// Only listings the docs explicitly label as copy-and-compile are held to this contract.
const completeProtocols = readdirSync(sectionsDirectory)
  .filter((fileName) => fileName.endsWith('.tex'))
  .flatMap((fileName) => {
    const tex = readFileSync(new URL(fileName, sectionsDirectory), 'utf8');
    return [...tex.matchAll(/\\textbf\{Complete runnable protocol\}\s*\\begin\{lstlisting\}\n([\s\S]*?)\\end\{lstlisting\}/g)]
      .map((match) => ({ fileName, source: match[1] }));
  });

const bit = (value: string) => (value === '1p' ? 1 : 0);
const cells = (...bits: number[]) => bits.map((value) => (value ? '1p' : '0p'));

// Expected outputs, in RETURNVALS order, for each deterministic documented process given its PARAMS bits.
const expectedOutputs: Record<string, (inputs: number[]) => string[]> = {
  Inverter: ([input]) => cells(1 - input),
  HalfAdder: ([a, b]) => cells(a & b, a ^ b),
  PhaseInterference: () => cells(1),
  FlatFullAdder: ([a, b, cin]) => cells(a + b + cin >= 2 ? 1 : 0, (a + b + cin) % 2),
  TwoBitRippleAdder: ([a1, a0, b1, b0]) => {
    const total = (a1 * 2 + a0) + (b1 * 2 + b0);
    return cells((total >> 2) & 1, (total >> 1) & 1, total & 1);
  },
  GreaterThan: ([a, b]) => cells(a > b ? 1 : 0),
  TwoBitEquality: ([a1, a0, b1, b0]) => cells(a1 === b1 && a0 === b0 ? 1 : 0, 0, 0),
  FourBitParity: (inputs) => cells(inputs.reduce((sum, value) => sum + value, 0) % 2),
  PhaseKickback: () => cells(1),
  HiddenString101: () => cells(1, 0, 1),
  GroverFind11: () => cells(1, 1),
  NorGate: ([a, b]) => cells(a || b ? 0 : 1),
};

describe('documentation protocols', () => {
  it('finds the labelled listings', () => {
    const names = completeProtocols.map(({ source }) => extractMainProcessName(source));
    expect(names).toEqual(expect.arrayContaining(Object.keys(expectedOutputs)));
  });

  completeProtocols.forEach(({ fileName, source }) => {
    const name = extractMainProcessName(source) ?? '(unnamed)';

    it(`${fileName}: ${name} compiles`, () => {
      expect(() => compileQpuProtocol(source, protocolLibrary)).not.toThrow();
    });

    const expected = expectedOutputs[name];
    if (!expected) return;

    it(`${fileName}: ${name} produces its documented truth table`, () => {
      const table = simulateTruthTableOutputs(source, protocolLibrary);
      table.rows.forEach((row) => {
        const inputs = row.slice(0, table.inputColumns.length).map(bit);
        expect(row.slice(table.inputColumns.length), `inputs ${inputs.join('')}`).toEqual(expected(inputs));
      });
    });
  });
});
