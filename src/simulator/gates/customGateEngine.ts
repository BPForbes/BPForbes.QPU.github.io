import { compileQpuProtocol } from '../compiler/qpuAst';
import type { CircuitGate, ExecutionResult, MeasurementMap } from '../types';
import type { GateDefinition } from './types';
import { gateIoArity } from './types';
import { physics } from '../physics/PhysicsEngine';
import { checkCustomGateReversibility, REVERSIBILITY_CHECK_VERSION, type NestedCustomGateRunner } from './customGateReversibility';
import { preconfiguredGateMap } from './preconfigured';
import { conditionSatisfied, remapConditionWires } from './conditions';
import {
  getCustomGateRecord,
  listCustomGateRecords,
  readStore,
  removeCustomGateRecord as removeStoredRecord,
  writeStore,
  type CustomGateRecord,
} from './customGateStore';

export { getCustomGateRecord, listCustomGateRecords, type CustomGateRecord };
import { applyInverseAwareDefinition, invertCircuitGate } from './inverse';

const assertCustomGateIdAvailable = (trimmedId: string) => {
  const conflict = Object.keys(preconfiguredGateMap).find((id) => id.toLowerCase() === trimmedId.toLowerCase());
  if (conflict) {
    throw new Error(`Custom gate id '${trimmedId}' conflicts with preconfigured gate '${conflict}'.`);
  }
};


const PRECONFIGURED_HUES = [0, 25, 195, 260, 290, 120, 84, 205, 270, 142, 158, 228, 45, 315];

const randomCustomColor = (usedColors: Set<string>) => {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const hue = Math.floor(Math.random() * 360);
    const color = `linear-gradient(135deg, hsl(${hue} 78% 58%), hsl(${(hue + 36) % 360} 72% 42%))`;
    if (!usedColors.has(color)) return color;
  }
  const hue = Math.floor(Math.random() * 360);
  return `linear-gradient(135deg, hsl(${hue} 78% 58%), hsl(${(hue + 36) % 360} 72% 42%))`;
};

export type RegisterCustomGateInput = {
  id: string;
  source: string;
  librarySources?: Record<string, string>;
  color?: string;
  label?: string;
};

const runNestedCustomGate: NestedCustomGateRunner = (state, qubitCount, gate, measurements) => {
  const nested = getCustomGateRecord(String(gate.type));
  if (!nested) throw new Error(`Unknown custom gate '${gate.type}'.`);
  return applyCustomGateProcess(state, qubitCount, gate, measurements, nested, {});
};

const reversibilityFields = (compiled: ReturnType<typeof compileQpuProtocol>) => {
  const result = checkCustomGateReversibility(compiled, runNestedCustomGate);
  return {
    reversible: result.reversible,
    reversibilityIssue: result.reversible ? undefined : result.reason,
    reversibilityCheckVersion: REVERSIBILITY_CHECK_VERSION,
  };
};

// Registration compiles once up front to validate arity and capture any library sources needed by child processes.
export const registerCustomGate = ({
  id,
  source,
  librarySources = {},
  color,
  label,
}: RegisterCustomGateInput): CustomGateRecord => {
  const trimmedId = id.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmedId)) {
    throw new Error('Custom gate id must start with a letter and use only letters, digits, or underscores.');
  }
  assertCustomGateIdAvailable(trimmedId);

  const compiled = compileQpuProtocol(source, librarySources);
  const usedColors = new Set([
    ...readStore().map((record) => record.color),
    ...PRECONFIGURED_HUES.map((hue) => `hsl(${hue}`),
  ]);

  const record: CustomGateRecord = {
    id: trimmedId,
    label: label?.trim() || trimmedId,
    color: color?.trim() || randomCustomColor(usedColors),
    source,
    processName: compiled.parsed.find((command) => command.op === 'MAIN-PROCESS')?.args[0] ?? trimmedId,
    librarySources,
    inputParamNames: compiled.processParams.map((param) => param.name),
    outputParamNames: compiled.returnValues.map((value) => value.name),
    createdAt: new Date().toISOString(),
    ...reversibilityFields(compiled),
  };

  const previous = readStore();
  const replacing = previous.some((existing) => existing.id.toLowerCase() === trimmedId.toLowerCase());
  const next = previous.filter((existing) => existing.id.toLowerCase() !== trimmedId.toLowerCase());
  next.push(record);
  writeStore(next);
  if (replacing) recheckOtherGates(trimmedId);
  return record;
};

// Remapping binds public controls/targets to compiled process params/returns while reserving fresh wires for internals.
const buildQubitRemap = (
  compiled: ReturnType<typeof compileQpuProtocol>,
  gate: CircuitGate,
  qubitCount: number,
): { remap: Map<number, number>; expandedQubitCount: number } => {
  const remap = new Map<number, number>();
  const used = new Set<number>(gate.controls);

  compiled.processParams.forEach((param, index) => {
    const mapped = gate.controls[index];
    if (mapped === undefined) throw new Error(`Custom gate needs input wire for parameter '${param.name}'.`);
    remap.set(param.qubitIndex, mapped);
    used.add(mapped);
  });

  compiled.returnValues.forEach((value, index) => {
    const mapped = gate.targets[index];
    if (mapped === undefined) {
      throw new Error(`Custom gate needs output wire for '${value.name}' (index ${index}).`);
    }
    const inputIndex = compiled.processParams.findIndex((param) => param.name === value.name);
    const inputWire = inputIndex >= 0 ? gate.controls[inputIndex] : undefined;
    if (used.has(mapped) && mapped !== inputWire) {
      throw new Error(`Custom gate output '${value.name}' must map to a distinct wire (q${mapped} already used).`);
    }
    remap.set(value.qubitIndex, mapped);
    if (!used.has(mapped)) used.add(mapped);
  });

  let nextAncilla = Math.max(qubitCount - 1, ...used) + 1;
  const internalQubits = new Set<number>();
  compiled.gates.forEach((inner) => {
    inner.targets.forEach((qubit) => internalQubits.add(qubit));
    inner.controls.forEach((qubit) => internalQubits.add(qubit));
  });

  internalQubits.forEach((qubit) => {
    if (remap.has(qubit)) return;
    remap.set(qubit, nextAncilla);
    used.add(nextAncilla);
    nextAncilla += 1;
  });

  Object.values(compiled.tokenMap).forEach((qubit) => {
    if (!remap.has(qubit)) {
      remap.set(qubit, nextAncilla);
      used.add(nextAncilla);
      nextAncilla += 1;
    }
  });

  return { remap, expandedQubitCount: nextAncilla };
};

const remapInnerGate = (gate: CircuitGate, remap: Map<number, number>): CircuitGate => ({
  ...gate,
  targets: gate.targets.map((qubit) => remap.get(qubit) ?? qubit),
  controls: gate.controls.map((qubit) => remap.get(qubit) ?? qubit),
  ...(gate.condition
    ? { condition: remapConditionWires(gate.condition, (qubit) => remap.get(qubit) ?? qubit) }
    : {}),
  ...(gate.branch
    ? { branch: { ...gate.branch, sourceQubit: remap.get(gate.branch.sourceQubit) ?? gate.branch.sourceQubit } }
    : {}),
});

/**
 * True when a custom gate (or any custom gate it uses) contains a gate-expression IF.
 * Those predicates read amplitudes, so the gate is not one fixed linear map and cannot be
 * lifted to a density matrix column by column.
 */
export const customGateReadsAmplitudes = (
  id: string,
  librarySources: Record<string, string> = {},
  visiting: Set<string> = new Set(),
): boolean => {
  const record = getCustomGateRecord(id);
  if (!record || visiting.has(record.id)) return false;
  visiting.add(record.id);
  const compiled = compileQpuProtocol(record.source, { ...record.librarySources, ...librarySources });
  return compiled.gates.some((inner) => Boolean(inner.condition?.predicate)
    || customGateReadsAmplitudes(String(inner.type), librarySources, visiting));
};

// Applying a custom gate expands the saved protocol into ordinary registered gates at runtime.
/** Custom gates currently expanding, so a gate whose source uses itself fails instead of looping. */
const expandingCustomGates = new Set<string>();

export const applyCustomGateProcess = (
  state: import('../complex').Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  record: CustomGateRecord,
  librarySources: Record<string, string> = {},
): ExecutionResult => {
  if (expandingCustomGates.has(record.id)) {
    throw new Error(`Custom gate '${record.id}' uses itself; custom gates cannot recurse.`);
  }
  expandingCustomGates.add(record.id);
  try {
    return expandCustomGate(state, qubitCount, gate, measurements, record, librarySources);
  } finally {
    expandingCustomGates.delete(record.id);
  }
};

const expandCustomGate = (
  state: import('../complex').Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  record: CustomGateRecord,
  librarySources: Record<string, string>,
): ExecutionResult => {
  const mergedLibrary = { ...record.librarySources, ...librarySources };
  const compiled = compileQpuProtocol(record.source, mergedLibrary);
  const { remap, expandedQubitCount: baseQubitCount } = buildQubitRemap(compiled, gate, qubitCount);
  let expandedQubitCount = baseQubitCount;

  let nextState = physics.expandRegister(physics.fromAmplitudes(state, qubitCount), expandedQubitCount).amplitudes;
  let nextMeasurements = { ...measurements };
  const forwardSteps = compiled.gates;
  if (gate.inverse && !record.reversible) {
    throw new Error(`Custom gate '${record.id}' is not reversible and cannot be inverted.${record.reversibilityIssue ? ` ${record.reversibilityIssue}` : ''}`);
  }
  const steps = gate.inverse && record.reversible
    ? forwardSteps.slice().reverse().map(invertCircuitGate)
    : forwardSteps;
  const log: string[] = [
    gate.inverse
      ? `Custom gate ${record.label}† executing ${steps.length} inverted step(s).`
      : `Custom gate ${record.label} executing ${steps.length} compiled step(s).`,
  ];

  // Inner gates (and inner IF predicates) may themselves be custom gates.
  const runInnerGate = (
    inner: CircuitGate,
    innerState: import('../complex').Complex[],
    innerQubitCount: number,
    innerMeasurements: MeasurementMap,
  ): ExecutionResult => {
    const builtIn = preconfiguredGateMap[inner.type];
    if (builtIn) {
      return applyInverseAwareDefinition(builtIn, innerState, innerQubitCount, inner, innerMeasurements, mergedLibrary);
    }
    const nested = getCustomGateRecord(String(inner.type));
    if (!nested) throw new Error(`Custom gate '${record.id}' lowered unknown inner gate '${inner.type}'.`);
    return applyCustomGateProcess(innerState, innerQubitCount, inner, innerMeasurements, nested, mergedLibrary);
  };

  for (const innerGate of steps) {
    const remapped = remapInnerGate(innerGate, remap);
    // Inner -IF / IF-ELSE gates follow the same feed-forward rule as top-level gates.
    if (!conditionSatisfied(remapped, nextMeasurements, nextState, expandedQubitCount, runInnerGate)) {
      log.push(`${remapped.type} skipped because classical condition was false.`);
      continue;
    }
    const result = runInnerGate(remapped, nextState, expandedQubitCount, nextMeasurements);
    nextState = result.state;
    // A nested custom gate may add its own workspace wires.
    expandedQubitCount = physics.resolveQubitCount(nextState, expandedQubitCount);
    nextMeasurements = result.measurements;
    log.push(...result.log);
  }

  return { state: nextState, measurements: nextMeasurements, log };
};

export const customGateToDefinition = (record: CustomGateRecord): GateDefinition => ({
  id: record.id,
  category: 'custom',
  label: record.label,
  controlKind: record.inputParamNames.length > 1 ? 'parametric' : record.inputParamNames.length === 1 ? 'single' : 'none',
  ioArity: gateIoArity(
    record.inputParamNames.length,
    Math.max(record.outputParamNames.length, 1),
    record.inputParamNames.length,
    Math.max(record.outputParamNames.length, 1),
  ),
  astInputCount: Math.max(record.inputParamNames.length, 1),
  inPalette: true,
  isAstPrimitive: false,
  isAstDerived: false,
  supportsReverse: record.reversible,
  supportsPhase: false,
  cssClass: `gate-custom gate-custom-${record.id.toLowerCase()}`,
  color: record.color,
  apply: ({ state, qubitCount, gate, measurements, librarySources }) =>
    applyCustomGateProcess(state, qubitCount, gate, measurements, record, librarySources),
});

/** Re-check records saved under older reversibility rules so a stale flag cannot allow a wrong dagger. */
const isStale = (record: CustomGateRecord) => record.reversibilityCheckVersion !== REVERSIBILITY_CHECK_VERSION;

const recheckRecord = (record: CustomGateRecord): CustomGateRecord => {
  try {
    return { ...record, ...reversibilityFields(compileQpuProtocol(record.source, record.librarySources)) };
  } catch (error) {
    return {
      ...record,
      reversible: false,
      reversibilityIssue: `Could not re-check reversibility: ${(error as Error).message}`,
      reversibilityCheckVersion: REVERSIBILITY_CHECK_VERSION,
    };
  }
};

/**
 * Re-check the selected records in registration order. Saving after each one lets an inner gate's
 * new result be seen by the gates registered after it that use it.
 */
const recheckRecords = (records: CustomGateRecord[], shouldRecheck: (record: CustomGateRecord) => boolean) => {
  if (!records.some(shouldRecheck)) return records;
  const next = [...records];
  next.forEach((record, index) => {
    if (!shouldRecheck(record)) return;
    next[index] = recheckRecord(record);
    writeStore(next);
  });
  return next;
};

const refreshStaleReversibility = (records: CustomGateRecord[]) => recheckRecords(records, isStale);

/**
 * A gate's result depends on the stored results of the custom gates it uses, so replacing or removing
 * a gate re-checks every other gate. Rechecking a gate that does not use it leaves its result unchanged.
 */
const recheckOtherGates = (changedId: string) => {
  recheckRecords(readStore(), (record) => record.id.toLowerCase() !== changedId.toLowerCase());
};

/** Remove a custom gate and re-check the gates that may have used it. */
export const removeCustomGateRecord = (id: string) => {
  removeStoredRecord(id);
  recheckOtherGates(id);
  return readStore();
};

export const buildCustomGateDefinitions = () =>
  refreshStaleReversibility(readStore()).map((record) => customGateToDefinition(record));
