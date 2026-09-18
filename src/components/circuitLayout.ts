import type { CircuitGate, MeasurementMap, ParticleStartState } from '../simulator/types';

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
  if (gate.type === 'CNOT') return 'plus';
  if (gate.type === 'SWAP') return 'swap';
  if (gate.type === 'MEASURE') return 'measure';
  return 'box';
};

/** CCNOT is Toffoli (CCX): boxed X on the target, not a Z box or a CNOT-style plus. */
export const glyphLabelFor = (gate: CircuitGate, qubit: number, fallback: string): string => {
  if (gate.controls.includes(qubit)) return fallback;
  if (gate.type === 'CCNOT') return 'X';
  return fallback;
};

export const needsConnector = (gate: CircuitGate) => {
  const { min, max } = gateSpanQubits(gate);
  return Number.isFinite(min) && Number.isFinite(max) && max > min;
};

/** Half of a lane height, used to inset connectors so they stop on the wires. */
export const connectorEndInset = (rowHeight: number) => rowHeight / 2;

export type WireKind = 'classical' | 'quantum';

export const initialWireKind = (state?: ParticleStartState): WireKind =>
  state === 'sp' ? 'quantum' : 'classical';

const CLASSICAL_AFTER_GATES = new Set(['MEASURE', 'RESET']);
const SUPERPOSITION_ON_TARGET = new Set(['H']);
const SPREADS_SUPERPOSITION = new Set(['CNOT', 'CCNOT', 'CY']);

export const applyGateToWireKind = (kinds: readonly WireKind[], gate: CircuitGate): WireKind[] => {
  const next = kinds.slice();
  const type = String(gate.type);

  if (CLASSICAL_AFTER_GATES.has(type)) {
    gate.targets.forEach((qubit) => {
      next[qubit] = 'classical';
    });
    return next;
  }

  if (SUPERPOSITION_ON_TARGET.has(type)) {
    gate.targets.forEach((qubit) => {
      next[qubit] = 'quantum';
    });
    return next;
  }

  if (type === 'SWAP' && gate.targets.length >= 2) {
    const [left, right] = gate.targets;
    const swapped = next[left];
    next[left] = next[right];
    next[right] = swapped;
    return next;
  }

  if (SPREADS_SUPERPOSITION.has(type) && gate.controls.some((qubit) => next[qubit] === 'quantum')) {
    gate.targets.forEach((qubit) => {
      next[qubit] = 'quantum';
    });
  }

  return next;
};

/**
 * Per-column wire style: `=` classical (0p/1p or measured), `-` superposition.
 * The kind in a column is the incoming state before gates at that step apply.
 */
export const wireKindSegments = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  columnCount: number,
  measuredQubits: MeasurementMap = {},
): WireKind[][] => {
  const kinds = Array.from({ length: qubitCount }, (_, qubit) => initialWireKind(startStates[qubit]));
  const gatesByStep = new Map<number, CircuitGate[]>();
  gates.forEach((gate) => {
    const list = gatesByStep.get(gate.step) ?? [];
    list.push(gate);
    gatesByStep.set(gate.step, list);
  });

  const segments = Array.from({ length: qubitCount }, () => Array.from({ length: columnCount }, () => 'classical' as WireKind));
  for (let column = 0; column < columnCount; column += 1) {
    for (let qubit = 0; qubit < qubitCount; qubit += 1) {
      segments[qubit][column] = kinds[qubit];
    }
    (gatesByStep.get(column) ?? []).forEach((gate) => {
      const updated = applyGateToWireKind(kinds, gate);
      updated.forEach((kind, qubit) => {
        kinds[qubit] = kind;
      });
    });
  }

  Object.keys(measuredQubits).forEach((key) => {
    const qubit = Number(key);
    if (!Number.isInteger(qubit) || qubit < 0 || qubit >= qubitCount) return;
    const measureStep = gates.find((gate) => gate.type === 'MEASURE' && gate.targets.includes(qubit))?.step;
    const fromColumn = measureStep === undefined ? 0 : measureStep + 1;
    for (let column = fromColumn; column < columnCount; column += 1) {
      segments[qubit][column] = 'classical';
    }
  });

  return segments;
};
