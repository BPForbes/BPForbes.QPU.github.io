/**
 * Control pulses: a microwave drive of carrier frequency ω_d on one qubit,
 * H_d(t) = Ω(t)[ε_I(t) cos(ω_d t − φ) + ε_Q(t) sin(ω_d t − φ)] X,
 * where Ω = 2π·amplitude is the peak Rabi (angular) frequency and ε is the
 * envelope (peak 1). Gates stay matrices by default; the physical simulation
 * mode can translate single-qubit rotations into calibrated pulses.
 */
import type { QubitPhysicsProfile } from './QubitProfile';

export type PulseEnvelope =
  | { kind: 'square' }
  /** Gaussian centred in the pulse, shifted so it starts and ends at 0. */
  | { kind: 'gaussian'; sigma: number }
  /** Gaussian in-phase envelope plus a derivative quadrature −β·dε_I/dt (DRAG). */
  | { kind: 'drag'; sigma: number; beta: number };

export type ControlPulse = {
  /** Wire the drive couples to. */
  target: number;
  /** Carrier frequency f_d in cycles per time unit. */
  carrierFrequency: number;
  /** Peak Rabi frequency Ω/2π in cycles per time unit. */
  amplitude: number;
  /** Drive phase φ in radians; 0 rotates about X, π/2 about Y. */
  phase: number;
  /** Pulse length in time units; the pulse starts at the segment start. */
  duration: number;
  envelope: PulseEnvelope;
};

export type EnvelopeSample = { inPhase: number; quadrature: number };

const gaussianParts = (sigma: number, duration: number, time: number) => {
  const centre = duration / 2;
  const edge = Math.exp(-(centre * centre) / (2 * sigma * sigma));
  const raw = Math.exp(-((time - centre) ** 2) / (2 * sigma * sigma));
  const scale = 1 / (1 - edge);
  return { value: (raw - edge) * scale, slope: (-(time - centre) / (sigma * sigma)) * raw * scale };
};

/** Envelope at `time` measured from the pulse start; zero outside [0, duration]. */
export const envelopeAt = (envelope: PulseEnvelope, duration: number, time: number): EnvelopeSample => {
  if (time < 0 || time > duration) return { inPhase: 0, quadrature: 0 };
  if (envelope.kind === 'square') return { inPhase: 1, quadrature: 0 };
  const { value, slope } = gaussianParts(envelope.sigma, duration, time);
  return { inPhase: value, quadrature: envelope.kind === 'drag' ? -envelope.beta * slope : 0 };
};

/** ∫₀ᵀ ε_I(t) dt; the rotation of a resonant pulse is 2π·amplitude times this area. */
export const envelopeArea = (envelope: PulseEnvelope, duration: number): number => {
  if (envelope.kind === 'square') return duration;
  // Simpson's rule; the shifted Gaussian is smooth, so 1000 panels are far below other errors.
  const panels = 1000;
  const h = duration / panels;
  let sum = envelopeAt(envelope, duration, 0).inPhase + envelopeAt(envelope, duration, duration).inPhase;
  for (let index = 1; index < panels; index += 1) {
    sum += (index % 2 === 0 ? 2 : 4) * envelopeAt(envelope, duration, index * h).inPhase;
  }
  return (sum * h) / 3;
};

export const validatePulse = (pulse: ControlPulse) => {
  if (!(pulse.duration > 0) || !Number.isFinite(pulse.duration)) throw new RangeError(`Pulse duration must be positive (got ${pulse.duration}).`);
  if (!Number.isFinite(pulse.amplitude) || pulse.amplitude < 0) throw new RangeError(`Pulse amplitude must be non-negative (got ${pulse.amplitude}).`);
  if (!Number.isFinite(pulse.carrierFrequency) || pulse.carrierFrequency < 0) {
    throw new RangeError(`Carrier frequency must be non-negative (got ${pulse.carrierFrequency}).`);
  }
  if (pulse.envelope.kind !== 'square' && !(pulse.envelope.sigma > 0)) throw new RangeError('Gaussian pulses need sigma > 0.');
};

export type CalibratedPulseRequest = {
  target: number;
  profile: QubitPhysicsProfile;
  /** Desired rotation angle θ in radians (negative rotates the other way). */
  angle: number;
  /** Rotation axis in the XY plane: 0 = X, π/2 = Y. */
  axisPhase?: number;
  duration: number;
  envelope?: PulseEnvelope;
};

/**
 * A resonant pulse calibrated against the nominal f₀₁ so its area gives θ:
 * 2π·amplitude·∫ε dt = |θ|. A qubit whose actual frequency drifted is then
 * detuned from it, which is exactly how calibration error becomes gate error.
 */
export const calibratedPulse = ({ target, profile, angle, axisPhase = 0, duration, envelope = { kind: 'square' } }: CalibratedPulseRequest): ControlPulse => {
  const area = envelopeArea(envelope, duration);
  return {
    target,
    carrierFrequency: profile.transitionFrequency,
    amplitude: Math.abs(angle) / (2 * Math.PI * area),
    phase: axisPhase + (angle < 0 ? Math.PI : 0),
    duration,
    envelope,
  };
};
