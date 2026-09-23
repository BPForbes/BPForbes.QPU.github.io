import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, serializeCircuitToQpuProtocol } from '../../simulator/compiler';
import { runCircuit } from '../../simulator/engine';
import type { ParticleStartState } from '../../simulator/types';
import { examples } from '../examples';

const byName = (name: string) => {
  const example = examples.find((candidate) => candidate.name === name);
  if (!example) throw new Error(`Missing starter circuit ${name}`);
  return example;
};

const measure = (name: string, startStates?: ParticleStartState[]) => {
  const example = byName(name);
  return runCircuit(example.qubitCount, example.gates, startStates ?? Array.from({ length: example.qubitCount }, () => '0p')).measurements;
};

describe('starter circuits', () => {
  it('are ordered by learning-path step', () => {
    const steps = examples.map((example) => example.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  examples.forEach((example) => {
    it(`${example.name} serializes to a protocol that compiles`, () => {
      const source = serializeCircuitToQpuProtocol(
        example.gates,
        example.qubitCount,
        Array.from({ length: example.qubitCount }, () => '0p'),
        example.name,
      );
      expect(() => compileQpuProtocol(source)).not.toThrow();
    });
  });

  it('produce the outcomes their descriptions promise', () => {
    expect(measure('Phase interference (H-Z-H)')[0]).toBe(1);
    expect(measure('Phase kickback')[0]).toBe(1);
    expect(measure('Grover search (2 qubits)')).toEqual({ 0: 1, 1: 1 });
    expect(measure('Parity check', ['1p', '0p', '1p', '0p'])[3]).toBe(0);
    expect(measure('Parity check', ['1p', '1p', '1p', '0p'])[3]).toBe(1);
    [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([a, b]) => {
      const result = measure('Half adder', [a ? '1p' : '0p', b ? '1p' : '0p', '0p', '0p']);
      expect(result[2], `carry for ${a}${b}`).toBe(a & b);
      expect(result[3], `sum for ${a}${b}`).toBe(a ^ b);
    });
  });
});
