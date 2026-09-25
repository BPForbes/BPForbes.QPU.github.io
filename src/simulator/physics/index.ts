/**
 * Public surface of the physics layer. Callers use the `physics` engine
 * instance; the kernels under state/, measurement/, analysis/, noise/,
 * dynamics/ and numerics/ are its implementation and are not re-exported.
 */
export { PhysicsEngine, physics } from './PhysicsEngine';
export type { BlochGeometry, GlobalInspection, NoiseContext, QubitInspection, SubsystemInspection } from './PhysicsEngine';
export type { DensityMatrix, DensityMatrixState, QuantumState, StateVectorState } from './state/QuantumState';
export type { MeasurementDiagnostics, MeasurementResult } from './measurement/Measurement';
export type { MeasurementBasis } from './measurement/MeasurementBasis';
export type { BlochVector, MixedStateMetrics, PsiKet, SphericalCoordinates } from './analysis/Bloch';
export type { EntanglementAssessment, EntanglementMethod, EntanglementStatus } from './analysis/Entanglement';
export type { InterferenceAnalysis, InterferenceOperation, InterferenceTerm } from './analysis/Interference';
export type { PhaseComparison, PhaseRelation, RelativePhase } from './analysis/Phase';
export type { DecoherenceModel, NoiseChannel, NoiseModel, PhysicalTimingModel } from './noise/NoiseModel';
export type { Hamiltonian, TimeDependentHamiltonian } from './dynamics/Hamiltonian';
export type { DriveDiagnostics, DriveRegime } from './frequency/DriveDiagnostics';
export type {
  CouplingKind,
  DriveApproximation,
  PhysicalSegment,
  PhysicalSystem,
  QubitCoupling,
} from './frequency/PhysicalEvolution';
export type { PhysicalClock } from './frequency/PhysicalClock';
export type { ControlPulse, PulseEnvelope } from './frequency/Pulses';
export type { PhysicalFrame, QubitPhysicsProfile } from './frequency/QubitProfile';
export type { PhysicalUnits } from './frequency/Units';
export type { ComplexMatrix } from './numerics/linearAlgebra';
export { PhysicsValidationError } from './validation/Validation';
export type { StateValidationOptions, ValidationTolerances } from './validation/Validation';

// Visualization tracker: observes the engine for the Bloch view.
export {
  blochVectorForQubit,
  buildOperationTransition,
  computeParticleDeltas,
  particleDelta,
  snapshotAllParticles,
  snapshotParticle,
} from './particleTracking';
export type { OperationTransition, ParticleDelta, ParticleSnapshot } from './particleTracking';

// Browser capability probe (not physics); kept here for existing imports.
export { hasWebGpu } from './webGpu';
