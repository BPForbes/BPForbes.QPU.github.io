/**
 * Global vs relative phase diagnostics.
 *
 * e^{iφ}|ψ⟩ is physically identical to |ψ⟩; a relative phase between
 * components (|+⟩ vs |−⟩) leaves Z-basis populations unchanged but changes
 * interference and other-basis measurements.
 */
import { type Complex, magnitudeSquared } from '../../complex';
import { innerProduct } from '../state/StateVector';

export type PhaseRelation = 'identical' | 'global-phase' | 'relative-phase' | 'different-populations';

export type PhaseComparison = {
  relation: PhaseRelation;
  /** arg⟨a|b⟩ when the states differ only by a global phase. */
  globalPhase?: number;
  fidelity: number;
  /** True unless the states are the same physical ray. */
  observablyDifferent: boolean;
};

export type RelativePhase = {
  basis: number;
  /** Phase relative to the first non-zero amplitude, in (−π, π]. */
  phase: number;
  magnitude: number;
};

const PHASE_TOLERANCE = 1e-9;

const argument = (value: Complex) => Math.atan2(value.im, value.re);

export const relativePhases = (state: readonly Complex[]): RelativePhase[] => {
  const reference = state.find((amplitude) => magnitudeSquared(amplitude) > PHASE_TOLERANCE);
  if (!reference) return [];
  const referencePhase = argument(reference);
  return state.flatMap((amplitude, basis) => {
    if (magnitudeSquared(amplitude) <= PHASE_TOLERANCE) return [];
    let phase = argument(amplitude) - referencePhase;
    while (phase <= -Math.PI) phase += 2 * Math.PI;
    while (phase > Math.PI) phase -= 2 * Math.PI;
    return [{ basis, phase: Math.abs(phase) < PHASE_TOLERANCE ? 0 : phase, magnitude: Math.sqrt(magnitudeSquared(amplitude)) }];
  });
};

export const comparePhase = (a: readonly Complex[], b: readonly Complex[]): PhaseComparison => {
  if (a.length !== b.length) throw new RangeError('Phase comparison needs states of the same dimension.');
  const overlap = innerProduct(a, b);
  const fidelity = magnitudeSquared(overlap);
  if (fidelity >= 1 - PHASE_TOLERANCE) {
    const globalPhase = argument(overlap);
    return Math.abs(globalPhase) < 1e-7
      ? { relation: 'identical', fidelity, observablyDifferent: false }
      : { relation: 'global-phase', globalPhase, fidelity, observablyDifferent: false };
  }
  const samePopulations = a.every((amplitude, index) =>
    Math.abs(magnitudeSquared(amplitude) - magnitudeSquared(b[index])) < 1e-7);
  return {
    relation: samePopulations ? 'relative-phase' : 'different-populations',
    fidelity,
    observablyDifferent: true,
  };
};
