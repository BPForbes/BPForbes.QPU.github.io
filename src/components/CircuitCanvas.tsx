import { isKnownGateType } from '../simulator/gates/registry';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState } from '../simulator/types';
import { CircuitGlyph } from './circuit/CircuitGlyph';
import {
  circuitColumnCount,
  classicalWireQubits,
  gateSpanQubits,
  MAX_SLOT_REM,
  MIN_SLOT_REM,
  needsConnector,
  startStateKet,
} from './circuitLayout';

type CircuitCanvasProps = {
  qubitCount: number;
  gates: CircuitGate[];
  /** Full simulator sequence, including hidden RESET gates used only for wire style. */
  wireGates?: CircuitGate[];
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
  wireGates,
  activeStep,
  selectedGate,
  measurements = {},
  startStates = [],
  onDropGate,
  onRemoveGate,
}: CircuitCanvasProps) {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const trackingGates = (wireGates ?? gates).slice().sort((a, b) => a.step - b.step);
  const maxStep = trackingGates.reduce((highest, gate) => Math.max(highest, gate.step), -1);
  const columns = circuitColumnCount(sorted.length, maxStep);
  const activeGate = activeStep >= 0 ? sorted.find((gate) => gate.step === activeStep) : undefined;
  const measureGates = sorted.filter((gate) => gate.type === 'MEASURE');
  const classicalQubits = classicalWireQubits(qubitCount, trackingGates, measurements);
  const classicalRowFor = (qubit: number) => qubitCount + classicalQubits.indexOf(qubit) + 1;
  const rowCount = qubitCount + classicalQubits.length;
  const measuredWithoutGate = classicalQubits.filter(
    (qubit) => !measureGates.some((gate) => gate.targets.includes(qubit)),
  );

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
            ['--rows' as string]: rowCount,
            ['--slot-min' as string]: `${MIN_SLOT_REM}rem`,
            ['--slot-max' as string]: `${MAX_SLOT_REM}rem`,
          }}
        >
          {Array.from({ length: qubitCount }, (_, qubit) =>
            Array.from({ length: columns }, (_, column) =>
              (['incoming', 'outgoing'] as const).map((half) => (
                <span
                  aria-hidden="true"
                  className={`circuit-wire ${half} quantum`}
                  key={`wire-${qubit}-${column}-${half}`}
                  style={{ gridColumn: column + 2, gridRow: qubit + 1 }}
                />
              )),
            ),
          )}

          {classicalQubits.flatMap((qubit) =>
            Array.from({ length: columns }, (_, column) =>
              (['incoming', 'outgoing'] as const).map((half) => (
                <span
                  aria-hidden="true"
                  className={`circuit-wire ${half} classical`}
                  key={`c-wire-${qubit}-${column}-${half}`}
                  style={{ gridColumn: column + 2, gridRow: classicalRowFor(qubit) }}
                />
              )),
            ),
          )}

          {measureGates.flatMap((gate) =>
            gate.targets.map((qubit) => (
              <span
                aria-hidden="true"
                className="circuit-measure-drop"
                key={`drop-${gate.id}-${qubit}`}
                style={{ gridColumn: gate.step + 2, gridRow: `${qubit + 1} / ${classicalRowFor(qubit) + 1}` }}
              />
            )),
          )}

          {measuredWithoutGate.map((qubit) => (
            <span
              aria-hidden="true"
              className="circuit-measure-drop"
              key={`runtime-drop-${qubit}`}
              style={{ gridColumn: columns + 1, gridRow: `${qubit + 1} / ${classicalRowFor(qubit) + 1}` }}
            />
          ))}

          {sorted.filter((gate) => gate.type === 'CYCLE').map((gate) => (
            <span
              className="circuit-cycle-slice"
              key={gate.id}
              style={{ gridColumn: gate.step + 2, gridRow: `1 / ${rowCount + 1}` }}
            >
              {gate.cycle ?? ''}
            </span>
          ))}

          {sorted.filter((gate) => gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE').map((gate) => (
            <span
              className="circuit-checkpoint"
              key={gate.id}
              style={{ gridColumn: gate.step + 2, gridRow: 1 }}
            >
              {gate.type === 'SAVE_STATE' ? 'save' : 'load'}
            </span>
          ))}

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

          {classicalQubits.map((qubit) => (
            <div
              className="circuit-label-cell circuit-classical-label"
              key={`c-label-${qubit}`}
              style={{ gridColumn: 1, gridRow: classicalRowFor(qubit) }}
            >
              <span className="circuit-q">c{qubit}</span>
            </div>
          ))}

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

          {measureGates.map((gate) => (
            <span
              className={`circuit-slot ${activeStep === gate.step ? 'active' : ''} ${activeStep >= gate.step ? 'done' : ''}`}
              key={`${gate.id}-c`}
              style={{ gridColumn: gate.step + 2, gridRow: classicalRowFor(gate.targets[0] ?? 0) }}
            >
              <CircuitGlyph
                active={activeStep === gate.step}
                gate={gate}
                onRemove={() => onRemoveGate(gate.id)}
                qubit={gate.targets[0] ?? 0}
              />
            </span>
          ))}

          {sorted.map((gate) =>
            Array.from({ length: qubitCount }, (_, qubit) => {
              if (gate.type === 'MEASURE' || !gateTouchesQubit(gate, qubit)) return null;
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
        Qubit wires stay single. Each measured qubit drops onto its own double line c0, c1, … Those lines cannot take a gate.
        Active steps use a red outline; measured particles turn red on their wire.
      </p>
    </section>
  );
}
