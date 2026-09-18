import { useState } from 'react';
import { isKnownGateType } from '../simulator/gates/registry';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState } from '../simulator/types';
import { CircuitGlyph } from './circuit/CircuitGlyph';
import {
  blockViewLabel,
  circuitColumnCount,
  circuitViewTip,
  circuitViewTitle,
  DEFAULT_SHOW_QUBIT_WIRES,
  gateSpanQubits,
  MAX_SLOT_REM,
  MIN_SLOT_REM,
  needsConnector,
  SHOW_QUBIT_WIRES_LABEL,
  startStateKet,
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
  const [showQubitWires, setShowQubitWires] = useState(DEFAULT_SHOW_QUBIT_WIRES);
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const maxStep = sorted.reduce((highest, gate) => Math.max(highest, gate.step), -1);
  const columns = circuitColumnCount(sorted.length, maxStep);
  const activeGate = activeStep >= 0 ? sorted.find((gate) => gate.step === activeStep) : undefined;

  const handleDrop = (event: React.DragEvent, qubit: number) => {
    event.preventDefault();
    const droppedGate = event.dataTransfer.getData('text/plain');
    if (isKnownGateType(droppedGate)) onDropGate(droppedGate, qubit);
  };

  const placeSelectedGate = (qubit: number) => {
    if (selectedGate) onDropGate(selectedGate, qubit);
  };

  const dropSlotProps = (qubit: number) => ({
    onClick: () => placeSelectedGate(qubit),
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: (event: React.DragEvent) => handleDrop(event, qubit),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        placeSelectedGate(qubit);
      }
    },
    role: 'button' as const,
    tabIndex: 0,
  });

  return (
    <section className="panel circuit-panel" aria-labelledby="circuit-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Circuit canvas</p>
          <h2 id="circuit-title">{circuitViewTitle(showQubitWires)}</h2>
        </div>
        <label className="circuit-view-toggle">
          <input
            aria-controls="circuit-board-view"
            aria-describedby="circuit-view-toggle-hint"
            checked={showQubitWires}
            onChange={(event) => setShowQubitWires(event.target.checked)}
            type="checkbox"
          />
          <span>{SHOW_QUBIT_WIRES_LABEL}</span>
        </label>
      </div>
      <p className="sr-only" id="circuit-view-toggle-hint">
        Display-mode toggle. Checked shows Standard Circuit View with qubit wires. Unchecked shows Gate Block View. Presentation only; the circuit and simulator stay the same.
      </p>
      <div className="canvas-scroll" style={showQubitWires ? undefined : { ['--columns' as string]: columns }}>
        {showQubitWires ? (
          <div
            className="circuit-board"
            id="circuit-board-view"
            style={{
              ['--columns' as string]: columns,
              ['--qubits' as string]: qubitCount,
              ['--slot-min' as string]: `${MIN_SLOT_REM}rem`,
              ['--slot-max' as string]: `${MAX_SLOT_REM}rem`,
            }}
          >
            <div aria-hidden="true" className="circuit-wire-layer">
              {Array.from({ length: qubitCount }, (_, qubit) => (
                <span className="circuit-wire" key={`wire-${qubit}`} />
              ))}
            </div>

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
                <div className="circuit-drop" key={`drop-${qubit}`} {...dropSlotProps(qubit)} />
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
        ) : (
          <div className="circuit-grid" id="circuit-board-view">
            {Array.from({ length: qubitCount }, (_, qubit) => (
              <div className="wire-row" key={qubit}>
                <div className="wire-label">q{qubit}</div>
                <div
                  aria-label={`Place gate on q${qubit}`}
                  className={`wire-lane ${selectedGate ? 'ready' : ''}`}
                  {...dropSlotProps(qubit)}
                >
                  <span aria-hidden="true" className="wire-line" />
                  {sorted.map((gate) => {
                    if (!gateTouchesQubit(gate, qubit)) return null;
                    const isTarget = gate.targets.includes(qubit);
                    const isControl = gate.controls.includes(qubit);
                    const label = blockViewLabel(gate);
                    return (
                      <span
                        className={`placed-gate ${activeStep === gate.step ? 'active' : ''} ${activeStep >= gate.step ? 'done' : ''}`}
                        key={`${gate.id}-${qubit}`}
                        style={{ ['--step' as string]: gate.step + 1 }}
                      >
                        {isControl ? <span className="control-dot" title={`${label} control`} /> : null}
                        {isTarget ? (
                          <button
                            aria-label={`Remove ${label}`}
                            className="block-gate"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemoveGate(gate.id);
                            }}
                            title={label}
                            type="button"
                          >
                            {label}
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="canvas-tip">{circuitViewTip(showQubitWires)}</p>
    </section>
  );
}
