import { describe, expect, it } from 'vitest';
import { complex } from '../../complex';
import { snapshotParticle } from '../particleTracking';
import { physics } from '../PhysicsEngine';
import { densityState, stateVector } from '../state/QuantumState';

const INV_SQRT2 = 1 / Math.sqrt(2);
const bell = () => stateVector([complex(INV_SQRT2), complex(), complex(), complex(INV_SQRT2)]);

const diagonal = (weights: number[]) =>
  weights.map((weight, row) => weights.map((_, col) => complex(row === col ? weight : 0)));

/**
 * Horodecki's 2⊗4 bound-entangled state (Phys. Lett. A 232, 333, 1997): PPT, so
 * negativity is zero, yet entangled for every 0 < b < 1.
 */
const horodecki2x4 = (b: number) => {
  const a = (1 + b) / 2;
  const c = Math.sqrt(1 - b * b) / 2;
  const rows = [
    [b, 0, 0, 0, 0, b, 0, 0],
    [0, b, 0, 0, 0, 0, b, 0],
    [0, 0, b, 0, 0, 0, 0, b],
    [0, 0, 0, b, 0, 0, 0, 0],
    [0, 0, 0, 0, a, 0, 0, c],
    [b, 0, 0, 0, 0, b, 0, 0],
    [0, b, 0, 0, 0, 0, b, 0],
    [0, 0, b, 0, c, 0, 0, a],
  ];
  return densityState(rows.map((row) => row.map((value) => complex(value / (7 * b + 1)))));
};

describe('assessEntanglement', () => {
  it('pure Bell pair: entangled, conclusive, by pure-state reduction', () => {
    expect(physics.assessEntanglement(bell(), [0])).toEqual({
      status: 'entangled',
      method: 'pure-state-reduction',
      conclusive: true,
    });
  });

  it('pure product state: separable, conclusive', () => {
    expect(physics.assessEntanglement(physics.createState(2), [1])).toEqual({
      status: 'separable',
      method: 'pure-state-reduction',
      conclusive: true,
    });
  });

  it('a pure state held as a density matrix still uses the exact pure-state test', () => {
    expect(physics.assessEntanglement(physics.toDensityMatrix(bell()), [0]).method).toBe('pure-state-reduction');
  });

  // Werner state v|Φ+⟩⟨Φ+| + (1 − v)I/4: entangled iff v > 1/3, with negativity (3v − 1)/4.
  const werner = (v: number) => densityState(physics.toDensityMatrix(bell()).rho.map((row, i) =>
    row.map((value, j) => complex(v * value.re + (i === j ? (1 - v) / 4 : 0), v * value.im))));

  it('mixed Werner state above v = 1/3: entangled via PPT with the analytic negativity', () => {
    const assessment = physics.assessEntanglement(werner(0.8), [0]);
    expect(assessment).toMatchObject({ status: 'entangled', method: 'ppt-negativity', conclusive: true });
    expect(assessment.negativity).toBeCloseTo((3 * 0.8 - 1) / 4, 9);
  });

  it('mixed Werner state below v = 1/3: separable, conclusively, because 2×2 PPT is exact', () => {
    expect(physics.assessEntanglement(werner(0.3), [0])).toMatchObject({
      status: 'separable',
      method: 'ppt-negativity',
      conclusive: true,
    });
  });

  it('separable two-qubit mixed state: PPT is exact for 2×2, so separable is conclusive', () => {
    const classical = densityState(diagonal([0.5, 0, 0, 0.5]));
    expect(physics.assessEntanglement(classical, [0])).toMatchObject({
      status: 'separable',
      method: 'ppt-negativity',
      conclusive: true,
    });
  });

  it('PPT mixed state on a 2×4 split: inconclusive, never "separable"', () => {
    // Classically correlated and truly separable, but PPT cannot prove that for 2×4.
    const correlated = densityState(diagonal([0.5, 0, 0, 0, 0, 0, 0, 0.5]));
    const assessment = physics.assessEntanglement(correlated, [0]);
    expect(assessment).toMatchObject({ status: 'inconclusive', method: 'ppt-negativity', conclusive: false });
    expect(assessment.negativity).toBeCloseTo(0, 9);
    expect(assessment.reason).toContain('2×4');
  });

  it('bound-entangled Horodecki state is reported inconclusive, not separable', () => {
    const state = horodecki2x4(0.5);
    expect(physics.inspectGlobal(state).normalization).toBeCloseTo(1, 12);
    expect(physics.negativity(state, [0])).toBeLessThan(1e-9);
    const assessment = physics.assessEntanglement(state, [0]);
    expect(assessment.status).toBe('inconclusive');
    expect(assessment.conclusive).toBe(false);
  });

  it('negative partial transpose on a 2×4 split is still conclusive entanglement', () => {
    // Bell pair on q0,q1 with q2 in |0⟩, as a density matrix.
    const ghzLike = physics.toDensityMatrix(stateVector([
      complex(INV_SQRT2), complex(), complex(), complex(), complex(), complex(), complex(INV_SQRT2), complex(),
    ]));
    const mixed = physics.applyChannel(ghzLike, physics.channels.depolarizing(0.1), [2]);
    expect(physics.assessEntanglement(mixed, [0])).toMatchObject({ status: 'entangled', conclusive: true });
  });

  it('registers past the PPT size limit are inconclusive with a reason instead of throwing', () => {
    const mixed = physics.applyChannel(physics.createState(7, 'densityMatrix'), physics.channels.depolarizing(0.5), [0]);
    const assessment = physics.assessEntanglement(mixed, [0]);
    expect(assessment).toMatchObject({ status: 'inconclusive', conclusive: false });
    expect(assessment.negativity).toBeUndefined();
    expect(assessment.reason).toMatch(/limited to 6 qubits/);
  });

  it('a subsystem covering the whole register is separable from the (empty) rest', () => {
    expect(physics.assessEntanglement(bell(), [0, 1])).toMatchObject({ status: 'separable', conclusive: true });
  });

  it('inspections carry the same assessment', () => {
    expect(physics.inspectQubit(bell(), 1).entanglement.status).toBe('entangled');
    expect(physics.inspectSubsystem(densityState(diagonal([0.5, 0, 0, 0, 0, 0, 0, 0.5])), [0]).entanglement.status)
      .toBe('inconclusive');
  });

  it('particle snapshots expose the assessment and only flag proven entanglement', () => {
    const snapshot = snapshotParticle((bell() as { amplitudes: ReturnType<typeof complex>[] }).amplitudes, 2, 0);
    expect(snapshot.entanglement?.status).toBe('entangled');
    expect(snapshot.entangledWithRegister).toBe(true);
    const measured = snapshotParticle(bell().amplitudes, 2, 0, { 0: 1 });
    expect(measured.entanglement).toBeUndefined();
    expect(measured.entangledWithRegister).toBe(false);
  });
});
