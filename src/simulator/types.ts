/**
 * Core simulator and protocol type definitions.
 *
 * These exported shapes are intentionally colocated so React components, gate
 * definitions, protocol parsing, and tests share the same vocabulary for gates,
 * measurements, particles, and QPU operations.
 */
import { Complex } from './complex';
import type { MeasurementBasis } from './physics/measurement/MeasurementBasis';

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
  | 'TREC'
  | 'RECUR'
  | 'EXIT'
  | 'IF'
  | 'ELSE'
  | 'ENDIF'
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

/** Value a gate predicate is compared with: definite 0, definite 1, or superposed (S). */
export type ConditionValue = 0 | 1 | 's';

/** Display/source form of a `ConditionValue`, matching the 0p/1p/sp particle-state vocabulary. */
export const conditionValueLabel = (value: ConditionValue): '0p' | '1p' | 'sp' =>
  (value === 's' ? 'sp' : `${value}p`);

/**
 * Gate-expression test from `IF (GATE -I … -O …) = 0|1|S`.
 * The gate runs on a scratch copy of the state (the circuit is not changed)
 * and the result wire is classified as 0, 1, or S.
 */
export type ConditionPredicate = {
  type: GateType;
  /** Every -I wire, in source order. */
  inputs: number[];
  /** The -O wire. */
  output: number;
  /**
   * True when a multi-input Boolean gate names one of its inputs as -O
   * (e.g. AND -I A B -O B): the result goes to a fresh |0⟩ wire so all
   * inputs stay as operands.
   */
  scratch: boolean;
  phase?: number;
  inverse?: boolean;
  expect: ConditionValue;
  /** `!=` in source, or the ELSE half of the block. */
  negate: boolean;
  /** Compact label for the canvas, e.g. AND(A,B). */
  text: string;
};

/**
 * Classical feed-forward condition. Without `predicate` it checks a prior
 * measurement (`qubit` = `equals`). With `predicate` it evaluates a gate
 * expression; `qubit` is then the wire the result is read from.
 */
export type GateCondition = {
  qubit: number;
  equals: 0 | 1;
  predicate?: ConditionPredicate;
};

/**
 * UI metadata for structured IF/ELSE blocks.
 * The simulator only evaluates `condition`; the canvas uses `branch` for labels
 * and taken/skipped styling.
 */
export type ClassicalBranchMeta = {
  groupId: string;
  kind: 'if' | 'else';
  sourceQubit: number;
  equals: 0 | 1;
};

/**
 * Compile-time recursion frame that produced this gate.
 * REC/TREC/RECUR expand into ordinary gates; this metadata drives canvas badges.
 */
export type RecursionFrameMeta = {
  process: string;
  depth: number;
  level: number;
  rootDepth: number;
  mode: 'tco' | 'stack';
  /**
   * Unique per call site that starts a recursion chain, so two calls to the
   * same child with the same DEPTH stay separate on the canvas.
   */
  invocation?: string;
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
  /** Logical cycle (program stage) that produced this gate; INCREASECYCLE advances it. Not physical time. */
  cycle?: number;
  /** Named simulator checkpoint for SAVE_STATE and LOAD_STATE. */
  checkpoint?: string;
  /** MEASURE observable; omitted means the computational (Z) basis. */
  basis?: MeasurementBasis;
  /** Optional classical condition; evaluated only after the named qubit is measured. */
  condition?: GateCondition;
  /** Structured IF/ELSE origin; absent for bare `-IF` feed-forward. */
  branch?: ClassicalBranchMeta;
  /** Present when this gate came from a bounded REC/TREC expansion. */
  recursion?: RecursionFrameMeta;
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
// This is the Complex[] compatibility view; engine-native runs (executeCircuit) return QuantumExecutionResult,
// whose state is a QuantumState and may be a density matrix.
export type ExecutionResult = {
  state: Complex[];
  measurements: MeasurementMap;
  log: string[];
  particles?: import('./physics/particleTracking').ParticleSnapshot[];
  transitions?: import('./physics/particleTracking').OperationTransition[];
  checkpoints?: Record<string, StateCheckpoint>;
  /** Result of each evaluated condition, by gate id (true = ran, false = skipped). */
  conditionOutcomes?: Record<string, boolean>;
};
