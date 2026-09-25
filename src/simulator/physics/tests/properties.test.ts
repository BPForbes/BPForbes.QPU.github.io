import { describe, expect, it } from 'vitest';
import { complex, type Complex } from '../../complex';
import { executeCircuit, runCircuit } from '../../engine';
import { invertCircuitGate } from '../../gates/inverse';
import { randomCircuit, seededRandom } from '../../tests/support/randomCircuits';
import { physics } from '../PhysicsEngine';
import { densityState } from '../state/QuantumState';
import type { NoiseChannel } from '../noise/NoiseModel';
import type { MeasurementBasis } from '../measurement/MeasurementBasis';

// Seeded property tests: every failure message names its seed so it can be replayed.
const RUNS = 150;

const normSquared = (amplitudes: Complex[]) => amplitudes.reduce((sum, value) => sum + value.re ** 2 + value.im ** 2, 0);

/** Random normalized pure state on n qubits. */
const randomPureState = (random: () => number, qubitCount: number) => {
  const raw = Array.from({ length: 2 ** qubitCount }, () => complex(random() - 0.5, random() - 0.5));
  const scale = 1 / Math.sqrt(normSquared(raw));
  return physics.fromAmplitudes(raw.map((value) => complex(value.re * scale, value.im * scale)), qubitCount);
};

/** Random mixed state: a convex mixture of random pure states. */
const randomMixedState = (random: () => number, qubitCount: number) => {
  const size = 2 ** qubitCount;
  const weights = [random(), random(), random()];
  const total = weights.reduce((sum, value) => sum + value, 0);
  const rho = Array.from({ length: size }, () => Array.from({ length: size }, () => ({ re: 0, im: 0 })));
  weights.forEach((weight) => {
    const { rho: term } = physics.toDensityMatrix(randomPureState(random, qubitCount));
    term.forEach((row, i) => row.forEach((value, j) => {
      rho[i][j].re += (weight / total) * value.re;
      rho[i][j].im += (weight / total) * value.im;
    }));
  });
  return densityState(rho.map((row) => row.map((value) => complex(value.re, value.im))), qubitCount);
};

const randomChannel = (random: () => number): NoiseChannel => {
  const strength = random();
  return [
    physics.channels.bitFlip,
    physics.channels.phaseFlip,
    physics.channels.depolarizing,
    physics.channels.amplitudeDamping,
    physics.channels.phaseDamping,
  ][Math.floor(random() * 5)](strength);
};

const collect = (check: (seed: number) => string | undefined, runs = RUNS) => {
  const failures: string[] = [];
  for (let seed = 1; seed <= runs; seed += 1) {
    const failure = check(seed);
    if (failure) failures.push(`seed ${seed}: ${failure}`);
  }
  return failures;
};

describe('physics properties over random inputs', () => {
  it('unitary circuits preserve normalization', () => {
    expect(collect((seed) => {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 5, maxDepth: 40 });
      const { state } = runCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const norm = normSquared(state);
      return Math.abs(norm - 1) < 1e-10 ? undefined : `‖ψ‖² = ${norm}`;
    })).toEqual([]);
  });

  it('every unitary circuit is undone by its inverse (U†U = I on the state)', () => {
    expect(collect((seed) => {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 4, maxDepth: 25 });
      const inverse = circuit.gates.slice().reverse().map(invertCircuitGate)
        .map((gate, index) => ({ ...gate, id: `inv${index}`, step: circuit.gates.length + index }));
      const start = runCircuit(circuit.qubitCount, [], circuit.startStates).state;
      const roundTrip = runCircuit(circuit.qubitCount, [...circuit.gates, ...inverse], circuit.startStates).state;
      const error = roundTrip.reduce((worst, value, index) => Math.max(worst, Math.hypot(value.re - start[index].re, value.im - start[index].im)), 0);
      return error < 1e-9 ? undefined : `round-trip error ${error}`;
    })).toEqual([]);
  });

  it('Kraus channels preserve trace, Hermiticity, and positivity', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const qubitCount = 1 + Math.floor(random() * 3);
      const start = random() < 0.5 ? randomMixedState(random, qubitCount) : physics.toDensityMatrix(randomPureState(random, qubitCount));
      const qubits = [Math.floor(random() * qubitCount)];
      const after = physics.applyChannel(start, randomChannel(random), qubits);
      try {
        physics.validateState(after, { fullPositivity: true });
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    })).toEqual([]);
  });

  it('channels keep register purity within [1/d, 1]', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const state = randomPureState(random, 2);
      const noisy = physics.applyChannel(state, randomChannel(random), [Math.floor(random() * 2)]);
      const purity = physics.inspectGlobal(noisy).purity;
      return purity <= 1 + 1e-12 && purity >= 0.25 - 1e-12 ? undefined : `purity ${purity}`;
    })).toEqual([]);
  });

  it('density-matrix execution equals |ψ⟩⟨ψ| of state-vector execution', () => {
    expect(collect((seed) => {
      const circuit = randomCircuit(seededRandom(seed), { maxQubits: 3, maxDepth: 15 });
      const pure = executeCircuit(circuit.qubitCount, circuit.gates, circuit.startStates);
      const mixed = executeCircuit(circuit.qubitCount, circuit.gates, circuit.startStates, undefined, { representation: 'densityMatrix' });
      const fidelity = physics.fidelity(mixed.state, pure.state);
      return Math.abs(fidelity - 1) < 1e-9 ? undefined : `fidelity ${fidelity}`;
    }, 60)).toEqual([]);
  });

  it('measurement probabilities sum to 1 in every basis, and collapse stays normalized', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const qubitCount = 1 + Math.floor(random() * 3);
      const state = random() < 0.5 ? randomPureState(random, qubitCount) : randomMixedState(random, qubitCount);
      const qubit = Math.floor(random() * qubitCount);
      for (const basis of ['X', 'Y', 'Z'] as MeasurementBasis[]) {
        const [p0, p1] = physics.measurementDiagnostics(state, qubit, basis).probabilities;
        if (Math.abs(p0 + p1 - 1) > 1e-12 || p0 < -1e-12 || p1 < -1e-12) return `${basis}: ${p0} + ${p1}`;
        const collapsed = physics.measure(state, qubit, basis, random());
        const norm = physics.inspectGlobal(collapsed.state).normalization;
        if (Math.abs(norm - 1) > 1e-9) return `${basis} collapse norm ${norm}`;
        if (Math.abs(physics.measurementDiagnostics(collapsed.state, qubit, basis).probabilities[collapsed.outcome] - 1) > 1e-9) {
          return `${basis} collapse is not the observed eigenstate`;
        }
      }
      return undefined;
    })).toEqual([]);
  });

  it('reduced states are valid density matrices with purity in [1/d, 1]', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const qubitCount = 2 + Math.floor(random() * 3);
      const state = random() < 0.5 ? randomPureState(random, qubitCount) : randomMixedState(random, Math.min(qubitCount, 3));
      const size = 1 + Math.floor(random() * (state.qubitCount - 1));
      const subsystem = Array.from({ length: state.qubitCount }, (_, qubit) => qubit).sort(() => random() - 0.5).slice(0, size);
      const reduced = physics.reducedState(state, subsystem);
      const purity = physics.purity(reduced);
      return purity >= 1 / 2 ** size - 1e-9 && purity <= 1 + 1e-9 ? undefined : `purity ${purity} for ${subsystem}`;
    })).toEqual([]);
  });

  it('pure-state entanglement assessment agrees with entanglement entropy', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const state = randomPureState(random, 3);
      const subsystem = [Math.floor(random() * 3)];
      const entropy = physics.entanglementEntropy(state, subsystem);
      const assessment = physics.assessEntanglement(state, subsystem);
      const expected = entropy > 1e-6 ? 'entangled' : 'separable';
      return assessment.status === expected && assessment.conclusive ? undefined : `S = ${entropy} but ${assessment.status}`;
    })).toEqual([]);
  });

  it('Hamiltonian evolution is unitary for random Hermitian generators', () => {
    expect(collect((seed) => {
      const random = seededRandom(seed);
      const size = 2 ** (1 + Math.floor(random() * 2));
      const raw = Array.from({ length: size }, () => Array.from({ length: size }, () => complex(random() - 0.5, random() - 0.5)));
      const hermitian = raw.map((row, i) => row.map((value, j) => complex((value.re + raw[j][i].re) / 2, (value.im - raw[j][i].im) / 2)));
      const targets = size === 2 ? [0] : [0, 1];
      const evolved = physics.evolve(randomPureState(random, 2), { matrix: hermitian, targets }, random() * 5);
      const norm = physics.inspectGlobal(evolved).normalization;
      return Math.abs(norm - 1) < 1e-9 ? undefined : `norm ${norm}`;
    }, 60)).toEqual([]);
  });
});
