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
import type { EntanglementAssessment } from './analysis/Entanglement';
import { sphericalFromBlochCartesian } from './analysis/Bloch';
import { physics } from './PhysicsEngine';
import type { QuantumState } from './state/QuantumState';

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
  /** Shorthand for `entanglement.status === 'entangled'`. */
  entangledWithRegister?: boolean;
  /** Engine assessment for an unmeasured wire; absent once the wire is measured. */
  entanglement?: EntanglementAssessment;
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

// Raw amplitudes are read at their true width; display wires past it are fresh |0⟩ wires.
const quantumView = (state: Complex[], qubitCount: number): QuantumState => {
  const view = physics.fromAmplitudes(state, physics.resolveQubitCount(state, 0));
  return qubitCount > view.qubitCount ? physics.expandRegister(view, qubitCount) : view;
};

// Snapshot extraction classifies each displayed qubit from its Bloch vector plus any recorded measurement.
export const snapshotStateParticle = (
  state: QuantumState,
  qubit: number,
  measurements: MeasurementMap = {},
): ParticleSnapshot => {
  const measured = measurements[qubit];
  const inspection = measured === undefined ? physics.inspectQubit(state, qubit) : undefined;
  const { bloch, spherical, ket, mixed } = inspection
    ? physics.describeBlochVector(inspection.bloch)
    : physics.measuredBlochGeometry(measured!);
  return {
    qubit,
    bloch,
    spherical,
    ket,
    mixed,
    entangledWithRegister: inspection?.entanglement.status === 'entangled',
    entanglement: inspection?.entanglement,
    probOne: (1 - bloch.z) / 2,
    measured,
  };
};

/** One snapshot per wire of a state vector or density matrix. */
export const snapshotStateParticles = (
  state: QuantumState,
  measurements: MeasurementMap = {},
  qubitCount = state.qubitCount,
): ParticleSnapshot[] =>
  Array.from({ length: qubitCount }, (_, qubit) => snapshotStateParticle(state, qubit, measurements));

/** Compatibility wrapper for raw amplitude arrays. */
export const snapshotParticle = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  measurements: MeasurementMap = {},
): ParticleSnapshot => snapshotStateParticle(quantumView(state, qubitCount), qubit, measurements);

/** Compatibility wrapper for raw amplitude arrays. */
export const snapshotAllParticles = (
  state: Complex[],
  qubitCount: number,
  measurements: MeasurementMap = {},
): ParticleSnapshot[] => snapshotStateParticles(quantumView(state, qubitCount), measurements, qubitCount);

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
// A gate that added workspace wires is compared against the earlier state padded to the same width.
export const buildStateTransition = (
  gate: CircuitGate,
  stateBefore: QuantumState,
  stateAfter: QuantumState,
  measurementsBefore: MeasurementMap,
  measurementsAfter: MeasurementMap,
  qubitCount = stateAfter.qubitCount,
): OperationTransition => {
  const width = Math.max(qubitCount, stateBefore.qubitCount, stateAfter.qubitCount);
  const before = snapshotStateParticles(physics.expandRegister(stateBefore, width), measurementsBefore, qubitCount);
  const after = snapshotStateParticles(physics.expandRegister(stateAfter, width), measurementsAfter, qubitCount);
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

/** Compatibility wrapper for raw amplitude arrays. */
export const buildOperationTransition = (
  gate: CircuitGate,
  stateBefore: Complex[],
  stateAfter: Complex[],
  qubitCount: number,
  measurementsBefore: MeasurementMap,
  measurementsAfter: MeasurementMap,
): OperationTransition => buildStateTransition(
  gate,
  quantumView(stateBefore, qubitCount),
  quantumView(stateAfter, qubitCount),
  measurementsBefore,
  measurementsAfter,
  qubitCount,
);
