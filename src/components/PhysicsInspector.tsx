import { useMemo, useState } from 'react';
import type { Complex } from '../simulator/complex';
import { executeCircuit, type PhysicalRunOptions } from '../simulator/engine';
import { FrequencyPanel } from './FrequencyPanel';
import { PhysicalTrace, type TraceStep } from './PhysicalTrace';
import { buildProfile, hasOverride, type ProfileField, type ProfileOverrides, QubitProfileTable } from './QubitProfileTable';
import { physics } from '../simulator/physics/PhysicsEngine';
import type {
  EntanglementAssessment,
  NoiseChannel,
  NoiseModel,
  PhysicalFrame,
  QuantumState,
  QubitPhysicsProfile,
} from '../simulator/physics';
import type { CircuitGate, MeasurementMap, ParticleStartState } from '../simulator/types';

// Physics diagnostics for the current register plus an opt-in noisy run.
// Every number here comes from the Physics Engine; this component only lays it out.

type ChannelKind = 'none' | 'bitFlip' | 'phaseFlip' | 'depolarizing' | 'amplitudeDamping' | 'phaseDamping';

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  none: 'No gate noise',
  bitFlip: 'Bit flip',
  phaseFlip: 'Phase flip',
  depolarizing: 'Depolarizing',
  amplitudeDamping: 'Amplitude damping',
  phaseDamping: 'Phase damping',
};

// Mixed-state tests diagonalize 2^n × 2^n matrices, so the inspector stops offering them past this width.
const NEGATIVITY_MAX_QUBITS = 6;

type PhysicsInspectorProps = {
  state: Complex[];
  qubitCount: number;
  /** Simulator wire behind each displayed wire. */
  physicalQubitIndices: number[];
  qubitLabels: string[];
  gates: CircuitGate[];
  simulationQubitCount: number;
  startStates: ParticleStartState[];
  paramQubitIndices?: number[];
  librarySources: () => Record<string, string>;
};

type NoisyRun = {
  noisy: QuantumState;
  ideal: QuantumState;
  measurements: MeasurementMap;
  idealMeasurements: MeasurementMap;
  physicalTime?: number;
  leakage?: Record<number, number>;
  trace: TraceStep[];
  id: number;
};

// Deterministic draws so the ideal and noisy runs sample MEASURE with the same random numbers.
const seededRandom = (seed: number) => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const format = (value: number | undefined, digits = 3) =>
  (value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));

const assessmentText = (assessment: EntanglementAssessment) => {
  const method = assessment.method === 'pure-state-reduction' ? 'pure-state reduction' : 'PPT / negativity';
  if (assessment.status === 'entangled') return `Entangled with the rest (proven by ${method})`;
  if (assessment.status === 'separable') return `Not entangled with the rest (proven by ${method})`;
  // A failed witness is not evidence of separability, so never phrase this as "not entangled".
  return `Undetermined: ${assessment.reason ?? 'the test could not decide'}`;
};

const buildNoiseModel = (kind: ChannelKind, strength: number, t1: string, t2: string, duration: string): NoiseModel => {
  const channels: Record<Exclude<ChannelKind, 'none'>, (value: number) => NoiseChannel> = {
    bitFlip: physics.channels.bitFlip,
    phaseFlip: physics.channels.phaseFlip,
    depolarizing: physics.channels.depolarizing,
    amplitudeDamping: physics.channels.amplitudeDamping,
    phaseDamping: physics.channels.phaseDamping,
  };
  const t1Value = t1.trim() ? Number(t1) : undefined;
  const t2Value = t2.trim() ? Number(t2) : undefined;
  return {
    ...(kind !== 'none' ? { gate: [channels[kind](strength)] } : {}),
    ...(t1Value !== undefined || t2Value !== undefined
      ? { decoherence: { t1: t1Value, t2: t2Value }, timing: { defaultGateDuration: Number(duration) || 1 } }
      : {}),
  };
};

function SubsystemReport({ state, subsystem }: { state: QuantumState; subsystem: number[] }) {
  const report = useMemo(() => {
    if (subsystem.length === 0) return undefined;
    const inspection = physics.inspectSubsystem(state, subsystem);
    const negativity = state.qubitCount <= NEGATIVITY_MAX_QUBITS && subsystem.length < state.qubitCount
      ? physics.negativity(state, subsystem)
      : undefined;
    return { inspection, negativity };
  }, [state, subsystem]);

  if (!report) return <p className="physics-note">Select one or more wires to inspect them together.</p>;
  const { inspection, negativity } = report;
  return (
    <dl className="physics-metrics">
      <dt>Purity Tr(ρ²)</dt>
      <dd>{format(inspection.purity)}</dd>
      <dt>Linear entropy</dt>
      <dd>{format(inspection.linearEntropy)}</dd>
      <dt>Von Neumann entropy</dt>
      <dd>{format(inspection.vonNeumannEntropy)} bits</dd>
      <dt>Negativity</dt>
      <dd>{negativity === undefined ? `— (up to ${NEGATIVITY_MAX_QUBITS} qubits)` : format(negativity)}</dd>
      <dt>Entanglement</dt>
      <dd className={`physics-entanglement ${inspection.entanglement.status}`}>{assessmentText(inspection.entanglement)}</dd>
    </dl>
  );
}

export function PhysicsInspector({
  state,
  qubitCount,
  physicalQubitIndices,
  qubitLabels,
  gates,
  simulationQubitCount,
  startStates,
  paramQubitIndices,
  librarySources,
}: PhysicsInspectorProps) {
  const [selected, setSelected] = useState<number[]>([0]);
  const [channel, setChannel] = useState<ChannelKind>('depolarizing');
  const [strength, setStrength] = useState(0.02);
  const [t1, setT1] = useState('');
  const [t2, setT2] = useState('');
  const [duration, setDuration] = useState('1');
  // Qubit profile shared by the physical run and the frequency panel (GHz / MHz / mK in the form, GHz / K internally).
  const [f01, setF01] = useState(5);
  const [offsetMHz, setOffsetMHz] = useState(0);
  const [temperatureMK, setTemperatureMK] = useState('');
  // Blank keeps the ideal two-level qubit; a value adds the |2⟩ level so pulses can leak.
  const [anharmonicityMHz, setAnharmonicityMHz] = useState('');
  // Per-qubit overrides of the shared profile, keyed by simulator wire.
  const [overrides, setOverrides] = useState<ProfileOverrides>({});
  const [frequencyWire, setFrequencyWire] = useState<number | 'shared'>('shared');
  const [physicalMode, setPhysicalMode] = useState(false);
  const [frame, setFrame] = useState<PhysicalFrame>('rotating');
  const [gateMode, setGateMode] = useState<'matrix' | 'drive'>('matrix');
  const [noisyRun, setNoisyRun] = useState<NoisyRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(() => physics.fromAmplitudes(state, physics.resolveQubitCount(state, 0)), [state]);
  const subsystem = useMemo(
    () => selected
      .filter((display) => display < qubitCount)
      .map((display) => physicalQubitIndices[display] ?? display)
      .filter((qubit) => qubit < current.qubitCount),
    [selected, qubitCount, physicalQubitIndices, current.qubitCount],
  );

  const wires = useMemo(
    () => Array.from({ length: qubitCount }, (_, display) => ({
      wire: physicalQubitIndices[display] ?? display,
      label: qubitLabels[display] ?? `q${display}`,
    })),
    [qubitCount, physicalQubitIndices, qubitLabels],
  );
  const wireLabel = (wire: number) => wires.find((entry) => entry.wire === wire)?.label ?? `w${wire}`;

  // T1/T2 belong to the qubit profile only on the physical clock; otherwise they feed the noise model.
  const shared = useMemo(() => ({
    f01: String(f01),
    offsetMHz: String(offsetMHz),
    t1: physicalMode ? t1 : '',
    t2: physicalMode ? t2 : '',
    temperatureMK,
    anharmonicityMHz,
  }), [f01, offsetMHz, t1, t2, temperatureMK, anharmonicityMHz, physicalMode]);
  const profile = useMemo<QubitPhysicsProfile>(() => buildProfile(shared), [shared]);
  const profiles = useMemo(() => Object.fromEntries(Object.entries(overrides)
    .filter(([, override]) => hasOverride(override))
    .map(([wire, override]) => [Number(wire), buildProfile(shared, override)])), [shared, overrides]);
  const frequencyProfile = frequencyWire === 'shared' ? profile : profiles[frequencyWire] ?? profile;
  const setOverride = (wire: number, field: ProfileField, value: string) =>
    setOverrides((current) => ({ ...current, [wire]: { ...current[wire], [field]: value } }));

  const toggle = (display: number) => setSelected((wires) => (
    wires.includes(display) ? wires.filter((wire) => wire !== display) : [...wires, display].sort((a, b) => a - b)
  ));

  const runWithNoise = () => {
    setError(null);
    try {
      // Physical mode takes T1/T2 from the qubit profile on the physical clock instead of the noise model.
      const noise = buildNoiseModel(channel, strength, physicalMode ? '' : t1, physicalMode ? '' : t2, duration);
      const physical: PhysicalRunOptions | undefined = physicalMode
        ? {
          system: { defaultProfile: profile, profiles, frame, approximation: 'rwa' },
          timing: { defaultGateDuration: Number(duration) || 1 },
          gates: gateMode,
        }
        : undefined;
      const seed = Date.now();
      const common = { librarySources: librarySources() };
      const params = paramQubitIndices?.length ? paramQubitIndices : undefined;
      // The ideal run keeps its (pure) register after every gate so each noisy step can be compared with it.
      const idealSteps: QuantumState[] = [];
      const ideal = executeCircuit(simulationQubitCount, gates, startStates, params, {
        ...common,
        random: seededRandom(seed),
        onStep: (step) => {
          idealSteps[step.index] = step.state;
        },
      });
      const trace: TraceStep[] = [];
      const noisy = executeCircuit(simulationQubitCount, gates, startStates, params, {
        ...common,
        noise,
        random: seededRandom(seed),
        ...(physical ? { physical } : {}),
        onStep: (step) => {
          const reference = idealSteps[step.index];
          const stepWidth = Math.max(step.state.qubitCount, reference.qubitCount);
          const frequencies = physical && step.physicalTime !== undefined
            ? physics.frequency.transitionFrequencies(physical.system, step.state.qubitCount, step.physicalTime)
            : undefined;
          const targets = [...step.gate.controls, ...step.gate.targets].map(wireLabel).join(' ');
          trace.push({
            label: `${String(step.gate.type)}${targets ? ` ${targets}` : ''}`,
            ...(step.physicalTime === undefined ? {} : { physicalTime: step.physicalTime }),
            fidelity: physics.fidelity(physics.expandRegister(step.state, stepWidth), physics.expandRegister(reference, stepWidth)),
            qubits: wires.filter(({ wire }) => wire < step.state.qubitCount).map(({ wire, label }) => ({
              wire,
              label,
              ...(frequencies ? { frequency: frequencies[wire] } : {}),
              pOne: physics.probabilityOfOne(step.state, wire),
              purity: physics.purity(physics.reducedState(step.state, [wire])),
              ...(step.leakage?.[wire] !== undefined ? { leakage: step.leakage[wire] } : {}),
            })),
          });
        },
      });
      const width = Math.max(noisy.state.qubitCount, ideal.state.qubitCount);
      setNoisyRun({
        noisy: physics.expandRegister(noisy.state, width),
        ideal: physics.expandRegister(ideal.state, width),
        measurements: noisy.measurements,
        idealMeasurements: ideal.measurements,
        physicalTime: noisy.physicalTime,
        leakage: noisy.leakage,
        trace,
        id: seed,
      });
    } catch (caught) {
      setNoisyRun(null);
      setError((caught as Error).message);
    }
  };

  const noisyGlobal = noisyRun ? physics.inspectGlobal(noisyRun.noisy) : undefined;
  const fidelity = noisyRun ? physics.fidelity(noisyRun.noisy, noisyRun.ideal) : undefined;
  const sameOutcomes = noisyRun
    ? JSON.stringify(noisyRun.measurements) === JSON.stringify(noisyRun.idealMeasurements)
    : true;
  const noisySubsystem = noisyRun ? subsystem.filter((qubit) => qubit < noisyRun.noisy.qubitCount) : [];

  return (
    <section className="panel physics-inspector" aria-labelledby="physics-inspector-title">
      <div className="section-heading">
        <p className="eyebrow">Physics inspector</p>
        <h2 id="physics-inspector-title">Subsystems, entanglement, and noise</h2>
      </div>

      <fieldset className="physics-wires">
        <legend>Subsystem</legend>
        {Array.from({ length: qubitCount }, (_, display) => (
          <label key={display}>
            <input checked={selected.includes(display)} onChange={() => toggle(display)} type="checkbox" />
            {qubitLabels[display] ?? `q${display}`}
          </label>
        ))}
      </fieldset>

      <h3>Current state</h3>
      <SubsystemReport state={current} subsystem={subsystem} />

      <h3>Run with noise</h3>
      <p className="physics-note">
        Runs the circuit again as an open system and compares it with the ideal run. Noise acts after each gate;
        logical cycles are not physical time. With physical timing, every gate lasts its duration on a physical
        clock while each qubit precesses at its own frequency, and T1/T2 act over that time. Density matrices need
        4<sup>n</sup> entries, so noisy runs are limited to 10 qubits.
      </p>
      <div className="physics-noise-form">
        <label>
          Gate noise
          <select onChange={(event) => setChannel(event.target.value as ChannelKind)} value={channel}>
            {(Object.keys(CHANNEL_LABELS) as ChannelKind[]).map((kind) => (
              <option key={kind} value={kind}>{CHANNEL_LABELS[kind]}</option>
            ))}
          </select>
        </label>
        <label>
          Strength p / γ / λ
          <input
            disabled={channel === 'none'}
            max={1}
            min={0}
            onChange={(event) => setStrength(Number(event.target.value))}
            step={0.01}
            type="number"
            value={strength}
          />
        </label>
        <label>
          T1{physicalMode ? ' (ns)' : ''}
          <input onChange={(event) => setT1(event.target.value)} placeholder="off" type="number" min={0} value={t1} />
        </label>
        <label>
          T2{physicalMode ? ' (ns)' : ''}
          <input onChange={(event) => setT2(event.target.value)} placeholder="off" type="number" min={0} value={t2} />
        </label>
        <label>
          Gate duration{physicalMode ? ' (ns)' : ''}
          <input onChange={(event) => setDuration(event.target.value)} type="number" min={0} value={duration} />
        </label>
      </div>
      <div className="physics-noise-form">
        <label className="physics-toggle">
          <input checked={physicalMode} onChange={(event) => setPhysicalMode(event.target.checked)} type="checkbox" />
          Physical timing (qubit frequency model)
        </label>
        <label>
          f₀₁ (GHz)
          <input min={0.001} onChange={(event) => setF01(Number(event.target.value))} step={0.1} type="number" value={f01} />
        </label>
        <label>
          Offset (MHz)
          <input onChange={(event) => setOffsetMHz(Number(event.target.value))} step={0.1} type="number" value={offsetMHz} />
        </label>
        <label>
          Temperature (mK)
          <input min={0} onChange={(event) => setTemperatureMK(event.target.value)} placeholder="0" type="number" value={temperatureMK} />
        </label>
        <label>
          Anharmonicity α/2π (MHz)
          <input onChange={(event) => setAnharmonicityMHz(event.target.value)} placeholder="two-level" step={10} type="number" value={anharmonicityMHz} />
        </label>
        <label>
          Frame
          <select disabled={!physicalMode} onChange={(event) => setFrame(event.target.value as PhysicalFrame)} value={frame}>
            <option value="rotating">Rotating at f₀₁</option>
            <option value="lab">Lab</option>
          </select>
        </label>
        <label>
          Single-qubit gates
          <select disabled={!physicalMode} onChange={(event) => setGateMode(event.target.value as 'matrix' | 'drive')} value={gateMode}>
            <option value="matrix">Ideal matrices</option>
            <option value="drive">Microwave pulses</option>
          </select>
        </label>
        <button disabled={gates.length === 0} onClick={runWithNoise} type="button">Run with noise</button>
      </div>
      {physicalMode && (
        <details className="physics-profiles">
          <summary>Per-qubit profiles{Object.keys(profiles).length > 0 ? ` (${Object.keys(profiles).length} customized)` : ''}</summary>
          <p className="physics-note">
            Real qubits differ: each has its own frequency, coherence times, and anharmonicity. A blank cell uses the
            shared value above (shown greyed).
          </p>
          <QubitProfileTable onChange={setOverride} overrides={overrides} shared={shared} wires={wires} />
        </details>
      )}

      {error && <p className="physics-error" role="alert">{error}</p>}

      {noisyRun && noisyGlobal && (
        <div className="physics-noisy-result">
          <dl className="physics-metrics">
            <dt>Representation</dt>
            <dd>{noisyGlobal.representation === 'densityMatrix' ? 'Density matrix (mixed)' : 'State vector (pure)'}</dd>
            <dt>Register purity</dt>
            <dd>{format(noisyGlobal.purity)}</dd>
            <dt>Fidelity with ideal run</dt>
            <dd>{format(fidelity, 4)}{sameOutcomes ? '' : ' (measurement outcomes differ between the runs)'}</dd>
            {noisyRun.physicalTime !== undefined && (
              <>
                <dt>Elapsed physical time</dt>
                <dd>{format(noisyRun.physicalTime, 1)} ns</dd>
              </>
            )}
            {noisyRun.leakage && (
              <>
                <dt>Leakage to |2⟩ (returned as |1⟩)</dt>
                <dd>{Object.entries(noisyRun.leakage).map(([wire, population]) => `q${wire}: ${population.toExponential(2)}`).join(', ')}</dd>
              </>
            )}
          </dl>
          <h3>Noisy subsystem</h3>
          <SubsystemReport state={noisyRun.noisy} subsystem={noisySubsystem} />
          <h3>Step through the run</h3>
          <p className="physics-note">
            The noisy run after each gate, compared with the ideal run after the same gate. The strip plots fidelity
            with the ideal run across the circuit.
          </p>
          <PhysicalTrace key={noisyRun.id} steps={noisyRun.trace} />
        </div>
      )}

      <h3>Frequency and resonance</h3>
      <p className="physics-note">
        The qubit above as a physical two-level system: its transition frequency fixes the energy gap (E = hf), and a
        microwave drive rotates it fastest on resonance. Frequencies are in GHz and times in ns.
      </p>
      {physicalMode && Object.keys(profiles).length > 0 && (
        <div className="physics-noise-form">
          <label>
            Qubit
            <select
              onChange={(event) => setFrequencyWire(event.target.value === 'shared' ? 'shared' : Number(event.target.value))}
              value={String(frequencyWire)}
            >
              <option value="shared">Shared profile</option>
              {wires.map(({ wire, label }) => <option key={wire} value={wire}>{label}</option>)}
            </select>
          </label>
        </div>
      )}
      <FrequencyPanel profile={physicalMode ? frequencyProfile : profile} />
    </section>
  );
}
