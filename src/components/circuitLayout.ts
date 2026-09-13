import type { CircuitGate, ParticleStartState } from '../simulator/types';

export const MIN_CIRCUIT_COLUMNS = 6;
export const MIN_SLOT_REM = 1.7;
export const MAX_SLOT_REM = 2.7;
export const PLAY_DELAY_BASE_MS = 800;
export const MIN_PLAY_SPEED = 0.25;
export const MAX_PLAY_SPEED = 3;

export const circuitColumnCount = (gateCount: number, maxStep = -1, minColumns = MIN_CIRCUIT_COLUMNS) =>
  Math.max(minColumns, gateCount + 2, maxStep + 3);

export const playDelayMs = (speed: number, baseMs = PLAY_DELAY_BASE_MS) => {
  const clamped = Math.min(MAX_PLAY_SPEED, Math.max(MIN_PLAY_SPEED, speed));
  return Math.round(baseMs / clamped);
};

export const startStateKet = (state?: ParticleStartState) => {
  if (state === '1p') return '|1⟩';
  if (state === 'sp') return '|+⟩';
  return '|0⟩';
};

export const gateTouchedQubits = (gate: CircuitGate) => [...gate.controls, ...gate.targets];

export const gateSpanQubits = (gate: CircuitGate) => {
  const qubits = gateTouchedQubits(gate);
  return { min: Math.min(...qubits), max: Math.max(...qubits) };
};

export type CircuitGlyphKind = 'box' | 'control' | 'plus' | 'swap' | 'measure';

export const glyphKindFor = (gate: CircuitGate, qubit: number): CircuitGlyphKind => {
  if (gate.controls.includes(qubit)) return 'control';
  if (gate.type === 'CNOT' || gate.type === 'CCNOT') return 'plus';
  if (gate.type === 'SWAP') return 'swap';
  if (gate.type === 'MEASURE') return 'measure';
  return 'box';
};

export const needsConnector = (gate: CircuitGate) => {
  const { min, max } = gateSpanQubits(gate);
  return Number.isFinite(min) && Number.isFinite(max) && max > min;
};
