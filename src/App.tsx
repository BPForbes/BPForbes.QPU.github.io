import { ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  announceGuestReady,
  isEmbedMode,
  isHostSetViewMessage,
  pushViewInLocation,
  readViewLocation,
  replaceViewInLocation,
} from './embedMode';
import { CircuitCanvas } from './components/CircuitCanvas';
import { WorkbenchDocs } from './components/docs/WorkbenchDocs';
import { CustomGatePanel, GatePalette, SelectorMapDiagram } from './components/gate';
import { ModuleLab } from './components/ModuleLab';
import { OutputPanel } from './components/OutputPanel';
import { ParticleView } from './components/ParticleView';
import {
  playgroundPageDomId,
  type PlaygroundViewId,
} from './components/PlaygroundScrubber';
import { MAX_PLAY_SPEED, MIN_PLAY_SPEED, playDelayMs } from './components/circuitLayout';
import { examples, learningSteps } from './data/examples';
import {
  docHref,
  docTargets,
  gateHelp,
  uiTips,
  workbenchSelectorUse,
  type DocTarget,
} from './data/learning/learningHelp';
import {
  readLearningProgress,
  suggestNextLearningStep,
  toggleLearningStep,
  type LearningProgress,
} from './data/learning/learningProgress';
import { protocolDocEntry, resolveDocEntry } from './data/learning/docEntries';
import { startStateWireValue, wireValuesFromState } from './data/learning/docContext';
import {
  isProtectedQpuioProcess,
  getCatalogLibrarySources,
  protocolExamples,
  registerCatalogProcess,
  warnProtectedTruthTable,
  type ConfiguredQpucirProcess,
  type ProcessCatalogOrigin,
} from './data/catalog';
import {
  companionQpuioFileName,
  downloadQpucirContents,
  downloadQpucirTxtSource,
  isLooseQpucirUpload,
  isQpuioFileName,
  isQpucirFileName,
  parseQpucirPayload,
  parseQpuioPayload,
  QPU_FILE_UPLOAD_ACCEPT,
  validateUploadFileName,
} from './data/formats';
import { createInitialState, measureAll, measureQubit, projectStateOntoQubits, resolveStateQubitCount, runCircuit, stepCircuitGate } from './simulator/engine';
import {
  analyzeQpuProtocol,
  compileQpuProtocol,
  extractMainProcessName,
  getProtocolParameterEntries,
  ProcessParam,
  qpucirFileNameForSource,
  ReturnValue,
  serializeCircuitToQpuProtocol,
  supportedQpuOperations,
  updateProtocolParameterCount,
  updateProtocolStartStateSet,
  visibleCircuitGates,
} from './simulator/compiler';
import { controlsForGateType, getGateDefinition, paletteGateIds } from './simulator/gates/registry';
import type { OperationTransition, ParticleSnapshot } from './simulator/physics';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState, StateCheckpoint } from './simulator/types';
import { Complex } from './simulator/complex';
import './styles.css';

const QUBIT_COUNT = 3;

const QPU_DOCUMENTS = [
  {
    fileName: 'QPU_Getting_Started.pdf',
    title: 'Getting Started',
    description: 'Website walkthrough and programming basics.',
  },
  {
    fileName: 'QPU_Theory_Guide.pdf',
    title: 'Classical and Quantum Theory',
    description: 'Bits, complex amplitudes, Bloch spheres, and gate mathematics.',
  },
  {
    fileName: 'QPU_Language_Reference.pdf',
    title: 'Language Reference',
    description: 'Complete protocol, gate, process, and truth-table syntax.',
  },
  {
    fileName: 'QPU_Examples_and_Troubleshooting.pdf',
    title: 'Examples and Troubleshooting',
    description: 'Runnable examples, diagnostics, and Correction Lab guidance.',
  },
  {
    fileName: 'QPU_Circuit_Docs.pdf',
    title: 'Documentation Suite Index',
    description: 'A short map of all QPU guides.',
  },
] as const;
type QpuDocument = (typeof QPU_DOCUMENTS)[number];

type AppView = PlaygroundViewId;

const initialProtocolSource = protocolExamples[0].source;

const DocLink = ({ target, children }: { target: DocTarget; children?: ReactNode }) => (
  <a className="doc-link" href={docHref(import.meta.env.BASE_URL, target)} rel="noreferrer" target="_blank">
    {children ?? target.label}
  </a>
);

// Placement defers control/target wiring to the registry so palette drops and workbench picks share one layout policy.
const newGate = (
  type: GateType,
  step: number,
  target: number,
  qubitCount: number,
  overrideControls?: number[],
  swapPartner?: number,
  phase = Math.PI / 2,
  inverse = false,
): CircuitGate | null => {
  const placement = controlsForGateType(type, target, qubitCount, swapPartner);
  if (!placement) return null;

  const definition = getGateDefinition(type);
  const controls = overrideControls ?? placement.controls;
  const targets = placement.targets;

  return {
    id: `${type}-${step}-${target}-${crypto.randomUUID()}`,
    type,
    step,
    targets,
    controls,
    phase: definition?.supportsPhase ? (inverse ? -phase : phase) : undefined,
    inverse: inverse && definition?.supportsReverse ? true : undefined,
    customGateId: definition?.category === 'custom' ? type : undefined,
  };
};

const PlaygroundPage = ({
  active = true,
  children,
  id,
  label,
}: {
  active?: boolean;
  children: ReactNode;
  id: PlaygroundViewId;
  label: string;
}) => (
  <section
    aria-label={label}
    className="playground-page"
    data-playground-page={id}
    hidden={!active}
    id={playgroundPageDomId(id)}
  >
    {children}
  </section>
);

const scrollRouteTop = () => {
  document.querySelector<HTMLElement>('.app-shell')?.scrollTo({ top: 0, behavior: 'auto' });
};

function App() {
  const [qubitCount, setQubitCount] = useState(QUBIT_COUNT);
  const [simulationQubitCount, setSimulationQubitCount] = useState(QUBIT_COUNT);
  const [runtimeQubitCount, setRuntimeQubitCount] = useState(QUBIT_COUNT);
  const [gates, setGates] = useState<CircuitGate[]>([]);
  const [startStates, setStartStates] = useState<ParticleStartState[]>(() => Array.from({ length: QUBIT_COUNT }, () => '0p'));
  const [state, setState] = useState<Complex[]>(() => createInitialState(QUBIT_COUNT));
  const [measurements, setMeasurements] = useState<MeasurementMap>({});
  const [log, setLog] = useState<string[]>(['Initialized |000⟩.']);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [selectedGate, setSelectedGate] = useState<GateType | null>('H');
  const [inverseMode, setInverseMode] = useState(false);
  const [learningProgress, setLearningProgress] = useState<LearningProgress>(() => readLearningProgress());
  const [targetQubit, setTargetQubit] = useState(0);
  const [controlQubit, setControlQubit] = useState(1);
  const [secondControlQubit, setSecondControlQubit] = useState(2);
  const [phaseDegrees, setPhaseDegrees] = useState(90);
  const [protocolSource, setProtocolSource] = useState(protocolExamples[0].source);
  // The protocol card describes the last circuit that compiled, not the editor text while it is being changed.
  const [compiledSource, setCompiledSource] = useState<string | null>(null);
  const [selectedQpuDocument, setSelectedQpuDocument] = useState<QpuDocument>(QPU_DOCUMENTS[0]);
  const [compileSummary, setCompileSummary] = useState('Paste or load a QPU protocol, then compile it into visual gates.');
  const [tokenMap, setTokenMap] = useState<Record<string, number>>({});
  const [processParams, setProcessParams] = useState<ProcessParam[]>([]);
  const [returnValues, setReturnValues] = useState<ReturnValue[]>([]);
  const [activeView, setActiveView] = useState<AppView>(() => readViewLocation(window.location) ?? 'builder');
  const [menuOpen, setMenuOpen] = useState(false);
  const [fileStatus, setFileStatus] = useState('Upload a .qpucir file (or -qpucir.txt on restrictive file pickers), or download one of the bundled QPU circuits.');
  const [protocolMode, setProtocolMode] = useState<'canvas' | 'process'>('process');
  const [customGateRegistryVersion, setCustomGateRegistryVersion] = useState(0);
  // The workbench docs follow the canvas while stepping and return to the selectors on any selector change.
  const [docFocus, setDocFocus] = useState<'selection' | 'circuit'>('selection');
  const [preStep, setPreStep] = useState<{ cursor: number; state: Complex[]; qubitCount: number } | null>(null);
  const checkpointsRef = useRef<Record<string, StateCheckpoint>>({});
  const [particleSnapshots, setParticleSnapshots] = useState<ParticleSnapshot[]>([]);
  const [particleTransitions, setParticleTransitions] = useState<OperationTransition[]>([]);
  // Palette refresh bumps when custom gates register so GateBlock picks up new definitions.
  const palette = useMemo(() => paletteGateIds(), [customGateRegistryVersion]);
  const selectedGateDefinition = selectedGate ? getGateDefinition(selectedGate) : undefined;
  const selectorUse = workbenchSelectorUse(selectedGateDefinition);
  const orderedGates = useMemo(() => gates.slice().sort((a, b) => a.step - b.step), [gates]);
  const protocolDiagnosticReport = useMemo(
    () => analyzeQpuProtocol(protocolSource, getCatalogLibrarySources()),
    [protocolSource],
  );
  // RESET lowering stays in orderedGates for simulation but is hidden on the canvas timeline.
  const renderedGates = useMemo(() => visibleCircuitGates(orderedGates), [orderedGates]);
  // Token labels decorate canvas wires but never change simulator qubit indices.
  const qubitLabels = useMemo(() => {
    const labels = Array.from({ length: qubitCount }, (_, qubit) => `q${qubit}`);
    Object.entries(tokenMap).forEach(([token, qubit]) => {
      if (qubit < qubitCount) {
        const shortName = token.includes('/') ? token.split('/').pop() ?? token : token;
        const isNumeric = /^\d+$/.test(shortName);
        const existing = labels[qubit];
        const existingIsDefault = existing === `q${qubit}` || /^\d+$/.test(existing.split(' · ')[1] ?? '');
        if (existingIsDefault || !isNumeric) {
          labels[qubit] = `q${qubit} · ${shortName}`;
        }
      }
    });
    return labels;
  }, [qubitCount, tokenMap]);
  const phaseRadians = (phaseDegrees * Math.PI) / 180;
  // Canvas mode synthesizes one PARAM per wire; compiled mode filters to user-visible process inputs only.
  const controllableParams = useMemo(() => {
    const inRange = processParams.filter((param) => param.qubitIndex >= 0 && param.qubitIndex < simulationQubitCount);
    if (inRange.length > 0) return inRange;
    return Array.from({ length: qubitCount }, (_, qubit) => ({ name: `q${qubit}`, type: '1', qubitIndex: qubit }));
  }, [processParams, qubitCount, simulationQubitCount]);
  const paramQubitIndices = useMemo(() => controllableParams.map((param) => param.qubitIndex), [controllableParams]);
  // Compiled processes can use hidden workspace qubits, so result panels project the full state down to RETURNVALS or PARAMS.
  const displayQubitIndices = useMemo(
    () => (returnValues.length > 0 ? returnValues.map((value) => value.qubitIndex) : paramQubitIndices),
    [returnValues, paramQubitIndices],
  );
  const displayQubitCount = returnValues.length > 0
    ? returnValues.length
    : processParams.length > 0
      ? controllableParams.length
      : qubitCount;
  const selectedTarget = Math.min(targetQubit, displayQubitCount - 1);
  // Workbench indices are display-order; gate placement uses the mapped simulation wire when compiled.
  const selectedSimulationQubit = displayQubitIndices[selectedTarget]
    ?? controllableParams[selectedTarget]?.qubitIndex
    ?? selectedTarget;
  const displayQubitLabels = useMemo(
    () => (returnValues.length > 0
      ? returnValues.map((value) => value.name)
      : processParams.length > 0
        ? controllableParams.map((param) => param.name)
        : qubitLabels.slice(0, qubitCount)),
    [returnValues, processParams.length, controllableParams, qubitLabels, qubitCount],
  );
  // Ket readouts use the projected state whenever ancilla wires exceed logical RETURNVALS width.
  const displayState = useMemo(() => {
    if (displayQubitIndices.length > 0 && simulationQubitCount > displayQubitCount) {
      return projectStateOntoQubits(state, simulationQubitCount, displayQubitIndices);
    }
    return state;
  }, [state, simulationQubitCount, displayQubitCount, displayQubitIndices]);
  // Measurement panels mirror the same RETURNVALS/PARAMS projection as displayState.
  const displayMeasurements = useMemo(() => {
    if (returnValues.length > 0) {
      const mapped: MeasurementMap = {};
      returnValues.forEach((value, displayIndex) => {
        if (measurements[value.qubitIndex] !== undefined) {
          mapped[displayIndex] = measurements[value.qubitIndex]!;
        }
      });
      return mapped;
    }
    if (processParams.length === 0) return measurements;
    const mapped: MeasurementMap = {};
    controllableParams.forEach((param, displayIndex) => {
      if (measurements[param.qubitIndex] !== undefined) {
        mapped[displayIndex] = measurements[param.qubitIndex]!;
      }
    });
    return mapped;
  }, [measurements, returnValues, controllableParams, processParams.length]);

  // First free wire wins so parametric gates can auto-fill a third control without another dropdown.
  const chooseDistinctQubit = (avoid: number[], wireCount = simulationQubitCount): number | undefined =>
    Array.from({ length: wireCount }, (_, qubit) => qubit).find((qubit) => !avoid.includes(qubit));

  // Workbench placement auto-repairs conflicting control selections instead of rejecting common target/control overlaps.
  const workbenchControlsForGate = (type: GateType, target: number) => {
    const definition = getGateDefinition(type);
    if (!definition || definition.controlKind === 'none' || definition.controlKind === 'swap') return undefined;
    if (definition.controlKind === 'single' || definition.controlKind === 'parametric') {
      const inputCount = Math.max(1, definition.astInputCount);
      if (simulationQubitCount - 1 < inputCount) return undefined;
      const controls: number[] = [];
      for (let index = 0; index < inputCount; index += 1) {
        const preferred = index === 0 ? controlQubit : secondControlQubit;
        let candidate = preferred === target || controls.includes(preferred)
          ? chooseDistinctQubit([target, ...controls])
          : preferred;
        if (candidate === undefined || candidate === target || controls.includes(candidate)) {
          return undefined;
        }
        controls.push(candidate);
      }
      return controls;
    }
    if (definition.controlKind === 'double') {
      if (simulationQubitCount < 3) return undefined;
      const first = controlQubit === target
        ? chooseDistinctQubit([target, secondControlQubit])
        : controlQubit;
      if (first === undefined || first === target) return undefined;
      const second = secondControlQubit === target || secondControlQubit === first
        ? chooseDistinctQubit([target, first])
        : secondControlQubit;
      if (second === undefined || second === target || second === first) return undefined;
      return [first, second];
    }
    return undefined;
  };

  // Canvas edits own the protocol text in canvas mode; compiled process metadata is cleared to avoid stale token labels.
  const syncCanvasProtocol = (nextGates: CircuitGate[], nextQubitCount = simulationQubitCount, nextStartStates = startStates) => {
    setProtocolMode('canvas');
    setCompiledSource(null);
    setProcessParams([]);
    setReturnValues([]);
    setTokenMap({});
    setQubitCount(nextQubitCount);
    setProtocolSource(serializeCircuitToQpuProtocol(nextGates, nextQubitCount, nextStartStates));
  };

  // New PARAMS receive fresh qubit slots after existing compiled wires so user-added inputs do not collide with workspace registers.
  // Preserves existing qubitIndex bindings when PARAMS are renamed but keeps new names on fresh slots.
  const processParamsFromProtocolSource = (source: string, previousParams = processParams, firstNewQubit = simulationQubitCount) => {
    let nextNewQubit = firstNewQubit;
    return getProtocolParameterEntries(source).map((param) => {
      const existing = previousParams.find((candidate) => candidate.name === param.name);
      if (existing) return existing;
      const created = { name: param.name, type: param.type, qubitIndex: nextNewQubit };
      nextNewQubit += 1;
      return created;
    });
  };

  // Runtime resets initialize only user-controllable PARAMS when a compiled process has internal ancilla wires.
  const resetRuntime = (
    nextSimulationQubitCount = simulationQubitCount,
    reason?: string,
    nextStartStates = startStates,
    nextProcessParams = processParams,
  ) => {
    const activeControllable = nextProcessParams.filter(
      (param) => param.qubitIndex >= 0 && param.qubitIndex < nextSimulationQubitCount,
    );
    const activeParamIndices = activeControllable.length
      ? activeControllable.map((param) => param.qubitIndex)
      : undefined;
    checkpointsRef.current = {};
    setState(createInitialState(nextSimulationQubitCount, nextStartStates, activeParamIndices));
    setRuntimeQubitCount(nextSimulationQubitCount);
    setMeasurements({});
    const initDesc = activeControllable.length
      ? activeControllable.map((param) => `${param.name}=${nextStartStates[param.qubitIndex] ?? '0p'}`).join(' ')
      : nextStartStates.slice(0, nextSimulationQubitCount).map((value) => value ?? '0p').join(' ');
    setLog([reason ?? `Initialized ${initDesc}.`]);
    setCursor(0);
    setPlaying(false);
    setParticleSnapshots([]);
    setParticleTransitions([]);
  };

  // Drag-drop placement: CircuitCanvas resolves the drop qubit row from the
  // pointer's Y coordinate and passes it as `target`; the step index is always
  // appended (max existing step + 1) — there is no mid-sequence insertion or
  // collision check. Gates re-index sequentially on removal via removeGate.
  const addGate = (type: GateType, target: number, controls?: number[]) => {
    const step = gates.length === 0 ? 0 : Math.max(...gates.map((gate) => gate.step)) + 1;
    const swapPartner = getGateDefinition(type)?.controlKind === 'swap'
      ? (secondControlQubit === target ? chooseDistinctQubit([target]) : secondControlQubit)
      : undefined;
    const gate = newGate(type, step, target, simulationQubitCount, controls, swapPartner, phaseRadians, inverseMode);
    if (!gate) {
      setLog((current) => [...current, `${type} requires more qubits than are available in this circuit.`]);
      return;
    }
    const nextGates = [...gates, gate];
    setGates(nextGates);
    syncCanvasProtocol(nextGates);
    setSelectedGate(type);
    resetRuntime();
  };

  // Steps are renumbered after removal so the canvas column layout stays contiguous.
  const removeGate = (gateId: string) => {
    const nextGates = gates.filter((gate) => gate.id !== gateId).map((gate, step) => ({ ...gate, step }));
    setGates(nextGates);
    syncCanvasProtocol(nextGates);
    resetRuntime();
  };

  // Run / step boundary: both paths write to the same shared vectors (state,
  // measurements, particleSnapshots). `run` replaces them wholesale and sets
  // cursor to orderedGates.length. `step` applies one gate and increments cursor,
  // so the two modes interleave freely — stepping after a full run is a no-op
  // because cursor >= orderedGates.length guards the gate lookup.
  // Play Sequence walks the same step path on a timer; Run all skips animation.
  const run = () => {
    setPlaying(false);
    checkpointsRef.current = {};
    const result = runCircuit(
      simulationQubitCount,
      orderedGates,
      startStates,
      paramQubitIndices.length ? paramQubitIndices : undefined,
      { librarySources: getCatalogLibrarySources(), trackParticles: true, checkpoints: checkpointsRef.current },
    );
    setState(result.state);
    setRuntimeQubitCount(resolveStateQubitCount(result.state, simulationQubitCount));
    setMeasurements(result.measurements);
    setParticleSnapshots(result.particles ?? []);
    setParticleTransitions(result.transitions ?? []);
    setLog(result.log.filter((entry) => !entry.startsWith('RESET') && !entry.startsWith('Cycle workspace prepared')));
    setPreStep(null);
    setDocFocus('circuit');
    setCursor(orderedGates.length);
  };

  // Step mode resolves the current state-vector width because child-process expansion can allocate qubits lazily.
  const step = () => {
    const gate = orderedGates[cursor];
    if (!gate) return;
    const workingQubitCount = resolveStateQubitCount(state, runtimeQubitCount);
    const { result, qubitCount: nextQubitCount } = stepCircuitGate(state, workingQubitCount, gate, measurements, {
      librarySources: getCatalogLibrarySources(),
      trackParticles: true,
      checkpoints: checkpointsRef.current,
    });
    setRuntimeQubitCount(nextQubitCount);
    setState(result.state);
    setMeasurements(result.measurements);
    setParticleSnapshots(result.particles ?? []);
    setParticleTransitions((current) => [...current, ...(result.transitions ?? [])]);
    setLog((current) => [...current, ...result.log.filter((entry) => !entry.startsWith('RESET') && !entry.startsWith('Cycle workspace prepared'))]);
    setPreStep({ cursor: cursor + 1, state, qubitCount: workingQubitCount });
    setDocFocus('circuit');
    setCursor((current) => current + 1);
  };

  const stepRef = useRef(step);
  stepRef.current = step;

  const playSequence = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (orderedGates.length === 0) {
      setLog((current) => [...current, 'Add gates before playing the sequence.']);
      return;
    }
    if (cursor >= orderedGates.length) {
      resetRuntime(simulationQubitCount, 'Replay from the start of the circuit.');
    }
    setPlaying(true);
  };

  useEffect(() => {
    if (!playing) return;
    if (cursor >= orderedGates.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      stepRef.current();
    }, cursor === 0 ? 0 : playDelayMs(playSpeed));
    return () => window.clearTimeout(timer);
  }, [playing, playSpeed, cursor, orderedGates.length]);

  // resetCircuit is a convenience alias; it does not change qubit count or start states.
  const resetCircuit = () => resetRuntime();

  // Start-state edits write back into either the canvas serialization or the matching PARAMS declaration.
  const updateStartStates = (assignments: ReadonlyMap<number, ParticleStartState>) => {
    // In a compiled process only PARAMS are start states. A return wire or a selector
    // that is not a parameter must not become a new SET line.
    const updates = [...assignments].flatMap(([qubit, value]) => {
      const name = controllableParams.find((param) => param.qubitIndex === qubit)?.name;
      if (protocolMode === 'process' && !name) return [];
      return [{ qubit, value, name: name ?? `q${qubit}` }];
    });
    if (updates.length === 0) return;
    const allowed = new Map(updates.map(({ qubit, value }) => [qubit, value]));
    const nextStartStates = Array.from(
      { length: simulationQubitCount },
      (_, index) => allowed.get(index) ?? startStates[index] ?? '0p',
    );
    setStartStates(nextStartStates);
    setProtocolSource((current) => {
      if (protocolMode !== 'process') {
        return serializeCircuitToQpuProtocol(gates, simulationQubitCount, nextStartStates);
      }
      return updates.reduce((source, { value, name }) => updateProtocolStartStateSet(source, name, value), current);
    });
    resetRuntime(
      simulationQubitCount,
      `Set ${updates.map(({ name, value }) => `${name} start state to ${value}`).join(', ')}.`,
      nextStartStates,
    );
  };

  const updateStartState = (qubit: number, value: ParticleStartState) => updateStartStates(new Map([[qubit, value]]));

  // Full site reset restores default protocol text, runtime vectors, and UI selections; the process catalog is unchanged.
  const resetSite = () => {
    setQubitCount(QUBIT_COUNT);
    setSimulationQubitCount(QUBIT_COUNT);
    const defaultStartStates = Array.from({ length: QUBIT_COUNT }, () => '0p' as ParticleStartState);
    setStartStates(defaultStartStates);
    setGates([]);
    setSelectedGate('H');
    setInverseMode(false);
    setTargetQubit(0);
    setControlQubit(1);
    setSecondControlQubit(2);
    setPhaseDegrees(90);
    setProtocolSource(initialProtocolSource);
    setCompiledSource(null);
    setCompileSummary('Paste or load a QPU protocol, then compile it into visual gates.');
    setTokenMap({});
    setProcessParams([]);
    setReturnValues([]);
    setFileStatus('Site reset to the default circuit builder state.');
    setProtocolMode('process');
    setActiveView('builder');
    setMenuOpen(false);
    replaceViewInLocation(window.location, 'builder');
    resetRuntime(QUBIT_COUNT, undefined, defaultStartStates);
  };

  // Bulk measurement collapses all unmeasured qubits at once; individual qubit measure is handled by measureSelectedQubit.
  // measureAll walks every simulation wire; display panels still project results afterward.
  const measure = () => {
    const result = measureAll(state, simulationQubitCount, measurements);
    setState(result.state);
    setMeasurements(result.measurements);
    setLog((current) => [...current, ...result.log.filter((entry) => !entry.startsWith('RESET') && !entry.startsWith('Cycle workspace prepared'))]);
  };

  // The UI measures display qubits, then maps that choice back onto compiled PARAM qubits when needed.
  const measureSelectedQubit = () => {
    if (measurements[selectedTarget] !== undefined) {
      setLog((current) => [...current, `q${selectedTarget} is already measured as ${measurements[selectedTarget]}.`]);
      return;
    }

    const result = measureQubit(state, simulationQubitCount, controllableParams[selectedTarget]?.qubitIndex ?? selectedTarget);
    setState(result.state);
    setMeasurements((current) => ({ ...current, [selectedTarget]: result.value }));
    setLog((current) => [...current, `Measured q${selectedTarget} = ${result.value} (P(1)=${result.probabilityOne.toFixed(3)}).`]);
  };

  // Workbench adds override controls computed from the selected target and control dropdowns.
  const addGateFromWorkbench = () => {
    if (!selectedGate) {
      setLog((current) => [...current, 'Select a gate before adding it to the circuit.']);
      return;
    }
    addGate(selectedGate, selectedSimulationQubit, workbenchControlsForGate(selectedGate, selectedSimulationQubit));
  };

  const addCycleBoundary = () => {
    const step =
      gates.length === 0
        ? 0
        : Math.max(...gates.map((gate) => gate.step)) + 1;
    const previousCycle = gates.reduce(
      (highest, gate) => Math.max(highest, gate.cycle ?? 0),
      0,
    );
    const marker: CircuitGate = {
      id: `cycle-${crypto.randomUUID()}`,
      type: 'CYCLE',
      step,
      targets: [],
      controls: [],
      cycle: previousCycle + 1,
      source: 'INCREASECYCLE',
    };
    const nextGates = [...gates, marker];
    setGates(nextGates);
    syncCanvasProtocol(nextGates);
    resetRuntime();
    setLog((current) => [
      ...current,
      `Added INCREASECYCLE boundary (cycle ${previousCycle + 1}). This advances the logical stage; it does not loop.`,
    ]);
  };

  // Particle count controls either raw canvas wires or process PARAMS, depending on which authoring mode is active.
  const addParticle = () => {
    if (protocolMode === 'process') {
      const currentParamCount = getProtocolParameterEntries(protocolSource).length;
      const nextSource = updateProtocolParameterCount(protocolSource, currentParamCount + 1);
      const nextParams = processParamsFromProtocolSource(nextSource);
      const nextSimulationQubitCount = Math.max(
        simulationQubitCount,
        ...nextParams.map((param) => param.qubitIndex + 1),
      );
      const nextStartStates = Array.from(
        { length: nextSimulationQubitCount },
        (_, index) => startStates[index] ?? '0p' as ParticleStartState,
      );
      const addedParam = nextParams[nextParams.length - 1];
      setProtocolSource(nextSource);
      setProcessParams(nextParams);
      setSimulationQubitCount(nextSimulationQubitCount);
      if (returnValues.length === 0) setQubitCount(Math.max(1, nextParams.length));
      setStartStates(nextStartStates);
      resetRuntime(
        nextSimulationQubitCount,
        `Added process parameter ${addedParam?.name ?? `Q${currentParamCount}`}; compile the protocol to bind it into the circuit.`,
        nextStartStates,
        nextParams,
      );
      return;
    }

    // Canvas particle cap keeps the drag palette and Bloch view readable on small screens.
    const nextCount = Math.min(qubitCount + 1, 6);
    if (nextCount === qubitCount) {
      setLog((current) => [...current, 'This playground supports up to 6 qubit particles.']);
      return;
    }
    setQubitCount(nextCount);
    setSimulationQubitCount(nextCount);
    setTargetQubit(nextCount - 1);
    if (nextCount > 1) setControlQubit(0);
    if (nextCount > 2) setSecondControlQubit(1);
    const nextStartStates = [...startStates, '0p' as ParticleStartState];
    setStartStates(nextStartStates);
    syncCanvasProtocol(gates, nextCount, nextStartStates);
    resetRuntime(nextCount, `Added particle q${nextCount - 1}; reset start states.`, nextStartStates);
  };

  const removeParticle = () => {
    if (protocolMode === 'process') {
      const currentParamCount = getProtocolParameterEntries(protocolSource).length;
      const nextParamCount = Math.max(0, currentParamCount - 1);
      if (nextParamCount === currentParamCount) {
        setLog((current) => [...current, 'This compiled process has no parameter particles to remove.']);
        return;
      }
      const nextSource = updateProtocolParameterCount(protocolSource, nextParamCount);
      const nextParams = processParamsFromProtocolSource(nextSource);
      setProtocolSource(nextSource);
      setProcessParams(nextParams);
      if (returnValues.length === 0) setQubitCount(Math.max(1, nextParams.length || qubitCount - 1));
      resetRuntime(
        simulationQubitCount,
        'Removed the last process parameter; compile the protocol to rebuild the circuit inputs.',
        startStates,
        nextParams,
      );
      return;
    }

    const nextCount = Math.max(1, qubitCount - 1);
    if (nextCount === qubitCount) {
      setLog((current) => [...current, 'At least one qubit particle is required.']);
      return;
    }

    setQubitCount(nextCount);
    setSimulationQubitCount(nextCount);
    const nextStartStates = startStates.slice(0, nextCount);
    setStartStates(nextStartStates);
    // Removing a canvas wire drops gates that referenced the deleted index and compacts steps.
    setGates((current) =>
      current
        .filter((gate) => gate.targets.every((target) => target < nextCount) && gate.controls.every((control) => control < nextCount))
        .map((gate, step) => ({ ...gate, step })),
    );
    setTargetQubit((current) => Math.min(current, nextCount - 1));
    setControlQubit((current) => (current >= nextCount ? 0 : current));
    setSecondControlQubit((current) => (current >= nextCount ? Math.max(0, nextCount - 1) : current));
    syncCanvasProtocol(gates.filter((gate) => gate.targets.every((target) => target < nextCount) && gate.controls.every((control) => control < nextCount)), nextCount, nextStartStates);
    resetRuntime(nextCount, `Removed last particle; reset start states.`, nextStartStates);
  };

  // Clearing gates keeps qubit count and start states; only the serialized protocol and runtime reset.
  const clearCircuit = () => {
    setGates([]);
    syncCanvasProtocol([], simulationQubitCount, startStates);
    resetRuntime();
  };

  // Loading a canvas example intentionally drops compiled metadata; examples are edited as visual circuits first.
  const loadExample = (index: number) => {
    const example = examples[index];
    const nextStartStates = Array.from({ length: example.qubitCount }, () => '0p' as ParticleStartState);
    setQubitCount(example.qubitCount);
    setSimulationQubitCount(example.qubitCount);
    setGates(example.gates);
    setProtocolMode('canvas');
    setCompiledSource(null);
    setProtocolSource(serializeCircuitToQpuProtocol(example.gates, example.qubitCount, nextStartStates, example.name));
    setStartStates(nextStartStates);
    setTokenMap({});
    setProcessParams([]);
    setReturnValues([]);
    resetRuntime(example.qubitCount, `Loaded ${example.name}.`, nextStartStates);
  };

  // Compilation is the handoff point between text protocols, visual gates, catalog entries, and simulator runtime sizing.
  const compileProtocolSource = (
    source: string,
      label = 'QPU protocol',
    origin: ProcessCatalogOrigin = 'compiled',
    options?: { fileName?: string; skipCatalogRegister?: boolean },
  ) => {
    try {
      const result = compileQpuProtocol(source, getCatalogLibrarySources());
      setCompiledSource(source);
      setProtocolMode('process');
      setSimulationQubitCount(result.qubitCount);
      setQubitCount(result.logicalQubitCount);
      const nextStartStates = Array.from({ length: result.qubitCount }, () => '0p' as ParticleStartState);
      setStartStates(nextStartStates);
      setGates(result.gates);
      setTokenMap(result.tokenMap);
      setProcessParams(result.processParams);
      setReturnValues(result.returnValues);
      const paramSummary = result.processParams.length
        ? `${result.processParams.length} process parameter(s) (${result.processParams.map((param) => param.name).join(', ')})`
        : 'no explicit process parameters';
      const returnSummary = result.returnValues.length
        ? `; ket displays ${result.returnValues.map((value) => value.name).join(', ')}`
        : '';
      // logicalQubitCount tracks RETURNVALS width; qubitCount includes hidden workspace/ancilla wires.
      const registerSummary = result.logicalQubitCount < result.qubitCount
        ? `${result.logicalQubitCount} return qubit(s) over ${result.qubitCount} simulation register(s)${returnSummary}`
        : `${result.qubitCount} register(s)`;
      setCompileSummary(`Compiled ${result.parsed.length} QPU instruction(s) into ${result.gates.length} runnable gate(s) over ${registerSummary} with ${paramSummary}.`);
      resetRuntime(result.qubitCount, `Compiled ${label}. ${result.log[0] ?? ''}`, nextStartStates, result.processParams);
      setLog((current) => [...current, ...result.log.filter((entry) => !entry.startsWith('RESET') && !entry.startsWith('Cycle workspace prepared')).slice(0, 24)]);
      if (!options?.skipCatalogRegister) {
        registerCatalogProcess({
          name: extractMainProcessName(source) ?? label,
          source,
          origin,
          fileName: options?.fileName ?? qpucirFileNameForSource(source, label),
          description: `Compiled in circuit builder (${result.gates.length} gate(s))`,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompileSummary(`Compile error: ${message}`);
      setLog((current) => [...current, `Compile error: ${message}`]);
      throw error;
    }
  };

  // Compile wraps compileProtocolSource so the UI button does not surface raw errors that are already in the log.
  const compileProtocol = () => {
    try {
      compileProtocolSource(protocolSource);
    } catch {
      // The compile summary and runtime log already contain the specific parse error.
    }
  };

  // Downloads always use the on-disk .qpucir naming helpers so uploads round-trip cleanly.
  const downloadNamedQpucirContents = (name: string, fileName: string, contents: string) => {
    downloadQpucirContents(fileName, contents);
    setFileStatus(`Downloaded ${name} as ${fileName}.`);
  };

  // Bundled examples download their frozen catalog source, not the mutable editor text.
  const downloadConfiguredProtocol = (process: ConfiguredQpucirProcess) => {
    downloadNamedQpucirContents(process.name, process.fileName, process.source);
  };

  // Serializes the live editor buffer, which may differ from the last compiled catalog snapshot.
  const downloadCurrentProtocol = () => {
    const name = extractMainProcessName(protocolSource) ?? 'Current editor protocol';
    downloadNamedQpucirContents(name, qpucirFileNameForSource(protocolSource, name), protocolSource);
  };

  // Validate editor text before exporting so an invalid protocol is not downloaded.
  const downloadCompiledProtocol = () => {
    const name = extractMainProcessName(protocolSource) ?? 'Compiled QPU circuit';
    try {
      compileQpuProtocol(protocolSource, getCatalogLibrarySources());
      downloadNamedQpucirContents(name, qpucirFileNameForSource(protocolSource, name), protocolSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompileSummary(`Download error: ${message}`);
    }
  };

  // Multi-file uploads pair qpucir with optional qpuio; protected bundled tables ignore companion overrides.
  const uploadProtocol = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
      // QPUCIR drives compilation; companion QPUIO is catalog metadata and cannot overwrite protected bundled tables.
      const fileList = Array.from(files);
      fileList.forEach((file) => validateUploadFileName(file.name));
      const qpucirFile = fileList.find((file) => isQpucirFileName(file.name))
        ?? fileList.find((file) => isLooseQpucirUpload(file.name) && !isQpuioFileName(file.name));
      if (!qpucirFile) {
        throw new Error('Upload at least one .qpucir file (or -qpucir.txt when .qpucir is not available).');
      }

      const contents = await qpucirFile.text();
      const parsed = parseQpucirPayload(contents);
      const companion = fileList.find((file) => file.name === companionQpuioFileName(qpucirFile.name))
        ?? fileList.find((file) => isQpuioFileName(file.name));
      let truthTable;
      let truthTableFileName;
      if (companion) {
        const qpuioParsed = parseQpuioPayload(await companion.text(), parsed.source);
        if (qpuioParsed.processName !== parsed.name) {
          throw new Error(`QPUIO process '${qpuioParsed.processName}' does not match .qpucir process '${parsed.name}'.`);
        }
        if (isProtectedQpuioProcess(parsed.name)) {
          warnProtectedTruthTable(parsed.name, `Uploaded ${companion.name} cannot replace protected site metadata.`);
        } else {
          truthTable = qpuioParsed.truthTable;
        }
        truthTableFileName = companion.name;
      }

      registerCatalogProcess({
        name: parsed.name,
        source: parsed.source,
        origin: 'uploaded',
        fileName: qpucirFile.name,
        truthTable,
        truthTableFileName,
        description: `Uploaded from ${qpucirFile.name}${companion ? ` + ${companion.name}` : ''}`,
      });
      setProtocolSource(parsed.source);
      compileProtocolSource(parsed.source, parsed.name, 'uploaded', {
        fileName: qpucirFile.name,
        skipCatalogRegister: true,
      });
      setFileStatus(
        `Uploaded and compiled ${qpucirFile.name}${companion ? ` with truth table from ${companion.name}` : ''}.`,
      );
      setActiveView('builder');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileStatus(`Upload error: ${message}`);
    } finally {
      event.target.value = '';
    }
  };

  // Hash routes work on direct GitHub Pages loads without server-side rewrites.
  const showView = (view: AppView) => {
    setActiveView(view);
    setMenuOpen(false);
    pushViewInLocation(window.location, view);
    scrollRouteTop();
  };

  const embedMode = isEmbedMode();

  useEffect(() => {
    announceGuestReady(window, activeView);
  }, [activeView]);

  useEffect(() => {
    const onHostMessage = (event: MessageEvent<unknown>) => {
      if (!isHostSetViewMessage(event.data)) return;
      const view = event.data.view;
      setActiveView(view);
      setMenuOpen(false);
      replaceViewInLocation(window.location, view);
    };
    window.addEventListener('message', onHostMessage);
    return () => window.removeEventListener('message', onHostMessage);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('site-menu-open', menuOpen);
    return () => document.body.classList.remove('site-menu-open');
  }, [menuOpen]);

  useEffect(() => {
    const onRouteChange = () => {
      setActiveView(readViewLocation(window.location) ?? 'builder');
      setMenuOpen(false);
      scrollRouteTop();
    };
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    };
  }, []);

  const activeCanvasGate = cursor > 0 ? orderedGates[cursor - 1] : undefined;
  const activeCanvasGateId = activeCanvasGate ? activeCanvasGate.customGateId ?? activeCanvasGate.type : undefined;
  // customGateRegistryVersion re-resolves custom gate entries after register/remove.
  const selectionDoc = useMemo(
    () => (selectedGate ? resolveDocEntry(`gate:${selectedGate}`) : undefined),
    [selectedGate, customGateRegistryVersion],
  );
  const circuitDoc = useMemo(
    () => (activeCanvasGateId ? resolveDocEntry(`gate:${activeCanvasGateId}`) : undefined),
    [activeCanvasGateId, customGateRegistryVersion],
  );
  const protocolDoc = useMemo(
    () => (protocolMode === 'process' && processParams.length > 0 && compiledSource
      ? protocolDocEntry(compiledSource)
      : undefined),
    [protocolMode, processParams.length, compiledSource],
  );
  const startValue = (qubit: number) => startStateWireValue(startStates[qubit]);
  const gateSymbol = (gateId: string) => (['X', 'NOT', 'CNOT', 'CCNOT'].includes(gateId) ? '⊕' : getGateDefinition(gateId)?.label ?? gateId);
  const focusSelection = () => setDocFocus('selection');
  const selectGate = (gate: GateType) => {
    setSelectedGate(gate);
    focusSelection();
  };

  const workbenchDocs = (() => {
    if (docFocus === 'circuit' && activeCanvasGate && activeCanvasGateId && circuitDoc) {
      const touched = [...activeCanvasGate.controls, ...activeCanvasGate.targets];
      const before = preStep?.cursor === cursor
        ? wireValuesFromState(preStep.state, preStep.qubitCount, touched)
        : undefined;
      return (
        <WorkbenchDocs
          action={<button onClick={focusSelection} type="button">Back to selected gate</button>}
          controls={activeCanvasGate.controls}
          entry={circuitDoc}
          eyebrow={`Step ${cursor} of ${orderedGates.length} on the canvas`}
          qubitCount={simulationQubitCount}
          reversible={gateHelp[activeCanvasGateId]?.reversible}
          symbol={gateSymbol(activeCanvasGateId)}
          targets={activeCanvasGate.targets}
          valueOf={(qubit) => before?.get(qubit)}
          valuesNote={before
            ? `Values going into step ${cursor}, just before it ran.`
            : 'Run all skips the in-between values. Reset state, then use Step gate to see what goes into each gate.'}
        />
      );
    }
    if (docFocus === 'circuit' && activeCanvasGate) {
      const wires = activeCanvasGate.targets.map((qubit) => `q${qubit}`).join(' and ');
      return (
        <aside aria-label={`About step ${cursor}`} className="workbench-docs">
          <div className="workbench-docs-heading">
            <p className="eyebrow">Step {cursor} of {orderedGates.length} on the canvas</p>
            <button onClick={focusSelection} type="button">Back to selected gate</button>
          </div>
          <p>
            {activeCanvasGate.type === 'RESET'
              ? `This step is the compiler's internal RESET, inserted by SET: it forces ${wires} to |0⟩. It is hidden on the canvas and is not reversible.`
              : `This step runs ${activeCanvasGateId} on ${wires}. There are no workbench notes for it.`}
          </p>
          {activeCanvasGate.type === 'RESET' ? <DocLink target={docTargets.resetSemantics} /> : null}
        </aside>
      );
    }
    if (!selectedGate || !selectionDoc) return null;
    const swaps = selectedGateDefinition?.controlKind === 'swap';
    const swapPartner = secondControlQubit === selectedSimulationQubit
      ? chooseDistinctQubit([selectedSimulationQubit])
      : secondControlQubit;
    return (
      <WorkbenchDocs
        controls={workbenchControlsForGate(selectedGate, selectedSimulationQubit) ?? []}
        entry={selectionDoc}
        eyebrow="Selected gate · where Add gate to target will put it"
        onTryRow={protocolMode === 'canvas' ? updateStartStates : undefined}
        qubitCount={qubitCount}
        reversible={gateHelp[selectedGate]?.reversible}
        symbol={gateSymbol(selectedGate)}
        targets={swaps ? [selectedSimulationQubit, swapPartner] : [selectedSimulationQubit]}
        valueOf={startValue}
        valuesNote={protocolMode === 'canvas'
          ? 'Values from the start states. Change them below, or press Try on a row under Learn more.'
          : 'Values from the start states. Use Try on the compiled protocol card to load one of its input rows.'}
      />
    );
  })();

  return (
    <main className={embedMode ? 'app-shell embed-shell' : 'app-shell'}>
      <button
        aria-expanded={menuOpen}
        aria-label="Open site navigation"
        className="hamburger-button"
        onClick={() => setMenuOpen((open) => !open)}
        type="button"
      >
        <span />
        <span />
        <span />
      </button>

      <nav className={`site-menu ${menuOpen ? 'open' : ''}`} aria-label="Site sections">
        <div className="site-menu-panel">
          <div className="menu-heading">
            <strong>QPU Playground</strong>
            <button onClick={() => setMenuOpen(false)} type="button">×</button>
          </div>
          <div className="site-menu-scroll" tabIndex={0}>
            <button className={activeView === 'builder' ? 'active' : ''} onClick={() => showView('builder')} type="button">Circuit builder</button>
            <details open>
              <summary>Documentation</summary>
              <button className={activeView === 'docs' ? 'active' : ''} onClick={() => showView('docs')} type="button">Wiki / docs</button>
              <button className={activeView === 'qpu-docs' ? 'active' : ''} onClick={() => showView('qpu-docs')} type="button">QPU Documentation</button>
            </details>
            <button className={activeView === 'particles' ? 'active' : ''} onClick={() => showView('particles')} type="button">Particle visualization</button>
            <button className={activeView === 'module-tester' ? 'active' : ''} onClick={() => showView('module-tester')} type="button">Circuit correction lab</button>
            <details open>
              <summary>File upload and download</summary>
              <button className={activeView === 'files' ? 'active' : ''} onClick={() => showView('files')} type="button">Upload files</button>
              <button className={activeView === 'files' ? 'active' : ''} onClick={() => showView('files')} type="button">Download files</button>
            </details>
            <button className={activeView === 'more' ? 'active' : ''} onClick={() => showView('more')} type="button">More</button>
            <button className="danger" onClick={resetSite} type="button">Reset site</button>
          </div>
        </div>
      </nav>

      {menuOpen && <button aria-label="Close menu overlay" className="menu-backdrop" onClick={() => setMenuOpen(false)} type="button" />}

      {activeView === 'builder' && <PlaygroundPage id="builder" label="Circuit builder">
      {!embedMode && (
        <header className="hero">
          <div>
            <p className="eyebrow">Static React QPU MVP</p>
            <h1>Build, compile, run, and watch quantum circuits collapse.</h1>
            <p>A mobile-first browser playground with draggable gates, a QPU protocol compiler, and an in-browser state-vector simulator.</p>
          </div>
          <div className="hero-card">
            <span>{orderedGates.length}</span>
            <small>gates queued</small>
          </div>
        </header>
      )}

          <section className="panel palette-panel" aria-labelledby="palette-title">
            <div className="section-heading">
              <p className="eyebrow">Gate palette</p>
              <h2 id="palette-title">Pick up a block</h2>
            </div>
            <GatePalette inverse={inverseMode} onSelectGate={selectGate} onToggleInverse={() => setInverseMode((on) => !on)} selectedGate={selectedGate} />
          </section>

          <CustomGatePanel
            onRegistryChange={() => setCustomGateRegistryVersion((version) => version + 1)}
            protocolSource={protocolSource}
            registryVersion={customGateRegistryVersion}
          />

          <CircuitCanvas
            activeStep={cursor - 1}
            gates={renderedGates}
            measurements={measurements}
            onDropGate={addGate}
            onRemoveGate={removeGate}
            qubitCount={simulationQubitCount}
            selectedGate={selectedGate}
            startStates={startStates}
            wireGates={orderedGates}
          />

          <section className="panel workbench-panel" aria-labelledby="workbench-title">
            <div className="section-heading">
              <p className="eyebrow">Interactive workbench</p>
              <h2 id="workbench-title">Add particles, gates, and measurements</h2>
            </div>
            <div className="workbench-grid">
              <label title={uiTips.gate}>
                Gate
                <select value={selectedGate ?? ''} onChange={(event) => selectGate(event.target.value as GateType)}>
                  {palette.map((gate) => <option key={gate} value={gate}>{gate}</option>)}
                </select>
              </label>
              <label className="selector-role selector-writes" title={uiTips.targetParticle}>
                <span>Target particle <small>changed</small></span>
                <select value={selectedTarget} onChange={(event) => { setTargetQubit(Number(event.target.value)); focusSelection(); }}>
                  {Array.from({ length: qubitCount }, (_, qubit) => <option key={qubit} value={qubit}>q{qubit}</option>)}
                </select>
              </label>
              <label className={`selector-role ${selectorUse.controlA ? 'selector-reads' : 'selector-unused'}`} title={uiTips.controlA}>
                <span>Control A <small>{selectorUse.controlA ? 'read only' : `not used by ${selectedGate ?? 'this gate'}`}</small></span>
                <select value={controlQubit} onChange={(event) => { setControlQubit(Number(event.target.value)); focusSelection(); }}>
                  {Array.from({ length: qubitCount }, (_, qubit) => <option disabled={qubit === selectedTarget} key={qubit} value={qubit}>q{qubit}</option>)}
                </select>
              </label>
              <label className={`selector-role ${selectorUse.controlB ? 'selector-reads' : 'selector-unused'}`} title={uiTips.controlB}>
                <span>Control B <small>{selectorUse.controlB ? (selectedGateDefinition?.controlKind === 'swap' ? 'swap partner' : 'read only') : `not used by ${selectedGate ?? 'this gate'}`}</small></span>
                <select value={secondControlQubit} onChange={(event) => { setSecondControlQubit(Number(event.target.value)); focusSelection(); }}>
                  {Array.from({ length: qubitCount }, (_, qubit) => <option disabled={qubit === selectedTarget || qubit === controlQubit} key={qubit} value={qubit}>q{qubit}</option>)}
                </select>
              </label>
              {selectedGateDefinition?.supportsPhase ? (
                <label className="phase-control" title={uiTips.phaseAngle}>
                  Phase angle: {phaseDegrees}°
                  <input min="0" max="360" step="15" type="range" value={phaseDegrees} onChange={(event) => setPhaseDegrees(Number(event.target.value))} />
                </label>
              ) : null}
            </div>
            {workbenchDocs}
            {protocolDoc ? (
              <WorkbenchDocs
                controls={(protocolDoc.inputs ?? []).map((name) => processParams.find((param) => param.name === name)?.qubitIndex)}
                entry={protocolDoc}
                eyebrow="Compiled protocol"
                onTryRow={updateStartStates}
                qubitCount={simulationQubitCount}
                targets={(protocolDoc.outputs ?? []).map((name) => returnValues.find((value) => value.name === name)?.qubitIndex)}
                valueOf={startValue}
                valuesNote="Inputs from the start states; outputs are what the process should return for them."
              />
            ) : null}
            <div className="workbench-actions">
              <button onClick={addGateFromWorkbench} title={uiTips.addGate} type="button">Add gate to target</button>
              <button onClick={addCycleBoundary} title={uiTips.increaseCycle} type="button">Add cycle boundary</button>
              <button onClick={addParticle} title={uiTips.addParticle} type="button">Add particle</button>
              <button onClick={removeParticle} title={uiTips.removeParticle} type="button">Remove particle</button>
              <button onClick={measureSelectedQubit} title={uiTips.measureTarget} type="button">Measure target</button>
            </div>
            <div className="start-state-picker" aria-label="Process parameter start states">
              {controllableParams.map((param) => (
                <label key={param.name} title={uiTips.startState}>
                  {param.name} start
                  <select value={startStates[param.qubitIndex] ?? '0p'} onChange={(event) => updateStartState(param.qubitIndex, event.target.value as ParticleStartState)}>
                    <option value="0p">0p</option>
                    <option value="1p">1p</option>
                    <option value="sp">sp</option>
                  </select>
                </label>
              ))}
            </div>
            <p className="canvas-tip">Selected {selectedGate} gate will target q{selectedTarget}; controlled gates use the control selectors above. Only declared process parameters are user-controllable; ancilla and reset registers are initialized by the compiler.</p>
          </section>

          <section className="controls panel" aria-label="Run controls">
            <button aria-pressed={playing} className={playing ? 'playing' : ''} onClick={playSequence} title={uiTips.playSequence} type="button">
              {playing ? 'Pause sequence' : 'Play Sequence'}
            </button>
            <button onClick={run} title={uiTips.runAll} type="button">Run all</button>
            <button disabled={playing || cursor >= orderedGates.length} onClick={step} title={uiTips.stepGate} type="button">Step gate</button>
            <button onClick={resetCircuit} title={uiTips.resetState} type="button">Reset state</button>
            <button onClick={measure} title={uiTips.measureAll} type="button">Measure all</button>
            <button onClick={clearCircuit} title={uiTips.clearCircuit} type="button">Clear circuit</button>
            <button onClick={resetSite} title={uiTips.resetSite} type="button">Reset site</button>
            <details className="help-panel">
              <summary>What do Reset state, Clear circuit, and Reset site do?</summary>
              <table>
                <thead>
                  <tr><th>Button</th><th>Gates</th><th>Wires and start states</th><th>Protocol editor</th></tr>
                </thead>
                <tbody>
                  <tr><th>Reset state</th><td>kept</td><td>kept</td><td>kept</td></tr>
                  <tr><th>Clear circuit</th><td>deleted</td><td>kept</td><td>rewritten from the empty canvas</td></tr>
                  <tr><th>Reset site</th><td>deleted</td><td>back to 3 wires at 0p</td><td>back to the default protocol</td></tr>
                </tbody>
              </table>
              <p>
                All three rewind the quantum state and clear measurements. None of them adds a gate. The compiler&apos;s
                internal RESET is different: it is inserted by <code>SET wire 0p</code>, is hidden from the canvas, and
                is not reversible, unlike every palette gate except M.
              </p>
              <p className="help-links">
                <DocLink target={docTargets.resetButtons} />
                <DocLink target={docTargets.resetSemantics} />
              </p>
            </details>
            <label className="speed-control" title={uiTips.speed}>
              Speed {playSpeed.toFixed(2).replace(/\.00$/, '')}x
              <input
                aria-label="Play sequence speed"
                max={MAX_PLAY_SPEED}
                min={MIN_PLAY_SPEED}
                onChange={(event) => setPlaySpeed(Number(event.target.value))}
                step={0.25}
                type="range"
                value={playSpeed}
              />
            </label>
          </section>

          <section className="examples panel" aria-labelledby="examples-title">
            <div className="section-heading">
              <p className="eyebrow">Examples</p>
              <h2 id="examples-title">Load a starter circuit</h2>
            </div>
            <details className="help-panel learning-path">
              <summary>New here? Follow the six-step learning path</summary>
              <ol>
                <li><strong>Single qubit:</strong> X flips, H makes a superposition, Z changes phase, M measures.</li>
                <li><strong>Controlled gates:</strong> Control A is read, Target particle is changed.</li>
                <li><strong>Reversible logic:</strong> AND and CCNOT compute t&apos; = t <span className="op-xor">⊕</span> (A ∧ B). A and B are kept; t is the output.</li>
                <li><strong>Entanglement:</strong> correlated wires with no separate states, and phase kickback.</li>
                <li><strong>Arithmetic:</strong> sums are parity (XOR), carries are majority (AND). Try the bundled full adders below.</li>
                <li><strong>Multi-stage:</strong> compute, use, and uncompute helper wires; reuse circuits as child processes or custom gates.</li>
              </ol>
              <p>Cards below are numbered by step. For each one, predict the result, then use Step gate and compare.</p>
              <div className="learning-progress" aria-label="Learning path progress">
                {learningSteps.map((label, index) => {
                  const step = index + 1;
                  const done = learningProgress.completedSteps.includes(step);
                  const suggested = suggestNextLearningStep(learningProgress) === step;
                  return (
                    <label className={`learning-progress-step ${done ? 'done' : ''} ${suggested ? 'suggested' : ''}`} key={label}>
                      <input
                        checked={done}
                        onChange={(event) => setLearningProgress(toggleLearningStep(step, event.target.checked))}
                        type="checkbox"
                      />
                      <span>Step {step}{done ? ' ✓' : suggested ? ' →' : ''} · {label}</span>
                    </label>
                  );
                })}
                <p className="learning-progress-note">
                  Mark a checkpoint yourself when you understand it. Progress is saved in this browser and never blocks jumping ahead.
                </p>
              </div>
              <p className="help-links">
                <DocLink target={docTargets.learningPath} />
                <DocLink target={docTargets.advancedCircuits} />
              </p>
            </details>
            <div className="example-grid">
              {examples.map((example, index) => (
                <button className="example-card" key={example.name} onClick={() => loadExample(index)} type="button">
                  <small className="example-step">Step {example.step} · {learningSteps[example.step - 1]}</small>
                  <strong>{example.name}</strong>
                  <span>{example.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel compiler-panel" aria-labelledby="compiler-title">
            <div className="section-heading">
              <p className="eyebrow">QPU protocol compiler</p>
              <h2 id="compiler-title">Compile text into a circuit</h2>
            </div>
            <div className="compiler-actions">
              {protocolExamples.map((example) => (
                <button
                  key={example.name}
                  onClick={() => {
                    setProtocolSource(example.source);
                    try {
                      compileProtocolSource(example.source, example.name, 'compiled', {
                        fileName: example.fileName,
                        skipCatalogRegister: true,
                      });
                    } catch {
                      // Compile summary and runtime log already contain the parse error.
                    }
                  }}
                  title={uiTips.bundledProtocol}
                  type="button"
                >
                  {example.name}
                </button>
              ))}
            </div>
            <textarea
              aria-label="QPU protocol source"
              value={protocolSource}
              onChange={(event) => { setProtocolMode('process'); setProtocolSource(event.target.value); }}
              spellCheck={false}
            />
            <div className="compiler-footer">
              <button onClick={compileProtocol} title={uiTips.compileProtocol} type="button">Compile protocol</button>
              <button onClick={downloadCompiledProtocol} title={uiTips.downloadQpucir} type="button">Download as .qpucir</button>
              <button onClick={() => downloadQpucirTxtSource(protocolSource, extractMainProcessName(protocolSource) ?? 'Compiled QPU circuit')} title={uiTips.downloadQpucirTxt} type="button">Download as -qpucir.txt</button>
              <span>{compileSummary}</span>
            </div>
            <section
              aria-label="Protocol diagnostics"
              aria-live="polite"
              className={`protocol-diagnostics ${protocolDiagnosticReport.errorCount > 0 ? 'has-errors' : protocolDiagnosticReport.warningCount > 0 ? 'has-warnings' : 'is-clear'}`}
            >
              <div className="protocol-diagnostics-heading">
                <strong>Protocol checks</strong>
                <span>
                  {protocolDiagnosticReport.errorCount} error(s), {protocolDiagnosticReport.warningCount} warning(s)
                </span>
              </div>
              {protocolDiagnosticReport.diagnostics.length === 0 ? (
                <p>No syntax or compile issues found.</p>
              ) : (
                <ol>
                  {protocolDiagnosticReport.diagnostics.slice(0, 12).map((diagnostic, index) => (
                    <li className={`diagnostic-${diagnostic.severity}`} key={`${diagnostic.code}-${diagnostic.line ?? 'protocol'}-${index}`}>
                      <strong>{diagnostic.severity === 'error' ? 'Error' : 'Warning'}{diagnostic.line ? ` on line ${diagnostic.line}` : ''}: {diagnostic.message}</strong>
                      {diagnostic.source ? <code>{diagnostic.source}</code> : null}
                      <span>{diagnostic.suggestion}</span>
                    </li>
                  ))}
                </ol>
              )}
              {protocolDiagnosticReport.diagnostics.length > 0 ? (
                <button onClick={() => showView('module-tester')} type="button">
                  Open Correction Lab for guided help
                </button>
              ) : null}
            </section>
            <details>
              <summary>Supported operations and token map</summary>
              <p>{supportedQpuOperations.join(', ')}</p>
              <pre>{JSON.stringify(tokenMap, null, 2)}</pre>
            </details>
          </section>
      </PlaygroundPage>}

      {activeView === 'docs' && <PlaygroundPage id="docs" label="Wiki / docs">
        <section className="panel docs-panel" aria-labelledby="docs-title">
          <div className="section-heading">
            <p className="eyebrow">Wiki / docs</p>
            <h2 id="docs-title">Circuit construction and compile semantics</h2>
          </div>
          <div className="docs-grid">
            <article>
              <h3>Start here: six steps</h3>
              <ol>
                <li><strong>Single qubit</strong>: X, H, Z, and measurement.</li>
                <li><strong>Controlled gates</strong>: CNOT, CZ, CY, SWAP.</li>
                <li><strong>Reversible logic</strong>: CCNOT and AND/OR/XOR/NAND; the half adder.</li>
                <li><strong>Entanglement</strong>: Bell states and phase kickback.</li>
                <li><strong>Arithmetic</strong>: full adders, comparators, parity.</li>
                <li><strong>Multi-stage</strong>: child processes, uncomputation, oracles, custom gates.</li>
              </ol>
              <p>Every starter circuit in the builder is labelled with its step. Load one, predict the result, then use Step gate and compare.</p>
              <p className="help-links"><DocLink target={docTargets.learningPath} /></p>
            </article>
            <article>
              <h3>Reading a controlled gate</h3>
              <p>
                <code>t&apos; = t <span className="op-xor">⊕</span> (A ∧ B)</code> has three roles. <strong>A</strong> and <strong>B</strong> are controls:
                they are only read and come out unchanged. <strong>t</strong> is the target, the output workspace, and is the
                only wire that changes: it flips when A ∧ B is 1. Start t at 0 and it ends holding A AND B.
              </p>
              <SelectorMapDiagram controls={[0, 1]} qubitCount={3} symbol="⊕" target={2} />
              <p>
                In the workbench, <strong>Control A</strong> and <strong>Control B</strong> become the dots and
                <strong> Target particle</strong> becomes <span className="op-xor">⊕</span>. CCNOT and AND both follow this picture; NAND, OR, and XOR
                change only the rule applied to the target. The gate card under the selectors redraws it for your current
                choices, and unused selectors are dimmed.
              </p>
            </article>
            <article>
              <h3>Reset state, Clear circuit, or Reset site?</h3>
              <ul>
                <li><strong>Reset state</strong>: run the same experiment again. Keeps every gate and start state; rewinds the quantum state.</li>
                <li><strong>Clear circuit</strong>: delete all gates, keep the wires and start states. The protocol editor is rewritten from the empty canvas.</li>
                <li><strong>Reset site</strong> (also <strong>Reset site completely</strong> on More): back to the first-visit builder. Custom gates and the catalog are kept.</li>
              </ul>
              <p>
                None of these is the compiler&apos;s internal <code>RESET</code>. That operation is inserted by <code>SET wire 0p</code>,
                hidden from the canvas, and forces a wire to |0⟩. Because it erases what the wire held, it is not reversible.
                Every palette gate except M is reversible.
              </p>
              <p className="help-links">
                <DocLink target={docTargets.resetButtons} />
                <DocLink target={docTargets.resetSemantics} />
              </p>
            </article>
            <article>
              <h3>Custom gates</h3>
              <p>
                A custom gate is a saved process that runs its own gates on the wires you pick. Its first PARAMS input maps to
                Control A, the second to Control B, and its first RETURNVALS output to Target particle.
              </p>
              <p>
                It is reversible when every gate inside is reversible, it contains no MEASURE, it does not <code>SET</code> its
                output (which would overwrite the target), and every helper wire is uncomputed back to 0. Quick check: place it
                twice in a row; every wire should end where it started.
              </p>
              <p className="help-links"><DocLink target={docTargets.customGates} /></p>
            </article>
            <article>
              <h3>Main and child processes</h3>
              <p>
                A process is a named list of gates with inputs (<code>PARAMS</code>) and outputs (<code>RETURNVALS</code>). The
                <strong> main process</strong> is the one you compile and run. A <strong>child process</strong> is another saved
                process it borrows with <code>RUNCHILD</code>, like calling a helper function.
              </p>
              <p>
                Nothing is called at run time: the compiler copies the child&apos;s gates into the main circuit, feeding
                <code> -I</code> wires to the child&apos;s inputs and <code>-O</code> wires to its outputs, in order. TwoBitFullAdder
                is a main process that runs SingleBitFullAdder twice as a child. Compile it, then open <strong>Learn more</strong> on
                the Compiled protocol card in the Interactive workbench to read its table and expand the child.
              </p>
              <p className="help-links"><DocLink target={docTargets.processes} /></p>
            </article>
            <article>
              <h3>How circuits are built</h3>
              <p>Use the circuit builder to drag a gate onto a qubit wire, or select a gate, target, and controls from the workbench. Play Sequence advances one gate at a time at the speed meter, including Measure (M) gates. Run all skips to the finished state.</p>
              <ul>
                <li><strong>Targets</strong> are the qubit registers modified by a gate.</li>
                <li><strong>Controls</strong> must be distinct from the target and determine when controlled gates fire.</li>
                <li><strong>Measurements</strong> collapse qubits into classical 0/1 outcomes and are recorded in the runtime log.</li>
              </ul>
              <p className="help-links"><DocLink target={docTargets.uiReference} /></p>
            </article>
            <article>
              <h3>QPU protocol requirements</h3>
              <p>A protocol can begin with <code>PARAMS:</code>, should name its entry point with <code>MAIN-PROCESS</code>, and compiles commands with explicit <code>-I</code> inputs and <code>-O</code> outputs where required.</p>
              <ul>
                <li>Primitive gates include X, Y, Z, H, S, T, RX, RY, RZ, CNOT, CCNOT, CZ, CY, CPHASE, SWAP, and PHASE.</li>
                <li>Derived Boolean gates include NOT, AND, NAND, OR, and XOR.</li>
                <li>Child protocols can be declared, run, and accepted through DECLARECHILD, RUNCHILD, and ACCEPTVALS.</li>
                <li>Constants <code>0p</code>, <code>1p</code>, and <code>sp</code> initialize zero, one, and superposition registers.</li>
              </ul>
            </article>
            <article>
              <h3>Quantum theory references</h3>
              <p>Gate buttons expose the visual vocabulary, while the compiler maps QPU instructions to state-vector transformations. For deeper theory, start with matrix definitions for Pauli-X, Hadamard, controlled-NOT, Toffoli, phase rotations, and measurement postulates.</p>
              <div className="reference-links">
                <a href="https://en.wikipedia.org/wiki/Quantum_logic_gate" rel="noreferrer" target="_blank">Quantum logic gates</a>
                <a href="https://en.wikipedia.org/wiki/Hadamard_transform" rel="noreferrer" target="_blank">Hadamard transform</a>
                <a href="https://en.wikipedia.org/wiki/Controlled_NOT_gate" rel="noreferrer" target="_blank">Controlled-NOT gate</a>
                <a href="https://www.youtube.com/results?search_query=quantum+logic+gates+explained" rel="noreferrer" target="_blank">YouTube gate explainers</a>
              </div>
            </article>
          </div>
        </section>
      </PlaygroundPage>}

      {activeView === 'qpu-docs' && <PlaygroundPage id="qpu-docs" label="QPU Documentation">
        <section className="panel docs-panel qpu-doc-panel" aria-labelledby="qpu-docs-title">
          <div className="section-heading">
            <p className="eyebrow">Documentation › QPU Documentation</p>
            <h2 id="qpu-docs-title">QPU documentation library</h2>
          </div>
          <p className="canvas-tip">Choose a focused guide. Start with Getting Started if programming or the website is new to you.</p>
          <div className="qpu-document-grid">
            {QPU_DOCUMENTS.map((document) => (
              <button
                className={selectedQpuDocument.fileName === document.fileName ? 'active' : ''}
                key={document.fileName}
                onClick={() => setSelectedQpuDocument(document)}
                type="button"
              >
                <strong>{document.title}</strong>
                <span>{document.description}</span>
              </button>
            ))}
          </div>
          <div className="pdf-frame">
            <object
              aria-label={`${selectedQpuDocument.title} PDF`}
              data={`${import.meta.env.BASE_URL}${selectedQpuDocument.fileName}`}
              key={selectedQpuDocument.fileName}
              type="application/pdf"
            >
              <embed
                src={`${import.meta.env.BASE_URL}${selectedQpuDocument.fileName}`}
                type="application/pdf"
                title={`${selectedQpuDocument.title} PDF`}
              />
            </object>
          </div>
          <a
            className="primary-link"
            href={`${import.meta.env.BASE_URL}${selectedQpuDocument.fileName}`}
            target="_blank"
            rel="noreferrer"
          >
            Open {selectedQpuDocument.title} in a new tab
          </a>
        </section>
      </PlaygroundPage>}

      {activeView === 'particles' && <PlaygroundPage id="particles" label="Particle visualization">
        <div className="results-grid standalone-results">
          <ParticleView
            activeStep={cursor - 1}
            gates={renderedGates}
            measurements={displayMeasurements}
            particleSnapshots={particleSnapshots}
            physicalQubitIndices={displayQubitIndices}
            qubitCount={displayQubitCount}
            qubitLabels={displayQubitLabels}
            startStates={controllableParams.map((param) => startStates[param.qubitIndex] ?? '0p')}
            transitions={particleTransitions}
          />
          <OutputPanel
            log={log}
            measurements={displayMeasurements}
            qubitCount={displayQubitCount}
            qubitLabels={displayQubitLabels}
            state={displayState}
          />
        </div>
      </PlaygroundPage>}

      <PlaygroundPage active={activeView === 'module-tester'} id="module-tester" label="Circuit correction lab">
        <ModuleLab />
      </PlaygroundPage>

      {activeView === 'files' && <PlaygroundPage id="files" label="File upload and download">
        <section className="panel files-panel" aria-labelledby="files-title">
          <div className="section-heading">
            <p className="eyebrow">File upload and download</p>
            <h2 id="files-title">Move compiled QPU circuits as protocol files</h2>
          </div>
          <div className="file-grid">
            <label className="upload-card">
              <strong>Upload files</strong>
              <span>Select a .qpucir protocol file (optionally with a matching .qpuio truth table). Use -qpucir.txt / -qpuio.txt only when your device file picker cannot open custom extensions.</span>
              <input accept={QPU_FILE_UPLOAD_ACCEPT} multiple onChange={uploadProtocol} type="file" />
            </label>
            <div className="download-card">
              <strong>Download files</strong>
              <span>Downloads use .qpucir by default; -qpucir.txt is available where plain .txt is easier to share from mobile file pickers.</span>
              <div className="download-list">
                {protocolExamples.map((example) => (
                  <button key={example.name} onClick={() => downloadConfiguredProtocol(example)} type="button">
                    Download {example.name}
                  </button>
                ))}
                <button onClick={downloadCurrentProtocol} type="button">Download current editor protocol</button>
              </div>
            </div>
          </div>
          <p className="file-status">{fileStatus}</p>
        </section>
      </PlaygroundPage>}

      {activeView === 'more' && <PlaygroundPage id="more" label="More">
        <section className="panel docs-panel" aria-labelledby="more-title">
          <div className="section-heading">
            <p className="eyebrow">More</p>
            <h2 id="more-title">Quick actions</h2>
          </div>
          <div className="quick-actions">
            <button onClick={() => showView('builder')} type="button">Open circuit builder</button>
            <button onClick={() => showView('files')} type="button">Open file tools</button>
            <button onClick={resetSite} type="button">Reset site completely</button>
          </div>
        </section>
      </PlaygroundPage>}
    </main>
  );
}

export default App;
