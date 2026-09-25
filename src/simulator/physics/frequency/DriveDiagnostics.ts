/**
 * Resonance diagnostics for a drive on a qubit, from the rotating-wave picture
 * H = (Δ/2)Z + (Ω/2)(cos φ X + sin φ Y) with detuning Δ = ω_d − ω₀₁.
 * Square-pulse formulas are exact in the RWA; shaped pulses report their
 * peak rates and area. These are diagnostics: evolution itself is simulated.
 */
import { actualTransitionFrequency, type QubitPhysicsProfile } from './QubitProfile';
import { envelopeArea, type ControlPulse } from './Pulses';

export type DriveRegime = 'resonant' | 'near-resonant' | 'dispersive';

export type DriveDiagnostics = {
  /** Actual f₀₁ at the pulse start (nominal + offset + drift). */
  transitionFrequency: number;
  /** Carrier frequency f_d. */
  driveFrequency: number;
  /** f_d − f₀₁ in cycles per time unit (Δ/2π). */
  detuning: number;
  /** Peak Rabi frequency Ω/2π. */
  rabiFrequency: number;
  /** √(Ω² + Δ²)/2π: the generalized Rabi frequency at peak amplitude. */
  effectiveRabiFrequency: number;
  pulseDuration: number;
  /** ∫ε_I dt. */
  pulseArea: number;
  /** θ = Ω·∫ε dt: the rotation a resonant pulse of this shape produces. */
  resonantRotationAngle: number;
  /** Rotation axis on the Bloch sphere for a square pulse: (Ω cos φ, Ω sin φ, Δ)/Ω_eff. */
  rotationAxis: { x: number; y: number; z: number };
  /** Largest |1⟩ population reachable from |0⟩: Ω²/(Ω² + Δ²). */
  maxExcitationProbability: number;
  /** |1⟩ population after a square pulse of this duration from |0⟩. */
  squarePulseExcitation: number;
  /** Shift of the qubit frequency, −Ω²/(2Δ) in cycles per time unit, reported in the dispersive regime. */
  acStarkShift?: number;
  regime: DriveRegime;
};

const RESONANCE_TOLERANCE = 1e-9;
// |Δ| ≥ 5Ω is where the second-order (Ω²/2Δ) Stark estimate is within a few percent.
const DISPERSIVE_RATIO = 5;

export const driveDiagnostics = (profile: QubitPhysicsProfile, pulse: ControlPulse, startTime = 0): DriveDiagnostics => {
  const qubitFrequency = actualTransitionFrequency(profile, startTime);
  const detuning = pulse.carrierFrequency - qubitFrequency;
  const rabi = pulse.amplitude;
  const effective = Math.hypot(rabi, detuning);
  const area = envelopeArea(pulse.envelope, pulse.duration);
  const regime: DriveRegime = Math.abs(detuning) <= RESONANCE_TOLERANCE * Math.max(1, qubitFrequency)
    ? 'resonant'
    : Math.abs(detuning) >= DISPERSIVE_RATIO * rabi ? 'dispersive' : 'near-resonant';
  const maxExcitation = effective > 0 ? (rabi * rabi) / (effective * effective) : 0;
  return {
    transitionFrequency: qubitFrequency,
    driveFrequency: pulse.carrierFrequency,
    detuning,
    rabiFrequency: rabi,
    effectiveRabiFrequency: effective,
    pulseDuration: pulse.duration,
    pulseArea: area,
    resonantRotationAngle: 2 * Math.PI * rabi * area,
    rotationAxis: effective > 0
      ? { x: (rabi * Math.cos(pulse.phase)) / effective, y: (rabi * Math.sin(pulse.phase)) / effective, z: detuning / effective }
      : { x: 0, y: 0, z: 1 },
    maxExcitationProbability: maxExcitation,
    squarePulseExcitation: maxExcitation * Math.sin(Math.PI * effective * pulse.duration) ** 2,
    ...(regime === 'dispersive' && detuning !== 0 ? { acStarkShift: -(rabi * rabi) / (2 * detuning) } : {}),
    regime,
  };
};
