import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCircuit, runCircuit } from '../engine';
import { runLegacyCircuit } from './support/legacyReference';
import { randomCircuit, seededRandom } from './support/randomCircuits';

// The engine must reproduce the pre-PhysicsEngine simulator on ideal circuits.
// RESET is excluded on purpose: it changed from post-selection to a physical reset.
const CIRCUITS = 400;
const TOLERANCE = 1e-10;

const maxAmplitudeError = (a: { re: number; im: number }[], b: { re: number; im: number }[]) =>
  a.reduce((worst, value, index) => Math.max(worst, Math.hypot(value.re - b[index].re, value.im - b[index].im)), 0);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('regression against the pre-engine state-vector simulator', () => {
  it(`matches amplitudes on ${CIRCUITS} generated unitary circuits`, () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= CIRCUITS; seed += 1) {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 5, maxDepth: 30 });
      const engine = runCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const legacy = runLegacyCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const error = maxAmplitudeError(engine.state, legacy.state);
      if (!(error < TOLERANCE)) failures.push(`seed ${seed}: max amplitude error ${error}`);
    }
    expect(failures).toEqual([]);
  });

  it('matches outcomes and collapsed states with MEASURE and -IF feed-forward under shared random draws', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= CIRCUITS / 2; seed += 1) {
      const circuit = randomCircuit(seededRandom(10_000 + seed), { maxQubits: 4, maxDepth: 25, measurements: true });
      vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
      const engine = runCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      vi.restoreAllMocks();
      const legacy = runLegacyCircuit(circuit.qubitCount, circuit.gates, circuit.startStates, seededRandom(seed));
      const error = maxAmplitudeError(engine.state, legacy.state);
      if (!(error < TOLERANCE) || JSON.stringify(engine.measurements) !== JSON.stringify(legacy.measurements)) {
        failures.push(`seed ${seed}: error ${error}, measurements ${JSON.stringify(engine.measurements)} vs ${JSON.stringify(legacy.measurements)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the engine-native path agrees with the Complex[] adapter on the same circuits', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 4 });
      const native = executeCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const adapter = runCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      expect(native.state.kind === 'stateVector' && native.state.amplitudes).toEqual(adapter.state);
    }
  });
});
