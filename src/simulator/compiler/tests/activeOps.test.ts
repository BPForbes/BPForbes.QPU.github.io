import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, visibleCircuitGates } from '../qpuAst';
import { serializeCircuitToQpuProtocol } from '../qpuFormat';
import { analyzeQpuProtocol } from '../protocolDiagnostics';
import { createInitialState, measureAll, runCircuit, stepCircuitGate } from '../../engine';
import type { CircuitGate } from '../../types';
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

describe('inverse markers', () => {
  it('lowers dg and inv on S, T, and PHASE to the negative angle', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Inverse
SET Q 0p
Sdg -I Q -O Q
Tinv -I Q -O Q
dgS -I Q -O Q
invT -I Q -O Q
PHASEdg=pi/4 -I Q -O Q
invPHASE=pi/2 -I Q -O Q
Xdg -I Q -O Q
dgCNOT -I Q -O Q
RETURNVALS Q`);
    const phases = compiled.gates.filter((gate) => gate.type === 'PHASE').map((gate) => gate.phase);
    expect(phases).toEqual([
      expect.closeTo(-Math.PI / 2, 12),
      expect.closeTo(-Math.PI / 4, 12),
      expect.closeTo(-Math.PI / 2, 12),
      expect.closeTo(-Math.PI / 4, 12),
      expect.closeTo(-Math.PI / 4, 12),
      expect.closeTo(-Math.PI / 2, 12),
    ]);
    expect(compiled.gates.filter((gate) => gate.type === 'X')).toHaveLength(1);
    expect(compiled.gates.filter((gate) => gate.type === 'CNOT')).toHaveLength(1);
    expect(compiled.warnings).toEqual([]);
  });

  it('rejects the retired B prefix', () => {
    expect(() => compileQpuProtocol(`MAIN-PROCESS Old
SET Q 0p
BX -I Q -O Q
RETURNVALS Q`)).toThrow(/Unknown command: BX/);
  });

  it('accepts dg and inv on reversible derived Boolean gates', () => {
    const markers = ['ANDdg', 'ANDinv', 'ORdg', 'ORinv', 'XORdg', 'XORinv', 'NOTdg', 'NOTinv', 'NANDdg'];
    for (const marker of markers) {
      const isNot = marker.startsWith('NOT');
      const compiled = compileQpuProtocol(isNot
        ? `MAIN-PROCESS DerivedInverse
SET T 0p
${marker} -I T -O T
RETURNVALS T`
        : `MAIN-PROCESS DerivedInverse
SET A 1p
SET B 1p
SET T 0p
${marker} -I A B -O T
RETURNVALS T`);
      expect(compiled.gates.some((gate) => gate.inverse)).toBe(true);
      expect(compiled.warnings).toEqual([]);
    }
  });

  it('round-trips derived inverse gates through serialize and compile', () => {
    const source = serializeCircuitToQpuProtocol([
      { id: 'and', type: 'AND', step: 0, targets: [2], controls: [0, 1], inverse: true },
    ], 3);
    expect(source).toContain('ANDdg');
    const compiled = compileQpuProtocol(source);
    expect(compiled.gates.some((gate) => gate.type === 'AND' && gate.inverse)).toBe(true);
  });

  it('applies derived gate then dagger back to the initial state', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS UndoAnd
SET A 1p
SET B 1p
SET T 0p
AND -I A B -O T
ANDdg -I A B -O T
RETURNVALS T`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'T')]).toBe(0);
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

  it('keeps a pending zero reset when a known-zero wire is freed', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Recycled
SET Q 1p
SET Q 0p
FREE -I Q
X -I Fresh -O Fresh
RETURNVALS Fresh`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'Fresh')]).toBe(1);
  });

  it('does not recycle an input wire or a wire that still belongs to a register', () => {
    const input = compileQpuProtocol(`PARAMS: Q:state
MAIN-PROCESS Input
FREE -I Q
SET Next 0p
X -I Next -O Next
RETURNVALS Next`);
    expect(input.qubitCount).toBe(2);
    expect(input.processParams.map((param) => param.name)).toEqual(['Q']);
    const startStates = Array.from({ length: input.qubitCount }, () => '0p' as ParticleStartState);
    startStates[input.processParams[0].qubitIndex] = '1p';
    const executed = runCircuit(input.qubitCount, input.gates, startStates, [input.processParams[0].qubitIndex]);
    const measured = measureAll(executed.state, input.qubitCount, executed.measurements);
    expect(measured.measurements[input.processParams[0].qubitIndex]).toBe(1);
    expect(measured.measurements[tokenQubit(input.tokenMap, 'Next')]).toBe(1);

    const joined = compileQpuProtocol(`MAIN-PROCESS JoinedFree
SET A 0p
SET B 0p
JOIN -I A B -O AB
FREE -I A
SET Next 0p
RETURNVALS Next`);
    expect(joined.qubitCount).toBe(3);
  });

  it('returns the wires currently named by JOIN and SPLIT', () => {
    const joined = compileQpuProtocol(`MAIN-PROCESS JoinedReturn
SET A 0p
SET B 1p
JOIN -I A B -O AB
RETURNVALS AB`);
    expect(joined.returnValues.map((value) => value.name)).toEqual(['AB[0]', 'AB[1]']);
    expect(joined.returnValues.map((value) => value.qubitIndex)).toEqual([
      tokenQubit(joined.tokenMap, 'A'),
      tokenQubit(joined.tokenMap, 'B'),
    ]);

    const split = compileQpuProtocol(`MAIN-PROCESS SplitReturn
SET R 0p_dim4
SPLIT R Low 2
RETURNVALS R`);
    expect(split.returnValues).toHaveLength(1);
    expect(split.returnValues[0].name).toBe('R');
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

  it('saves a queued zero preparation before the checkpoint marker', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS SavedZero
SET Q 1p
SET Q 0p
SAVE_STATE zero
X -I Q -O Q
LOAD_STATE zero
RETURNVALS Q`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const probabilityOne = executed.state.reduce((sum, amplitude, index) => sum + (index % 2 === 1 ? magnitudeSquared(amplitude) : 0), 0);
    expect(probabilityOne).toBeCloseTo(0, 8);
  });

  it('does not treat a loaded checkpoint as known zero', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Loaded
SET Q 1p
SAVE_STATE mark
SET Q 0p
LOAD_STATE mark
FREE -I Q
X -I Fresh -O Fresh
RETURNVALS Fresh`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);
    expect(compiled.qubitCount).toBe(2);
    expect(measured.measurements[tokenQubit(compiled.tokenMap, 'Fresh')]).toBe(1);
  });

  it('shares a checkpoint store passed without other execution options', () => {
    const store = {};
    const save: CircuitGate = {
      id: 'save', type: 'SAVE_STATE', step: 0, targets: [], controls: [], source: 'SAVE_STATE mark', checkpoint: 'mark',
    };
    const load: CircuitGate = {
      id: 'load', type: 'LOAD_STATE', step: 1, targets: [], controls: [], source: 'LOAD_STATE mark', checkpoint: 'mark',
    };
    stepCircuitGate(createInitialState(1), 1, save, {}, { checkpoints: store });
    const loaded = stepCircuitGate(createInitialState(1), 1, load, {}, { checkpoints: store });
    expect(loaded.result.log.some((line) => line.startsWith('Loaded checkpoint'))).toBe(true);
  });

  it('rejects a load of an unknown checkpoint', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Missing
SET Q 0p
LOAD_STATE absent
RETURNVALS Q`);
    expect(() => runCircuit(compiled.qubitCount, compiled.gates)).toThrow(/Unknown checkpoint 'absent'/);
  });
});

describe('canvas serialization', () => {
  it('numbers wire suffixes from the cycle and emits dg on reversible derived NOT', () => {
    const source = serializeCircuitToQpuProtocol([
      { id: 'h', type: 'H', step: 0, targets: [0], controls: [], source: 'H', inverse: true },
      { id: 'cycle', type: 'CYCLE', step: 1, targets: [], controls: [], source: 'INCREASECYCLE' },
      { id: 'x', type: 'X', step: 2, targets: [0], controls: [], source: 'X' },
      { id: 'not', type: 'NOT', step: 3, targets: [0], controls: [], source: 'NOT', inverse: true },
    ], 1);
    expect(source).toContain('Hdg -I $Q0:0 -O $Q0:0');
    expect(source).toContain('X -I $Q0:1 -O $Q0:1');
    expect(source).toContain('NOTdg -I $Q0:1 -O $Q0:1');
    expect(analyzeQpuProtocol(source).diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('CYCLE_SUFFIX_MISMATCH');
  });
});

describe('initial state helper', () => {
  it('still builds a zero state for the bundled qubit width', () => {
    expect(createInitialState(2)[0]).toEqual({ re: 1, im: 0 });
  });
});
