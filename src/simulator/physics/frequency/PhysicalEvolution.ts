/**
 * Coherent evolution of a register over one physical time segment:
 * H(t) = Σ_q H₀,q(t) + Σ couplings + Σ drives, in the lab frame or a frame
 * rotating at each qubit's nominal f₀₁, with drives either exact or in the
 * rotating-wave approximation (RWA). The result is a set of propagators on
 * independent wire groups; the PhysicsEngine applies them to the state.
 *
 * Conventions (ħ = 1, frequencies in cycles per time unit, ω = 2πf):
 * - Idle: H₀ = −(ω/2)Z, so |1⟩ is the excited level.
 * - Drive (lab): Ω(t)[ε_I cos(ω_d t − φ) + ε_Q sin(ω_d t − φ)] X.
 * - Drive (rotating frame, RWA): (Ω/2)[ε_I(cos θ X + sin θ Y) + ε_Q(−sin θ X + cos θ Y)],
 *   θ = φ − (ω_d − ω_ref)t; on resonance a pulse of area θ is exactly RX/RY(θ).
 * - ZZ coupling J: (2πJ/4) Z⊗Z, a conditional phase of 2πJ per time unit.
 * - Exchange coupling J: (2πJ/2)(X⊗X + Y⊗Y), which swaps |01⟩ ↔ |10⟩.
 */
import { complex, type Complex, ZERO } from '../../complex';
import { MATRIX_X, MATRIX_Y, MATRIX_Z } from '../../gates/matrices';
import { MAX_PROPAGATOR_STEPS, timeDependentPropagator } from '../dynamics/Hamiltonian';
import { type ComplexMatrix, qubitUnitary, unitaryFromHermitian } from '../numerics/linearAlgebra';
import { leakageChannel, type LeakageChannel, transmonPropagator } from './Leakage';
import { envelopeAt, validatePulse, type ControlPulse } from './Pulses';
import {
  actualTransitionFrequency,
  frameFrequency,
  idlePropagator,
  type PhysicalFrame,
  type QubitPhysicsProfile,
  validateProfile,
} from './QubitProfile';
import { angularFrequency, type PhysicalUnits } from './Units';

export type CouplingKind = 'zz' | 'exchange';

export type QubitCoupling = {
  qubits: [number, number];
  kind: CouplingKind;
  /** Coupling strength J in cycles per time unit. */
  strength: number;
};

export type DriveApproximation = 'rwa' | 'exact';

export type PhysicalSystem = {
  /** Profile per wire; wires without one use `defaultProfile`. */
  profiles?: Record<number, QubitPhysicsProfile>;
  defaultProfile?: QubitPhysicsProfile;
  couplings?: QubitCoupling[];
  /** Frame the state is expressed in (default: rotating at each nominal f₀₁). */
  frame?: PhysicalFrame;
  /** Drive treatment (default: RWA, an explicit approximation). */
  approximation?: DriveApproximation;
  units?: PhysicalUnits;
  /** Upper bound on H(t) steps, in time units. */
  maxStep?: number;
};

export type PhysicalSegment = {
  /** Physical clock time at the start of the segment. */
  start: number;
  duration: number;
  /** Drives that start with the segment. */
  pulses?: ControlPulse[];
};

export type WirePropagator = { wires: number[]; unitary: Complex[][] };
/** A driven anharmonic wire: a qubit channel that includes leakage to |2⟩ (see Leakage.ts). */
export type WireLeakageChannel = { wires: [number]; channel: LeakageChannel };
export type WireEvolution = WirePropagator | WireLeakageChannel;

/** Coupled groups are exponentiated as dense 2^k matrices, so keep them small. */
export const MAX_COUPLED_WIRES = 5;

// Fourth-order Magnus steps per fastest period (global error ~ (ω·dt)⁴). Single-qubit steps use the
// closed-form propagator and are cheap; multi-qubit steps diagonalize a 2^k matrix each time.
const STEPS_PER_PERIOD_SINGLE = 100;
const STEPS_PER_PERIOD_MULTI = 40;

export const profileFor = (system: PhysicalSystem, wire: number): QubitPhysicsProfile => {
  const profile = system.profiles?.[wire] ?? system.defaultProfile;
  if (!profile) throw new RangeError(`No physical profile for q${wire}; set profiles[${wire}] or defaultProfile.`);
  return profile;
};

// Places a local operator acting on `positions` (MSB first) inside a k-wire block.
const embed = (operator: ComplexMatrix, positions: number[], wireCount: number): Complex[][] => {
  const size = 2 ** wireCount;
  const bit = (index: number, position: number) => (index >> (wireCount - position - 1)) & 1;
  const local = (index: number) => positions.reduce((value, position) => (value << 1) | bit(index, position), 0);
  const restMask = positions.reduce((mask, position) => mask & ~(1 << (wireCount - position - 1)), size - 1);
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) =>
    ((row & restMask) === (col & restMask) ? operator[local(row)][local(col)] : ZERO)));
};

const addInto = (target: Complex[][], term: ComplexMatrix, scale = 1) => {
  term.forEach((row, i) => row.forEach((value, j) => {
    target[i][j] = complex(target[i][j].re + scale * value.re, target[i][j].im + scale * value.im);
  }));
};

const scaled = (matrix: ComplexMatrix, scale: number): Complex[][] =>
  matrix.map((row) => row.map((value) => complex(value.re * scale, value.im * scale)));

const kron2 = (a: ComplexMatrix, b: ComplexMatrix): Complex[][] =>
  Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, col) => {
    const x = a[row >> 1][col >> 1];
    const y = b[row & 1][col & 1];
    return complex(x.re * y.re - x.im * y.im, x.re * y.im + x.im * y.re);
  }));

const ZZ = kron2(MATRIX_Z, MATRIX_Z);
const XX_PLUS_YY = (() => {
  const sum = kron2(MATRIX_X, MATRIX_X);
  addInto(sum, kron2(MATRIX_Y, MATRIX_Y));
  return sum;
})();

const couplingOperator = (coupling: QubitCoupling): Complex[][] => (coupling.kind === 'zz'
  ? scaled(ZZ, angularFrequency(coupling.strength) / 4)
  : scaled(XX_PLUS_YY, angularFrequency(coupling.strength) / 2));

/**
 * Rotating-frame conjugation for a diagonal frame Hamiltonian H_R:
 * (e^{iH_R t} H e^{−iH_R t})_jk = H_jk e^{i(r_j − r_k)t}.
 */
const conjugateByFrame = (matrix: ComplexMatrix, frameDiagonal: number[], time: number): Complex[][] =>
  matrix.map((row, j) => row.map((value, k) => {
    const angle = (frameDiagonal[j] - frameDiagonal[k]) * time;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return complex(value.re * c - value.im * s, value.re * s + value.im * c);
  }));

// Diagonal of H_R = Σ −(ω_ref/2) Z over the block's wires.
const frameDiagonal = (references: number[]) => {
  const count = references.length;
  return Array.from({ length: 2 ** count }, (_, index) => references.reduce((sum, reference, position) => {
    const excited = (index >> (count - position - 1)) & 1;
    return sum + (excited ? 1 : -1) * (angularFrequency(reference) / 2);
  }, 0));
};

const rwaDrive = (pulse: ControlPulse, reference: number, pulseStart: number, time: number): Complex[][] => {
  const { inPhase, quadrature } = envelopeAt(pulse.envelope, pulse.duration, time - pulseStart);
  const half = angularFrequency(pulse.amplitude) / 2;
  const theta = pulse.phase - angularFrequency(pulse.carrierFrequency - reference) * time;
  const xWeight = half * (inPhase * Math.cos(theta) - quadrature * Math.sin(theta));
  const yWeight = half * (inPhase * Math.sin(theta) + quadrature * Math.cos(theta));
  const result = scaled(MATRIX_X, xWeight);
  addInto(result, MATRIX_Y, yWeight);
  return result;
};

// Lab-frame drive; in the rotating frame X becomes cos(ω_ref t)X + sin(ω_ref t)Y.
const exactDrive = (pulse: ControlPulse, frame: PhysicalFrame, reference: number, pulseStart: number, time: number): Complex[][] => {
  const { inPhase, quadrature } = envelopeAt(pulse.envelope, pulse.duration, time - pulseStart);
  const carrier = angularFrequency(pulse.carrierFrequency) * time - pulse.phase;
  const strength = angularFrequency(pulse.amplitude) * (inPhase * Math.cos(carrier) + quadrature * Math.sin(carrier));
  if (frame === 'lab') return scaled(MATRIX_X, strength);
  const frameAngle = angularFrequency(reference) * time;
  const result = scaled(MATRIX_X, strength * Math.cos(frameAngle));
  addInto(result, MATRIX_Y, strength * Math.sin(frameAngle));
  return result;
};

type Block = { wires: number[]; couplings: QubitCoupling[]; pulses: ControlPulse[] };

// Wires joined by couplings (or carrying drives) evolve together; everything else idles independently.
const buildBlocks = (system: PhysicalSystem, qubitCount: number, pulses: ControlPulse[]): Block[] => {
  const parent = Array.from({ length: qubitCount }, (_, wire) => wire);
  const find = (wire: number): number => (parent[wire] === wire ? wire : (parent[wire] = find(parent[wire])));
  const couplings = (system.couplings ?? []).filter(({ qubits: [a, b] }) => a < qubitCount && b < qubitCount);
  couplings.forEach(({ qubits: [a, b] }) => {
    parent[find(a)] = find(b);
  });
  const groups = new Map<number, number[]>();
  Array.from({ length: qubitCount }, (_, wire) => wire).forEach((wire) => {
    const root = find(wire);
    groups.set(root, [...(groups.get(root) ?? []), wire]);
  });
  return [...groups.values()].map((wires) => ({
    wires,
    couplings: couplings.filter(({ qubits: [a] }) => wires.includes(a)),
    pulses: pulses.filter((pulse) => wires.includes(pulse.target)),
  }));
};

const validateSystem = (system: PhysicalSystem, qubitCount: number, segment: PhysicalSegment) => {
  if (!(segment.duration >= 0) || !Number.isFinite(segment.duration)) throw new RangeError(`Segment duration must be non-negative (got ${segment.duration}).`);
  Array.from({ length: qubitCount }, (_, wire) => validateProfile(profileFor(system, wire)));
  (segment.pulses ?? []).forEach((pulse) => {
    validatePulse(pulse);
    if (pulse.target < 0 || pulse.target >= qubitCount) throw new RangeError(`Pulse targets q${pulse.target}, outside the register.`);
  });
  (system.couplings ?? []).forEach((coupling) => {
    if (coupling.qubits[0] === coupling.qubits[1]) throw new RangeError('A coupling needs two different qubits.');
    if (!Number.isFinite(coupling.strength)) throw new RangeError(`Invalid coupling strength ${coupling.strength}.`);
  });
};

/**
 * Propagators for every wire over one segment. Idle, uncoupled, undriven
 * wires get their exact phase; groups with couplings or drives are integrated
 * (exactly when H is constant, otherwise with piecewise-constant steps).
 * A driven wire with an anharmonicity is integrated with its |2⟩ level and
 * returns a leakage channel instead of a unitary.
 */
export const segmentPropagators = (system: PhysicalSystem, qubitCount: number, segment: PhysicalSegment): WireEvolution[] => {
  validateSystem(system, qubitCount, segment);
  const frame = system.frame ?? 'rotating';
  const approximation = system.approximation ?? 'rwa';
  const { start, duration } = segment;
  const pulses = segment.pulses ?? [];
  if (duration === 0) return [];

  return buildBlocks(system, qubitCount, pulses).flatMap<WireEvolution>((block) => {
    if (block.couplings.length === 0 && block.pulses.length === 0) {
      return block.wires.map((wire) => ({ wires: [wire], unitary: idlePropagator(profileFor(system, wire), frame, start, duration) }));
    }
    const leaky = block.pulses.filter((pulse) => profileFor(system, pulse.target).anharmonicity !== undefined);
    if (leaky.length > 0) {
      if (block.wires.length > 1 || block.pulses.length > 1) {
        throw new RangeError(`Leakage is modelled for one drive on an uncoupled wire; q${leaky[0].target} is coupled or driven twice.`);
      }
      const unitary = transmonPropagator(profileFor(system, leaky[0].target), leaky[0], start, duration, {
        frame,
        approximation,
        maxStep: system.maxStep,
      });
      return [{ wires: [leaky[0].target], channel: leakageChannel(unitary) }];
    }
    if (block.wires.length > MAX_COUPLED_WIRES) {
      throw new RangeError(`A coupled group of ${block.wires.length} qubits exceeds the ${MAX_COUPLED_WIRES}-qubit limit.`);
    }
    const profiles = block.wires.map((wire) => profileFor(system, wire));
    const references = profiles.map((profile) => profile.transitionFrequency);
    const count = block.wires.length;
    const position = (wire: number) => block.wires.indexOf(wire);
    const frameDiag = frameDiagonal(references);
    // RWA is defined in the rotating frame; a lab-frame run converts at the segment edges.
    const integrationFrame: PhysicalFrame = approximation === 'rwa' ? 'rotating' : frame;
    const hasDrift = profiles.some((profile) => (profile.frequencyDriftRate ?? 0) !== 0);
    const exchangeDependsOnTime = integrationFrame === 'rotating'
      && block.couplings.some(({ kind, qubits: [a, b] }) => kind === 'exchange'
        && profileFor(system, a).transitionFrequency !== profileFor(system, b).transitionFrequency);

    const hamiltonianAt = (time: number): Complex[][] => {
      const total = Array.from({ length: 2 ** count }, () => Array.from({ length: 2 ** count }, () => ZERO));
      profiles.forEach((profile, index) => {
        const half = angularFrequency(frameFrequency(profile, integrationFrame, time)) / 2;
        addInto(total, embed(scaled(MATRIX_Z, -half), [index], count));
      });
      block.couplings.forEach((coupling) => {
        const local = embed(couplingOperator(coupling), coupling.qubits.map(position), count);
        addInto(total, integrationFrame === 'rotating' ? conjugateByFrame(local, frameDiag, time) : local);
      });
      block.pulses.forEach((pulse) => {
        const index = position(pulse.target);
        const drive = approximation === 'rwa'
          ? rwaDrive(pulse, references[index], start, time)
          : exactDrive(pulse, integrationFrame, references[index], start, time);
        addInto(total, embed(drive, [index], count));
      });
      return total;
    };

    let unitary: Complex[][];
    if (block.pulses.length === 0 && !hasDrift && !exchangeDependsOnTime) {
      const constant = hamiltonianAt(start);
      unitary = count === 1 ? qubitUnitary(constant, duration) : unitaryFromHermitian(constant, duration);
    } else {
      const fastest = Math.max(
        1e-12,
        ...profiles.map((profile) => Math.abs(frameFrequency(profile, integrationFrame, start))),
        ...block.pulses.map((pulse) => pulse.amplitude),
        ...block.pulses.map((pulse) => (approximation === 'rwa'
          ? Math.abs(pulse.carrierFrequency - references[position(pulse.target)])
          : pulse.carrierFrequency + (integrationFrame === 'rotating' ? references[position(pulse.target)] : 0))),
        ...block.couplings.map((coupling) => Math.abs(coupling.strength)),
        ...(exchangeDependsOnTime ? references.flatMap((a) => references.map((b) => Math.abs(a - b))) : []),
      );
      // Shaped envelopes also need enough samples across the pulse itself.
      const envelopeStep = Math.min(...block.pulses.map((pulse) => pulse.duration / 100), Number.POSITIVE_INFINITY);
      const perPeriod = count === 1 ? STEPS_PER_PERIOD_SINGLE : STEPS_PER_PERIOD_MULTI;
      const maxStep = Math.min(1 / (perPeriod * fastest), envelopeStep, system.maxStep ?? Number.POSITIVE_INFINITY, duration);
      if (Math.ceil(duration / maxStep) > MAX_PROPAGATOR_STEPS) {
        throw new RangeError(
          `Exact ${integrationFrame}-frame evolution over ${duration} time units needs more than ${MAX_PROPAGATOR_STEPS} steps; use approximation 'rwa'.`,
        );
      }
      unitary = timeDependentPropagator({ kind: 'timeDependent', targets: block.wires, at: hamiltonianAt, maxStep }, start, duration);
    }

    if (approximation === 'rwa' && frame === 'lab') {
      // U_lab = R(t₁)† U_rot R(t₀) with R(t) = e^{iH_R t} diagonal.
      const end = start + duration;
      unitary = unitary.map((row, j) => row.map((value, k) => {
        const angle = -frameDiag[j] * end + frameDiag[k] * start;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return complex(value.re * c - value.im * s, value.re * s + value.im * c);
      }));
    }
    return [{ wires: block.wires, unitary }];
  });
};

/** Actual transition frequency of every wire at `time` (for inspectors and logs). */
export const transitionFrequencies = (system: PhysicalSystem, qubitCount: number, time = 0) =>
  Array.from({ length: qubitCount }, (_, wire) => actualTransitionFrequency(profileFor(system, wire), time));
