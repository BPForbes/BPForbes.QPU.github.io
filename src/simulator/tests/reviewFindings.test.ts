import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileQpuProtocol } from '../compiler/qpuAst';
import { complex } from '../complex';
import { protocolDocEntry } from '../../data/learning/docEntries';
import { applyGate, executeCircuit, measureAll, projectStateOntoQubits, runCircuit, stepCircuitGate } from '../engine';
import { registerCustomGate } from '../gates/customGateEngine';
import { refreshCustomGateRegistry } from '../gates/registry';
import { physics } from '../physics/PhysicsEngine';
import type { CircuitGate, StateCheckpoint } from '../types';

// Regressions for PR #51 review findings.
const gate = (id: string, type: string, step: number, targets: number[], controls: number[] = [], extra: Partial<CircuitGate> = {}): CircuitGate => ({
  id,
  type,
  step,
  targets,
  controls,
  ...extra,
});

describe('particle snapshots follow the measured basis', () => {
  const plusThenMeasureX = [gate('h', 'H', 0, [0]), gate('m', 'MEASURE', 1, [0], [], { basis: 'X' })];

  it('an X measurement of |+⟩ pins the particle to +x, not the Z pole', () => {
    const run = runCircuit(1, plusThenMeasureX, [], undefined, { trackParticles: true });
    expect(run.measurements[0]).toBe(0);
    expect(run.measurementBases).toEqual({ 0: 'X' });
    const [particle] = run.particles!;
    expect(particle.measuredBasis).toBe('X');
    expect(particle.bloch.x).toBeCloseTo(1, 12);
    expect(particle.bloch.z).toBeCloseTo(0, 12);
    expect(run.transitions!.at(-1)!.after[0].bloch.x).toBeCloseTo(1, 12);
  });

  it('Y outcome 1 sits on −y, and a later Z measurement clears the basis', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const run = runCircuit(1, [gate('h', 'H', 0, [0]), gate('m', 'MEASURE', 1, [0], [], { basis: 'Y' })], [], undefined, { trackParticles: true });
    vi.restoreAllMocks();
    expect(run.measurements[0]).toBe(1);
    expect(run.particles![0].bloch.y).toBeCloseTo(-1, 12);
    const remeasured = runCircuit(1, [...plusThenMeasureX, gate('mz', 'MEASURE', 2, [0])], [], undefined, { trackParticles: true });
    expect(remeasured.measurementBases).toEqual({});
    expect(Math.abs(remeasured.particles![0].bloch.z)).toBeCloseTo(1, 12);
  });

  it('stepping carries bases between steps and through checkpoints', () => {
    const first = stepCircuitGate(physics.createState(1).amplitudes, 1, plusThenMeasureX[0], {}, { trackParticles: true });
    const second = stepCircuitGate(first.result.state, 1, plusThenMeasureX[1], first.result.measurements, { trackParticles: true });
    const store: Record<string, StateCheckpoint> = {};
    applyGate(second.result.state, 1, gate('s', 'SAVE_STATE', 2, [], [], { checkpoint: 'x' }), second.result.measurements, {
      checkpoints: store,
      measurementBases: second.result.measurementBases,
    });
    expect(store.x.measurementBases).toEqual({ 0: 'X' });
    const later = applyGate(second.result.state, 1, gate('z', 'Z', 3, [1]), second.result.measurements, {
      trackParticles: true,
      measurementBases: second.result.measurementBases,
    });
    expect(later.particles![0].bloch.x).toBeCloseTo(1, 12);
    const loaded = executeCircuit(1, [
      ...plusThenMeasureX,
      gate('s', 'SAVE_STATE', 2, [], [], { checkpoint: 'x' }),
      gate('mz', 'MEASURE', 3, [0]),
      gate('l', 'LOAD_STATE', 4, [], [], { checkpoint: 'x' }),
    ]);
    expect(loaded.measurementBases).toEqual({ 0: 'X' });
  });
});

describe('density-matrix execution of custom gates', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) { this.storage[key] = value; },
      getItem(key: string) { return this.storage[key] ?? null; },
      removeItem(key: string) { delete this.storage[key]; },
    });
    registerCustomGate({
      id: 'PredFlip',
      source: `PARAMS: A:1 B:1
MAIN-PROCESS PredFlip
IF (OR -I A B -O B) = 1
X -I B -O B
ENDIF
RETURNVALS B`,
    });
    registerCustomGate({ id: 'Plain', source: 'PARAMS: Q:1\nMAIN-PROCESS Plain\nX -I Q -O Q\nRETURNVALS Q' });
    refreshCustomGateRegistry();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    refreshCustomGateRegistry();
  });

  it('refuses a custom gate whose body contains a gate-expression IF', () => {
    const compiled = compileQpuProtocol('PARAMS: A:1 B:1\nMAIN-PROCESS UsePred\nPredFlip -I A B -O B\nRETURNVALS A B');
    const params = compiled.processParams.map((param) => param.qubitIndex);
    expect(() => executeCircuit(compiled.qubitCount, compiled.gates, ['1p', '0p'], params, { representation: 'densityMatrix' }))
      .toThrow(/gate-expression IF/);
    // The same circuit is fine on a state vector, where the predicate reads one well-defined state.
    expect(() => executeCircuit(compiled.qubitCount, compiled.gates, ['1p', '0p'], params)).not.toThrow();
  });

  it('still lifts custom gates without predicates', () => {
    const compiled = compileQpuProtocol('PARAMS: Q:1\nMAIN-PROCESS UsePlain\nPlain -I Q -O Q\nRETURNVALS Q');
    const params = compiled.processParams.map((param) => param.qubitIndex);
    const run = executeCircuit(compiled.qubitCount, compiled.gates, ['0p'], params, { representation: 'densityMatrix' });
    expect(physics.probabilityOfOne(run.state, params[0])).toBeCloseTo(1, 12);
  });
});

describe('gate noise on overlapping wires', () => {
  it('applies each channel once per touched wire even when a wire is both control and target', () => {
    // CNOT listing q0 as both control and target is a no-op; a certain bit flip must still flip q0 once.
    const aliased = gate('cx', 'CNOT', 0, [0], [0]);
    const run = executeCircuit(1, [aliased], [], undefined, { noise: { gate: [physics.channels.bitFlip(1)] } });
    expect(physics.probabilities(run.state)[1]).toBeCloseTo(1, 12);
  });
});

describe('CodeRabbit findings on 152a6bb', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) { this.storage[key] = value; },
      getItem(key: string) { return this.storage[key] ?? null; },
      removeItem(key: string) { delete this.storage[key]; },
    });
    // SET O 0p compiles to a RESET inside the custom gate.
    registerCustomGate({
      id: 'FreshCopy',
      source: 'PARAMS: A:1\nMAIN-PROCESS FreshCopy\nCREATETOKEN -I O\nSET O 0p\nCNOT -I A -O O\nRETURNVALS O',
    });
    refreshCustomGateRegistry();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    refreshCustomGateRegistry();
  });

  it('doc tables read X-basis measurement logs instead of falling back to Z', () => {
    // Out is |+⟩, which reads 0 with certainty in X (in Z it would be a 50/50 "sp").
    const entry = protocolDocEntry(`PARAMS: A:state
MAIN-PROCESS PlusInX
CREATETOKEN -I Out
SET Out 0p
H -I Out -O Out
MEASURE -I Out -BASIS X
RETURNVALS A Out`);
    expect(entry?.table?.rows.map((row) => row.at(-1))).toEqual(['0', '0']);
  });

  it('refuses a custom gate containing RESET on a density matrix, but runs it on a state vector', () => {
    const compiled = compileQpuProtocol('PARAMS: A:1\nMAIN-PROCESS UseCopy\nCREATETOKEN -I B\nFreshCopy -I A -O B\nRETURNVALS A B');
    const params = compiled.processParams.map((param) => param.qubitIndex);
    expect(compiled.gates.some((entry) => entry.type === 'FreshCopy')).toBe(true);
    expect(() => executeCircuit(compiled.qubitCount, compiled.gates, ['1p'], params, { representation: 'densityMatrix' }))
      .toThrow(/RESET/);
    expect(() => executeCircuit(compiled.qubitCount, compiled.gates, ['1p'], params)).not.toThrow();
  });

  it('fromAmplitudes keeps workspace wires a custom gate appended', () => {
    // q0 = |1⟩ with one appended |0⟩ workspace wire: index 0b10.
    const widened = [complex(), complex(), complex(1), complex()];
    expect(physics.fromAmplitudes(widened, 1).qubitCount).toBe(2);
    const measured = measureAll(widened, 1, {});
    expect(measured.measurements).toEqual({ 0: 1 });
    expect(projectStateOntoQubits(widened, 1, [0])[1].re).toBeCloseTo(1, 12);
  });

  it('inspectGlobal diagnoses an unnormalized state instead of throwing', () => {
    const unnormalized = physics.fromAmplitudes([complex(1), complex(1)]);
    expect(physics.inspectGlobal(unnormalized).normalization).toBeCloseTo(2, 12);
  });
});
