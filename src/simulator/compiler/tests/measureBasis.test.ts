import { describe, expect, it } from 'vitest';
import { executeCircuit, runCircuit } from '../../engine';
import { physics } from '../../physics/PhysicsEngine';
import { compileQpuProtocol, parseCommand } from '../qpuAst';
import { serializeCircuitToQpuProtocol } from '../qpuFormat';

const compile = (body: string) => compileQpuProtocol(`PARAMS: Q:1\nMAIN-PROCESS Basis\n${body}\nRETURNVALS Q`);

describe('MEASURE -BASIS', () => {
  it('parses X, Y, and Z case-insensitively and defaults to no basis', () => {
    expect(parseCommand('MEASURE -I Q -BASIS X').basis).toBe('X');
    expect(parseCommand('MEASURE -I Q -basis y').basis).toBe('Y');
    expect(parseCommand('MEASURE -BASIS Z').basis).toBe('Z');
    expect(parseCommand('MEASURE -I Q').basis).toBeUndefined();
  });

  it('keeps -BASIS out of the -I wire list', () => {
    expect(parseCommand('MEASURE -I Q -BASIS X').inputs).toEqual(['Q']);
  });

  it('rejects a missing or unknown basis and -BASIS on other operations', () => {
    expect(() => parseCommand('MEASURE -I Q -BASIS')).toThrow(/X, Y, or Z/);
    expect(() => parseCommand('MEASURE -I Q -BASIS W')).toThrow(/got 'W'/);
    expect(() => parseCommand('H -I Q -O Q -BASIS X')).toThrow(/only valid on MEASURE/);
  });

  it('records X/Y on the compiled gate and leaves Z implicit', () => {
    const x = compile('H -I Q -O Q\nMEASURE -I Q -BASIS X');
    expect(x.gates.find((gate) => gate.type === 'MEASURE')?.basis).toBe('X');
    const z = compile('MEASURE -I Q -BASIS Z');
    expect(z.gates.find((gate) => gate.type === 'MEASURE')?.basis).toBeUndefined();
  });

  it('applies the basis to a bare MEASURE of every wire', () => {
    const compiled = compileQpuProtocol('PARAMS: A:1 B:1\nMAIN-PROCESS Both\nMEASURE -BASIS Y\nRETURNVALS A B');
    const measures = compiled.gates.filter((gate) => gate.type === 'MEASURE');
    expect(measures.length).toBeGreaterThan(0);
    expect(measures.every((gate) => gate.basis === 'Y')).toBe(true);
  });

  it('|+⟩ measured in X always reads 0, in Z it is random', () => {
    const compiled = compile('H -I Q -O Q\nMEASURE -I Q -BASIS X');
    const params = compiled.processParams.map((param) => param.qubitIndex);
    [0.01, 0.5, 0.99].forEach((draw) => {
      const run = executeCircuit(compiled.qubitCount, compiled.gates, ['0p'], params, { random: () => draw });
      expect(run.measurements[params[0]]).toBe(0);
      expect(physics.measurementDiagnostics(run.state, params[0], 'X').expectation).toBeCloseTo(1, 12);
    });
    const zRun = runCircuit(compiled.qubitCount, compile('H -I Q -O Q\nMEASURE -I Q').gates, ['0p'], params);
    expect(zRun.log.at(-1)).toMatch(/P\(1\)=0\.500/);
  });

  it('round-trips through the canvas serializer', () => {
    const compiled = compile('H -I Q -O Q\nMEASURE -I Q -BASIS Y');
    const source = serializeCircuitToQpuProtocol(compiled.gates, compiled.qubitCount);
    expect(source).toMatch(/MEASURE -I \S+ -BASIS Y/);
    const again = compileQpuProtocol(source);
    expect(again.gates.find((gate) => gate.type === 'MEASURE')?.basis).toBe('Y');
  });
});
