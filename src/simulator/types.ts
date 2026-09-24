/**
 * Core simulator and protocol type definitions.
 *
 * These exported shapes are intentionally colocated so React components, gate
 * definitions, protocol parsing, and tests share the same vocabulary for gates,
 * measurements, particles, and QPU operations.
 */
import { Complex } from './complex';

export type PreconfiguredGateType =
  | 'X'
  | 'Y'
  | 'Z'
  | 'H'
  | 'S'
  | 'T'
  | 'RX'
  | 'RY'
  | 'RZ'
  | 'CNOT'
  | 'CCNOT'
  | 'CZ'
  | 'CY'
  | 'CPHASE'
  | 'SWAP'
  | 'PHASE'
  | 'MEASURE'
  | 'RESET'
  | 'NOT'
  | 'AND'
  | 'NAND'
  | 'OR'
  | 'XOR';

// Gate identifiers include the built-in set plus user-registered custom ids.
export type GateType = PreconfiguredGateType | (string & {});

export type ParticleStartState = '0p' | '1p' | 'sp';

export const preconfiguredGateTypes = [
  'X',
  'Y',
  'Z',
  'H',
  'S',
  'T',
  'RX',
  'RY',
  'RZ',
  'CNOT',
  'CCNOT',
  'CZ',
  'CY',
  'CPHASE',
  'SWAP',
  'PHASE',
  'MEASURE',
  'RESET',
  'NOT',
  'AND',
  'NAND',
  'OR',
  'XOR',
] as const satisfies readonly PreconfiguredGateType[];

/** @deprecated Use preconfiguredPaletteGates() from gates/registry for palette listing. */
export const gateTypes = [...preconfiguredGateTypes] as const;

export const isPreconfiguredGateType = (value: string): value is PreconfiguredGateType =>
  (preconfiguredGateTypes as readonly string[]).includes(value);

/**
 * @deprecated Use `isKnownGateType` from `gates/registry` to validate palette and custom gate ids.
 */
export const isGateType = (value: string): boolean => isPreconfiguredGateType(value);

export type QpuOperation =
  | 'INCREASECYCLE'
  | 'COMPILEPROCESS'
  | 'FREE'
  | 'SET'
  | 'JOIN'
  | 'SPLIT'
  | 'CALL'
  | 'DECLARECHILD'
  | 'RUNCHILD'
  | 'REC'
  | 'RECUR'
  | 'EXIT'
  | DerivedGateType
  | 'MEASURE'
  | 'RETURNVALS'
  | 'ACCEPTVALS'
  | 'MASTERVAL'
  | 'SAVE_STATE'
  | 'LOAD_STATE'
  | 'MAIN-PROCESS'
  | 'CREATETOKEN'
  | 'DELETETOKEN'
  | PrimitiveGateType;

export type PrimitiveGateType =
  | 'X'
  | 'Y'
  | 'Z'
  | 'H'
  | 'S'
  | 'T'
  | 'RX'
  | 'RY'
  | 'RZ'
  | 'CNOT'
  | 'CCNOT'
  | 'CZ'
  | 'CY'
  | 'CPHASE'
  | 'SWAP'
  | 'PHASE'
  | 'MEASURE'
  | 'RESET';

export type DerivedGateType = 'NOT' | 'AND' | 'NAND' | 'OR' | 'XOR';

/** Classical feed-forward condition checked against a prior measurement. */
export type GateCondition = {
  qubit: number;
  equals: 0 | 1;
};

export type CircuitGate = {
  id: string;
  type: GateType;
  step: number;
  targets: number[];
  controls: number[];
  phase?: number;
  /** Dagger of the forward gate. Self-inverse gates keep the same matrix. */
  inverse?: boolean;
  source?: string;
  customGateId?: string;
  /** Timeline cycle that produced this gate. INCREASECYCLE advances it. */
  cycle?: number;
  /** Named simulator checkpoint for SAVE_STATE and LOAD_STATE. */
  checkpoint?: string;
  /** Optional classical condition; evaluated only after the named qubit is measured. */
  condition?: GateCondition;
};

export type MeasurementMap = Record<number, 0 | 1>;

export type StateCheckpoint = {
  state: Complex[];
  measurements: MeasurementMap;
};

export type {
  MixedStateMetrics,
  OperationTransition,
  ParticleDelta,
  ParticleSnapshot,
  PsiKet,
  SphericalCoordinates,
} from './physics/particleTracking';

// Execution results may include optional particle snapshots and per-gate transitions when tracing is enabled.
export type ExecutionResult = {
  state: Complex[];
  measurements: MeasurementMap;
  log: string[];
  particles?: import('./physics/particleTracking').ParticleSnapshot[];
  transitions?: import('./physics/particleTracking').OperationTransition[];
  checkpoints?: Record<string, StateCheckpoint>;
};
