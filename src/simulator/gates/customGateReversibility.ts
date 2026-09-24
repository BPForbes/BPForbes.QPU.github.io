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
 * linear: only reversible built-ins or custom gates that passed this check, and no
 * classical conditions.
 */
import type { compileQpuProtocol } from '../compiler/qpuAst';
import { add, type Complex, magnitudeSquared, mul, ONE, ZERO } from '../complex';
import type { CircuitGate, ExecutionResult, MeasurementMap } from '../types';
import { getCustomGateRecord } from './customGateStore';
import { applyInverseAwareDefinition, invertCircuitGate } from './inverse';
import { hasBit } from './operations';
import { preconfiguredGateMap } from './preconfigured';

export type ReversibilityResult = { reversible: true } | { reversible: false; reason: string };

/** Runs a nested custom gate; passed in by the engine to avoid an import cycle. */
export type NestedCustomGateRunner = (
  state: Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
) => ExecutionResult;

type CompiledGate = ReturnType<typeof compileQpuProtocol>;

/** Visible wires are the matrix's rows/columns; workspace wires must start and end at |0⟩. */
type WireLayout = {
  qubitCount: number;
  visible: number[];
  workspace: number[];
  dimension: number;
};

/** Bump when the rules change so records saved under older rules are re-checked. */
export const REVERSIBILITY_CHECK_VERSION = 3;

const NON_UNITARY_TYPES = new Set(['MEASURE', 'RESET', 'SAVE_STATE', 'LOAD_STATE']);
const MAX_VISIBLE_WIRES = 8;
const MAX_TOTAL_WIRES = 16;
const EPSILON = 1e-6;

const conjugateDot = (left: Complex[], right: Complex[]): Complex => left.reduce(
  (sum, value, index) => add(sum, mul({ re: value.re, im: -value.im }, right[index])),
  ZERO,
);

const isClose = (value: Complex, re: number) => Math.hypot(value.re - re, value.im) < EPSILON;

/** First non-undefined result of the checks, run in order and stopping early. */
const firstIssue = (checks: Array<() => string | undefined>) => {
  for (const check of checks) {
    const issue = check();
    if (issue) return issue;
  }
  return undefined;
};

// --- Criterion 1, structural: every step must be a fixed unitary ---

const stepIssue = (gate: CircuitGate): string | undefined => {
  const type = String(gate.type);
  if (type === 'CYCLE') return undefined;
  if (gate.condition || gate.branch) {
    return `${type} runs under an IF/ELSE condition, which depends on the state and is not a fixed unitary matrix (criterion 1).`;
  }
  if (NON_UNITARY_TYPES.has(type)) return `${type} is not unitary, so the gate has no inverse (criterion 1).`;
  const builtIn = preconfiguredGateMap[type];
  if (builtIn) {
    return builtIn.supportsReverse
      ? undefined
      : `${type} is not a reversible built-in gate, so the gate cannot be verified as unitary (criterion 1).`;
  }
  const nested = getCustomGateRecord(type);
  if (nested?.reversible) return undefined;
  const detail = nested?.reversibilityIssue ? ` (${nested.reversibilityIssue})` : '';
  return `Custom gate ${type} is not reversible${detail}, so this gate is not either (criterion 1).`;
};

const structuralIssue = (gates: CircuitGate[]) => firstIssue(gates.map((gate) => () => stepIssue(gate)));

// --- Wire layout and simulation ---

const wireLayout = (compiled: CompiledGate): WireLayout => {
  const visible = [...new Set([
    ...compiled.processParams.map((param) => param.qubitIndex),
    ...compiled.returnValues.map((value) => value.qubitIndex),
  ])];
  const qubitCount = compiled.qubitCount;
  const workspace = Array.from({ length: qubitCount }, (_, qubit) => qubit).filter((qubit) => !visible.includes(qubit));
  return { qubitCount, visible, workspace, dimension: 2 ** visible.length };
};

const sizeIssue = ({ visible, qubitCount }: WireLayout) => (
  visible.length > MAX_VISIBLE_WIRES || qubitCount > MAX_TOTAL_WIRES
    ? `Too large to verify (${visible.length} visible wires, ${qubitCount} total; limits ${MAX_VISIBLE_WIRES} and ${MAX_TOTAL_WIRES}).`
    : undefined
);

/** Full-register basis index for visible bit pattern `bits`, with workspace at |0⟩. */
const basisIndex = ({ visible, qubitCount }: WireLayout, bits: number) => visible.reduce(
  (index, qubit, position) => (bits & (1 << position) ? index | (1 << (qubitCount - qubit - 1)) : index),
  0,
);

const inputLabel = ({ visible }: WireLayout, bits: number) => visible.map((_, position) => (bits >> position) & 1).join('');

const basisState = (index: number, qubitCount: number) =>
  Array.from({ length: 2 ** qubitCount }, (_, entry) => (entry === index ? ONE : ZERO));

/** A nested gate appends its workspace as the lowest bits; its own check proved that workspace returns to |0⟩. */
const trimNestedWorkspace = (expanded: Complex[], qubitCount: number) => {
  const shift = Math.round(Math.log2(expanded.length)) - qubitCount;
  // Any amplitude dropped here shows up in the recovery and norm checks.
  return shift > 0 ? Array.from({ length: 2 ** qubitCount }, (_, index) => expanded[index << shift]) : expanded;
};

const runStep = (state: Complex[], qubitCount: number, gate: CircuitGate, runNested: NestedCustomGateRunner) => {
  if (gate.type === 'CYCLE') return state;
  const builtIn = preconfiguredGateMap[gate.type];
  if (builtIn) return applyInverseAwareDefinition(builtIn, state, qubitCount, gate, {}, {}).state;
  return trimNestedWorkspace(runNested(state, qubitCount, gate, {}).state, qubitCount);
};

const runSteps = (state: Complex[], qubitCount: number, steps: CircuitGate[], runNested: NestedCustomGateRunner) =>
  steps.reduce((current, gate) => runStep(current, qubitCount, gate, runNested), state);

// --- Criterion 2: the dagger, on fresh workspace, recovers each basis input ---

const leavesWorkspaceDirty = (output: Complex[], { workspace, qubitCount }: WireLayout) => output.some((amplitude, index) => (
  magnitudeSquared(amplitude) > EPSILON && workspace.some((qubit) => hasBit(index, qubit, qubitCount))
));

const recoveryIssue = (
  layout: WireLayout,
  bits: number,
  output: Complex[],
  inverseSteps: CircuitGate[],
  runNested: NestedCustomGateRunner,
) => {
  if (leavesWorkspaceDirty(output, layout)) {
    return `Input ${inputLabel(layout, bits)} leaves an internal wire away from |0⟩, so the dagger (which starts internal wires at |0⟩) cannot recover it (criterion 2).`;
  }
  const recovered = runSteps(output, layout.qubitCount, inverseSteps, runNested);
  return magnitudeSquared(recovered[basisIndex(layout, bits)]) < 1 - EPSILON
    ? `Running the dagger after the gate does not return input ${inputLabel(layout, bits)} (criterion 2).`
    : undefined;
};

/** Simulate every basis input; returns U's columns on the visible wires, or the first recovery failure. */
const buildColumns = (
  compiled: CompiledGate,
  layout: WireLayout,
  runNested: NestedCustomGateRunner,
): { columns: Complex[][] } | { issue: string } => {
  const inverseSteps = compiled.gates.slice().reverse().map(invertCircuitGate);
  const columns: Complex[][] = [];
  for (let bits = 0; bits < layout.dimension; bits += 1) {
    const output = runSteps(basisState(basisIndex(layout, bits), layout.qubitCount), layout.qubitCount, compiled.gates, runNested);
    const issue = recoveryIssue(layout, bits, output, inverseSteps, runNested);
    if (issue) return { issue };
    columns.push(Array.from({ length: layout.dimension }, (_, row) => output[basisIndex(layout, row)]));
  }
  return { columns };
};

// --- Criteria 4, 3 and 1 on the matrix ---

const normIssue = (layout: WireLayout, columns: Complex[][]) => {
  const bad = columns.findIndex((column) => !isClose(conjugateDot(column, column), 1));
  return bad >= 0 ? `Output for input ${inputLabel(layout, bad)} does not have norm 1 (criterion 4).` : undefined;
};

const overlapIssue = (layout: WireLayout, columns: Complex[][]) => {
  for (let x = 0; x < columns.length; x += 1) {
    for (let y = 0; y < x; y += 1) {
      if (!isClose(conjugateDot(columns[y], columns[x]), 0)) {
        return `Inputs ${inputLabel(layout, y)} and ${inputLabel(layout, x)} map to overlapping outputs, so the gate is not one-to-one (criterion 3).`;
      }
    }
  }
  return undefined;
};

/** Orthonormal columns give U†U = I; check the rows too so UU† = I is verified, not assumed. */
const rowIdentityIssue = (columns: Complex[][]) => {
  const rows = columns.map((_, row) => columns.map((column) => column[row]));
  for (let r = 0; r < rows.length; r += 1) {
    for (let s = 0; s <= r; s += 1) {
      if (!isClose(conjugateDot(rows[s], rows[r]), r === s ? 1 : 0)) return 'UU† is not the identity (criterion 1).';
    }
  }
  return undefined;
};

// --- Entry point ---

const verify = (compiled: CompiledGate, runNested: NestedCustomGateRunner): string | undefined => {
  const layout = wireLayout(compiled);
  const upfront = firstIssue([() => structuralIssue(compiled.gates), () => sizeIssue(layout)]);
  if (upfront) return upfront;
  const built = buildColumns(compiled, layout, runNested);
  if ('issue' in built) return built.issue;
  const { columns } = built;
  return firstIssue([
    () => normIssue(layout, columns),
    () => overlapIssue(layout, columns),
    () => rowIdentityIssue(columns),
  ]);
};

export const checkCustomGateReversibility = (
  compiled: CompiledGate,
  runNested: NestedCustomGateRunner,
): ReversibilityResult => {
  try {
    const issue = verify(compiled, runNested);
    return issue ? { reversible: false, reason: issue } : { reversible: true };
  } catch (error) {
    return { reversible: false, reason: `Could not verify reversibility: ${(error as Error).message}` };
  }
};
