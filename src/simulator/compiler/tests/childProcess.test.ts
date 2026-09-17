import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { compileQpuProtocol, getReturnValToken, visibleCircuitGates } from '../qpuAst';
import { getProtocolParameterEntries, serializeCircuitToQpuProtocol, updateProtocolParameterCount, updateProtocolStartStateSet } from '../qpuFormat';
import { createInitialState, measureAll, projectStateOntoQubits, runCircuit } from '../../engine';
import { complex, magnitudeSquared } from '../../complex';
import type { ParticleStartState } from '../../types';
const readProcess = (fileName: string) => readFileSync(new URL(`../../../data/processes/${fileName}`, import.meta.url), 'utf8');

const protocolLibrary = {
  SingleBitFullAdder: readProcess('single-bit-full-adder.qpucir'),
  TwoBitFullAdder: readProcess('two-bit-full-adder.qpucir'),
};

const tokenQubit = (tokenMap: Record<string, number>, name: string) => {
  const entry = Object.entries(tokenMap).find(([token]) => token === name || token.endsWith(`/${name}`));
  if (entry === undefined) throw new Error(`Missing token '${name}' in ${JSON.stringify(tokenMap)}`);
  return entry[1];
};

const setToken = (tokenMap: Record<string, number>, startStates: ParticleStartState[], name: string, value: ParticleStartState) => {
  startStates[tokenQubit(tokenMap, name)] = value;
};

const readMeasured = (tokenMap: Record<string, number>, measurements: Record<number, 0 | 1>, name: string) =>
  measurements[tokenQubit(tokenMap, name)];

describe('DECLARECHILD bindings', () => {
  it('binds SingleBitFullAdder before TwoBitFullAdder RUNCHILD expansion', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    expect(compiled.log).toContain("Bound child process 'SingleBitFullAdder' for RUNCHILD/CALL.");
    expect(visibleCircuitGates(compiled.gates).some((gate) => gate.type === 'CNOT')).toBe(true);
  });

  it('binds TwoBitFullAdder before FourBitFullAdder nested RUNCHILD expansion', () => {
    const source = readProcess('four-bit-full-adder.qpucir');
    const compiled = compileQpuProtocol(source, protocolLibrary);
    expect(compiled.log).toContain("Bound child process 'TwoBitFullAdder' for RUNCHILD/CALL.");
    expect(compiled.log).toContain("Bound child process 'SingleBitFullAdder' for RUNCHILD/CALL.");
  });

  it('rejects DECLARECHILD of a process that is not in the library', () => {
    expect(() => compileQpuProtocol(`MAIN-PROCESS Parent
DECLARECHILD MissingChild
RETURNVALS A`, {})).toThrow("Unknown child process 'MissingChild'");
  });
});

describe('SingleBitFullAdder via TwoBitFullAdder', () => {
  it('writes child sum and carry into S0tmp, S1tmp, and Cmid', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '0p');

    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S0tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S1tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Cmid')).toBe(0);
  });
});

describe('rotation parameter parsing', () => {
  it('accepts pi, fractional-pi, degree, and rational radian parameters for PHASE-style operations', () => {
    const source = `MAIN-PROCESS PiPhase
SET Q0:0 0p
PHASE=pi -I Q0:0 -O Q0:0
BPHASE=-pi -I Q0:0 -O Q0:0
PHASE=-11pi/6 -I Q0:0 -O Q0:0
PHASE=2*pi/3 -I Q0:0 -O Q0:0
PHASE=7pi/2 -I Q0:0 -O Q0:0
PHASE=630d -I Q0:0 -O Q0:0
PHASE=180.5d -I Q0:0 -O Q0:0
PHASE=45/2d -I Q0:0 -O Q0:0
PHASE=3/2 -I Q0:0 -O Q0:0
RETURNVALS Q0`;
    const compiled = compileQpuProtocol(source, protocolLibrary);
    const phaseGates = compiled.gates.filter((gate) => gate.type === 'PHASE');

    expect(phaseGates.map((gate) => gate.phase)).toEqual([
      expect.closeTo(Math.PI, 12),
      expect.closeTo(Math.PI, 12),
      expect.closeTo((-11 * Math.PI) / 6, 12),
      expect.closeTo((2 * Math.PI) / 3, 12),
      expect.closeTo((7 * Math.PI) / 2, 12),
      expect.closeTo((630 * Math.PI) / 180, 12),
      expect.closeTo((180.5 * Math.PI) / 180, 12),
      expect.closeTo((22.5 * Math.PI) / 180, 12),
      expect.closeTo(1.5, 12),
    ]);
  });
});

describe('process parameter exposure', () => {
  it('exposes only PARAMS entries for SingleBitFullAdder', () => {
    const compiled = compileQpuProtocol(protocolLibrary.SingleBitFullAdder, protocolLibrary);
    expect(compiled.processParams).toEqual([
      { name: 'A', type: 'state', qubitIndex: expect.any(Number) },
      { name: 'B', type: 'state', qubitIndex: expect.any(Number) },
      { name: 'Cin', type: 'state', qubitIndex: expect.any(Number) },
    ]);
    expect(compiled.processParams).toHaveLength(3);
    expect(compiled.qubitCount).toBe(5);
    expect(compiled.logicalQubitCount).toBe(2);
    expect(compiled.returnValues.map((value) => value.name)).toEqual(['Cout', 'Sum']);
  });

  it('excludes reset targets from process parameters in FourBitFullAdder', () => {
    const source = readProcess('four-bit-full-adder.qpucir');
    const compiled = compileQpuProtocol(source, protocolLibrary);
    expect(compiled.processParams.map((param) => param.name)).toEqual([
      'A0', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'B3', 'Cin',
    ]);
    expect(compiled.gates.some((gate) => gate.type === 'RESET')).toBe(true);
    expect(visibleCircuitGates(compiled.gates).some((gate) => gate.type === 'RESET')).toBe(false);
  });

  it('batches workspace zeroing at cycle boundaries instead of one gate per qubit', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const resetGates = compiled.gates.filter((gate) => gate.type === 'RESET');
    const zeroedQubits = resetGates.reduce((count, gate) => count + gate.targets.length, 0);
    expect(zeroedQubits).toBeGreaterThan(resetGates.length);
    expect(resetGates.length).toBeLessThan(zeroedQubits);
  });

  it('updates parameter SET lines without serializing a compiled process as CanvasCircuit', () => {
    const updated = updateProtocolStartStateSet(protocolLibrary.SingleBitFullAdder, 'A', 'sp');

    expect(updated).toContain('MAIN-PROCESS SingleBitFullAdder');
    expect(updated).toContain('SET 0:0 sp');
    expect(updated).not.toContain('MAIN-PROCESS CanvasCircuit');

    const compiled = compileQpuProtocol(updated, protocolLibrary);
    expect(compiled.logicalQubitCount).toBe(2);
    expect(compiled.returnValues.map((value) => value.name)).toEqual(['Cout', 'Sum']);
  });

  it('updates continued PARAMS blocks as a single logical parameter list', () => {
    const source = readProcess('four-bit-full-adder.qpucir');
    const updated = updateProtocolParameterCount(source, 8);

    expect(getProtocolParameterEntries(source).map((param) => param.name)).toEqual([
      'A0', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'B3', 'Cin', 'Sum0', 'Sum1', 'Sum2', 'Sum3', 'Cout',
    ]);
    expect(getProtocolParameterEntries(updated).map((param) => param.name)).toEqual([
      'A0', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'B3',
    ]);
    expect(updated).toContain('MAIN-PROCESS FourBitFullAdder');
    expect(updated).not.toMatch(/^\s*B0:state/m);
    expect(updated).not.toMatch(/^\s*Cin:state/m);

    const compiled = compileQpuProtocol(updated, protocolLibrary);
    expect(compiled.processParams.map((param) => param.name)).toEqual([
      'A0', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'B3',
    ]);
  });

  it('updates PARAMS when process particles are added or removed without converting to CanvasCircuit', () => {
    const added = updateProtocolParameterCount(protocolLibrary.SingleBitFullAdder, 4);
    expect(added).toContain('MAIN-PROCESS SingleBitFullAdder');
    expect(added).toMatch(/PARAMS:\s+A:state B:state Cin:state Q\d+:state/);
    expect(added).not.toContain('MAIN-PROCESS CanvasCircuit');
    expect(getProtocolParameterEntries(added)).toHaveLength(4);

    const compiledWithAddedParam = compileQpuProtocol(added, protocolLibrary);
    expect(compiledWithAddedParam.processParams.map((param) => param.name)).toHaveLength(4);
    expect(compiledWithAddedParam.returnValues.map((value) => value.name)).toEqual(['Cout', 'Sum']);

    const removed = updateProtocolParameterCount(added, 3);
    expect(getProtocolParameterEntries(removed).map((param) => param.name)).toEqual(['A', 'B', 'Cin']);
    expect(removed).toContain('MAIN-PROCESS SingleBitFullAdder');
  });

// Case: does not inflate qubit count when a compiled circuit is serialized and recompiled.
  it('does not inflate qubit count when a compiled circuit is serialized and recompiled', () => {
    const first = compileQpuProtocol(protocolLibrary.SingleBitFullAdder, protocolLibrary);
    const roundTripSource = serializeCircuitToQpuProtocol(first.gates, first.qubitCount);
    const second = compileQpuProtocol(roundTripSource, protocolLibrary);

    expect(second.qubitCount).toBe(first.qubitCount);
    expect(second.processParams.length).toBeGreaterThan(0);
    expect(second.processParams.length).toBeLessThanOrEqual(first.qubitCount);
  });

// Case: preserves workspace zeroing when a compiled circuit is serialized and recompiled.
  it('preserves workspace zeroing when a compiled circuit is serialized and recompiled', () => {
    const source = protocolLibrary.SingleBitFullAdder;
    const first = compileQpuProtocol(source, protocolLibrary);
    const roundTripSource = serializeCircuitToQpuProtocol(first.gates, first.qubitCount);
    const roundTrip = compileQpuProtocol(roundTripSource, protocolLibrary);

    const pollutedStartStates = Array.from({ length: first.qubitCount }, () => '1p' as ParticleStartState);
    setToken(first.tokenMap, pollutedStartStates, 'A', '1p');
    setToken(first.tokenMap, pollutedStartStates, 'B', '1p');
    setToken(first.tokenMap, pollutedStartStates, 'Cin', '0p');

    const pollutedRoundTrip = Array.from({ length: roundTrip.qubitCount }, () => '1p' as ParticleStartState);
    setToken(roundTrip.tokenMap, pollutedRoundTrip, 'Q0', '1p');
    setToken(roundTrip.tokenMap, pollutedRoundTrip, 'Q1', '1p');
    setToken(roundTrip.tokenMap, pollutedRoundTrip, 'Q2', '0p');

    const firstCarryQubit = first.returnValues.find((value) => value.name === 'Cout')!.qubitIndex;
    const firstSumQubit = first.returnValues.find((value) => value.name === 'Sum')!.qubitIndex;
    const roundTripSumQubit = roundTrip.returnValues.find((value) => value.qubitIndex === firstSumQubit)!.qubitIndex;
    const roundTripCarryQubit = roundTrip.returnValues.find((value) => value.qubitIndex === firstCarryQubit)!.qubitIndex;

    const firstMeasured = measureAll(
      runCircuit(first.qubitCount, first.gates, pollutedStartStates).state,
      first.qubitCount,
      {},
    );
    const roundTripMeasured = measureAll(
      runCircuit(roundTrip.qubitCount, roundTrip.gates, pollutedRoundTrip).state,
      roundTrip.qubitCount,
      {},
    );

    expect(roundTripMeasured.measurements[roundTripSumQubit]).toBe(firstMeasured.measurements[firstSumQubit]);
    expect(roundTripMeasured.measurements[roundTripCarryQubit]).toBe(firstMeasured.measurements[firstCarryQubit]);
    expect(firstMeasured.measurements[firstSumQubit]).toBe(0);
    expect(firstMeasured.measurements[firstCarryQubit]).toBe(1);
  });
});

// Test group: projectStateOntoQubits.
describe('projectStateOntoQubits', () => {
// Case: marginalizes probabilities instead of summing amplitudes when hidden qubits interfere.
  it('marginalizes probabilities instead of summing amplitudes when hidden qubits interfere', () => {
    const fullState = createInitialState(2, ['0p', 'sp']);
    const projected = projectStateOntoQubits(fullState, 2, [0]);

    expect(magnitudeSquared(projected[0])).toBeCloseTo(1, 8);
    expect(magnitudeSquared(projected[1] ?? complex(0, 0))).toBeCloseTo(0, 8);
  });
});

// Test group: PhaseDemo.
describe('PhaseDemo', () => {
// Case: uses one qubit and displays the RETURNVALS wire.
  it('uses one qubit and displays the RETURNVALS wire', () => {
    const source = readProcess('phase-demo.qpucir');
    const compiled = compileQpuProtocol(source, protocolLibrary);
    expect(compiled.qubitCount).toBe(1);
    expect(compiled.logicalQubitCount).toBe(1);
    expect(compiled.processParams).toHaveLength(0);
    expect(compiled.returnValues).toEqual([{ name: 'Q0', qubitIndex: 0 }]);
  });
});

// Test group: SingleBitFullAdder standalone.
describe('SingleBitFullAdder standalone', () => {
// Case: projects the displayed ket onto Cout and Sum return values.
  it('projects the displayed ket onto Cout and Sum return values', () => {
    const compiled = compileQpuProtocol(protocolLibrary.SingleBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A', '1p');
    setToken(compiled.tokenMap, startStates, 'B', '0p');
    setToken(compiled.tokenMap, startStates, 'Cin', '0p');

    const paramIndices = compiled.processParams.map((param) => param.qubitIndex);
    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates, paramIndices);
    const returnIndices = compiled.returnValues.map((value) => value.qubitIndex);
    const projected = projectStateOntoQubits(executed.state, compiled.qubitCount, returnIndices);

    expect(projected).toHaveLength(4);
    expect(compiled.returnValues.map((value) => value.name)).toEqual(['Cout', 'Sum']);
  });

// Case: computes sum and carry from RETURNVALS register names.
  it('computes sum and carry from RETURNVALS register names', () => {
    const source = protocolLibrary.SingleBitFullAdder;
    const compiled = compileQpuProtocol(source, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A', '1p');
    setToken(compiled.tokenMap, startStates, 'B', '1p');
    setToken(compiled.tokenMap, startStates, 'Cin', '0p');

    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    const carryQubit = tokenQubit(compiled.tokenMap, getReturnValToken(source, 0));
    const sumQubit = tokenQubit(compiled.tokenMap, getReturnValToken(source, 1));
    expect(measured.measurements[sumQubit]).toBe(0);
    expect(measured.measurements[carryQubit]).toBe(1);
  });
});

// Test group: TwoBitFullAdder.
describe('TwoBitFullAdder', () => {
// Case: allocates only live qubits instead of one ancilla per child invocation.
  it('allocates only live qubits instead of one ancilla per child invocation', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    expect(compiled.qubitCount).toBe(9);
    expect(compiled.logicalQubitCount).toBe(3);
    expect(compiled.returnValues.map((value) => value.name)).toEqual(['Cout', 'S1tmp', 'S0tmp']);
    expect(Object.keys(compiled.tokenMap)).not.toContain('SingleBitFullAdder#1/2');
  });

// Case: projects the final state onto RETURNVALS outputs for TwoBitFullAdder.
  it('projects the final state onto RETURNVALS outputs for TwoBitFullAdder', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '1p');
    setToken(compiled.tokenMap, startStates, 'Cin', '0p');

    const paramIndices = compiled.processParams.map((param) => param.qubitIndex);
    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates, paramIndices);
    const returnIndices = compiled.returnValues.map((value) => value.qubitIndex);
    const projected = projectStateOntoQubits(executed.state, compiled.qubitCount, returnIndices);

    expect(projected).toHaveLength(8);
    expect(projected.filter((amplitude) => Math.abs(amplitude.re) > 1e-8 || Math.abs(amplitude.im) > 1e-8)).toHaveLength(1);
  });

// Case: adds |10> and |11> with cin=0 to produce |101> on sum and carry outputs.
  it('adds |10> and |11> with cin=0 to produce |101> on sum and carry outputs', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '1p');
    setToken(compiled.tokenMap, startStates, 'Cin', '0p');

    const paramIndices = compiled.processParams.map((param) => param.qubitIndex);
    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates, paramIndices);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S0tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S1tmp')).toBe(0);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Cout')).toBe(1);
  });

// Case: adds |10> and |01> to produce sum 3.
  it('adds |10> and |01> to produce sum 3', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '0p');

    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S0tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S1tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Cout')).toBe(0);
  });

// Case: ignores incorrect 1p start states on child output registers.
  it('ignores incorrect 1p start states on child output registers', () => {
    const compiled = compileQpuProtocol(protocolLibrary.TwoBitFullAdder, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '0p');
    setToken(compiled.tokenMap, startStates, 'S0tmp', '1p');
    setToken(compiled.tokenMap, startStates, 'Cmid', '1p');
    setToken(compiled.tokenMap, startStates, 'S1tmp', '1p');
    setToken(compiled.tokenMap, startStates, 'Cout', '1p');

    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S0tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'S1tmp')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Cout')).toBe(0);
  });
});

// Test group: FourBitFullAdder nested children.
describe('FourBitFullAdder nested children', () => {
// Case: computes low-nibble 2 + 1 = 3.
  it('computes low-nibble 2 + 1 = 3', () => {
    const source = readProcess('four-bit-full-adder.qpucir');
    const compiled = compileQpuProtocol(source, protocolLibrary);
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);

    setToken(compiled.tokenMap, startStates, 'A0', '0p');
    setToken(compiled.tokenMap, startStates, 'A1', '1p');
    setToken(compiled.tokenMap, startStates, 'A2', '0p');
    setToken(compiled.tokenMap, startStates, 'A3', '0p');
    setToken(compiled.tokenMap, startStates, 'B0', '1p');
    setToken(compiled.tokenMap, startStates, 'B1', '0p');
    setToken(compiled.tokenMap, startStates, 'B2', '0p');
    setToken(compiled.tokenMap, startStates, 'B3', '0p');
    setToken(compiled.tokenMap, startStates, 'Cin', '0p');

    const executed = runCircuit(compiled.qubitCount, compiled.gates, startStates);
    const measured = measureAll(executed.state, compiled.qubitCount, executed.measurements);

    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Sum0')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Sum1')).toBe(1);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Sum2')).toBe(0);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'Sum3')).toBe(0);
    expect(readMeasured(compiled.tokenMap, measured.measurements, 'C4')).toBe(0);
  });
});
