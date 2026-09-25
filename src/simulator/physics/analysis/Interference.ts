/**
 * Amplitude-level interference diagnostics for one operation.
 *
 * Each output amplitude is a sum of contributions U_ij ψ_j. Comparing |Σ c|²
 * with the "classical" Σ |c|² separates constructive from destructive
 * interference, e.g. H·H|0⟩: |0⟩ gets +½ + +½ = 1, |1⟩ gets +½ + −½ = 0.
 * Purely diagnostic: circuit execution never goes through this path.
 */
import { add, type Complex, magnitudeSquared, mul, ZERO } from '../../complex';
import type { ComplexMatrix } from '../numerics/linearAlgebra';
import { applyMultiQubitUnitary, bitMask, controlsAreActive } from '../state/StateVector';

export type AmplitudeContribution = {
  /** Input basis index the contribution flows from. */
  from: number;
  amplitude: Complex;
};

export type InterferenceKind = 'constructive' | 'destructive' | 'none';

export type InterferenceTerm = {
  basis: number;
  label: string;
  contributions: AmplitudeContribution[];
  amplitude: Complex;
  probability: number;
  /** Σ |c|²: what adding probabilities instead of amplitudes would give. */
  classicalProbability: number;
  kind: InterferenceKind;
};

export type InterferenceAnalysis = {
  before: Complex[];
  after: Complex[];
  terms: InterferenceTerm[];
  /** True when any output shows constructive or destructive interference. */
  interferes: boolean;
};

export type InterferenceOperation = {
  targets: number[];
  matrix: ComplexMatrix;
  controls?: number[];
};

const CONTRIBUTION_TOLERANCE = 1e-12;
const INTERFERENCE_TOLERANCE = 1e-9;

export const analyzeInterference = (
  before: Complex[],
  qubitCount: number,
  operation: InterferenceOperation,
): InterferenceAnalysis => {
  const { targets, matrix, controls = [] } = operation;
  const after = applyMultiQubitUnitary(before, qubitCount, targets, matrix, controls);
  const masks = targets.map((target) => bitMask(target, qubitCount));
  const targetMask = masks.reduce((all, mask) => all | mask, 0);
  const localIndex = (index: number) =>
    masks.reduce((local, mask) => (local << 1) | ((index & mask) !== 0 ? 1 : 0), 0);
  const offsets = Array.from({ length: 2 ** targets.length }, (_, local) =>
    masks.reduce((offset, mask, bit) => ((local >> (targets.length - bit - 1)) & 1 ? offset | mask : offset), 0));

  const terms: InterferenceTerm[] = [];
  for (let basis = 0; basis < before.length; basis += 1) {
    const contributions: AmplitudeContribution[] = [];
    if (controlsAreActive(basis, qubitCount, controls)) {
      const row = localIndex(basis);
      offsets.forEach((offset, column) => {
        const from = (basis & ~targetMask) | offset;
        const amplitude = mul(matrix[row][column], before[from]);
        if (magnitudeSquared(amplitude) > CONTRIBUTION_TOLERANCE) contributions.push({ from, amplitude });
      });
    } else if (magnitudeSquared(before[basis]) > CONTRIBUTION_TOLERANCE) {
      contributions.push({ from: basis, amplitude: before[basis] });
    }
    if (contributions.length === 0) continue;

    const amplitude = contributions.reduce((sum, contribution) => add(sum, contribution.amplitude), ZERO);
    const probability = magnitudeSquared(amplitude);
    const classicalProbability = contributions.reduce((sum, contribution) => sum + magnitudeSquared(contribution.amplitude), 0);
    const kind: InterferenceKind = contributions.length < 2 || Math.abs(probability - classicalProbability) < INTERFERENCE_TOLERANCE
      ? 'none'
      : probability > classicalProbability ? 'constructive' : 'destructive';
    terms.push({
      basis,
      label: `|${basis.toString(2).padStart(qubitCount, '0')}⟩`,
      contributions,
      amplitude,
      probability,
      classicalProbability,
      kind,
    });
  }

  return { before, after, terms, interferes: terms.some((term) => term.kind !== 'none') };
};
