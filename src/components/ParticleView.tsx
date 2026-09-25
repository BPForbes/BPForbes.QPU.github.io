import { getGateDefinition } from '../simulator/gates/registry';
import { resolvedArity } from '../simulator/gates/arity';
import type { OperationTransition, ParticleSnapshot } from '../simulator/physics';
import { CircuitGate, MeasurementMap, ParticleStartState } from '../simulator/types';
type ParticleViewProps = {
  qubitCount: number;
  measurements: MeasurementMap;
  gates?: CircuitGate[];
  activeStep?: number;
  startStates?: ParticleStartState[];
  qubitLabels?: string[];
  physicalQubitIndices?: number[];
  particleSnapshots?: ParticleSnapshot[];
  transitions?: OperationTransition[];
};

// Use a golden-angle hue step so adjacent physical qubits remain visually distinct as circuits grow.
const seededColor = (index: number): [number, number, number] => {
  const hue = ((index * 137.508) % 360) / 60;
  const chroma = 0.76;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const m = 0.22;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

const srgbToLinear = (value: number) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round((clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255);
};

// Color mixing happens in Oklab to keep entangled/multi-qubit particles perceptually balanced instead of muddy.
const rgbToOklab = ([r, g, b]: [number, number, number]) => {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};

const oklabToCss = ([L, a, b]: number[]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rLin = 4.0767416621 * l - 3.3077115903 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `rgb(${linearToSrgb(rLin)} ${linearToSrgb(gLin)} ${linearToSrgb(bLin)})`;
};

const mixedColor = (qubits: number[]) => {
  const labs = qubits.map((qubit) => rgbToOklab(seededColor(qubit)));
  const average = labs[0].map((_, channel) => labs.reduce((sum, lab) => sum + lab[channel], 0) / labs.length);
  return oklabToCss(average);
};

const deg = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`;

const gateIoLabel = (gate: CircuitGate) => {
  const definition = getGateDefinition(String(gate.type));
  if (!definition) return '';
  const { minInputs, maxInputs, minOutputs, maxOutputs } = resolvedArity(definition.ioArity);
  const inLabel = minInputs === maxInputs ? `${minInputs}` : `${minInputs}-${maxInputs}`;
  const outLabel = minOutputs === maxOutputs ? `${minOutputs}` : `${minOutputs}-${maxOutputs}`;
  return `${inLabel}→${outLabel} I/O`;
};

export function ParticleView({
  qubitCount,
  measurements,
  gates = [],
  activeStep = -1,
  startStates = [],
  qubitLabels = [],
  physicalQubitIndices,
  particleSnapshots = [],
  transitions = [],
}: ParticleViewProps) {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const activeTransition = activeStep >= 0 ? transitions.find((entry) => entry.step === activeStep) : undefined;
  const snapshotByQubit = new Map(particleSnapshots.map((entry) => [entry.qubit, entry]));
  const deltaByQubit = new Map((activeTransition?.deltas ?? []).map((entry) => [entry.qubit, entry]));

  return (
    <section className="panel particles" aria-labelledby="particles-title">
      <div className="section-heading">
        <p className="eyebrow">Particle renderer</p>
        <h2 id="particles-title">Qubit states and execution progress</h2>
      </div>
      <div className="particle-grid">
        {Array.from({ length: qubitCount }, (_, displayIndex) => {
          const physicalQubit = physicalQubitIndices?.[displayIndex] ?? displayIndex;
          const measured = measurements[physicalQubit];
          const baseColor = oklabToCss(rgbToOklab(seededColor(physicalQubit)));
          const snapshot = snapshotByQubit.get(physicalQubit);
          const delta = deltaByQubit.get(physicalQubit);
          return (
            <div className={`particle-card ${measured !== undefined ? 'collapsed' : ''}`} key={physicalQubit} style={{ ['--particle-color' as string]: baseColor }}>
              <div className="qubit-label">{qubitLabels[displayIndex] ?? `q${physicalQubit}`} · {startStates[displayIndex] ?? '0p'}</div>
              {measured === undefined ? (
                <div className="sphere" aria-label={`q${physicalQubit} unmeasured quantum sphere`} />
              ) : (
                <div className="state-card" aria-label={`q${physicalQubit} measured ${measured}`}>
                  {measured}
                </div>
              )}
              {snapshot && (
                <>
                  <div className="particle-ket" aria-label={`q${physicalQubit} state ket`}>
                    <code>{snapshot.ket.formatted}</code>
                  </div>
                  <div className="particle-coords" aria-label={`q${physicalQubit} spherical coordinates`}>
                    <span>r {snapshot.spherical.r.toFixed(3)}</span>
                    <span>θ {deg(snapshot.spherical.theta)}</span>
                    <span>φ {deg(snapshot.spherical.phi)}</span>
                  </div>
                  <div className="particle-bloch" aria-label={`q${physicalQubit} Bloch coordinates`}>
                    <span>x {snapshot.bloch.x.toFixed(3)}</span>
                    <span>y {snapshot.bloch.y.toFixed(3)}</span>
                    <span>z {snapshot.bloch.z.toFixed(3)}</span>
                  </div>
                  <div className="particle-mixed" aria-label={`q${physicalQubit} mixed-state metrics`}>
                    <span>purity {snapshot.mixed.purity.toFixed(3)}</span>
                    <span>mixedness {snapshot.mixed.mixedness.toFixed(3)}</span>
                    {!snapshot.mixed.isPure && (
                      <span>⟨ρ⟩ {snapshot.mixed.rhoExpectation.toFixed(3)}</span>
                    )}
                  </div>
                  {snapshot.entanglement?.status === 'entangled' && (
                    <div className="particle-entangled" aria-label={`q${physicalQubit} entangled with register`}>
                      Entangled with register
                    </div>
                  )}
                  {/* A failed witness is not evidence of separability, so say so instead of "not entangled". */}
                  {snapshot.entanglement?.status === 'inconclusive' && (
                    <div
                      className="particle-entangled particle-entangled-inconclusive"
                      aria-label={`q${physicalQubit} entanglement inconclusive`}
                      title={snapshot.entanglement.reason}
                    >
                      Entanglement undetermined
                    </div>
                  )}
                </>
              )}
              {delta && delta.displacement > 1e-4 && (
                <div className="particle-delta" aria-label={`q${physicalQubit} change after last gate`}>
                  <span>Δr {delta.deltaR.toFixed(3)}</span>
                  <span>Δθ {deg(delta.deltaTheta)}</span>
                  <span>Δφ {deg(delta.deltaPhi)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {sorted.length > 0 && (
        <div className="execution-timeline" aria-label="Circuit execution timeline">
          {sorted.map((gate) => {
            const touched = [...gate.controls, ...gate.targets];
            const transition = transitions.find((entry) => entry.step === gate.step);
            return (
              <div className={`timeline-step ${activeStep === gate.step ? 'active' : ''} ${activeStep >= gate.step ? 'done' : ''}`} key={gate.id} style={{ ['--mix-color' as string]: mixedColor(touched.length ? touched : gate.targets) }}>
                <span>{gate.step + 1}</span>
                <strong>{gate.type}</strong>
                <small>
                  -I {transition?.inputQubits.map((qubit) => `q${qubit}`).join(', ') || gate.controls.map((qubit) => `q${qubit}`).join(', ') || gate.targets.map((qubit) => `q${qubit}`).join(', ') || '—'}
                  {' · '}
                  -O {transition?.outputQubits.map((qubit) => `q${qubit}`).join(', ') || gate.targets.map((qubit) => `q${qubit}`).join(', ')}
                </small>
                <small>{gateIoLabel(gate)}</small>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
