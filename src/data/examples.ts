/**
 * Small starter circuits for the visual builder.
 *
 * Examples are kept separate from bundled process files because they exercise
 * the drag-and-drop canvas directly instead of the `.qpucir` process catalog.
 * They are ordered by the six-step learning path in the Getting Started guide,
 * and `step` matches that guide's step numbers.
 */
import { CircuitGate } from '../simulator/types';

const gate = (
  id: string,
  type: CircuitGate['type'],
  step: number,
  targets: number[],
  controls: number[] = [],
  extras: Partial<CircuitGate> = {},
): CircuitGate => ({
  id,
  type,
  step,
  targets,
  controls,
  ...extras,
});

const cycle = (id: string, step: number, cycleNumber: number): CircuitGate => ({
  id,
  type: 'CYCLE',
  step,
  targets: [],
  controls: [],
  cycle: cycleNumber,
  source: 'INCREASECYCLE',
});

export const learningSteps = [
  'Single qubit',
  'Controlled gates',
  'Reversible logic',
  'Entanglement',
  'Arithmetic',
  'Multi-stage',
] as const;

export type ExampleCircuit = {
  name: string;
  description: string;
  step: 1 | 2 | 3 | 4 | 5 | 6;
  qubitCount: number;
  gates: CircuitGate[];
};

export const examples: ExampleCircuit[] = [
  {
    name: 'Superposition coin',
    description: 'H puts q0 into an equal superposition; M then reads 0 or 1 at random. Use Reset state and Run all to sample again.',
    step: 1,
    qubitCount: 1,
    gates: [gate('coin-h', 'H', 0, [0]), gate('coin-m', 'MEASURE', 1, [0])],
  },
  {
    name: 'Phase interference (H-Z-H)',
    description: 'Z changes only the phase, yet the second H turns that phase into a certain 1.',
    step: 1,
    qubitCount: 1,
    gates: [gate('hzh-h1', 'H', 0, [0]), gate('hzh-z', 'Z', 1, [0]), gate('hzh-h2', 'H', 2, [0]), gate('hzh-m', 'MEASURE', 3, [0])],
  },
  {
    name: 'CNOT demo',
    description: 'Flip q0, then use it as a control to toggle q1.',
    step: 2,
    qubitCount: 3,
    gates: [gate('cnot-x', 'X', 0, [0]), gate('cnot-gate', 'CNOT', 1, [1], [0]), gate('cnot-m0', 'MEASURE', 2, [0]), gate('cnot-m1', 'MEASURE', 3, [1])],
  },
  {
    name: 'CCNOT demo',
    description: 'Prepare q0 and q1 as 1, then Toffoli flips q2.',
    step: 3,
    qubitCount: 3,
    gates: [gate('ccnot-x0', 'X', 0, [0]), gate('ccnot-x1', 'X', 1, [1]), gate('ccnot-gate', 'CCNOT', 2, [2], [0, 1]), gate('ccnot-m2', 'MEASURE', 3, [2])],
  },
  {
    name: 'Half adder',
    description: 'q0 = A, q1 = B. AND writes Carry on q2 and XOR writes Sum on q3; A and B are left unchanged. Change q0 start and q1 start to try every input.',
    step: 3,
    qubitCount: 4,
    gates: [
      gate('half-and', 'AND', 0, [2], [0, 1]),
      gate('half-xor', 'XOR', 1, [3], [0, 1]),
      gate('half-m2', 'MEASURE', 2, [2]),
      gate('half-m3', 'MEASURE', 3, [3]),
    ],
  },
  {
    name: 'Bell state',
    description: 'Entangle q0 and q1 with H + CNOT, then measure both qubits. Watch purity drop and “Entangled with register” appear before measurement.',
    step: 4,
    qubitCount: 3,
    gates: [gate('bell-h', 'H', 0, [0]), gate('bell-cnot', 'CNOT', 1, [1], [0]), gate('bell-m0', 'MEASURE', 2, [0]), gate('bell-m1', 'MEASURE', 3, [1])],
  },
  {
    name: 'GHZ state',
    description: 'H on q0 then CNOT chain q0→q1→q2 prepares (|000⟩+|111⟩)/√2. A three-qubit follow-up to Bell.',
    step: 4,
    qubitCount: 3,
    gates: [
      gate('ghz-h', 'H', 0, [0]),
      gate('ghz-cnot1', 'CNOT', 1, [1], [0]),
      gate('ghz-cnot2', 'CNOT', 2, [2], [1]),
      gate('ghz-m0', 'MEASURE', 3, [0]),
      gate('ghz-m1', 'MEASURE', 4, [1]),
      gate('ghz-m2', 'MEASURE', 5, [2]),
    ],
  },
  {
    name: 'Phase kickback',
    description: 'q1 is prepared as |−⟩. The CNOT never flips q0, but its phase kicks back so q0 always measures 1.',
    step: 4,
    qubitCount: 2,
    gates: [
      gate('kick-x', 'X', 0, [1]),
      gate('kick-h0', 'H', 1, [0]),
      gate('kick-h1', 'H', 2, [1]),
      gate('kick-cnot', 'CNOT', 3, [1], [0]),
      gate('kick-h0b', 'H', 4, [0]),
      gate('kick-m', 'MEASURE', 5, [0]),
    ],
  },
  {
    name: 'Superdense coding',
    description: 'Share a Bell pair, encode two classical bits on Alice’s qubit with X/Z, then Bob decodes with CNOT+H. Try changing q0 start (message bit 0) and q1 start (message bit 1) before the shared entanglement step — here they are prepared after the Bell pair as Alice’s encoding.',
    step: 4,
    qubitCount: 2,
    gates: [
      gate('sd-h', 'H', 0, [0]),
      gate('sd-cnot', 'CNOT', 1, [1], [0]),
      gate('sd-x', 'X', 2, [0]),
      gate('sd-z', 'Z', 3, [0]),
      gate('sd-cnot2', 'CNOT', 4, [1], [0]),
      gate('sd-h2', 'H', 5, [0]),
      gate('sd-m0', 'MEASURE', 6, [0]),
      gate('sd-m1', 'MEASURE', 7, [1]),
    ],
  },
  {
    name: 'Deutsch–Jozsa (balanced oracle)',
    description: 'Constant-vs-balanced demo: oracle is CNOT (balanced). After interference q0 measures 1, showing the function is balanced in one query.',
    step: 4,
    qubitCount: 2,
    gates: [
      gate('dj-x', 'X', 0, [1]),
      gate('dj-h0', 'H', 1, [0]),
      gate('dj-h1', 'H', 2, [1]),
      gate('dj-oracle', 'CNOT', 3, [1], [0]),
      gate('dj-h0b', 'H', 4, [0]),
      gate('dj-m', 'MEASURE', 5, [0]),
    ],
  },
  {
    name: 'Parity check',
    description: 'Three CNOTs add q0, q1, and q2 into q3 modulo 2: q3 is 1 when an odd number of inputs are 1.',
    step: 5,
    qubitCount: 4,
    gates: [
      gate('parity-0', 'CNOT', 0, [3], [0]),
      gate('parity-1', 'CNOT', 1, [3], [1]),
      gate('parity-2', 'CNOT', 2, [3], [2]),
      gate('parity-m', 'MEASURE', 3, [3]),
    ],
  },
  {
    name: 'Two-qubit QFT',
    description: 'H, CPHASE(π/2), then SWAP. Uses the new controlled-phase gate; a first look at Fourier-style circuits.',
    step: 5,
    qubitCount: 2,
    gates: [
      gate('qft-h0', 'H', 0, [0]),
      gate('qft-cp', 'CPHASE', 1, [1], [0], { phase: Math.PI / 2 }),
      gate('qft-h1', 'H', 2, [1]),
      gate('qft-swap', 'SWAP', 3, [0, 1]),
      gate('qft-m0', 'MEASURE', 4, [0]),
      gate('qft-m1', 'MEASURE', 5, [1]),
    ],
  },
  {
    name: 'Grover search (2 qubits)',
    description: 'Superpose, mark 11 with CZ, then reflect about the average. One round finds 11 with certainty.',
    step: 6,
    qubitCount: 2,
    gates: [
      gate('grover-h0', 'H', 0, [0]),
      gate('grover-h1', 'H', 1, [1]),
      gate('grover-oracle', 'CZ', 2, [1], [0]),
      gate('grover-h0b', 'H', 3, [0]),
      gate('grover-h1b', 'H', 4, [1]),
      gate('grover-x0', 'X', 5, [0]),
      gate('grover-x1', 'X', 6, [1]),
      gate('grover-cz', 'CZ', 7, [1], [0]),
      gate('grover-x0b', 'X', 8, [0]),
      gate('grover-x1b', 'X', 9, [1]),
      gate('grover-h0c', 'H', 10, [0]),
      gate('grover-h1c', 'H', 11, [1]),
      gate('grover-m0', 'MEASURE', 12, [0]),
      gate('grover-m1', 'MEASURE', 13, [1]),
    ],
  },
  {
    name: 'T state transition across cycles',
    description:
      'An unrolled sequential-state example. q0 = T controls whether q1 = Q toggles at each logical cycle boundary. INCREASECYCLE advances the stage; nothing loops backward. Try T = 0 and T = 1.',
    step: 6,
    qubitCount: 2,
    gates: [
      gate('tff-0', 'CNOT', 0, [1], [0]),
      cycle('tff-cycle-1', 1, 1),
      gate('tff-1', 'CNOT', 2, [1], [0]),
      cycle('tff-cycle-2', 3, 2),
      gate('tff-2', 'CNOT', 4, [1], [0]),
      gate('tff-measure', 'MEASURE', 5, [1]),
    ],
  },
  {
    name: 'Quantum teleportation',
    description:
      'Alice and Bob share a Bell pair. Alice measures her message and half of the pair, then Bob applies X/Z conditioned on those classical bits (-IF). Forward-only feed-forward; no loops.',
    step: 6,
    qubitCount: 3,
    gates: [
      gate('tp-h', 'H', 0, [1]),
      gate('tp-cnot', 'CNOT', 1, [2], [1]),
      gate('tp-cnot2', 'CNOT', 2, [1], [0]),
      gate('tp-h2', 'H', 3, [0]),
      gate('tp-m0', 'MEASURE', 4, [0]),
      gate('tp-m1', 'MEASURE', 5, [1]),
      gate('tp-x', 'X', 6, [2], [], { condition: { qubit: 1, equals: 1 } }),
      gate('tp-z', 'Z', 7, [2], [], { condition: { qubit: 0, equals: 1 } }),
      gate('tp-m2', 'MEASURE', 8, [2]),
    ],
  },
];
