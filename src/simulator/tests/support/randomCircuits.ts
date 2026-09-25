/**
 * Seeded random circuits for property and regression tests. A failing seed is
 * printed by the tests, so any counterexample can be replayed exactly.
 */
import type { CircuitGate, ParticleStartState } from '../../types';

export const seededRandom = (seed: number) => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Random = () => number;

const pick = <T,>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];

const distinctWires = (random: Random, qubitCount: number, count: number) => {
  const wires = Array.from({ length: qubitCount }, (_, qubit) => qubit);
  for (let index = wires.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [wires[index], wires[swap]] = [wires[swap], wires[index]];
  }
  return wires.slice(0, count);
};

const ONE_QUBIT = ['X', 'Y', 'Z', 'H', 'S', 'T', 'NOT'] as const;
const ANGLED = ['PHASE', 'RX', 'RY', 'RZ'] as const;
const CONTROLLED = ['CNOT', 'CZ', 'CY', 'CPHASE'] as const;
const TWO_CONTROL = ['CCNOT', 'AND', 'NAND', 'OR', 'XOR'] as const;

export type RandomCircuitOptions = {
  maxQubits?: number;
  maxDepth?: number;
  /** Include MEASURE (and measurement-conditioned gates). */
  measurements?: boolean;
};

export type RandomCircuit = {
  qubitCount: number;
  gates: CircuitGate[];
  startStates: ParticleStartState[];
};

/** Unitary gate mix over every preconfigured family, with optional MEASURE and -IF feed-forward. */
export const randomCircuit = (random: Random, options: RandomCircuitOptions = {}): RandomCircuit => {
  const qubitCount = 1 + Math.floor(random() * (options.maxQubits ?? 4));
  const depth = 1 + Math.floor(random() * (options.maxDepth ?? 20));
  const startStates = Array.from({ length: qubitCount }, () => pick(random, ['0p', '1p', 'sp'] as const));
  const measured = new Set<number>();
  const gates: CircuitGate[] = [];

  for (let step = 0; step < depth; step += 1) {
    const roll = random();
    const id = `g${step}`;
    let gate: CircuitGate;
    if (options.measurements && roll < 0.1) {
      const target = Math.floor(random() * qubitCount);
      measured.add(target);
      gate = { id, type: 'MEASURE', step, targets: [target], controls: [] };
    } else if (roll < 0.4 || qubitCount === 1) {
      const type = pick(random, [...ONE_QUBIT, ...ANGLED, 'S', 'T']);
      const target = Math.floor(random() * qubitCount);
      const inverse = (type === 'S' || type === 'T') && random() < 0.5;
      gate = {
        id,
        type,
        step,
        targets: [target],
        controls: [],
        ...((ANGLED as readonly string[]).includes(type) ? { phase: (random() - 0.5) * 4 * Math.PI } : {}),
        ...(inverse ? { inverse: true } : {}),
      };
    } else if (roll < 0.75 || qubitCount === 2) {
      const [control, target] = distinctWires(random, qubitCount, 2);
      const type = pick(random, [...CONTROLLED, 'SWAP']);
      gate = type === 'SWAP'
        ? { id, type, step, targets: [control, target], controls: [] }
        : {
          id,
          type,
          step,
          targets: [target],
          controls: [control],
          ...(type === 'CPHASE' ? { phase: (random() - 0.5) * 4 * Math.PI } : {}),
        };
    } else {
      const [a, b, target] = distinctWires(random, qubitCount, 3);
      gate = { id, type: pick(random, TWO_CONTROL), step, targets: [target], controls: [a, b] };
    }
    // Feed-forward only on bits that are already measured, as the language requires.
    if (options.measurements && measured.size > 0 && gate.type !== 'MEASURE' && random() < 0.2) {
      gate = { ...gate, condition: { qubit: pick(random, [...measured]), equals: random() < 0.5 ? 0 : 1 } };
    }
    gates.push(gate);
  }
  return { qubitCount, gates, startStates };
};
