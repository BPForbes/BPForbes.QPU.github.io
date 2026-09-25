/**
 * Beginner documentation shown in the Interactive workbench.
 *
 * Entries are keyed `gate:<ID>` (preconfigured or custom gates),
 * `process:<Name>` (catalog processes, used for child processes), or built
 * from the current protocol source. Table columns carry role names (A, B, t,
 * or PARAMS/RETURNVALS names) so the workbench can map them onto wires.
 */
import { getCatalogEntry, getCatalogLibrarySources } from '../catalog';
import {
  compileQpuProtocol,
  extractMainProcessName,
  getProtocolParameterEntries,
  getReturnValTokens,
  type TruthTable,
} from '../../simulator/compiler';
import { runCircuit } from '../../simulator/engine';
import { physics } from '../../simulator/physics/PhysicsEngine';
import type { ParticleStartState } from '../../simulator/types';
import { getCustomGateRecord, type CustomGateRecord } from '../../simulator/gates/customGateEngine';
import { docTargets, gateDocTarget, gateHelp, type DocTarget } from './learningHelp';

export type DocTable = {
  columns: string[];
  /** Space-separated role names per column; a column like "A t" spans two wires. */
  roles: string[];
  inputCount: number;
  rows: string[][];
  note?: string;
};
export type DocSection = { heading: string; body: string };

export type DocEntry = {
  key: string;
  kind: 'gate' | 'custom' | 'process';
  /** PARAMS and RETURNVALS names for processes; they map to controls and targets in order. */
  inputs?: string[];
  outputs?: string[];
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

const stripPrime = (column: string) => column.replace(/'/g, '');

const booleanTable = (inputs: string[], outputs: string[], apply: (bits: number[]) => number[]): DocTable => ({
  columns: [...inputs, ...outputs],
  roles: [...inputs, ...outputs].map(stripPrime),
  inputCount: inputs.length,
  rows: Array.from({ length: 2 ** inputs.length }, (_, index) => {
    const bits = inputs.map((_, bit) => (index >> (inputs.length - 1 - bit)) & 1);
    return [...bits, ...apply(bits)].map(String);
  }),
  note: '0 and 1 are the basis states |0⟩ and |1⟩ (0p and 1p).',
});

const ketTable = (columns: string[], rows: string[][], note?: string, roles = columns.map(stripPrime)): DocTable => ({
  columns,
  roles,
  inputCount: 1,
  rows,
  note,
});

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
    target: `${singleWireTarget} On the canvas every qubit wire stays a single line.`,
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
  RX: {
    how: 'RX rotates the Bloch vector about the x-axis by θ. RX(π) is X up to a global phase.',
    target: singleWireTarget,
    syntax: ['RX=pi/2 -I Q -O Q', 'RX=90d -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', 'cos(θ/2)|0⟩ − i sin(θ/2)|1⟩'], ['|1⟩', '−i sin(θ/2)|0⟩ + cos(θ/2)|1⟩']]),
  },
  RY: {
    how: 'RY rotates the Bloch vector about the y-axis by θ. Useful for preparing arbitrary real amplitudes.',
    target: singleWireTarget,
    syntax: ['RY=pi/2 -I Q -O Q', 'RY=90d -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', 'cos(θ/2)|0⟩ + sin(θ/2)|1⟩'], ['|1⟩', '−sin(θ/2)|0⟩ + cos(θ/2)|1⟩']]),
  },
  RZ: {
    how: 'RZ rotates about the z-axis by θ. Related to PHASE by a global phase factor.',
    target: singleWireTarget,
    syntax: ['RZ=pi/4 -I Q -O Q', 'RZ=45d -I Q -O Q'],
    table: ketTable(['t', "t'"], [['|0⟩', 'e^{−iθ/2}|0⟩'], ['|1⟩', 'e^{iθ/2}|1⟩']]),
  },
  MEASURE: {
    how: 'M reads the wire. A definite 0 or 1 is read as itself; a superposition is read as 0 or 1 at random, weighted by its amplitudes, and becomes that bit. -BASIS X or -BASIS Y reads a different observable instead: 0 means |+⟩ (or |+i⟩) and 1 means |−⟩ (or |−i⟩), and the wire is left in that state.',
    target: 'The measured wire is the target, and the meter stays on that qubit wire. A double stroke, not an arrow, drops to the c lane and numbers the bit read at that time. c is a clock for measurements, the only double line, and it cannot take a gate. Later gates can still run on the qubit. Measuring one half of an entangled pair also fixes the other half.',
    syntax: ['MEASURE -I Q', 'MEASURE -I Q -BASIS X'],
    table: ketTable(['t before', 'reading'], [['|0⟩', '0 always'], ['|1⟩', '1 always'], ['|+⟩', '0 or 1 (50% each)'], ['|+⟩, -BASIS X', '0 always']], undefined, ['t', 't']),
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
    table: ketTable(['A t', 'result'], [['|00⟩', '|00⟩'], ['|01⟩', '|01⟩'], ['|10⟩', '|10⟩'], ['|11⟩', '−|11⟩']], undefined, ['A t', 'A t']),
  },
  CY: {
    how: 'When Control A is 1 the target gets Y (a flip plus a ±i phase). When A is 0 nothing happens.',
    target: 'Only t changes, and only when A is 1. A is only read.',
    syntax: ['CY -I A -O Target'],
    table: ketTable(['A t', 'result'], [['|00⟩', '|00⟩'], ['|01⟩', '|01⟩'], ['|10⟩', 'i|11⟩'], ['|11⟩', '−i|10⟩']], undefined, ['A t', 'A t']),
  },
  CPHASE: {
    how: 'CPHASE multiplies |11⟩ by e^{iθ}. CZ is the special case θ = π. Set θ with the Phase angle slider.',
    target: 'Only the joint |11⟩ amplitude changes phase. Control A is read; Target particle is the boxed phase.',
    syntax: ['CPHASE=pi/2 -I Control -O Target', 'CPHASE=90d -I Control -O Target'],
    table: ketTable(['A t', 'result'], [['|00⟩', '|00⟩'], ['|01⟩', '|01⟩'], ['|10⟩', '|10⟩'], ['|11⟩', 'e^{iθ}|11⟩']], undefined, ['A t', 'A t']),
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
const REC_DECL = /^\s*(REC|TREC)\b(?:\s+MAXDEPTH\s+(\d+))?/i;
const HAS_RECUR = /^\s*(?:RECUR|RUNCHILD\s+\S+)/m;

/** Child process names a protocol declares or runs, in first-use order. */
export const childProcessNames = (source: string): string[] => {
  const names = new Set<string>();
  source.split(/\r?\n/).forEach((line) => {
    const match = line.replace(/#.*$/, '').match(CHILD_CALL);
    if (match) names.add(match[1]);
  });
  return [...names];
};

export type ProtocolRecursionInfo = {
  declared: 'REC' | 'TREC' | null;
  maxDepth?: number;
  hasRecur: boolean;
  usesDepthFlag: boolean;
};

export type ProtocolBranchInfo = {
  /** Structured IF … ENDIF blocks. */
  blocks: number;
  /** Blocks that also have an ELSE part. */
  elses: number;
  /** Single gates with an inline -IF condition. */
  inlineConditions: number;
};

/** Count classical feed-forward (IF/ELSE blocks and inline -IF) in protocol text for workbench copy. */
export const protocolBranchInfo = (source: string): ProtocolBranchInfo => {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim());
  return {
    blocks: lines.filter((line) => /^IF\s+\S+=[01]$/i.test(line) || /^IF\s*\(/i.test(line)).length,
    elses: lines.filter((line) => /^ELSE$/i.test(line)).length,
    inlineConditions: lines.filter((line) => /\s-IF\s+\S+=[01]\b/i.test(line)).length,
  };
};

/** Detect REC/TREC/RECUR/−DEPTH markers in protocol text for workbench copy. */
export const protocolRecursionInfo = (source: string): ProtocolRecursionInfo => {
  let declared: 'REC' | 'TREC' | null = null;
  let maxDepth: number | undefined;
  source.split(/\r?\n/).forEach((line) => {
    const match = line.replace(/#.*$/, '').match(REC_DECL);
    if (!match) return;
    declared = match[1].toUpperCase() as 'REC' | 'TREC';
    if (match[2]) maxDepth = Number(match[2]);
  });
  const stripped = source.replace(/#.*$/gm, '');
  return {
    declared,
    maxDepth,
    hasRecur: /^\s*RECUR\b/m.test(stripped) || (
      declared !== null && HAS_RECUR.test(stripped)
    ),
    usesDepthFlag: /-DEPTH(?:\s*=\s*|\s+)\d+/i.test(stripped),
  };
};

// Simulation runs the whole circuit once per row; wider processes rely on their .qpuio table.
const MAX_SIMULATED_INPUTS = 6;

const cellText = (cell: string) => (cell === '0p' ? '0' : cell === '1p' ? '1' : cell);

const toDocTable = (table: TruthTable, note: string): DocTable => ({
  columns: [...table.inputColumns, ...table.outputColumns],
  roles: [...table.inputColumns, ...table.outputColumns],
  inputCount: table.inputColumns.length,
  rows: table.rows.map((row) => row.map(cellText)),
  note,
});

const registerQubit = (tokenMap: Record<string, number>, name: string) => {
  const entry = Object.entries(tokenMap).find(([token]) => token === name || token.endsWith(`/${name}`));
  if (!entry) throw new Error(`Missing register '${name}'`);
  return entry[1];
};

const bitFromProbability = (probabilityOne: number, tolerance: number): '0' | '1' | 'sp' => {
  if (probabilityOne <= tolerance) return '0';
  if (probabilityOne >= 1 - tolerance) return '1';
  return 'sp';
};

// The shared table simulator measures each row once. A teaching table must not
// present that sample as the row, so this reads the probability instead.
const simulateDocTable = (source: string, library: Record<string, string>): DocTable => {
  const compiled = compileQpuProtocol(source, library);
  const inputColumns = compiled.processParams.filter((param) => param.type === 'state').map((param) => param.name);
  const outputColumns = compiled.returnValues.map((value) => value.name);
  const rows = Array.from({ length: 2 ** inputColumns.length }, (_, index) => {
    const inputs = inputColumns.map((_, bit) => ((index >> (inputColumns.length - 1 - bit)) & 1) === 1 ? '1p' : '0p') as ParticleStartState[];
    const startStates = Array.from({ length: compiled.qubitCount }, () => '0p' as ParticleStartState);
    inputs.forEach((value, inputIndex) => {
      startStates[registerQubit(compiled.tokenMap, inputColumns[inputIndex])] = value;
    });
    const executed = runCircuit(
      compiled.qubitCount,
      compiled.gates,
      startStates,
      compiled.processParams.map((param) => param.qubitIndex),
    );
    const qubitCount = physics.resolveQubitCount(executed.state, 0);
    const outputs = outputColumns.map((name) => {
      const qubit = registerQubit(compiled.tokenMap, name);
      const logged = executed.log.reduce<number | undefined>((found, line) => {
        const match = line.match(new RegExp(`Measured q${qubit} = [01] \\(P\\(1\\)=([0-9.]+)\\)`));
        return match ? Number(match[1]) : found;
      }, undefined);
      if (logged !== undefined) return bitFromProbability(logged, 5e-3);
      const probabilityOne = physics.probabilityOfOne(physics.fromAmplitudes(executed.state, qubitCount), qubit);
      return bitFromProbability(probabilityOne, 1e-6);
    });
    return [...inputs.map((value) => (value === '1p' ? '1' : '0')), ...outputs];
  });
  const superposed = rows.some((row) => row.slice(inputColumns.length).includes('sp'));
  return {
    columns: [...inputColumns, ...outputColumns],
    roles: [...inputColumns, ...outputColumns],
    inputCount: inputColumns.length,
    rows,
    note: superposed
      ? 'Read from the state vector. sp means that output is not a definite 0 or 1, so one measurement is not the row.'
      : 'Read from the state vector for every basis input. Each output shown is a definite 0 or 1.',
  };
};

const processTable = (
  source: string,
  library: Record<string, string>,
  inputCount: number,
  canonical?: TruthTable,
): DocTable | undefined => {
  if (canonical) return toDocTable(canonical, 'From the process’s .qpuio truth table. 0 = 0p, 1 = 1p, sp = either.');
  if (inputCount > MAX_SIMULATED_INPUTS) return undefined;
  try {
    return simulateDocTable(source, library);
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
  const recursion = protocolRecursionInfo(source);
  const branches = protocolBranchInfo(source);
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
  const recursiveChild = recursion.declared !== null || recursion.hasRecur || recursion.usesDepthFlag;

  const sections: DocSection[] = [
    {
      heading: 'How it works',
      body: `${name} is a process: a named list of gates. It reads ${inputs} (its PARAMS) and returns ${outputList} (its RETURNVALS).${gateCount === undefined ? '' : ` It compiles to ${gateCount} gate step${gateCount === 1 ? '' : 's'}.`}`,
    },
    {
      heading: 'Main process or child process?',
      body: children.length > 0
        ? `Here ${name} is the main process: it calls ${children.join(', ')} as child process${children.length === 1 ? '' : 'es'}. RUNCHILD copies the child's gates into this circuit at compile time, on the wires passed with -I (inputs) and -O (outputs)${recursion.usesDepthFlag ? '. Recursive children also need -DEPTH N so the compiler knows how many times to expand them' : ''}. Open a child below to read it.`
        : `${name} calls no child processes. Any other process can use it as a child: DECLARECHILD names it, and RUNCHILD copies its gates into the caller on the wires you pass.`,
    },
    {
      heading: 'The targets (outputs)',
      body: `${outputList} ${outputs.length === 1 ? 'is the target' : 'are the targets'}: the wires this process writes. Inputs are only read unless the process itself changes them. ${measures
        ? 'It measures inside the process. Each meter marks that time on the c lane. The collapse cannot be undone, but the qubit wire stays available for later gates.'
        : 'It contains no MEASURE, so it is reversible as long as it does not SET its outputs and returns every helper wire to 0.'}`,
    },
  ];

  if (recursiveChild) {
    const form = recursion.declared === 'TREC'
      ? 'TREC (explicit tail form; always TCO)'
      : recursion.declared === 'REC'
        ? 'REC (auto-TCO when every RECUR is in tail position, like F#; otherwise stacked frames)'
        : recursion.usesDepthFlag
          ? 'a parent RUNCHILD with -DEPTH (the child supplies REC/TREC)'
          : 'self-RECUR / self-RUNCHILD';
    sections.splice(1, 0, {
      heading: 'Bounded recursion and TCO',
      body: `${name} uses ${form}${recursion.maxDepth !== undefined ? ` with MAXDEPTH ${recursion.maxDepth}` : ''}. `
        + 'Root self-recursion is banned; only a child may expand itself. DEPTH, LEVEL, and ROOTDEPTH are read-only compile-time values for EXIT WHEN. '
        + 'The canvas never shows a loop: a recursive call draws as one gate with a teal D{n} badge that counts down as you step. '
        + 'Tail form reuses one compiler frame (TCO); non-tail REC nests scopes. '
        + 'Compile RecursiveHParent (or any parent with RUNCHILD … -DEPTH N) to see D{n} above the gate.',
    });
  }

  if (branches.blocks > 0 || branches.inlineConditions > 0) {
    const parts = [
      branches.blocks > 0
        ? `${branches.blocks} IF block${branches.blocks === 1 ? '' : 's'}${branches.elses > 0 ? ` (${branches.elses} with ELSE)` : ''}`
        : undefined,
      branches.inlineConditions > 0
        ? `${branches.inlineConditions} gate${branches.inlineConditions === 1 ? '' : 's'} with an inline -IF`
        : undefined,
    ].filter(Boolean).join(' and ');
    sections.splice(1, 0, {
      heading: 'Classical IF / ELSE',
      body: `${name} has ${parts}. A plain IF Token=0|1 runs its gates only if an earlier MEASURE read that bit; `
        + 'IF (GATE -I … -O …) = 0|1|S runs the gate on a scratch copy and compares its result wire. '
        + 'ELSE gates use the opposite value. Both branches stay in the circuit and the other one is skipped, so nothing loops or forks. '
        + 'On the canvas each conditioned gate has a yellow double line to the c lane, labelled IF or ELSE underneath, '
        + 'and shows ✓ taken or ⊘ skipped once the bit is measured.',
    });
  }

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

  const runChildSyntax = recursiveChild && children.length === 0
    ? `RUNCHILD ${name} -DEPTH ${recursion.maxDepth ?? 4} -I ${params.join(' ') || '…'}`
    : children.length > 0 && recursion.usesDepthFlag
      ? `RUNCHILD ${children[0]} -DEPTH 4 -I ${params.join(' ') || '…'}`
      : `RUNCHILD ${name} -I ${params.join(' ') || '…'} -O ${outputs.join(' ') || '…'}`;

  return {
    key,
    kind,
    inputs: params,
    outputs,
    title: customGate ? `${customGate.id} · custom gate` : name,
    subtitle: customGate
      ? `Custom gate from process ${name}`
      : recursion.declared === 'TREC'
        ? 'Process · TREC (tail / TCO)'
        : recursion.declared === 'REC'
          ? 'Process · bounded REC (auto-TCO when tail)'
          : recursion.usesDepthFlag
            ? 'Process · expands recursive child (−DEPTH)'
            : children.length > 0
              ? 'Process · calls child processes'
              : 'Process',
    summary: customGate
      ? `A saved process that replays its gates on the wires you choose: ${inputs} in, ${outputList} out.`
      : recursion.declared
        ? `${inputs} in, ${outputList} out · compile-time recursion (${recursion.declared}).`
        : recursion.usesDepthFlag
          ? `${inputs} in, ${outputList} out · RUNCHILD with −DEPTH expands a recursive child.`
          : `${inputs} in, ${outputList} out.`,
    table,
    syntax: [
      ...(customGate ? [`# Canvas: select ${customGate.id}, then Add gate to target`] : []),
      ...(recursion.declared
        ? [
            recursion.declared === 'TREC' ? 'TREC MAXDEPTH 16' : 'REC MAXDEPTH 16',
            'EXIT WHEN DEPTH == 0',
            'RECUR -I Q',
            `DECLARECHILD ${name}`,
            runChildSyntax,
          ]
        : [
            `DECLARECHILD ${name}`,
            runChildSyntax,
          ]),
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

/** Entry for the protocol in the editor; bundled processes reuse their canonical .qpuio table. */
export const protocolDocEntry = (source: string): DocEntry | undefined => {
  try {
    const name = extractMainProcessName(source);
    if (!name) return undefined;
    const catalogEntry = getCatalogEntry(name);
    return processDocEntry({
      key: `protocol:${name}`,
      kind: 'process',
      name,
      source,
      library: getCatalogLibrarySources(),
      canonical: catalogEntry?.source.trim() === source.trim() ? catalogEntry.truthTable : undefined,
    });
  } catch {
    // Half-typed editor text may not parse yet.
    return undefined;
  }
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
  return undefined;
};
