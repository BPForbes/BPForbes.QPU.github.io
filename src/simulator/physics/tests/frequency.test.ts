import { describe, expect, it } from 'vitest';
import { complex } from '../../complex';
import { MATRIX_H } from '../../gates/matrices';
import { rotationXMatrix, rotationYMatrix } from '../../gates/matrices';
import { physics } from '../PhysicsEngine';
import type { PhysicalSystem } from '../frequency/PhysicalEvolution';
import type { QubitPhysicsProfile } from '../frequency/QubitProfile';
import { BOLTZMANN, PLANCK } from '../frequency/Units';
import { stateVector } from '../state/QuantumState';

// Frequencies in GHz, times in ns (the default units).
const F01 = 5;
const qubit: QubitPhysicsProfile = { transitionFrequency: F01 };
const rotating = (profile: QubitPhysicsProfile = qubit, extra: Partial<PhysicalSystem> = {}): PhysicalSystem => ({
  defaultProfile: profile,
  frame: 'rotating',
  approximation: 'rwa',
  ...extra,
});
const plus = () => physics.applyUnitary(physics.createState(1), [0], MATRIX_H);
const relativePhase = (state: ReturnType<typeof plus>) => {
  const [a, b] = state.amplitudes;
  return Math.atan2(b.im, b.re) - Math.atan2(a.im, a.re);
};
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

describe('Planck–Einstein relation and derived quantities', () => {
  it('E = hf and f₀₁ = ΔE/h round-trip', () => {
    const hertz = physics.frequency.toHertz(F01);
    expect(hertz).toBeCloseTo(5e9, 0);
    const gap = physics.frequency.energyGap(hertz);
    expect(gap).toBeCloseTo(PLANCK * 5e9, 40);
    expect(physics.frequency.transitionFrequency(0, gap)).toBeCloseTo(5e9, 0);
    expect(physics.frequency.joulesToElectronVolts(gap) * 1e6).toBeCloseTo(20.678, 2); // ≈ 20.7 µeV
    expect(physics.frequency.profileFromEnergies(0, gap).transitionFrequency).toBeCloseTo(F01, 12);
  });

  it('thermal excitation follows the Boltzmann factor', () => {
    const hertz = physics.frequency.toHertz(F01);
    expect(physics.frequency.thermalExcitedPopulation(hertz, 0)).toBe(0);
    const cold = physics.frequency.thermalExcitedPopulation(hertz, 0.02);
    expect(cold).toBeCloseTo(1 / (1 + Math.exp((PLANCK * hertz) / (BOLTZMANN * 0.02))), 15);
    expect(cold).toBeLessThan(1e-4);
    expect(physics.frequency.thermalExcitedPopulation(hertz, 1e6)).toBeCloseTo(0.5, 6);
  });

  it('photon and de Broglie wavelengths', () => {
    expect(physics.frequency.photonWavelength(5e9)).toBeCloseTo(0.05996, 4); // ≈ 6 cm microwave
    expect(physics.frequency.deBroglieWavelengthForMass(9.1093837015e-31, 1e6)).toBeCloseTo(7.2739e-10, 13);
    expect(() => physics.frequency.deBroglieWavelength(0)).toThrow(RangeError);
  });
});

describe('free evolution under the idle Hamiltonian', () => {
  it('in the lab frame an idle |+⟩ precesses by Δφ = −ω₀₁Δt', () => {
    const duration = 0.123;
    const evolved = physics.evolvePhysical(plus(), rotating(qubit, { frame: 'lab' }), { start: 0, duration });
    expect(wrap(relativePhase(evolved))).toBeCloseTo(wrap(-2 * Math.PI * F01 * duration), 9);
    expect(physics.frequency.freePrecessionPhase(qubit, duration)).toBeCloseTo(-2 * Math.PI * F01 * duration, 12);
    // Populations never change while idle.
    expect(physics.probabilities(evolved)[1]).toBeCloseTo(0.5, 12);
  });

  it('in the rotating frame a well-calibrated idle qubit does nothing', () => {
    const evolved = physics.evolvePhysical(plus(), rotating(), { start: 0, duration: 37 });
    expect(physics.fidelity(evolved, plus())).toBeCloseTo(1, 12);
    expect(physics.comparePhase(evolved, plus()).relation).toBe('identical');
  });

  it('a frequency offset and drift accumulate phase in the rotating frame', () => {
    const drifting: QubitPhysicsProfile = { transitionFrequency: F01, frequencyOffset: 0.001, frequencyDriftRate: 1e-5 };
    const duration = 20;
    const evolved = physics.evolvePhysical(plus(), rotating(drifting), { start: 0, duration });
    const expected = -2 * Math.PI * (0.001 * duration + (1e-5 * duration * duration) / 2);
    expect(wrap(relativePhase(evolved))).toBeCloseTo(wrap(expected), 6);
  });

  it('idle Hamiltonian has the Planck–Einstein level spacing', () => {
    const h = physics.frequency.idleHamiltonian(qubit);
    expect(h[1][1].re - h[0][0].re).toBeCloseTo(2 * Math.PI * F01, 12);
  });
});

describe('drive pulses, resonance, and Rabi oscillations (RWA)', () => {
  const pi = (duration = 20, envelope?: Parameters<typeof physics.frequency.calibratedPulse>[0]['envelope']) =>
    physics.frequency.calibratedPulse({ target: 0, profile: qubit, angle: Math.PI, duration, envelope });

  it('a calibrated resonant π-pulse is an X gate (square, Gaussian, DRAG)', () => {
    for (const envelope of [
      { kind: 'square' as const },
      { kind: 'gaussian' as const, sigma: 5 },
      { kind: 'drag' as const, sigma: 5, beta: 0.2 },
    ]) {
      const pulse = pi(20, envelope);
      const final = physics.evolvePhysical(physics.createState(1), rotating(), { start: 0, duration: 20, pulses: [pulse] });
      // DRAG's quadrature suppresses leakage to |2⟩; a two-level model has no |2⟩, so it only adds a small error here.
      if (envelope.kind === 'drag') expect(physics.probabilities(final)[1]).toBeGreaterThan(0.99);
      else expect(physics.probabilities(final)[1]).toBeCloseTo(1, 9);
    }
  });

  it('pulses at phase 0 and π/2 reproduce RX(θ) and RY(θ) up to global phase', () => {
    const theta = 1.1;
    [[0, rotationXMatrix(theta)], [Math.PI / 2, rotationYMatrix(theta)]].forEach(([axisPhase, matrix]) => {
      const pulse = physics.frequency.calibratedPulse({ target: 0, profile: qubit, angle: theta, axisPhase: axisPhase as number, duration: 15 });
      const driven = physics.evolvePhysical(plus(), rotating(), { start: 3, duration: 15, pulses: [pulse] });
      const ideal = physics.applyUnitary(plus(), [0], matrix as ReturnType<typeof rotationXMatrix>);
      expect(physics.comparePhase(driven, ideal).observablyDifferent).toBe(false);
    });
  });

  it('Rabi oscillation: P(1) = sin²(πΩt) for a resonant square drive', () => {
    const amplitude = 0.02; // Ω/2π = 20 MHz
    [5, 12.5, 25, 40].forEach((duration) => {
      const pulse = { target: 0, carrierFrequency: F01, amplitude, phase: 0, duration, envelope: { kind: 'square' as const } };
      const final = physics.evolvePhysical(physics.createState(1), rotating(), { start: 0, duration, pulses: [pulse] });
      expect(physics.probabilities(final)[1]).toBeCloseTo(Math.sin(Math.PI * amplitude * duration) ** 2, 9);
    });
  });

  it('detuning reduces the peak transfer to Ω²/(Ω²+Δ²), matching the diagnostics', () => {
    const pulse = { target: 0, carrierFrequency: F01 + 0.03, amplitude: 0.02, phase: 0, duration: 17, envelope: { kind: 'square' as const } };
    const diagnostics = physics.frequency.driveDiagnostics(qubit, pulse);
    expect(diagnostics.detuning).toBeCloseTo(0.03, 12);
    expect(diagnostics.maxExcitationProbability).toBeCloseTo(0.02 ** 2 / (0.02 ** 2 + 0.03 ** 2), 12);
    expect(diagnostics.regime).toBe('near-resonant');
    const final = physics.evolvePhysical(physics.createState(1), rotating(), { start: 0, duration: 17, pulses: [pulse] });
    expect(physics.probabilities(final)[1]).toBeCloseTo(diagnostics.squarePulseExcitation, 6);
  });

  it('a calibration offset turns a π-pulse into an imperfect rotation', () => {
    const miscalibrated: QubitPhysicsProfile = { transitionFrequency: F01, frequencyOffset: 0.02 };
    const pulse = physics.frequency.calibratedPulse({ target: 0, profile: miscalibrated, angle: Math.PI, duration: 20 });
    const final = physics.evolvePhysical(physics.createState(1), rotating(miscalibrated), { start: 0, duration: 20, pulses: [pulse] });
    const expected = physics.frequency.driveDiagnostics(miscalibrated, pulse).squarePulseExcitation;
    expect(physics.probabilities(final)[1]).toBeCloseTo(expected, 6);
    expect(expected).toBeLessThan(0.8);
  });

  it('far off resonance the drive mainly shifts the qubit frequency (AC Stark shift)', () => {
    const detuning = 0.05;
    const amplitude = 0.005;
    const duration = 1000; // an integer number of detuning periods, so the fast wiggle averages out
    const pulse = { target: 0, carrierFrequency: F01 + detuning, amplitude, phase: 0, duration, envelope: { kind: 'square' as const } };
    const diagnostics = physics.frequency.driveDiagnostics(qubit, pulse);
    expect(diagnostics.regime).toBe('dispersive');
    expect(diagnostics.acStarkShift).toBeCloseTo(-(amplitude ** 2) / (2 * detuning), 12);
    const final = physics.evolvePhysical(plus(), rotating(), { start: 0, duration, pulses: [pulse] });
    const expectedPhase = -2 * Math.PI * diagnostics.acStarkShift! * duration;
    expect(Math.abs(wrap(relativePhase(final) - expectedPhase))).toBeLessThan(0.08);
    expect(physics.probabilities(final)[1]).toBeCloseTo(0.5, 1);
  });
});

describe('frames and the rotating-wave approximation', () => {
  const weakPi = physics.frequency.calibratedPulse({ target: 0, profile: qubit, angle: Math.PI, duration: 25 });

  it('exact lab-frame evolution agrees with the RWA for a weak drive', () => {
    const exact = physics.evolvePhysical(physics.createState(1), rotating(qubit, { frame: 'lab', approximation: 'exact' }), {
      start: 0,
      duration: 25,
      pulses: [weakPi],
    });
    // Bloch–Siegert and counter-rotating corrections scale like Ω/ω ≈ 0.004.
    expect(physics.probabilities(exact)[1]).toBeGreaterThan(0.999);
  });

  it('exact rotating-frame evolution agrees with the RWA to O(Ω/ω)', () => {
    const exact = physics.evolvePhysical(plus(), rotating(qubit, { approximation: 'exact' }), { start: 0, duration: 25, pulses: [weakPi] });
    const rwa = physics.evolvePhysical(plus(), rotating(), { start: 0, duration: 25, pulses: [weakPi] });
    expect(physics.fidelity(exact, rwa)).toBeGreaterThan(0.999);
  });

  it('lab and rotating RWA results differ only by the frame phase', () => {
    // 2.03 ns is not a whole number of 5 GHz periods, so the two frames really differ in phase.
    const lab = physics.evolvePhysical(plus(), rotating(qubit, { frame: 'lab' }), { start: 2.03, duration: 25, pulses: [weakPi] });
    const rot = physics.evolvePhysical(plus(), rotating(), { start: 2.03, duration: 25, pulses: [weakPi] });
    expect(physics.probabilities(lab)[1]).toBeCloseTo(physics.probabilities(rot)[1], 12);
    expect(physics.fidelity(lab, rot)).toBeLessThan(1 - 1e-6); // same physics, different phase reference
  });

  it('refuses exact lab-frame evolution that would need too many steps', () => {
    const long = { ...weakPi, duration: 2e5 };
    expect(() => physics.evolvePhysical(physics.createState(1), rotating(qubit, { frame: 'lab', approximation: 'exact' }), {
      start: 0,
      duration: 2e5,
      pulses: [long],
    })).toThrow(/rwa/);
  });
});

describe('qubit–qubit coupling Hamiltonians', () => {
  const pair = (couplings: PhysicalSystem['couplings'], profiles?: PhysicalSystem['profiles']): PhysicalSystem =>
    rotating(qubit, { couplings, ...(profiles ? { profiles } : {}) });
  const plusPlus = () => physics.applyUnitary(physics.applyUnitary(physics.createState(2), [0], MATRIX_H), [1], MATRIX_H);

  it('ZZ coupling entangles |++⟩ maximally after t = 1/(2J) (a CZ up to local phases)', () => {
    const J = 0.01;
    const entangled = physics.evolvePhysical(plusPlus(), pair([{ qubits: [0, 1], kind: 'zz', strength: J }]), { start: 0, duration: 1 / (2 * J) });
    expect(physics.entanglementEntropy(entangled, [0])).toBeCloseTo(1, 9);
    const half = physics.evolvePhysical(plusPlus(), pair([{ qubits: [0, 1], kind: 'zz', strength: J }]), { start: 0, duration: 1 / (4 * J) });
    expect(physics.entanglementEntropy(half, [0])).toBeLessThan(1);
  });

  it('exchange coupling swaps |01⟩ → |10⟩ at t = 1/(4J) and entangles at half that', () => {
    const J = 0.01;
    const system = pair([{ qubits: [0, 1], kind: 'exchange', strength: J }]);
    const zeroOne = physics.prepare(physics.createState(2), 1, '1p');
    const swapped = physics.evolvePhysical(zeroOne, system, { start: 0, duration: 1 / (4 * J) });
    expect(physics.probabilities(swapped)[2]).toBeCloseTo(1, 9);
    const sqrtSwap = physics.evolvePhysical(zeroOne, system, { start: 0, duration: 1 / (8 * J) });
    expect(physics.assessEntanglement(sqrtSwap, [0]).status).toBe('entangled');
    expect(physics.entanglementEntropy(sqrtSwap, [0])).toBeCloseTo(1, 9);
  });

  it('detuned qubits barely exchange: coupling is resonant too', () => {
    const J = 0.002;
    const system = pair(
      [{ qubits: [0, 1], kind: 'exchange', strength: J }],
      { 0: { transitionFrequency: 5 }, 1: { transitionFrequency: 5.2 } },
    );
    const zeroOne = physics.prepare(physics.createState(2), 1, '1p');
    const after = physics.evolvePhysical(zeroOne, system, { start: 0, duration: 1 / (4 * J) });
    expect(physics.probabilities(after)[2]).toBeLessThan(0.01);
  });

  it('coupled wires evolve independently of an uncoupled idle wire', () => {
    const J = 0.01;
    const three = physics.applyUnitary(physics.applyUnitary(physics.createState(3), [0], MATRIX_H), [1], MATRIX_H);
    const system = rotating(qubit, { frame: 'lab', couplings: [{ qubits: [0, 1], kind: 'zz', strength: J }] });
    const after = physics.evolvePhysical(three, system, { start: 0, duration: 1 / (2 * J) });
    expect(physics.entanglementEntropy(after, [2])).toBeCloseTo(0, 9);
    expect(physics.entanglementEntropy(after, [0])).toBeCloseTo(1, 9);
  });
});

describe('time-dependent Hamiltonians', () => {
  it('a constant H(t) matches static evolution', () => {
    const matrix = [[complex(0.3), complex(0.1, -0.2)], [complex(0.1, 0.2), complex(-0.4)]];
    const viaStatic = physics.evolve(plus(), { matrix, targets: [0] }, 2.5);
    const viaSteps = physics.evolveTimeDependent(plus(), { kind: 'timeDependent', targets: [0], at: () => matrix, maxStep: 0.01 }, 0, 2.5);
    expect(physics.fidelity(viaStatic, viaSteps)).toBeCloseTo(1, 12);
  });

  it('a linearly ramped Z field accumulates the integrated phase', () => {
    const rate = 0.4;
    const ramp = { kind: 'timeDependent' as const, targets: [0], maxStep: 0.001, at: (t: number) => [[complex(-rate * t / 2), complex()], [complex(), complex(rate * t / 2)]] };
    const evolved = physics.evolveTimeDependent(plus(), ramp, 0, 3);
    expect(wrap(relativePhase(evolved))).toBeCloseTo(wrap(-(rate * 9) / 2), 6);
  });
});

describe('thermal relaxation and decoherence on the physical clock', () => {
  it('generalized amplitude damping relaxes toward the thermal population', () => {
    let state: ReturnType<typeof physics.toDensityMatrix> = physics.toDensityMatrix(physics.prepare(physics.createState(1), 0, '1p'));
    const channel = physics.channels.generalizedAmplitudeDamping(0.3, 0.2);
    expect(() => physics.validateChannel(channel)).not.toThrow();
    for (let step = 0; step < 80; step += 1) state = physics.applyChannel(state, channel, [0]) as typeof state;
    expect(physics.probabilities(state)[1]).toBeCloseTo(0.2, 9);
  });

  it('profile T1 at a finite temperature settles at the Boltzmann population', () => {
    const warm: QubitPhysicsProfile = { transitionFrequency: 1, t1: 10, temperature: 0.1 };
    const system = rotating(warm);
    const final = physics.applyPhysicalDecoherence(physics.prepare(physics.createState(1), 0, '1p'), system, 0, 400);
    const expected = physics.frequency.thermalExcitedPopulation(physics.frequency.toHertz(1), 0.1);
    expect(physics.probabilities(final)[1]).toBeCloseTo(expected, 9);
  });

  it('the physical clock accumulates durations and rejects negative ones', () => {
    const clock = physics.frequency.advanceClock(physics.frequency.startClock(), 20);
    expect(physics.frequency.advanceClock(clock, 5).elapsedTime).toBe(25);
    expect(() => physics.frequency.advanceClock(clock, -1)).toThrow(RangeError);
  });

  it('rejects profiles without a positive transition frequency', () => {
    expect(() => physics.evolvePhysical(plus(), rotating({ transitionFrequency: 0 }), { start: 0, duration: 1 })).toThrow(/Transition frequency/);
    expect(() => physics.evolvePhysical(plus(), { frame: 'rotating' }, { start: 0, duration: 1 })).toThrow(/No physical profile/);
  });
});

describe('density matrices evolve physically too', () => {
  it('a resonant π-pulse on a mixed state flips populations', () => {
    const mixed = physics.applyChannel(physics.createState(1, 'densityMatrix'), physics.channels.depolarizing(0.2), [0]);
    const pulse = physics.frequency.calibratedPulse({ target: 0, profile: qubit, angle: Math.PI, duration: 20 });
    const flipped = physics.evolvePhysical(mixed, rotating(), { start: 0, duration: 20, pulses: [pulse] });
    expect(physics.probabilities(flipped)[1]).toBeCloseTo(physics.probabilities(mixed)[0], 9);
    expect(physics.inspectGlobal(flipped).purity).toBeCloseTo(physics.inspectGlobal(mixed).purity, 12);
  });

  it('keeps state vectors as state vectors', () => {
    const evolved = physics.evolvePhysical(stateVector([complex(1), complex()]), rotating(), { start: 0, duration: 5 });
    expect(evolved.kind).toBe('stateVector');
  });
});
