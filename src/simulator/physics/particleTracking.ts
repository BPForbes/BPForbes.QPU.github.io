/**
 * Particle tracking: turns Physics Engine inspections into per-wire snapshots
 * and before/after transitions for the Bloch view.
 *
 * The tracker observes physics; it does not derive reduced states, purity, or
 * entanglement itself. Those come from `physics.inspectQubit`.
 */
import type { Complex } from '../complex';
import type { CircuitGate, MeasurementMap } from '../types';
import type { BlochVector, MixedStateMetrics, PsiKet, SphericalCoordinates } from './analysis/Bloch';
import { sphericalFromBlochCartesian } from './analysis/Bloch';
import { physics } from './PhysicsEngine';

export {
  blochBallRhoExpectation,
  blochCartesianFromSpherical,
  formatPsiKet,
  ketFromSpherical,
  mixedStateMetrics,
  sphericalFromBlochCartesian,
} from './analysis/Bloch';
export type { BlochVector, MixedStateMetrics, PsiKet, SphericalCoordinates } from './analysis/Bloch';

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

// A recorded classical outcome pins the displayed particle to its pole, whatever later gates did.
export const blochVectorForQubit = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  measurements: MeasurementMap = {},
): BlochVector => {
  const measured = measurements[qubit];
  if (measured !== undefined) return physics.measuredBlochGeometry(measured).bloch;
  return physics.blochVector(physics.fromAmplitudes(state, qubitCount), qubit);
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
  const measured = measurements[qubit];
  const inspection = measured === undefined ? physics.inspectQubit(physics.fromAmplitudes(state, qubitCount), qubit) : undefined;
  const { bloch, spherical, ket, mixed } = inspection
    ? physics.describeBlochVector(inspection.bloch)
    : physics.measuredBlochGeometry(measured!);
  return {
    qubit,
    bloch,
    spherical,
    ket,
    mixed,
    entangledWithRegister: inspection?.entangledWithRest === true,
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
