import { compileQpuProtocol } from '../compiler/qpuAst';
import type { CircuitGate, ExecutionResult, MeasurementMap } from '../types';
import type { GateDefinition } from './types';
import { gateIoArity } from './types';
import { padStateVector } from './operations';
import { preconfiguredGateMap } from './preconfigured';
import { applyInverseAwareDefinition, invertCircuitGate } from './inverse';

const assertCustomGateIdAvailable = (trimmedId: string) => {
  const conflict = Object.keys(preconfiguredGateMap).find((id) => id.toLowerCase() === trimmedId.toLowerCase());
  if (conflict) {
    throw new Error(`Custom gate id '${trimmedId}' conflicts with preconfigured gate '${conflict}'.`);
  }
};

export type CustomGateRecord = {
  id: string;
  label: string;
  color: string;
  source: string;
  processName: string;
  librarySources: Record<string, string>;
  inputParamNames: string[];
  outputParamNames: string[];
  createdAt: string;
  /** True when every compiled step is reversible (no MEASURE/RESET/SAVE/LOAD). */
  reversible: boolean;
};

const STORAGE_KEY = 'qpu-custom-gates-v1';

const NON_REVERSIBLE_TYPES = new Set([
  'MEASURE',
  'RESET',
  'SAVE_STATE',
  'LOAD_STATE',
]);

const analyzeReversibility = (gates: CircuitGate[]): boolean =>
  gates.every((gate) => {
    if (gate.type === 'CYCLE') return true;
    if (NON_REVERSIBLE_TYPES.has(String(gate.type))) return false;
    return preconfiguredGateMap[String(gate.type)]?.supportsReverse ?? false;
  });

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

// Custom gates are session-scoped so experiments survive reloads without becoming bundled catalog metadata.
const readStore = (): CustomGateRecord[] => {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomGateRecord[];
    return Array.isArray(parsed)
      ? parsed.map((record) => ({
          ...record,
          reversible: record.reversible ?? false,
        }))
      : [];
  } catch {
    return [];
  }
};

const writeStore = (records: CustomGateRecord[]) => {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
};

export const listCustomGateRecords = () => readStore();

export const getCustomGateRecord = (id: string) =>
  readStore().find((record) => record.id.toLowerCase() === id.toLowerCase());

export const removeCustomGateRecord = (id: string) => {
  const next = readStore().filter((record) => record.id.toLowerCase() !== id.toLowerCase());
  writeStore(next);
  return next;
};

export type RegisterCustomGateInput = {
  id: string;
  source: string;
  librarySources?: Record<string, string>;
  color?: string;
  label?: string;
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
    reversible: analyzeReversibility(compiled.gates),
  };

  const next = readStore().filter((existing) => existing.id.toLowerCase() !== trimmedId.toLowerCase());
  next.push(record);
  writeStore(next);
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
});

// Applying a custom gate expands the saved protocol into ordinary registered gates at runtime.
export const applyCustomGateProcess = (
  state: import('../complex').Complex[],
  qubitCount: number,
  gate: CircuitGate,
  measurements: MeasurementMap,
  record: CustomGateRecord,
  librarySources: Record<string, string> = {},
): ExecutionResult => {
  const mergedLibrary = { ...record.librarySources, ...librarySources };
  const compiled = compileQpuProtocol(record.source, mergedLibrary);
  const { remap, expandedQubitCount } = buildQubitRemap(compiled, gate, qubitCount);

  let nextState = padStateVector(state, qubitCount, expandedQubitCount);
  let nextMeasurements = { ...measurements };
  const forwardSteps = compiled.gates;
  if (gate.inverse && !record.reversible) {
    throw new Error(`Custom gate '${record.id}' is not reversible and cannot be inverted.`);
  }
  const steps = gate.inverse && record.reversible
    ? forwardSteps.slice().reverse().map(invertCircuitGate)
    : forwardSteps;
  const log: string[] = [
    gate.inverse
      ? `Custom gate ${record.label}† executing ${steps.length} inverted step(s).`
      : `Custom gate ${record.label} executing ${steps.length} compiled step(s).`,
  ];

  for (const innerGate of steps) {
    const remapped = remapInnerGate(innerGate, remap);
    const definition = preconfiguredGateMap[remapped.type];
    if (!definition) throw new Error(`Custom gate '${record.id}' lowered unknown inner gate '${remapped.type}'.`);
    const result = applyInverseAwareDefinition(
      definition,
      nextState,
      expandedQubitCount,
      remapped,
      nextMeasurements,
      mergedLibrary,
    );
    nextState = result.state;
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

export const buildCustomGateDefinitions = () =>
  readStore().map((record) => customGateToDefinition(record));
