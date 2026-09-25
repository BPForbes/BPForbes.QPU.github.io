/**
 * Beginner-facing help text shown next to the controls it explains.
 *
 * Doc targets point at PDF named destinations (`\hypertarget` in the LaTeX
 * sources, plus the `gate-<ID>` targets emitted by `\GateHeading`), so a link
 * opens the guide at the matching section. Tests check that every target
 * exists in the document it names.
 */
import type { GateDefinition } from '../../simulator/gates/types';

export type QpuGuideFile =
  | 'QPU_Getting_Started.pdf'
  | 'QPU_Theory_Guide.pdf'
  | 'QPU_Language_Reference.pdf'
  | 'QPU_Examples_and_Troubleshooting.pdf';

export type DocTarget = { file: QpuGuideFile; anchor: string; label: string };

export const docHref = (baseUrl: string, target: DocTarget) =>
  `${baseUrl}${target.file}#nameddest=${target.anchor}`;

export const docTargets = {
  learningPath: { file: 'QPU_Getting_Started.pdf', anchor: 'learning-path', label: 'Learning path (Getting Started)' },
  uiReference: { file: 'QPU_Getting_Started.pdf', anchor: 'ui-reference', label: 'Every control by name (Getting Started)' },
  workbench: { file: 'QPU_Getting_Started.pdf', anchor: 'ui-workbench', label: 'Workbench controls (Getting Started)' },
  runControls: { file: 'QPU_Getting_Started.pdf', anchor: 'ui-run-controls', label: 'Run controls (Getting Started)' },
  compiler: { file: 'QPU_Getting_Started.pdf', anchor: 'ui-compiler', label: 'Protocol compiler (Getting Started)' },
  resetButtons: { file: 'QPU_Getting_Started.pdf', anchor: 'reset-buttons', label: 'Reset buttons compared (Getting Started)' },
  resetSemantics: { file: 'QPU_Theory_Guide.pdf', anchor: 'reset-semantics', label: 'Why RESET is not a gate (Theory Guide)' },
  customGates: { file: 'QPU_Examples_and_Troubleshooting.pdf', anchor: 'custom-gates', label: 'Custom gates (Examples)' },
  processes: { file: 'QPU_Language_Reference.pdf', anchor: 'process-composition', label: 'Main and child processes (Language Reference)' },
  recursion: { file: 'QPU_Language_Reference.pdf', anchor: 'bounded-child-recursion', label: 'Bounded recursion and TCO (Language Reference)' },
  ifElse: { file: 'QPU_Language_Reference.pdf', anchor: 'if-else-blocks', label: 'IF / ELSE / ENDIF (Language Reference)' },
  ifExpression: { file: 'QPU_Language_Reference.pdf', anchor: 'if-gate-expression', label: 'Joined IF with gates (Language Reference)' },
  wrappers: { file: 'QPU_Getting_Started.pdf', anchor: 'ui-wrapper-dialog', label: 'REC / IF / ELSE wrapper tools (Getting Started)' },
  advancedCircuits: { file: 'QPU_Examples_and_Troubleshooting.pdf', anchor: 'advanced-circuits', label: 'Advanced worked circuits (Examples)' },
} as const satisfies Record<string, DocTarget>;

export type GateHelp = {
  name: string;
  summary: string;
  rule: string;
  reversible: boolean;
};

export const gateHelp: Record<string, GateHelp> = {
  X: { name: 'Pauli X (bit flip)', summary: 'Swaps |0⟩ and |1⟩, like a classical NOT.', rule: '|0⟩ ↔ |1⟩', reversible: true },
  Y: { name: 'Pauli Y', summary: 'Flips the bit like X and also adds a factor of ±i.', rule: 'Y|0⟩ = i|1⟩,  Y|1⟩ = −i|0⟩', reversible: true },
  Z: { name: 'Pauli Z (phase flip)', summary: 'Multiplies the |1⟩ part by −1. Measured 0/1 probabilities do not change; interference later can reveal it.', rule: '|1⟩ → −|1⟩', reversible: true },
  H: { name: 'Hadamard', summary: 'Turns |0⟩ into an equal superposition of 0 and 1. Applying it again undoes it.', rule: '|0⟩ → (|0⟩ + |1⟩)/√2', reversible: true },
  S: { name: 'S phase', summary: 'Multiplies the |1⟩ part by i (a quarter turn of phase).', rule: '|1⟩ → i|1⟩', reversible: true },
  T: { name: 'T phase', summary: 'Multiplies the |1⟩ part by e^{iπ/4} (an eighth turn of phase).', rule: '|1⟩ → e^{iπ/4}|1⟩', reversible: true },
  PHASE: { name: 'Arbitrary phase', summary: 'Multiplies the |1⟩ part by e^{iθ}. Set θ with the Phase angle slider.', rule: '|1⟩ → e^{iθ}|1⟩', reversible: true },
  RX: { name: 'X rotation', summary: 'Rotates about the Bloch x-axis by θ. Set θ with the Phase angle slider.', rule: 'RX(θ) = cos(θ/2)I − i sin(θ/2)X', reversible: true },
  RY: { name: 'Y rotation', summary: 'Rotates about the Bloch y-axis by θ. Set θ with the Phase angle slider.', rule: 'RY(θ) = cos(θ/2)I − i sin(θ/2)Y', reversible: true },
  RZ: { name: 'Z rotation', summary: 'Rotates about the Bloch z-axis by θ. Related to PHASE up to a global phase.', rule: 'RZ(θ) = e^{−iθ/2}|0⟩⟨0| + e^{iθ/2}|1⟩⟨1|', reversible: true },
  CNOT: { name: 'Controlled NOT', summary: 'Flips the target when Control A is 1. The control is only read and never changes.', rule: "t' = t ⊕ A", reversible: true },
  CCNOT: { name: 'Toffoli (CCNOT)', summary: 'Flips the target only when Control A and Control B are both 1. Both controls are only read. Start the target at 0 to compute A AND B.', rule: "t' = t ⊕ (A ∧ B)", reversible: true },
  CZ: { name: 'Controlled Z', summary: 'Adds a minus sign when both wires are 1. No bit changes; only the phase does.', rule: '|11⟩ → −|11⟩', reversible: true },
  CY: { name: 'Controlled Y', summary: 'Applies Y to the target when Control A is 1.', rule: 'target → Y·target when A = 1', reversible: true },
  CPHASE: { name: 'Controlled phase', summary: 'Multiplies |11⟩ by e^{iθ}. CZ is the special case θ = π. Set θ with the Phase angle slider.', rule: '|11⟩ → e^{iθ}|11⟩', reversible: true },
  SWAP: { name: 'Swap', summary: 'Exchanges the complete states of the target and Control B. Nothing is copied.', rule: '|a, b⟩ → |b, a⟩', reversible: true },
  MEASURE: { name: 'Measure', summary: 'Reads the wire as a classical 0 or 1 and collapses any superposition. The meter stays on the qubit; a double stroke marks that time on c. The reading cannot be undone, but later gates can still use the qubit. Add -BASIS X or -BASIS Y to measure another observable.', rule: 'P(1) = |amplitude of |1⟩|² (Z basis)', reversible: false },
  NOT: { name: 'Logical NOT', summary: 'Flips the target, exactly like X.', rule: "t' = t ⊕ 1", reversible: true },
  AND: { name: 'Reversible AND', summary: 'Flips the target when both inputs are 1. Inputs are only read. Start the target at 0 and it ends holding A AND B.', rule: "t' = t ⊕ (A ∧ B)", reversible: true },
  NAND: { name: 'Reversible NAND', summary: 'Flips the target unless both inputs are 1. Start the target at 0 and it ends holding NOT (A AND B).', rule: "t' = t ⊕ ¬(A ∧ B)", reversible: true },
  OR: { name: 'Reversible OR', summary: 'Flips the target when either input is 1. Start the target at 0 and it ends holding A OR B.', rule: "t' = t ⊕ (A ∨ B)", reversible: true },
  XOR: { name: 'Reversible XOR', summary: 'Flips the target when exactly one input is 1. Start the target at 0 and it ends holding A XOR B.', rule: "t' = t ⊕ A ⊕ B", reversible: true },
};

export const gateDocTarget = (gateId: string): DocTarget =>
  gateHelp[gateId]
    ? { file: 'QPU_Theory_Guide.pdf', anchor: `gate-${gateId}`, label: `${gateId} reference (Theory Guide)` }
    : docTargets.customGates;

export type WorkbenchSelectorUse = {
  controlA: boolean;
  controlB: boolean;
  phase: boolean;
};

// Mirrors the placement rules in App's workbench and the registry, so the UI can tell learners which selectors a gate reads.
export const workbenchSelectorUse = (definition: GateDefinition | undefined): WorkbenchSelectorUse => {
  if (!definition) return { controlA: false, controlB: false, phase: false };
  const inputs = Math.max(1, definition.astInputCount);
  const reads = definition.controlKind === 'single' || definition.controlKind === 'parametric';
  return {
    controlA: reads || definition.controlKind === 'double',
    controlB: definition.controlKind === 'double' || definition.controlKind === 'swap' || (reads && inputs >= 2),
    phase: definition.supportsPhase,
  };
};

export const uiTips = {
  gate: 'Which gate “Add gate to target” will place.',
  targetParticle: 'The wire the gate changes. Measure target also reads this wire.',
  controlA: 'First wire the gate reads. It is never changed by the gate.',
  controlB: 'Second wire the gate reads (two-input gates), or the partner wire for SWAP.',
  phaseAngle: 'θ for PHASE, RX, RY, RZ, and CPHASE, in degrees.',
  addGate: 'Append the selected gate as the next column, using the target and controls chosen above.',
  increaseCycle: 'Insert an INCREASECYCLE boundary. This advances the logical stage but does not loop or repeat earlier gates. Recursive INCREASECYCLE markers stay hidden; the recursive gate shows D{n} instead.',
  recursionDepth: 'Parent RUNCHILD of a recursive child must pass -DEPTH N. The canvas draws one gate with a teal D{n} badge that counts down as you step through the expansion.',
  addParticle: 'Add a wire (or, after compiling a protocol, a PARAMS input).',
  removeParticle: 'Remove the last wire (or the last PARAMS input).',
  measureTarget: 'Measure only the target wire now, without adding a meter to the circuit.',
  inverseToggle: 'Off drops the forward gate. On drops its dagger: blue outline, purple while that step is active. S, T, and PHASE negate their angle.',
  startState: 'Starting state for this wire: 0p = |0⟩, 1p = |1⟩, sp = equal superposition.',
  playSequence: 'Run one gate at a time at the chosen speed. At the end, replays from the start.',
  runAll: 'Jump straight to the final state.',
  stepGate: 'Run exactly one more gate.',
  resetState: 'Rewind to the start states and clear measurements. Keeps every gate.',
  measureAll: 'Measure every wire that has not been measured yet.',
  clearCircuit: 'Delete every gate. Keeps the wires, their start states, and custom gates.',
  resetSite: 'Put the whole builder back to its first-visit state. Custom gates and the catalog are kept.',
  speed: 'Playback speed for Play Sequence.',
  compileProtocol: 'Turn the editor text into canvas gates and rewind the run.',
  downloadQpucir: 'Save the editor text as a .qpucir protocol file.',
  downloadQpucirTxt: 'Save the same text with a -qpucir.txt name for devices that cannot open custom extensions.',
  bundledProtocol: 'Load and compile this bundled protocol.',
} as const;
