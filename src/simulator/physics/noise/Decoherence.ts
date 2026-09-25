/**
 * T1/T2 decoherence over a physical duration t.
 *
 * T1: populations relax with γ = 1 − e^{−t/T1} (amplitude damping).
 * T2: coherences decay as e^{−t/T2}. Amplitude damping already contributes
 * e^{−t/(2T1)}, so the remaining pure dephasing satisfies
 * √(1 − λ) = e^{−t/T2 + t/(2T1)}. Physical models require T2 ≤ 2·T1.
 */
import { amplitudeDamping } from './AmplitudeDamping';
import { phaseDamping } from './Dephasing';
import type { DecoherenceModel, NoiseChannel, PhysicalTimingModel } from './NoiseModel';

const assertPositiveTime = (name: string, value: number | undefined) => {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive duration (got ${value}).`);
  }
};

export const validateDecoherence = ({ t1, t2 }: DecoherenceModel) => {
  assertPositiveTime('T1', t1);
  assertPositiveTime('T2', t2);
  if (t1 !== undefined && t2 !== undefined && t2 > 2 * t1 + 1e-12) {
    throw new RangeError(`T2 (${t2}) cannot exceed 2·T1 (${2 * t1}).`);
  }
};

export const decoherenceChannels = (model: DecoherenceModel, duration: number): NoiseChannel[] => {
  validateDecoherence(model);
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`Duration must be non-negative (got ${duration}).`);
  if (duration === 0) return [];
  const { t1, t2 } = model;
  const channels: NoiseChannel[] = [];
  if (t1 !== undefined) channels.push(amplitudeDamping(1 - Math.exp(-duration / t1)));
  if (t2 !== undefined) {
    const coherenceExponent = -2 * duration / t2 + (t1 !== undefined ? duration / t1 : 0);
    const lambda = Math.min(1, Math.max(0, 1 - Math.exp(coherenceExponent)));
    if (lambda > 0) channels.push(phaseDamping(lambda));
  }
  return channels;
};

export const operationDuration = (timing: PhysicalTimingModel | undefined, gateType: string): number =>
  timing?.gateDurations?.[gateType] ?? timing?.defaultGateDuration ?? 1;
