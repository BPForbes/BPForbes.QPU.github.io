/**
 * Shared inverse helpers for built-in and custom reversible gates.
 *
 * Custom-gate expansion and the main engine both need the same dagger rules so
 * S/T/PHASE/RX/RY/RZ/CPHASE inverses stay consistent.
 */
import type { CircuitGate, ExecutionResult, MeasurementMap } from '../types';
import type { Complex } from '../complex';
import { applySingleQubitGate } from './operations';
import { phaseMatrix } from './matrices';
import { preconfiguredGateMap } from './preconfigured';
import type { GateDefinition } from './types';

const PARAMETERIZED_ANGLE_GATES = new Set(['PHASE', 'RX', 'RY', 'RZ', 'CPHASE']);

export const invertCircuitGate = (gate: CircuitGate): CircuitGate => {
  if (gate.type === 'CYCLE') return { ...gate };
  const definition = preconfiguredGateMap[String(gate.type)];
  if (!definition?.supportsReverse) {
    throw new Error(`${gate.type} cannot be inverted.`);
  }
  if (PARAMETERIZED_ANGLE_GATES.has(String(gate.type))) {
    return {
      ...gate,
      phase: -(gate.phase ?? 0),
      inverse: !gate.inverse,
    };
  }
  return {
    ...gate,
    inverse: !gate.inverse,
  };
};

/** Apply S†/T† when marked inverse; otherwise run the registered definition. */
export const applyInverseAwareDefinition = (
  definition: GateDefinition,
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  librarySources: Record<string, string> = {},
): ExecutionResult => {
  if (gate.inverse && (gate.type === 'S' || gate.type === 'T')) {
    const angle = gate.type === 'S' ? -Math.PI / 2 : -Math.PI / 4;
    const target = gate.targets[0];
    return {
      state: applySingleQubitGate(state, qubitCount, target, phaseMatrix(angle)),
      measurements,
      log: [`${gate.type}† applied phase ${angle.toFixed(3)} on q${target}.`],
    };
  }
  return definition.apply({ state, qubitCount, gate, measurements, librarySources });
};
