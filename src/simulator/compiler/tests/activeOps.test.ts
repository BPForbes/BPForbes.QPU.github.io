import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { analyzeQpuProtocol } from '../protocolDiagnostics';
import { createInitialState, measureAll, runCircuit } from '../../engine';
import { magnitudeSquared } from '../../complex';
import type { ParticleStartState } from '../../types';

const readProcess = (fileName: string) => readFileSync(new URL(`../../../data/processes/${fileName}`, import.meta.url), 'utf8');

const library = {
  SingleBitFullAdder: readProcess('single-bit-full-adder.qpucir'),
  TwoBitFullAdder: readProcess('two-bit-full-adder.qpucir'),
  FourBitFullAdder: readProcess('four-bit-full-adder.qpucir'),
};

const tokenQubit = (tokenMap: Record<string, number>, name: string) => {
  const entry = Object.entries(tokenMap).find(([token]) => token === name || token.endsWith(`/${name}`) || token.endsWith(`/${name}[0]`));
  if (entry === undefined) throw new Error(`Missing token '${name}' in ${JSON.stringify(tokenMap)}`);
  return entry[1];
};

describe('cycle boundaries', () => {
  it('keeps the four-bit adder carry across INCREASECYCLE and does not warn on child :0 labels', () => {
    const compiled = compileQpuProtocol(library.FourBitFullAdder, library);
    expect(compiled.warnings).toEqual([]);
    expect(visibleCircuitGates(compiled.gates).some((gate) => gate.type === 'CYCLE')).toBe(true);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    const set = (name: string, value: ParticleStartState) => {
      startStates[tokenQubit(compiled.tokenMap, name)] = value;
    };
    set('A0', '1p');
    set('A1', '1p');
    set('B0', '1p');
    set('B1', '1p');
    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'Sum0')]).toBe(0);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'Sum1')]).toBe(1);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'C2')]).toBe(1);
  });

  it('warns when an integer suffix does not match the process cycle', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS LateSuffix
SET Q:1 0p
H -I Q:1 -O Q:1
RETURNVALS Q`);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain('CYCLE_SUFFIX_MISMATCH');
  });
});

describe('dimension registers', () => {
  it('treats dim2 as one wire and dim4 as two wires with |1> on the LSB', () => {
    const single = compileQpuProtocol(`MAIN-PROCESS One
SET Q 0p_dim2
X -I Q -O Q
RETURNVALS Q`);
    const plain = compileQpuProtocol(`MAIN-PROCESS One
SET Q 0p
X -I Q -O Q
RETURNVALS Q`);
    expect(single.qubitCount).toBe(plain.qubitCount);
    expect(runCircuit(single.qubitCount, single.gates).state).toEqual(runCircuit(plain.qubitCount, plain.gates).state);

    const pair = compileQpuProtocol(`MAIN-PROCESS Pair
SET R 1p_dim4
RETURNVALS R`);
    expect(pair.qubitCount).toBe(2);
    const executed = runCircuit(pair.qubitCount, pair.gates);
    const measured = measureAll(executed.state, pair.qubitCount, executed.measurements);
    const low = tokenQubit(pair.tokenMap, 'R[1]');
    const high = tokenQubit(pair.tokenMap, 'R[0]');
    expect(measured.measurements[low]).toBe(1);
    expect(measured.measurements[high]).toBe(0);
  });

  it('rejects a dimension that is not a power of two', () => {
    expect(() => compileQpuProtocol(`MAIN-PROCESS Bad
SET Q 0p_dim3
RETURNVALS Q`)).toThrow(/not a power of two/);
  });

  it('prepares a uniform superposition across a dim8 register', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Spread
SET R sp_dim8
RETURNVALS R`);
    expect(compiled.qubitCount).toBe(3);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    executed.state.forEach((amplitude) => {
      expect(magnitudeSquared(amplitude)).toBeCloseTo(1 / 8, 8);
    });
  });
});

describe('inverse phase prefixes', () => {
  it('lowers BS and BT to the negative phase gates', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Inverse
SET Q 0p
BS -I Q -O Q
BT -I Q -O Q
RETURNVALS Q`);
    const phases = compiled.gates.filter((gate) => gate.type === 'PHASE').map((gate) => gate.phase);
    expect(phases).toEqual([expect.closeTo(-Math.PI / 2, 12), expect.closeTo(-Math.PI / 4, 12)]);
  });
});

describe('lifetimes and registers', () => {
  it('reuses a known-zero wire and rejects use after free', () => {
    const reused = compileQpuProtocol(`MAIN-PROCESS Reuse
SET Scratch 0p
FREE -I Scratch
SET Next 0p
X -I Next -O Next
RETURNVALS Next`);
    expect(reused.qubitCount).toBe(1);

    expect(() => compileQpuProtocol(`MAIN-PROCESS After
SET Q 0p
X -I Q -O Q
FREE -I Q
H -I Q -O Q
RETURNVALS Q`)).toThrow(/released/);
  });

  it('does not recycle a wire that has left |0>', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Held
SET Q 0p
X -I Q -O Q
FREE -I Q
SET Next 0p
RETURNVALS Next`);
    expect(compiled.qubitCount).toBe(2);
  });

  it('joins wires and splits off a dimension-2 component', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Joined
SET A 0p
SET B 1p
JOIN -I A B -O AB
SPLIT AB Left 2
X -I Left -O Left
RETURNVALS Left`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'A')]).toBe(1);
  });
});

describe('parameter lock, compile, and master value', () => {
  it('skips parameter substitution on a -$R instruction', () => {
    const child = `PARAMS: Q:state
MAIN-PROCESS Child
H -I Q -O Local -$R
RETURNVALS Local`;
    const parent = `MAIN-PROCESS Parent
DECLARECHILD Child
SET Q 0p
RUNCHILD Child -I Q -O Out
RETURNVALS Out`;
    const compiled = compileQpuProtocol(parent, { Child: child });
    const out = tokenQubit(compiled.tokenMap, 'Out');
    const input = tokenQubit(compiled.tokenMap, 'Q');
    expect(out).not.toBe(input);
  });

  it('verifies COMPILEPROCESS without inlining gates', () => {
    const child = `MAIN-PROCESS Child
X -I Q -O Q
RETURNVALS Q`;
    const compiled = compileQpuProtocol(`MAIN-PROCESS Parent
COMPILEPROCESS Child
SET A 0p
RETURNVALS A`, { Child: child });
    expect(compiled.gates.some((gate) => gate.type === 'X')).toBe(false);
    expect(compiled.log.some((line) => line.includes("COMPILEPROCESS verified 'Child'"))).toBe(true);
    expect(() => compileQpuProtocol(`MAIN-PROCESS Parent
COMPILEPROCESS Missing
RETURNVALS A`, {})).toThrow(/Unknown child process 'Missing'/);
  });

  it('uses MASTERVAL as returns only when RETURNVALS is absent', () => {
    const onlyMaster = compileQpuProtocol(`MAIN-PROCESS Master
SET Q 1p
MASTERVAL Q`);
    expect(onlyMaster.returnValues.map((value) => value.name)).toEqual(['Q']);

    const both = compileQpuProtocol(`MAIN-PROCESS Both
SET Q 1p
SET R 0p
MASTERVAL Q
RETURNVALS Q R`);
    expect(both.returnValues.map((value) => value.name)).toEqual(['Q', 'R']);
    expect(() => compileQpuProtocol(`MAIN-PROCESS Extra
SET Q 0p
MASTERVAL Other
RETURNVALS Q`)).toThrow(/not listed in RETURNVALS/);
  });
});

describe('simulator checkpoints', () => {
  it('restores amplitudes and measurements from a named checkpoint', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Checkpoint
SET Q 0p
SAVE_STATE mark
X -I Q -O Q
MEASURE -I Q
LOAD_STATE mark
RETURNVALS Q`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    expect(executed.measurements).toEqual({});
    const probabilityOne = executed.state.reduce((sum, amplitude, index) => sum + (index % 2 === 1 ? magnitudeSquared(amplitude) : 0), 0);
    expect(probabilityOne).toBeCloseTo(0, 8);
    expect(executed.log.some((line) => line.startsWith('Saved checkpoint'))).toBe(true);
    expect(executed.log.some((line) => line.startsWith('Loaded checkpoint'))).toBe(true);
  });

  it('rejects a load of an unknown checkpoint', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Missing
SET Q 0p
LOAD_STATE absent
RETURNVALS Q`);
    expect(() => runCircuit(compiled.qubitCount, compiled.gates)).toThrow(/Unknown checkpoint 'absent'/);
  });
});

describe('initial state helper', () => {
  it('still builds a zero state for the bundled qubit width', () => {
    expect(createInitialState(2)[0]).toEqual({ re: 1, im: 0 });
  });
});
