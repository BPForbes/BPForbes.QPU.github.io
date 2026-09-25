/**
 * Physical description of one qubit wire. The transition frequency f₀₁ fixes
 * the idle Hamiltonian H₀ = −(ω₀₁/2)Z (ħ = 1), so |1⟩ lies ħω₀₁ above |0⟩.
 *
 * `transitionFrequency` is the nominal (calibrated) value that drives and the
 * rotating frame use as their reference. The qubit's actual frequency adds a
 * static `frequencyOffset` and a linear `frequencyDriftRate`, which model
 * calibration error and slow drift: both accumulate unwanted phase.
 */
import type { Complex } from '../../complex';
import { complex } from '../../complex';
import { transitionFrequency } from './PlanckEinstein';
import { angularFrequency, fromHertz, type PhysicalUnits, DEFAULT_UNITS } from './Units';

export type QubitPhysicsProfile = {
  /** Nominal f₀₁ in cycles per time unit (GHz with the default ns unit). */
  transitionFrequency: number;
  /** Actual f₀₁ − nominal f₀₁ at t = 0 (calibration error). */
  frequencyOffset?: number;
  /** d(offset)/dt, in cycles per time unit per time unit. */
  frequencyDriftRate?: number;
  /** Energy relaxation time, in time units. */
  t1?: number;
  /** Coherence time, in time units (T2 ≤ 2·T1). */
  t2?: number;
  /** Bath temperature in kelvin; adds thermal excitation to T1 relaxation. */
  temperature?: number;
  /**
   * Anharmonicity α/2π = f₁₂ − f₀₁ in cycles per time unit (transmons: about −0.2 to −0.35 GHz).
   * When set, drive pulses on this wire see the |2⟩ level and can leak into it (frequency/Leakage.ts).
   */
  anharmonicity?: number;
};

/** Frame the register is represented in: the lab frame, or one rotating at each qubit's nominal f₀₁. */
export type PhysicalFrame = 'lab' | 'rotating';

/** Build a profile from level energies in joules (f₀₁ = (E₁ − E₀)/h). */
export const profileFromEnergies = (
  energy0: number,
  energy1: number,
  units: PhysicalUnits = DEFAULT_UNITS,
  rest: Omit<QubitPhysicsProfile, 'transitionFrequency'> = {},
): QubitPhysicsProfile => ({ ...rest, transitionFrequency: fromHertz(transitionFrequency(energy0, energy1), units) });

export const validateProfile = (profile: QubitPhysicsProfile) => {
  if (!Number.isFinite(profile.transitionFrequency) || profile.transitionFrequency <= 0) {
    throw new RangeError(`Transition frequency must be positive (got ${profile.transitionFrequency}).`);
  }
  if (profile.temperature !== undefined && !(profile.temperature >= 0)) {
    throw new RangeError(`Temperature must be non-negative (got ${profile.temperature}).`);
  }
  if (profile.anharmonicity !== undefined && (!Number.isFinite(profile.anharmonicity) || profile.anharmonicity === 0)) {
    throw new RangeError(`Anharmonicity must be finite and non-zero (got ${profile.anharmonicity}); omit it for an ideal two-level qubit.`);
  }
};

/** Actual f₀₁ at physical time t. */
export const actualTransitionFrequency = (profile: QubitPhysicsProfile, time = 0) =>
  profile.transitionFrequency + (profile.frequencyOffset ?? 0) + (profile.frequencyDriftRate ?? 0) * time;

/** Frequency the idle Hamiltonian uses in a frame: all of f₀₁ in the lab, only the error in the rotating frame. */
export const frameFrequency = (profile: QubitPhysicsProfile, frame: PhysicalFrame, time = 0) =>
  (frame === 'lab' ? actualTransitionFrequency(profile, time) : actualTransitionFrequency(profile, time) - profile.transitionFrequency);

/** ∫ ω(t) dt over [start, start + duration] for the frame frequency (exact for linear drift). */
export const accumulatedPhase = (profile: QubitPhysicsProfile, frame: PhysicalFrame, start: number, duration: number) => {
  const base = frameFrequency(profile, frame, start);
  const drift = profile.frequencyDriftRate ?? 0;
  return angularFrequency(base * duration + (drift * duration * duration) / 2);
};

/** H₀ = −(ω/2)Z at time t in the chosen frame (ħ = 1). */
export const idleHamiltonian = (profile: QubitPhysicsProfile, frame: PhysicalFrame = 'lab', time = 0): Complex[][] => {
  const half = angularFrequency(frameFrequency(profile, frame, time)) / 2;
  return [[complex(-half), complex()], [complex(), complex(half)]];
};

/**
 * Change of the |1⟩-vs-|0⟩ relative phase while idle for `duration`:
 * Δφ = −∫ω dt (the Bloch vector precesses about z at ω₀₁).
 */
export const freePrecessionPhase = (profile: QubitPhysicsProfile, duration: number, frame: PhysicalFrame = 'lab', start = 0) =>
  -accumulatedPhase(profile, frame, start, duration);

/** Exact idle propagator diag(e^{iΦ/2}, e^{−iΦ/2}) with Φ = ∫ω dt. */
export const idlePropagator = (profile: QubitPhysicsProfile, frame: PhysicalFrame, start: number, duration: number): Complex[][] => {
  const phase = accumulatedPhase(profile, frame, start, duration) / 2;
  return [[complex(Math.cos(phase), Math.sin(phase)), complex()], [complex(), complex(Math.cos(phase), -Math.sin(phase))]];
};
