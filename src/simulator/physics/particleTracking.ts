import { blochBallRhoExpectationFast } from './blochQuadrature';
import { complex, formatComplex, magnitudeSquared, type Complex } from '../complex';
import { hasBit } from '../gates/operations';
import type { CircuitGate, MeasurementMap } from '../types';
/** Bloch-vector Cartesian components: x = r sinθ cosφ, y = r sinθ sinφ, z = r cosθ. */
export type BlochVector = {
  x: number;
  y: number;
  z: number;
};

// Spherical coordinates on the Bloch ball: r is radial, θ is polar from +Z, and φ is azimuthal.
export type SphericalCoordinates = {
  r: number;
  theta: number;
  phi: number;
};

/** |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩ */
export type PsiKet = {
  alpha: Complex;
  beta: Complex;
  theta: number;
  phi: number;
  formatted: string;
};

// Mixed-state metrics from the Bloch radius: purity = Tr(ρ²), mixedness = normalized linear entropy.
// Local mixedness can come from entanglement with the rest of the register, not physical noise.
export type MixedStateMetrics = {
  blochRadius: number;
  purity: number;
  mixedness: number;
  rhoExpectation: number;
  isPure: boolean;
};

export type ParticleSnapshot = {
  qubit: number;
  bloch: BlochVector;
  spherical: SphericalCoordinates;
  ket: PsiKet;
  mixed: MixedStateMetrics;
  /** True when this reduced qubit is mixed while the global state-vector remains pure. */
  entangledWithRegister?: boolean;
  probOne: number;
  measured?: 0 | 1;
};

export type ParticleDelta = {
  qubit: number;
  deltaR: number;
  deltaTheta: number;
  deltaPhi: number;
  displacement: number;
};

export type OperationTransition = {
  step: number;
  gateId: string;
  gateType: string;
  inputQubits: number[];
  outputQubits: number[];
  before: ParticleSnapshot[];
  after: ParticleSnapshot[];
  deltas: ParticleDelta[];
};

const PURE_TOLERANCE = 1e-6;

const bitMask = (qubit: number, qubitCount: number) => 1 << (qubitCount - qubit - 1);

// Per-qubit reduced density matrices drive particle labels even when the full state is entangled.
const marginalRho = (state: Complex[], qubitCount: number, qubit: number) => {
  const mask = bitMask(qubit, qubitCount);
  let rho00 = 0;
  let rho11 = 0;
  let rho01re = 0;
  let rho01im = 0;

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) !== 0) continue;
    const amp0 = state[index];
    const amp1 = state[index | mask];
    rho00 += magnitudeSquared(amp0);
    rho11 += magnitudeSquared(amp1);
    rho01re += amp0.re * amp1.re + amp0.im * amp1.im;
    rho01im += amp0.im * amp1.re - amp0.re * amp1.im;
  }

  return { rho00, rho11, rho01: complex(rho01re, rho01im) };
};

/** Pauli Bloch coordinates from spherical angles. */
export const blochCartesianFromSpherical = (r: number, theta: number, phi: number): BlochVector => ({
  x: r * Math.sin(theta) * Math.cos(phi),
  y: r * Math.sin(theta) * Math.sin(phi),
  z: r * Math.cos(theta),
});

export const sphericalFromBlochCartesian = ({ x, y, z }: BlochVector): SphericalCoordinates => {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-12) return { r: 0, theta: 0, phi: 0 };
  return {
    r,
    theta: Math.acos(Math.min(1, Math.max(-1, z / r))),
    phi: Math.atan2(y, x),
  };
};

/** |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩ */
export const ketFromSpherical = (theta: number, phi: number): PsiKet => {
  const half = theta / 2;
  const alpha = complex(Math.cos(half), 0);
  const beta = complex(Math.cos(phi) * Math.sin(half), Math.sin(phi) * Math.sin(half));
  return {
    alpha,
    beta,
    theta,
    phi,
    formatted: formatPsiKet(alpha, beta),
  };
};

export const formatPsiKet = (alpha: Complex, beta: Complex): string => {
  const alphaText = formatComplex(alpha);
  const betaText = formatComplex(beta);
  if (magnitudeSquared(beta) < 1e-12) return `|ψ⟩ = ${alphaText}|0⟩`;
  if (magnitudeSquared(alpha) < 1e-12) return `|ψ⟩ = ${betaText}|1⟩`;
  return `|ψ⟩ = ${alphaText}|0⟩ + ${betaText}|1⟩`;
};

/** ⟨ρ⟩ via separable O(1) quadrature (see blochQuadrature.ts). */
export const blochBallRhoExpectation = blochBallRhoExpectationFast;

export const mixedStateMetrics = (spherical: SphericalCoordinates): MixedStateMetrics => {
  const blochRadius = spherical.r;
  const purity = (1 + blochRadius * blochRadius) / 2;
  // Normalized linear entropy: 0 = pure, 1 = maximally mixed one-qubit state.
  const mixedness = 2 * (1 - purity);
  return {
    blochRadius,
    purity,
    mixedness,
    rhoExpectation: blochBallRhoExpectation(spherical.r, spherical.theta, spherical.phi, mixedness),
    isPure: purity >= 1 - PURE_TOLERANCE,
  };
};

export const blochVectorForQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  measurements: MeasurementMap = {},
): BlochVector => {
  const measured = measurements[qubit];
  if (measured !== undefined) {
    return blochCartesianFromSpherical(1, measured === 1 ? Math.PI : 0, 0);
  }

  const { rho00, rho11, rho01 } = marginalRho(state, qubitCount, qubit);
  return {
    x: 2 * rho01.re,
    y: 2 * rho01.im,
    z: rho00 - rho11,
  };
};

/** @deprecated Use sphericalFromBlochCartesian */
export const sphericalFromBloch = sphericalFromBlochCartesian;

// Snapshot extraction classifies each displayed qubit from its Bloch vector plus any recorded measurement.
export const snapshotParticle = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  measurements: MeasurementMap = {},
): ParticleSnapshot => {
  const bloch = blochVectorForQubit(state, qubitCount, qubit, measurements);
  const spherical = sphericalFromBlochCartesian(bloch);
  const ket = ketFromSpherical(spherical.theta, spherical.phi);
  const mixed = mixedStateMetrics(spherical);
  const measured = measurements[qubit];
  const entangledWithRegister =
    measured === undefined && qubitCount > 1 && mixed.purity < 1 - PURE_TOLERANCE;
  return {
    qubit,
    bloch,
    spherical,
    ket,
    mixed,
    entangledWithRegister,
    probOne: (1 - bloch.z) / 2,
    measured,
  };
};

export const snapshotAllParticles = (
  state: Complex[],
  qubitCount: number,
  measurements: MeasurementMap = {},
): ParticleSnapshot[] =>
  Array.from({ length: qubitCount }, (_, qubit) => snapshotParticle(state, qubitCount, qubit, measurements));

const normalizeAngleDelta = (delta: number) => {
  let value = delta;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
};

export const particleDelta = (before: ParticleSnapshot, after: ParticleSnapshot): ParticleDelta => {
  const dx = after.bloch.x - before.bloch.x;
  const dy = after.bloch.y - before.bloch.y;
  const dz = after.bloch.z - before.bloch.z;
  return {
    qubit: before.qubit,
    deltaR: after.spherical.r - before.spherical.r,
    deltaTheta: after.spherical.theta - before.spherical.theta,
    deltaPhi: normalizeAngleDelta(after.spherical.phi - before.spherical.phi),
    displacement: Math.sqrt(dx * dx + dy * dy + dz * dz),
  };
};

export const computeParticleDeltas = (before: ParticleSnapshot[], after: ParticleSnapshot[]): ParticleDelta[] =>
  before.map((snapshot, index) => particleDelta(snapshot, after[index] ?? snapshot));

// Transition records compare pre/post snapshots so the visualizer can explain what each gate changed.
export const buildOperationTransition = (
  gate: CircuitGate,
  stateBefore: Complex[],
  stateAfter: Complex[],
  qubitCount: number,
  measurementsBefore: MeasurementMap,
  measurementsAfter: MeasurementMap,
): OperationTransition => {
  const before = snapshotAllParticles(stateBefore, qubitCount, measurementsBefore);
  const after = snapshotAllParticles(stateAfter, qubitCount, measurementsAfter);
  const inputQubits = gate.type === 'SWAP'
    ? gate.targets
    : gate.controls.length > 0
      ? gate.controls
      : gate.targets;
  return {
    step: gate.step,
    gateId: gate.id,
    gateType: String(gate.type),
    inputQubits,
    outputQubits: gate.targets,
    before,
    after,
    deltas: computeParticleDeltas(before, after),
  };
};
