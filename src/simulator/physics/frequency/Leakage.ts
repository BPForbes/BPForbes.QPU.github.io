/**
 * Leakage out of the computational subspace. A transmon is an anharmonic
 * oscillator, not a two-level system: its levels are
 *   E_n = (n − ½)ω₀₁ + (α/2)·n(n − 1)   (ħ = 1, E₀ = −ω₀₁/2 as in H₀ = −(ω₀₁/2)Z),
 * so f₁₂ = f₀₁ + α/2π with α < 0. A drive couples neighbouring levels through
 * a + a† with matrix elements √n, so a pulse resonant with 0↔1 is only
 * |α|-detuned from 1↔2. Short (spectrally wide) pulses therefore push
 * population into |2⟩, and the virtual 1↔2 coupling also shifts the phase of |1⟩.
 *
 * A driven wire whose profile sets `anharmonicity` is integrated in this
 * d-level space. The qubit register then receives the exact channel
 *   K₀ = P U P  (the computational block, including leakage-induced phase error),
 *   L_n = |1⟩⟨n|U P  for each leaked level n ≥ 2,
 * which is trace preserving because U is unitary. Returning leaked population to |1⟩
 * is the model's approximation: in a transmon |2⟩ decays to |1⟩ (at about twice the
 * 1→0 rate) and dispersive readout usually assigns |2⟩ the outcome 1. Leaked
 * population is not kept outside the register between operations.
 */
import { complex, type Complex, ZERO } from '../../complex';
import { MAX_PROPAGATOR_STEPS, timeDependentPropagator } from '../dynamics/Hamiltonian';
import { envelopeAt, validatePulse, type ControlPulse } from './Pulses';
import { frameFrequency, type PhysicalFrame, type QubitPhysicsProfile, validateProfile } from './QubitProfile';
import { angularFrequency } from './Units';

/** Levels simulated for an anharmonic wire: |0⟩, |1⟩, and the leakage level |2⟩. */
export const TRANSMON_LEVELS = 3;

const STEPS_PER_PERIOD = 100;

export type LeakageChannel = {
  /** Kraus operators on the qubit: the computational block, then one per leaked level. */
  kraus: Complex[][][];
  /** Population leaving the computational subspace from |0⟩ and from |1⟩. */
  leakageFrom: [number, number];
};

const ladderDrives = (levels: number) => {
  const x = Array.from({ length: levels }, () => Array.from({ length: levels }, () => ZERO));
  const y = Array.from({ length: levels }, () => Array.from({ length: levels }, () => ZERO));
  for (let n = 1; n < levels; n += 1) {
    const root = Math.sqrt(n);
    // a + a† and i(a† − a); both reduce to X and Y on the qubit levels.
    x[n - 1][n] = complex(root);
    x[n][n - 1] = complex(root);
    y[n - 1][n] = complex(0, -root);
    y[n][n - 1] = complex(0, root);
  }
  return { x, y };
};

// Level energies in a frame: the frame removes (n − ½)ω_ref but never the anharmonicity.
const levelEnergies = (profile: QubitPhysicsProfile, frame: PhysicalFrame, time: number, levels: number) => {
  const omega = angularFrequency(frameFrequency(profile, frame, time));
  const alpha = angularFrequency(profile.anharmonicity ?? 0);
  return Array.from({ length: levels }, (_, n) => (n - 0.5) * omega + (alpha * n * (n - 1)) / 2);
};

// Diagonal of the rotating-frame Hamiltonian H_R = Σ (n − ½)ω_ref |n⟩⟨n|.
const frameDiagonal = (reference: number, levels: number) =>
  Array.from({ length: levels }, (_, n) => (n - 0.5) * angularFrequency(reference));

const rotate = (value: Complex, angle: number) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return complex(value.re * c - value.im * s, value.re * s + value.im * c);
};

export type TransmonEvolutionOptions = {
  frame?: PhysicalFrame;
  approximation?: 'rwa' | 'exact';
  maxStep?: number;
  levels?: number;
};

/**
 * Propagator of one driven anharmonic wire over [start, start + duration], with
 * the pulse starting at `start`. Same frame and drive conventions as the qubit
 * model (PhysicalEvolution.ts); with d = 2 it reproduces that model exactly.
 */
export const transmonPropagator = (
  profile: QubitPhysicsProfile,
  pulse: ControlPulse,
  start: number,
  duration: number,
  { frame = 'rotating', approximation = 'rwa', maxStep, levels = TRANSMON_LEVELS }: TransmonEvolutionOptions = {},
): Complex[][] => {
  validateProfile(profile);
  validatePulse(pulse);
  if (!Number.isInteger(levels) || levels < 2) throw new RangeError(`A transmon needs at least 2 levels (got ${levels}).`);
  const reference = profile.transitionFrequency;
  const integrationFrame: PhysicalFrame = approximation === 'rwa' ? 'rotating' : frame;
  const drives = ladderDrives(levels);
  const refDiagonal = frameDiagonal(reference, levels);

  const at = (time: number): Complex[][] => {
    const energies = levelEnergies(profile, integrationFrame, time, levels);
    const { inPhase, quadrature } = envelopeAt(pulse.envelope, pulse.duration, time - start);
    let xWeight: number;
    let yWeight: number;
    if (approximation === 'rwa') {
      const half = angularFrequency(pulse.amplitude) / 2;
      const theta = pulse.phase - angularFrequency(pulse.carrierFrequency - reference) * time;
      xWeight = half * (inPhase * Math.cos(theta) - quadrature * Math.sin(theta));
      yWeight = half * (inPhase * Math.sin(theta) + quadrature * Math.cos(theta));
    } else {
      const carrier = angularFrequency(pulse.carrierFrequency) * time - pulse.phase;
      xWeight = angularFrequency(pulse.amplitude) * (inPhase * Math.cos(carrier) + quadrature * Math.sin(carrier));
      yWeight = 0;
    }
    return energies.map((energy, j) => energies.map((_, k) => {
      const x = drives.x[j][k];
      const y = drives.y[j][k];
      let value = complex(xWeight * x.re + yWeight * y.re + (j === k ? energy : 0), xWeight * x.im + yWeight * y.im);
      // Exact drive in the rotating frame: conjugate the lab-frame a + a† by e^{iH_R t}.
      if (approximation === 'exact' && integrationFrame === 'rotating' && j !== k) value = rotate(value, (refDiagonal[j] - refDiagonal[k]) * time);
      return value;
    }));
  };

  const fastest = Math.max(
    1e-12,
    Math.abs(frameFrequency(profile, integrationFrame, start)),
    Math.abs(profile.anharmonicity ?? 0),
    pulse.amplitude,
    approximation === 'rwa'
      ? Math.abs(pulse.carrierFrequency - reference)
      : pulse.carrierFrequency + (integrationFrame === 'rotating' ? reference : 0),
  );
  const step = Math.min(1 / (STEPS_PER_PERIOD * fastest), pulse.duration / 100, maxStep ?? Number.POSITIVE_INFINITY, duration);
  if (Math.ceil(duration / step) > MAX_PROPAGATOR_STEPS) {
    throw new RangeError(
      `Exact ${integrationFrame}-frame transmon evolution over ${duration} time units needs more than ${MAX_PROPAGATOR_STEPS} steps; use approximation 'rwa'.`,
    );
  }
  let unitary = timeDependentPropagator({ kind: 'timeDependent', targets: [pulse.target], at, maxStep: step, dimension: levels }, start, duration);
  if (approximation === 'rwa' && frame === 'lab') {
    // U_lab = R(t₁)† U_rot R(t₀) with R(t) = e^{iH_R t} diagonal.
    const end = start + duration;
    unitary = unitary.map((row, j) => row.map((value, k) => rotate(value, -refDiagonal[j] * end + refDiagonal[k] * start)));
  }
  return unitary;
};

/** The qubit channel of a d-level propagator (see the module comment). */
export const leakageChannel = (unitary: Complex[][]): LeakageChannel => {
  const block = [0, 1].map((row) => [unitary[row][0], unitary[row][1]]);
  const leaked = unitary.slice(2).map((row) => [[ZERO, ZERO], [row[0], row[1]]]);
  const leakageFrom = [0, 1].map((column) => unitary.slice(2).reduce((sum, row) => sum + row[column].re ** 2 + row[column].im ** 2, 0));
  return { kraus: [block, ...leaked], leakageFrom: leakageFrom as [number, number] };
};

export type LeakageDiagnostics = {
  levels: number;
  /** f₁₂ = f₀₁ + α/2π at the pulse start. */
  transitionFrequency12: number;
  /** Population in levels ≥ 2 after the pulse, starting from |0⟩ and from |1⟩. */
  leakageFrom0: number;
  leakageFrom1: number;
  /** Leakage averaged over computational input states: (L₀ + L₁)/2. */
  averageLeakage: number;
  /**
   * DRAG coefficient that cancels leakage to first order in this module's
   * convention (quadrature −β·dε_I/dt): β = 1/α with α in angular units
   * (negative for a transmon).
   */
  leakageDragBeta: number;
};

export const leakageDiagnostics = (
  profile: QubitPhysicsProfile,
  pulse: ControlPulse,
  options: TransmonEvolutionOptions = {},
): LeakageDiagnostics => {
  if (profile.anharmonicity === undefined) throw new RangeError('Leakage needs a profile with anharmonicity.');
  const levels = options.levels ?? TRANSMON_LEVELS;
  const { leakageFrom: [from0, from1] } = leakageChannel(transmonPropagator(profile, pulse, 0, pulse.duration, options));
  return {
    levels,
    transitionFrequency12: frameFrequency(profile, 'lab', 0) + profile.anharmonicity,
    leakageFrom0: from0,
    leakageFrom1: from1,
    averageLeakage: (from0 + from1) / 2,
    leakageDragBeta: 1 / angularFrequency(profile.anharmonicity),
  };
};
