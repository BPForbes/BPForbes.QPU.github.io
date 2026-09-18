import { isKnownGateType } from '../simulator/gates/registry';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState } from '../simulator/types';
import { CircuitGlyph } from './circuit/CircuitGlyph';
import {
  circuitColumnCount,
  gateSpanQubits,
  MAX_SLOT_REM,
  MIN_SLOT_REM,
  needsConnector,
  startStateKet,
  wireKindSegments,
} from './circuitLayout';

type CircuitCanvasProps = {
  qubitCount: number;
  gates: CircuitGate[];
  activeStep: number;
  selectedGate: GateType | null;
  measurements?: MeasurementMap;
  startStates?: ParticleStartState[];
  onDropGate: (gate: GateType, qubit: number) => void;
  onRemoveGate: (gateId: string) => void;
};

const gateTouchesQubit = (gate: CircuitGate, qubit: number) => gate.targets.includes(qubit) || gate.controls.includes(qubit);

export function CircuitCanvas({
  qubitCount,
  gates,
  activeStep,
  selectedGate,
  measurements = {},
  startStates = [],
  onDropGate,
  onRemoveGate,
}: CircuitCanvasProps) {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const maxStep = sorted.reduce((highest, gate) => Math.max(highest, gate.step), -1);
  const columns = circuitColumnCount(sorted.length, maxStep);
  const wireKinds = wireKindSegments(qubitCount, sorted, startStates, columns, measurements);
  const activeGate = activeStep >= 0 ? sorted.find((gate) => gate.step === activeStep) : undefined;

  const handleDrop = (event: React.DragEvent, qubit: number) => {
    event.preventDefault();
    const droppedGate = event.dataTransfer.getData('text/plain');
    if (isKnownGateType(droppedGate)) onDropGate(droppedGate, qubit);
  };

  const placeSelectedGate = (qubit: number) => {
    if (selectedGate) onDropGate(selectedGate, qubit);
  };

  return (
    <section className="panel circuit-panel" aria-labelledby="circuit-title">
      <div className="section-heading">
        <p className="eyebrow">Circuit canvas</p>
        <h2 id="circuit-title">Standard circuit diagram</h2>
      </div>
      <div className="canvas-scroll">
        <div
          className="circuit-board"
          style={{
            ['--columns' as string]: columns,
            ['--qubits' as string]: qubitCount,
            ['--slot-min' as string]: `${MIN_SLOT_REM}rem`,
            ['--slot-max' as string]: `${MAX_SLOT_REM}rem`,
          }}
        >
          {Array.from({ length: qubitCount }, (_, qubit) =>
            Array.from({ length: columns }, (_, column) => (
              <span
                aria-hidden="true"
                className={`circuit-wire ${wireKinds[qubit][column]}`}
                key={`wire-${qubit}-${column}`}
                style={{ gridColumn: column + 2, gridRow: qubit + 1 }}
              />
            )),
          )}

          {sorted.filter(needsConnector).map((gate) => {
            const { min, max } = gateSpanQubits(gate);
            // Row span covers the outer lanes; CSS margin-block insets to wire centers.
            return (
              <span
                className={`circuit-connector ${activeStep === gate.step ? 'active' : ''}`}
                key={`link-${gate.id}`}
                style={{ gridColumn: gate.step + 2, gridRow: `${min + 1} / ${max + 2}` }}
              />
            );
          })}

          {Array.from({ length: qubitCount }, (_, qubit) => {
            const measured = measurements[qubit] !== undefined;
            const activeOnWire = Boolean(activeGate && gateTouchesQubit(activeGate, qubit));
            return (
              <div className="circuit-label-cell" key={`label-${qubit}`} style={{ gridColumn: 1, gridRow: qubit + 1 }}>
                <span className="circuit-q">q{qubit}</span>
                <span className="circuit-ket">{startStateKet(startStates[qubit])}</span>
                <span
                  aria-label={measured ? `q${qubit} measured` : `q${qubit} particle`}
                  className={`circuit-particle ${measured ? 'measured' : ''} ${activeOnWire ? 'hot' : ''}`}
                />
              </div>
            );
          })}

          <div className={`circuit-drop-layer ${selectedGate ? 'ready' : ''}`}>
            {Array.from({ length: qubitCount }, (_, qubit) => (
              <div
                className="circuit-drop"
                key={`drop-${qubit}`}
                onClick={() => placeSelectedGate(qubit)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, qubit)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') placeSelectedGate(qubit);
                }}
                role="button"
                tabIndex={0}
              />
            ))}
          </div>

          {sorted.map((gate) =>
            Array.from({ length: qubitCount }, (_, qubit) => {
              if (!gateTouchesQubit(gate, qubit)) return null;
              const isTarget = gate.targets.includes(qubit);
              return (
                <span
                  className={`circuit-slot ${activeStep === gate.step ? 'active' : ''} ${activeStep >= gate.step ? 'done' : ''}`}
                  key={`${gate.id}-${qubit}`}
                  style={{ gridColumn: gate.step + 2, gridRow: qubit + 1 }}
                >
                  <CircuitGlyph
                    active={activeStep === gate.step}
                    gate={gate}
                    onRemove={isTarget ? () => onRemoveGate(gate.id) : undefined}
                    qubit={qubit}
                  />
                </span>
              );
            }),
          )}
        </div>
      </div>
      <p className="canvas-tip">
        Classical bits (0p, 1p, or measured) use double lines; superposition uses a single line. Measure is the meter
        symbol. Active steps use a red outline; measured particles turn red on the wire.
      </p>
    </section>
  );
}
