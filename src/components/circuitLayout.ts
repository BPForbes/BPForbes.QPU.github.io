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

/** Half of a lane height, used to inset connectors so they stop on the wires. */
export const connectorEndInset = (rowHeight: number) => rowHeight / 2;

export type CircuitDisplayMode = 'standard' | 'blocks';

export const SHOW_QUBIT_WIRES_LABEL = 'Show Qubit Wires';
export const DEFAULT_SHOW_QUBIT_WIRES = true;

export const circuitDisplayMode = (showQubitWires: boolean): CircuitDisplayMode =>
  showQubitWires ? 'standard' : 'blocks';

export const circuitViewTitle = (showQubitWires: boolean) =>
  showQubitWires ? 'Standard circuit view' : 'Gate block view';

export const circuitViewTip = (showQubitWires: boolean) => (
  showQubitWires
    ? 'Black wires stay equal length and shrink their spacing as more gates are added. Active steps use a red outline; measured particles turn red on the wire.'
    : 'Gate Block View uses compact labeled blocks on drop lanes. Active steps use a red outline. The circuit, measurements, and simulator are unchanged.'
);

/** Conventional gate-type names for Gate Block View (CNOT, AND, H) rather than palette glyphs (CX). */
export const blockViewLabel = (gate: Pick<CircuitGate, 'type'>) => String(gate.type);
