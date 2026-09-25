/**
 * Open-system noise described by single-qubit Kraus channels
 * ρ → Σ_k K_k ρ K_k† with Σ_k K_k† K_k = I.
 *
 * Noise is always opt-in: without a NoiseModel the simulator stays on the
 * ideal state-vector path.
 */
import { complex } from '../../complex';
import { type ComplexMatrix, dagger, matMul } from '../numerics/linearAlgebra';

export type NoiseChannel = {
  name: string;
  /** Channel strength as supplied (probability or damping rate). */
  parameter: number;
  kraus: readonly ComplexMatrix[];
};

/** T1 relaxation and T2 coherence times in the same unit as gate durations. */
export type DecoherenceModel = {
  t1?: number;
  t2?: number;
};

/**
 * Physical time per operation. Deliberately separate from logical QPU
 * CYCLE/INCREASECYCLE stages: a logical cycle is not elapsed time.
 */
export type PhysicalTimingModel = {
  defaultGateDuration: number;
  gateDurations?: Record<string, number>;
};

export type NoiseModel = {
  /** Channels applied to every qubit an operation touches, right after it. */
  gate?: NoiseChannel[];
  /** Channels applied to every qubit after each operation (idle/background noise). */
  idle?: NoiseChannel[];
  /** T1/T2 decoherence applied to every qubit for each operation's physical duration. */
  decoherence?: DecoherenceModel;
  /** Required for decoherence; defaults to unit gate duration when omitted. */
  timing?: PhysicalTimingModel;
};

export const assertProbability = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be in [0, 1] (got ${value}).`);
  }
};

export const scaledMatrix = (matrix: ComplexMatrix, factor: number): ComplexMatrix =>
  matrix.map((row) => row.map((value) => complex(value.re * factor, value.im * factor)));

/** Σ K†K = I within tolerance (trace preservation). */
export const isTracePreserving = (channel: NoiseChannel, tolerance = 1e-9): boolean => {
  const sum = channel.kraus
    .map((operator) => matMul(dagger(operator), operator))
    .reduce((total, term) => total.map((row, i) => row.map((value, j) => complex(value.re + term[i][j].re, value.im + term[i][j].im))));
  return sum.every((row, i) =>
    row.every((value, j) => Math.abs(value.re - (i === j ? 1 : 0)) < tolerance && Math.abs(value.im) < tolerance));
};

/** A channel that cannot change any state (all strength zero) can be skipped. */
export const isIdentityChannel = (channel: NoiseChannel): boolean => channel.parameter === 0;
