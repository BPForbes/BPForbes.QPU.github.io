/**
 * Beginner documentation for the hover docs drawer.
 *
 * Elements opt in with a `data-doc` key: `gate:<ID>` for palette/canvas gates
 * (preconfigured or custom), `process:<Name>` for catalog processes (child
 * links open these as drawer tabs), and `ui:<uiTips key>` for controls.
 */
import { getCatalogEntry, getCatalogLibrarySources } from '../catalog';
import {
  compileQpuProtocol,
  getProtocolParameterEntries,
  getReturnValTokens,
  simulateTruthTableOutputs,
  type TruthTable,
} from '../../simulator/compiler';
import { getCustomGateRecord, type CustomGateRecord } from '../../simulator/gates/customGateEngine';
import { docTargets, gateDocTarget, gateHelp, uiTips, type DocTarget } from './learningHelp';

export type DocTable = { columns: string[]; inputCount: number; rows: string[][]; note?: string };
export type DocSection = { heading: string; body: string };

export type DocEntry = {
  key: string;
  kind: 'gate' | 'custom' | 'process' | 'control';
  title: string;
  subtitle: string;
  summary: string;
  rule?: string;
  table?: DocTable;
  syntax?: string[];
  sections: DocSection[];
  children?: string[];
  source?: string;
  doc?: DocTarget;
};

const booleanTable = (inputs: string[], outputs: string[], apply: (bits: number[]) => number[]): DocTable => ({
  columns: [...inputs, ...outputs],
  inputCount: inputs.length,
  rows: Array.from({ length: 2 ** inputs.length }, (_, index) => {
    const bits = inputs.map((_, bit) => (index >> (inputs.length - 1 - bit)) & 1);
    return [...bits, ...apply(bits)].map(String);
  }),
  note: '0 and 1 are the basis states |0⟩ and |1⟩ (0p and 1p).',
});

const ketTable = (columns: string[], rows: string[][], note?: string): DocTable => ({ columns, inputCount: 1, rows, note });

const singleWireTarget = 'There are no controls. The target t is both the input and the output: the gate changes t in place.';

type GateDoc = { how: string; target: string; syntax: string[]; table: DocTable; notes?: string };

export const gateDocs: Record<string, GateDoc> = {
  X: {
    how: 'X swaps the amount of |0⟩ and |1⟩ on a wire. On a definite 0 or 1 it is a classical NOT; on a superposition it swaps the two parts.',
    target: `${singleWireTarget} t' = t ⊕ 1.`,
    syntax: ['X -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', '|1⟩'], ['|1⟩', '|0⟩']]),
  },
  Y: {
    how: 'Y flips the bit like X and also multiplies by i or −i. That factor is a phase, so measuring right after Y gives the same 0/1 as X would.',
    target: singleWireTarget,
    syntax: ['Y -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', 'i|1⟩'], ['|1⟩', '−i|0⟩']]),
  },
  Z: {
    how: 'Z leaves |0⟩ alone and puts a minus sign on |1⟩. Measuring straight after Z shows no change; the sign only matters when a later H makes the parts interfere (H, Z, H acts like X).',
    target: singleWireTarget,
    syntax: ['Z -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', '|0⟩'], ['|1⟩', '−|1⟩'], ['|+⟩', '|−⟩']]),
  },
  H: {
    how: 'H turns a definite 0 or 1 into an even mix. Measuring |+⟩ gives 0 or 1 with 50% each. H undoes itself: H followed by H returns the starting state.',
    target: `${singleWireTarget} On the canvas the wire turns from a double line (classical) to a single line (superposition).`,
    syntax: ['H -I Q -O Q'],
    table: ketTable(
      ['t', "t'"],
      [['|0⟩', '|+⟩'], ['|1⟩', '|−⟩'], ['|+⟩', '|0⟩'], ['|−⟩', '|1⟩']],
      '|+⟩ = (|0⟩ + |1⟩)/√2 and |−⟩ = (|0⟩ − |1⟩)/√2.',
    ),
  },
  S: {
    how: 'S gives the |1⟩ part a quarter turn of phase (a factor of i). Two S gates make one Z. Probabilities do not change.',
    target: singleWireTarget,
    syntax: ['S -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', '|0⟩'], ['|1⟩', 'i|1⟩']]),
  },
  T: {
    how: 'T gives the |1⟩ part an eighth turn of phase. Two T gates make one S. Probabilities do not change.',
    target: singleWireTarget,
    syntax: ['T -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', '|0⟩'], ['|1⟩', 'e^{iπ/4}|1⟩']]),
  },
  PHASE: {
    how: 'PHASE turns the |1⟩ part by any angle θ, set with the Phase angle slider. θ = 180° is Z, 90° is S, and 45° is T.',
    target: singleWireTarget,
    syntax: ['PHASE=90d -I Q -O Q      # degrees', 'PHASE=1.5708 -I Q -O Q   # radians'],
    table: ketTable(['t', "t'"], [['|0⟩', '|0⟩'], ['|1⟩', 'e^{iθ}|1⟩']]),
  },
  MEASURE: {
    how: 'M reads the wire. A definite 0 or 1 is read as itself; a superposition is read as 0 or 1 at random, weighted by its amplitudes, and becomes that bit.',
    target: 'The measured wire is the target. Afterwards it is a classical bit (double line on the canvas) and the superposition is gone for good. Measuring one half of an entangled pair also fixes the other half.',
    syntax: ['MEASURE -I Q'],
    table: ketTable(['t before', 'reading'], [['|0⟩', '0 always'], ['|1⟩', '1 always'], ['|+⟩', '0 or 1 (50% each)']]),
  },
  NOT: {
    how: 'NOT is the logic spelling of X: it flips the target.',
    target: `${singleWireTarget} t' = t ⊕ 1.`,
    syntax: ['NOT -I Target -O Target'],
    table: booleanTable(['t'], ["t'"], ([t]) => [t ^ 1]),
  },
  CNOT: {
    how: 'When Control A is 1 the target flips; when it is 0 nothing happens. With t starting at 0, t ends as a copy of A. If A is in superposition you get entanglement instead (H then CNOT makes a Bell pair).',
    target: "t is the only wire that changes: t' = t ⊕ A. Start t at 0p to copy A, or at 1p to get NOT A. A is only read.",
    syntax: ['CNOT -I A -O Target'],
    table: booleanTable(['A', 't'], ['A', "t'"], ([a, t]) => [a, t ^ a]),
  },
  CCNOT: {
    how: 'The target flips only when Control A and Control B are both 1. Every row keeps A and B as they were, which is why the gate is reversible.',
    target: "t' = t ⊕ (A ∧ B). Start t at 0p and it ends holding A AND B; start at 1p and it holds NAND. A and B are only read.",
    syntax: ['CCNOT -I A B -O Target'],
    table: booleanTable(['A', 'B', 't'], ['A', 'B', "t'"], ([a, b, t]) => [a, b, t ^ (a & b)]),
  },
  CZ: {
    how: 'CZ puts a minus sign on the |11⟩ part and changes nothing else. No bit flips, so measuring right after shows no change. Put H on the target before and after, and CZ acts like CNOT.',
    target: 'CZ is symmetric: swapping which wire is the control gives the same gate. The workbench still draws the Target particle as the boxed Z.',
    syntax: ['CZ -I A -O B'],
    table: ketTable(['A t', 'result'], [['|00⟩', '|00⟩'], ['|01⟩', '|01⟩'], ['|10⟩', '|10⟩'], ['|11⟩', '−|11⟩']]),
  },
  CY: {
    how: 'When Control A is 1 the target gets Y (a flip plus a ±i phase). When A is 0 nothing happens.',
    target: 'Only t changes, and only when A is 1. A is only read.',
    syntax: ['CY -I A -O Target'],
    table: ketTable(['A t', 'result'], [['|00⟩', '|00⟩'], ['|01⟩', '|01⟩'], ['|10⟩', 'i|11⟩'], ['|11⟩', '−i|10⟩']]),
  },
  SWAP: {
    how: 'SWAP exchanges the complete states of two wires, including any superposition. Nothing is copied; the two wires trade places.',
    target: 'SWAP changes two wires: Target particle and Control B. Control A is not used.',
    syntax: ['SWAP -I A B -O A B'],
    table: booleanTable(['t', 'B'], ["t'", "B'"], ([t, b]) => [b, t]),
  },
  AND: {
    how: 'Reversible AND flips the output when both inputs are 1. It is the logic spelling of CCNOT.',
    target: "Out is the target: Out' = Out ⊕ (A ∧ B). Start Out at 0p and it ends holding A AND B. A and B are preserved.",
    syntax: ['AND -I A B -O Out'],
    table: booleanTable(['A', 'B', 'Out'], ['A', 'B', "Out'"], ([a, b, t]) => [a, b, t ^ (a & b)]),
  },
  NAND: {
    how: 'Reversible NAND flips the output unless both inputs are 1.',
    target: "Out' = Out ⊕ ¬(A ∧ B). Start Out at 0p and it ends holding NOT (A AND B). A and B are preserved.",
    syntax: ['NAND -I A B -O Out'],
    table: booleanTable(['A', 'B', 'Out'], ['A', 'B', "Out'"], ([a, b, t]) => [a, b, t ^ (1 - (a & b))]),
  },
  OR: {
    how: 'Reversible OR flips the output when either input (or both) is 1.',
    target: "Out' = Out ⊕ (A ∨ B). Start Out at 0p and it ends holding A OR B. A and B are preserved.",
    syntax: ['OR -I A B -O Out'],
    table: booleanTable(['A', 'B', 'Out'], ['A', 'B', "Out'"], ([a, b, t]) => [a, b, t ^ (a | b)]),
  },
  XOR: {
    how: 'Reversible XOR flips the output once for each input that is 1, so two 1s cancel. It is the sum bit of an adder.',
    target: "Out' = Out ⊕ A ⊕ B. Start Out at 0p and it ends holding A XOR B. A and B are preserved.",
    syntax: ['XOR -I A B -O Out'],
    table: booleanTable(['A', 'B', 'Out'], ['A', 'B', "Out'"], ([a, b, t]) => [a, b, t ^ a ^ b]),
  },
};

export const gateDocEntry = (gateId: string): DocEntry | undefined => {
  const help = gateHelp[gateId];
  const doc = gateDocs[gateId];
  if (!help || !doc) return undefined;
  return {
    key: `gate:${gateId}`,
    kind: 'gate',
    title: `${gateId} · ${help.name}`,
    subtitle: help.reversible ? 'Built-in gate · reversible' : 'Built-in gate · not reversible',
    summary: help.summary,
    rule: help.rule,
    table: doc.table,
    syntax: doc.syntax,
    sections: [
      { heading: 'How it works', body: doc.how },
      { heading: 'The target (t)', body: doc.target },
    ],
    doc: gateDocTarget(gateId),
  };
};

const CHILD_CALL = /^\s*(?:RUNCHILD|CALL|DECLARECHILD)\s+([A-Za-z_][\w-]*)/;

/** Child process names a protocol declares or runs, in first-use order. */
export const childProcessNames = (source: string): string[] => {
  const names = new Set<string>();
  source.split(/\r?\n/).forEach((line) => {
    const match = line.replace(/#.*$/, '').match(CHILD_CALL);
    if (match) names.add(match[1]);
  });
  return [...names];
};

// 2^5 rows is still readable in a side drawer; larger processes show their .qpuio table or a note.
const MAX_SIMULATED_INPUTS = 5;

const cellText = (cell: string) => (cell === '0p' ? '0' : cell === '1p' ? '1' : cell);

const toDocTable = (table: TruthTable, note: string): DocTable => ({
  columns: [...table.inputColumns, ...table.outputColumns],
  inputCount: table.inputColumns.length,
  rows: table.rows.map((row) => row.map(cellText)),
  note,
});

const processTable = (
  source: string,
  library: Record<string, string>,
  inputCount: number,
  canonical?: TruthTable,
): DocTable | undefined => {
  if (canonical) return toDocTable(canonical, 'From the process’s .qpuio truth table. 0 = 0p, 1 = 1p, sp = either.');
  if (inputCount > MAX_SIMULATED_INPUTS) return undefined;
  try {
    return toDocTable(simulateTruthTableOutputs(source, library), 'Simulated by running every basis input and measuring the outputs.');
  } catch {
    return undefined;
  }
};

type ProcessDocOptions = {
  key: string;
  kind: 'custom' | 'process';
  name: string;
  source: string;
  library: Record<string, string>;
  canonical?: TruthTable;
  customGate?: CustomGateRecord;
};

const processDocEntry = ({ key, kind, name, source, library, canonical, customGate }: ProcessDocOptions): DocEntry => {
  const params = getProtocolParameterEntries(source).filter((param) => param.type === 'state').map((param) => param.name);
  const outputs = getReturnValTokens(source);
  const children = childProcessNames(source).filter((child) => child !== name);
  const measures = /^\s*MEASURE\b/m.test(source);
  let gateCount: number | undefined;
  try {
    gateCount = compileQpuProtocol(source, library).gates.length;
  } catch {
    gateCount = undefined;
  }
  const table = processTable(source, library, params.length, canonical);
  const inputs = params.join(', ') || 'no inputs';
  const outputList = outputs.join(', ') || 'no outputs';

  const sections: DocSection[] = [
    {
      heading: 'How it works',
      body: `${name} is a process: a named list of gates. It reads ${inputs} (its PARAMS) and returns ${outputList} (its RETURNVALS).${gateCount === undefined ? '' : ` It compiles to ${gateCount} gate step${gateCount === 1 ? '' : 's'}.`}`,
    },
    {
      heading: 'Main process or child process?',
      body: children.length > 0
        ? `Here ${name} is the main process: it calls ${children.join(', ')} as child process${children.length === 1 ? '' : 'es'}. RUNCHILD copies the child's gates into this circuit at compile time, on the wires passed with -I (inputs) and -O (outputs). Open a child below to read it.`
        : `${name} calls no child processes. Any other process can use it as a child: DECLARECHILD names it, and RUNCHILD copies its gates into the caller on the wires you pass.`,
    },
    {
      heading: 'The targets (outputs)',
      body: `${outputList} ${outputs.length === 1 ? 'is the target' : 'are the targets'}: the wires this process writes. Inputs are only read unless the process itself changes them. ${measures
        ? 'It measures inside the process, so its outputs end as classical bits and it cannot be undone.'
        : 'It contains no MEASURE, so it is reversible as long as it does not SET its outputs and returns every helper wire to 0.'}`,
    },
  ];

  if (customGate) {
    const roles = [
      ...params.map((param, index) => `${param} ← ${index === 0 ? 'Control A' : index === 1 ? 'Control B' : 'next free wire'}`),
      ...outputs.map((output, index) => `${output} → ${index === 0 ? 'Target particle' : 'next free wire'}`),
    ];
    sections.splice(1, 0, {
      heading: 'Using it on the canvas',
      body: `Pick ${customGate.id} in the Custom gates palette or the workbench Gate selector. Wires: ${roles.join('; ') || 'none'}.`,
    });
  }

  return {
    key,
    kind,
    title: customGate ? `${customGate.id} · custom gate` : name,
    subtitle: customGate ? `Custom gate from process ${name}` : children.length > 0 ? 'Process · calls child processes' : 'Process',
    summary: customGate
      ? `A saved process that replays its gates on the wires you choose: ${inputs} in, ${outputList} out.`
      : `${inputs} in, ${outputList} out.`,
    table,
    syntax: [
      ...(customGate ? [`# Canvas: select ${customGate.id}, then Add gate to target`] : []),
      `DECLARECHILD ${name}`,
      `RUNCHILD ${name} -I ${params.join(' ') || '…'} -O ${outputs.join(' ') || '…'}`,
    ],
    sections,
    children,
    source,
    doc: customGate ? docTargets.customGates : docTargets.processes,
  };
};

export const customGateDocEntry = (record: CustomGateRecord): DocEntry => processDocEntry({
  key: `gate:${record.id}`,
  kind: 'custom',
  name: record.processName,
  source: record.source,
  library: { ...getCatalogLibrarySources(), ...record.librarySources },
  customGate: record,
});

export const catalogProcessDocEntry = (name: string): DocEntry | undefined => {
  const entry = getCatalogEntry(name);
  if (!entry) return undefined;
  return processDocEntry({
    key: `process:${entry.name}`,
    kind: 'process',
    name: entry.name,
    source: entry.source,
    library: getCatalogLibrarySources(),
    canonical: entry.truthTable,
  });
};

export type UiDocKey = keyof typeof uiTips;

const uiDocs: Record<UiDocKey, { title: string; doc: DocTarget; more?: string }> = {
  gate: { title: 'Gate selector', doc: docTargets.workbench, more: 'The card below the selectors explains the chosen gate and draws it on your wires.' },
  targetParticle: { title: 'Target particle', doc: docTargets.workbench, more: "In t' = t ⊕ (A ∧ B) this is t: the output workspace and the only wire a controlled gate changes." },
  controlA: { title: 'Control A', doc: docTargets.workbench, more: "In t' = t ⊕ (A ∧ B) this is A. Dimmed when the selected gate does not read it." },
  controlB: { title: 'Control B', doc: docTargets.workbench, more: "In t' = t ⊕ (A ∧ B) this is B. For SWAP it is the second wire that is exchanged." },
  phaseAngle: { title: 'Phase angle', doc: docTargets.workbench, more: '180° is Z, 90° is S, 45° is T.' },
  addGate: { title: 'Add gate to target', doc: docTargets.workbench },
  addParticle: { title: 'Add particle', doc: docTargets.workbench },
  removeParticle: { title: 'Remove particle', doc: docTargets.workbench },
  measureTarget: { title: 'Measure target', doc: docTargets.workbench, more: 'This is a runtime action, not a gate: nothing is added to the circuit.' },
  startState: { title: 'Start state', doc: docTargets.workbench, more: 'On the canvas 0p and 1p start as double (classical) lines and sp as a single line.' },
  playSequence: { title: 'Play Sequence', doc: docTargets.runControls },
  runAll: { title: 'Run all', doc: docTargets.runControls },
  stepGate: { title: 'Step gate', doc: docTargets.runControls, more: 'Predict what the next gate will do, then step and compare.' },
  resetState: { title: 'Reset state', doc: docTargets.resetButtons, more: 'Gates: kept. Wires and start states: kept. Protocol editor: kept.' },
  measureAll: { title: 'Measure all', doc: docTargets.runControls },
  clearCircuit: { title: 'Clear circuit', doc: docTargets.resetButtons, more: 'Gates: deleted. Wires and start states: kept. Protocol editor: rewritten from the empty canvas.' },
  resetSite: { title: 'Reset site', doc: docTargets.resetButtons, more: 'Gates: deleted. Wires: back to 3 at 0p. Protocol editor: back to the default. None of the reset buttons is the compiler’s RESET operation.' },
  speed: { title: 'Speed', doc: docTargets.runControls },
  compileProtocol: { title: 'Compile protocol', doc: docTargets.compiler },
  downloadQpucir: { title: 'Download as .qpucir', doc: docTargets.compiler },
  downloadQpucirTxt: { title: 'Download as -qpucir.txt', doc: docTargets.compiler },
  bundledProtocol: { title: 'Bundled protocol', doc: docTargets.compiler, more: 'Hover a bundled protocol button to see its truth table and child processes.' },
};

export const uiDocEntry = (key: string): DocEntry | undefined => {
  if (!(key in uiDocs)) return undefined;
  const info = uiDocs[key as UiDocKey];
  return {
    key: `ui:${key}`,
    kind: 'control',
    title: info.title,
    subtitle: 'Builder control',
    summary: uiTips[key as UiDocKey],
    sections: info.more ? [{ heading: 'Good to know', body: info.more }] : [],
    doc: info.doc,
  };
};

export const resolveDocEntry = (key: string): DocEntry | undefined => {
  const separator = key.indexOf(':');
  if (separator < 0) return undefined;
  const scope = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (scope === 'gate') {
    const builtIn = gateDocEntry(id);
    if (builtIn) return builtIn;
    const record = getCustomGateRecord(id);
    return record ? customGateDocEntry(record) : undefined;
  }
  if (scope === 'process') return catalogProcessDocEntry(id);
  if (scope === 'ui') return uiDocEntry(id);
  return undefined;
};
