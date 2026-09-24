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

/** One classical wire per measured qubit, in qubit order. Unmeasured circuits have none. */
export const classicalWireQubits = (
  qubitCount: number,
  gates: CircuitGate[],
  measurements: MeasurementMap = {},
): number[] => {
  const measured = new Set<number>();
  gates.forEach((gate) => {
    if (gate.type !== 'MEASURE') return;
    gate.targets.forEach((qubit) => {
      if (qubit >= 0 && qubit < qubitCount) measured.add(qubit);
    });
  });
  Object.keys(measurements).forEach((key) => {
    const qubit = Number(key);
    if (Number.isInteger(qubit) && qubit >= 0 && qubit < qubitCount) measured.add(qubit);
  });
  return [...measured].sort((left, right) => left - right);
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

/** CZ/CY show a boxed Pauli letter on the target, not the two-letter gate id. CX keeps the plus. */
export const glyphLabelFor = (gate: CircuitGate, qubit: number, fallback: string): string => {
  if (gate.controls.includes(qubit)) return fallback;
  if (gate.type === 'CZ') return 'Z';
  if (gate.type === 'CY') return 'Y';
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

  // H is its own inverse on |0⟩/|1⟩/|+⟩/|-⟩, so a second H (or H on sp) returns a computational bit.
  if (type === 'H') {
    gate.targets.forEach((qubit) => {
      next[qubit] = next[qubit] === 'quantum' ? 'classical' : 'quantum';
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

export type WireKindHalves = { incoming: WireKind; outgoing: WireKind };

/**
 * Per-column wire style: `=` classical (0p/1p or measured), `-` superposition.
 * `incoming` is the left half of a column (before gates at that step apply) and
 * `outgoing` the right half, so the style flips at the gate glyph, not a column later.
 */
export const wireKindHalves = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  columnCount: number,
  measuredQubits: MeasurementMap = {},
): WireKindHalves[][] => {
  const kinds = Array.from({ length: qubitCount }, (_, qubit) => initialWireKind(startStates[qubit]));
  const gatesByStep = new Map<number, CircuitGate[]>();
  gates.forEach((gate) => {
    const list = gatesByStep.get(gate.step) ?? [];
    list.push(gate);
    gatesByStep.set(gate.step, list);
  });

  const segments = Array.from({ length: qubitCount }, () =>
    Array.from({ length: columnCount }, (): WireKindHalves => ({ incoming: 'classical', outgoing: 'classical' })),
  );
  for (let column = 0; column < columnCount; column += 1) {
    const incoming = kinds.slice();
    (gatesByStep.get(column) ?? []).forEach((gate) => {
      const updated = applyGateToWireKind(kinds, gate);
      updated.forEach((kind, qubit) => {
        kinds[qubit] = kind;
      });
    });
    for (let qubit = 0; qubit < qubitCount; qubit += 1) {
      segments[qubit][column] = { incoming: incoming[qubit], outgoing: kinds[qubit] };
    }
  }

  Object.keys(measuredQubits).forEach((key) => {
    const qubit = Number(key);
    if (!Number.isInteger(qubit) || qubit < 0 || qubit >= qubitCount) return;
    const hasMeasureGate = gates.some((gate) => gate.type === 'MEASURE' && gate.targets.includes(qubit));
    // Runtime Measure all/target has no meter on the diagram. A MEASURE box already
    // updated later segments, including a following H, so do not overwrite those.
    if (hasMeasureGate) return;
    for (let column = 0; column < columnCount; column += 1) {
      segments[qubit][column] = { incoming: 'classical', outgoing: 'classical' };
    }
  });

  return segments;
};

/** Incoming (left-half) wire kind per column. */
export const wireKindSegments = (
  qubitCount: number,
  gates: CircuitGate[],
  startStates: ParticleStartState[] = [],
  columnCount: number,
  measuredQubits: MeasurementMap = {},
): WireKind[][] =>
  wireKindHalves(qubitCount, gates, startStates, columnCount, measuredQubits).map((row) =>
    row.map((halves) => halves.incoming),
  );
