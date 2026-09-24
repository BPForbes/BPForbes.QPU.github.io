import { describe, expect, it, beforeEach, vi } from 'vitest';
import { compileQpuProtocol, parseCommand } from '../../compiler/qpuAst';
import { analyzeQpuProtocol } from '../../compiler/protocolDiagnostics';
import { createInitialState, runCircuit } from '../../engine';
import { preconfiguredPaletteGates, refreshCustomGateRegistry } from '../../gates/registry';
import { preconfiguredGates } from '../../gates/preconfigured';
import { applyCustomGateProcess, registerCustomGate } from '../../gates/customGateEngine';
import { gateHelp } from '../../../data/learning/learningHelp';
import { magnitudeSquared } from '../../complex';
import type { CircuitGate } from '../../types';

describe('feature parity invariants', () => {
  it('provides help for every palette gate', () => {
    for (const gate of preconfiguredPaletteGates()) {
      expect(gateHelp[gate.id], gate.id).toBeDefined();
    }
  });

  it('accepts dg and inv on every reversible built-in gate', () => {
    for (const gate of preconfiguredGates) {
      if (!gate.supportsReverse) continue;
      const anglePrefix = gate.supportsPhase ? `${gate.id}dg=pi/4` : `${gate.id}dg`;
      const invPrefix = gate.supportsPhase ? `inv${gate.id}=pi/4` : `inv${gate.id}`;
      if (gate.id === 'SWAP') {
        expect(() => parseCommand(`${anglePrefix} -I A B -O A B`)).not.toThrow();
        expect(() => parseCommand(`${invPrefix} -I A B -O A B`)).not.toThrow();
        continue;
      }
      if (gate.controlKind === 'none') {
        expect(() => parseCommand(`${anglePrefix} -I Q -O Q`)).not.toThrow();
        expect(() => parseCommand(`${invPrefix} -I Q -O Q`)).not.toThrow();
        continue;
      }
      if (gate.ioArity.minInputs >= 2) {
        expect(() => parseCommand(`${anglePrefix} -I A B -O T`)).not.toThrow();
        expect(() => parseCommand(`${invPrefix} -I A B -O T`)).not.toThrow();
        continue;
      }
      expect(() => parseCommand(`${anglePrefix} -I A -O T`)).not.toThrow();
      expect(() => parseCommand(`${invPrefix} -I A -O T`)).not.toThrow();
    }
  });

  it('warns on inactive inverse markers for MEASURE', () => {
    const report = analyzeQpuProtocol(`MAIN-PROCESS NoInverse
SET Q 0p
MEASUREdg -I Q
RETURNVALS Q`);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain('INACTIVE_INVERSE_MARKER');
  });

  it('INCREASECYCLE only emits CYCLE markers and never repeats earlier gates', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Stages
SET T 1p
SET Q 0p
CNOT -I T -O Q
INCREASECYCLE
CNOT -I T -O Q
INCREASECYCLE
CNOT -I T -O Q
RETURNVALS Q`);
    const cycles = compiled.gates.filter((gate) => gate.type === 'CYCLE');
    const cnots = compiled.gates.filter((gate) => gate.type === 'CNOT');
    expect(cycles).toHaveLength(2);
    expect(cnots).toHaveLength(3);
    expect(compiled.gates.map((gate) => gate.step)).toEqual(
      compiled.gates.map((_, index) => index),
    );
  });
});

describe('parameterized rotations and CPHASE', () => {
  it('applies RX then RXdg back to |0>', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS RxRoundTrip
SET Q 0p
RX=pi/2 -I Q -O Q
RXdg=pi/2 -I Q -O Q
RETURNVALS Q`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    expect(magnitudeSquared(executed.state[0])).toBeCloseTo(1, 8);
  });

  it('applies CPHASE of pi like CZ on |11>', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS Cp
SET A 1p
SET B 1p
CPHASE=pi -I A -O B
RETURNVALS A B`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    const amp = executed.state.find((amplitude) => magnitudeSquared(amplitude) > 0.5);
    expect(amp?.re).toBeCloseTo(-1, 8);
  });
});

describe('measurement-conditioned forward gates', () => {
  it('applies a conditioned X when the measured bit is 1', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS CondYes
SET C 1p
SET Q 0p
MEASURE -I C
X -I Q -O Q -IF C=1
RETURNVALS Q`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    expect(executed.log.some((line) => /skipped/i.test(line))).toBe(false);
    expect(magnitudeSquared(executed.state[0])).toBeCloseTo(0, 8);
  });

  it('skips a conditioned gate when the classical bit does not match', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS CondSkip
SET C 0p
SET Q 0p
MEASURE -I C
X -I Q -O Q -IF C=1
RETURNVALS Q`);
    const executed = runCircuit(compiled.qubitCount, compiled.gates);
    expect(executed.log.some((line) => /skipped because classical condition was false/i.test(line))).toBe(true);
    expect(magnitudeSquared(executed.state[0])).toBeCloseTo(1, 8);
  });

  it('requires the conditioned qubit to be measured first', () => {
    const compiled = compileQpuProtocol(`MAIN-PROCESS CondMissing
SET C 0p
SET Q 0p
X -I Q -O Q -IF C=1
RETURNVALS Q`);
    expect(() => runCircuit(compiled.qubitCount, compiled.gates)).toThrow(/measured first/);
  });
});

describe('reversible custom-gate dagger', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      storage: {} as Record<string, string>,
      setItem(key: string, value: string) {
        this.storage[key] = value;
      },
      getItem(key: string) {
        return this.storage[key] ?? null;
      },
      removeItem(key: string) {
        delete this.storage[key];
      },
    });
    refreshCustomGateRegistry();
  });

  it('marks a unitary custom gate reversible and undoes it with dagger', () => {
    const record = registerCustomGate({
      id: 'FlipOnce',
      source: 'PARAMS: Q:1\nMAIN-PROCESS FlipOnce\nX -I Q -O Q\nRETURNVALS Q',
    });
    expect(record.reversible).toBe(true);
    refreshCustomGateRegistry();
    const gate: CircuitGate = {
      id: 'flip',
      type: 'FlipOnce',
      step: 0,
      targets: [0],
      controls: [0],
      inverse: true,
    };
    const flipped = createInitialState(1);
    flipped[0] = { re: 0, im: 0 };
    flipped[1] = { re: 1, im: 0 };
    const result = applyCustomGateProcess(flipped, 1, gate, {}, record);
    expect(magnitudeSquared(result.state[0])).toBeCloseTo(1, 8);
  });

  it('marks a measuring custom gate non-reversible', () => {
    const record = registerCustomGate({
      id: 'MeasureOnce',
      source: 'PARAMS: Q:1\nMAIN-PROCESS MeasureOnce\nMEASURE -I Q\nRETURNVALS Q',
    });
    expect(record.reversible).toBe(false);
  });
});
