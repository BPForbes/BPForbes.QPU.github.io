import { describe, expect, it } from 'vitest';
import { createInitialState, runCircuit } from '../../engine';
import { compileQpuProtocol, serializeCircuitToQpuProtocol } from '../../compiler';
import { controlsForGateType, getGateDefinition, isKnownGateType } from '../registry';
import type { CircuitGate } from '../types';
const gate = (type: string, step: number, targets: number[], controls: number[] = [], phase?: number): CircuitGate => ({
  id: `${type}-${step}`,
  type,
  step,
  targets,
  controls,
  phase,
});

describe('gate registry', () => {
  it('includes new Pauli, phase, and swap gates', () => {
    expect(isKnownGateType('Y')).toBe(true);
    expect(isKnownGateType('Z')).toBe(true);
    expect(isKnownGateType('S')).toBe(true);
    expect(isKnownGateType('T')).toBe(true);
    expect(isKnownGateType('CZ')).toBe(true);
    expect(isKnownGateType('CY')).toBe(true);
    expect(isKnownGateType('SWAP')).toBe(true);
  });

  it('applies Y on |0⟩ to produce i|1⟩', () => {
    const result = runCircuit(1, [gate('Y', 0, [0])]);
    expect(result.state[1].re).toBeCloseTo(0, 5);
    expect(result.state[1].im).toBeCloseTo(1, 5);
  });

// Case: applies Z as a phase flip on |1⟩.
  it('applies Z as a phase flip on |1⟩', () => {
    const prepared = runCircuit(1, [gate('X', 0, [0])]);
    const result = runCircuit(1, [gate('Z', 1, [0])], ['0p'], undefined);
    const flipped = getGateDefinition('Z')!.apply({
      state: prepared.state,
      qubitCount: 1,
      gate: gate('Z', 0, [0]),
      measurements: {},
    });
    expect(flipped.state[1].re).toBeCloseTo(-1, 5);
  });

// Case: swaps two qubit amplitudes.
  it('swaps two qubit amplitudes', () => {
    const start = createInitialState(2);
    const withOne = runCircuit(2, [gate('X', 0, [0])], ['0p', '0p']).state;
    const swapped = getGateDefinition('SWAP')!.apply({
      state: withOne,
      qubitCount: 2,
      gate: gate('SWAP', 0, [0, 1]),
      measurements: {},
    });
    expect(Math.abs(swapped.state[1].re)).toBeCloseTo(1, 5);
  });

  it('places two-input derived gates with two controls so the canvas protocol compiles', () => {
    ['AND', 'NAND', 'OR', 'XOR'].forEach((type) => {
      const placement = controlsForGateType(type, 2, 3);
      expect(placement).toEqual({ controls: [0, 1], targets: [2] });
      const source = serializeCircuitToQpuProtocol(
        [{ ...gate(type, 0, placement!.targets, placement!.controls) }],
        3,
        ['0p', '0p', '0p'],
      );
      expect(() => compileQpuProtocol(source)).not.toThrow();
    });
    expect(controlsForGateType('CNOT', 2, 3)).toEqual({ controls: [0], targets: [2] });
  });
});
