/**
 * Numeric reversibility check for custom gates.
 *
 * A custom gate may be run backwards (dg/inv) only when its action on its visible
 * wires (PARAMS and RETURNVALS) is a unitary matrix U whose dagger, as the engine
 * actually runs it on fresh |0⟩ workspace, recovers every input:
 *   1. Unitary: U†U = UU† = I.
 *   2. Recovery: running the dagger steps on U|x⟩ gives back |x⟩.
 *   3. Bijective: distinct inputs map to distinct (orthogonal) outputs.
 *   4. Norm preserving: every output has norm 1.
 * The matrix is built by simulating each basis input, so the gate must first be
 * linear: only reversible built-in steps and no classical conditions.
 */
import type { compileQpuProtocol } from '../compiler/qpuAst';
import { add, type Complex, magnitudeSquared, mul, ONE, ZERO } from '../complex';
import type { CircuitGate } from '../types';
import { applyInverseAwareDefinition, invertCircuitGate } from './inverse';
import { hasBit } from './operations';
import { preconfiguredGateMap } from './preconfigured';

export type ReversibilityResult = { reversible: true } | { reversible: false; reason: string };

/** Bump when the rules change so records saved under older rules are re-checked. */
export const REVERSIBILITY_CHECK_VERSION = 2;

const NON_UNITARY_TYPES = new Set(['MEASURE', 'RESET', 'SAVE_STATE', 'LOAD_STATE']);
const MAX_VISIBLE_WIRES = 8;
const MAX_TOTAL_WIRES = 16;
const EPSILON = 1e-6;

const conjugateDot = (left: Complex[], right: Complex[]): Complex => left.reduce(
  (sum, value, index) => add(sum, mul({ re: value.re, im: -value.im }, right[index])),
  ZERO,
);

const isClose = (value: Complex, re: number) => Math.hypot(value.re - re, value.im) < EPSILON;

const runSteps = (state: Complex[], qubitCount: number, steps: CircuitGate[]) => steps.reduce((current, gate) => {
  if (gate.type === 'CYCLE') return current;
  return applyInverseAwareDefinition(preconfiguredGateMap[gate.type], current, qubitCount, gate, {}, {}).state;
}, state);

const structuralIssue = (gates: CircuitGate[]): string | undefined => {
  for (const gate of gates) {
    if (gate.type === 'CYCLE') continue;
    if (gate.condition || gate.branch) {
      return `${gate.type} runs under an IF/ELSE condition, which depends on the state and is not a fixed unitary matrix (criterion 1).`;
    }
    if (NON_UNITARY_TYPES.has(String(gate.type))) {
      return `${gate.type} is not unitary, so the gate has no inverse (criterion 1).`;
    }
    if (!preconfiguredGateMap[String(gate.type)]?.supportsReverse) {
      return `${gate.type} is not a reversible built-in gate, so the gate cannot be verified as unitary (criterion 1).`;
    }
  }
  return undefined;
};

export const checkCustomGateReversibility = (
  compiled: ReturnType<typeof compileQpuProtocol>,
): ReversibilityResult => {
  const { gates, qubitCount } = compiled;
  const structural = structuralIssue(gates);
  if (structural) return { reversible: false, reason: structural };

  const visible = [...new Set([
    ...compiled.processParams.map((param) => param.qubitIndex),
    ...compiled.returnValues.map((value) => value.qubitIndex),
  ])];
  const workspace = Array.from({ length: qubitCount }, (_, qubit) => qubit).filter((qubit) => !visible.includes(qubit));
  if (visible.length > MAX_VISIBLE_WIRES || qubitCount > MAX_TOTAL_WIRES) {
    return {
      reversible: false,
      reason: `Too large to verify (${visible.length} visible wires, ${qubitCount} total; limits ${MAX_VISIBLE_WIRES} and ${MAX_TOTAL_WIRES}).`,
    };
  }

  const inverseSteps = gates.slice().reverse().map(invertCircuitGate);
  const dimension = 2 ** visible.length;
  const basisIndex = (bits: number) => visible.reduce(
    (index, qubit, position) => (bits & (1 << position) ? index | (1 << (qubitCount - qubit - 1)) : index),
    0,
  );
  const inputLabel = (bits: number) => visible.map((_, position) => ((bits >> position) & 1)).join('');

  // columns[x] = U|x⟩ restricted to the visible wires (workspace at |0⟩).
  const columns: Complex[][] = [];
  for (let bits = 0; bits < dimension; bits += 1) {
    const start = basisIndex(bits);
    const input = Array.from({ length: 2 ** qubitCount }, (_, index) => (index === start ? ONE : ZERO));
    const output = runSteps(input, qubitCount, gates);

    const dirty = output.some((amplitude, index) => (
      magnitudeSquared(amplitude) > EPSILON && workspace.some((qubit) => hasBit(index, qubit, qubitCount))
    ));
    if (dirty) {
      return {
        reversible: false,
        reason: `Input ${inputLabel(bits)} leaves an internal wire away from |0⟩, so the dagger (which starts internal wires at |0⟩) cannot recover it (criterion 2).`,
      };
    }

    const recovered = runSteps(output, qubitCount, inverseSteps);
    if (magnitudeSquared(recovered[start]) < 1 - EPSILON) {
      return { reversible: false, reason: `Running the dagger after the gate does not return input ${inputLabel(bits)} (criterion 2).` };
    }

    columns.push(Array.from({ length: dimension }, (_, row) => output[basisIndex(row)]));
  }

  for (let x = 0; x < dimension; x += 1) {
    if (!isClose(conjugateDot(columns[x], columns[x]), 1)) {
      return { reversible: false, reason: `Output for input ${inputLabel(x)} does not have norm 1 (criterion 4).` };
    }
    for (let y = 0; y < x; y += 1) {
      if (!isClose(conjugateDot(columns[y], columns[x]), 0)) {
        return {
          reversible: false,
          reason: `Inputs ${inputLabel(y)} and ${inputLabel(x)} map to overlapping outputs, so the gate is not one-to-one (criterion 3).`,
        };
      }
    }
  }

  // Orthonormal columns give U†U = I; check the rows too so UU† = I is verified, not assumed.
  const rows = Array.from({ length: dimension }, (_, row) => columns.map((column) => column[row]));
  for (let r = 0; r < dimension; r += 1) {
    for (let s = 0; s <= r; s += 1) {
      if (!isClose(conjugateDot(rows[s], rows[r]), r === s ? 1 : 0)) {
        return { reversible: false, reason: 'UU† is not the identity (criterion 1).' };
      }
    }
  }

  return { reversible: true };
};
