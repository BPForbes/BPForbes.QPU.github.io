import { isKnownGateType } from '../simulator/gates/registry';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState } from '../simulator/types';
import { CircuitGlyph } from './circuit/CircuitGlyph';
import {
  buildVisualCircuitColumns,
  columnIsActive,
  columnIsDone,
  recursionDepthForColumn,
  recursionDepthLabel,
  recursionDepthTitle,
  visualColumnIndexForStep,
} from './circuit/recursionVisuals';
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
  /** True when every gate has been stepped/run — hides recursive D{n} badges. */
  circuitComplete?: boolean;
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
  circuitComplete = false,
  selectedGate,
  measurements = {},
  startStates = [],
  onDropGate,
  onRemoveGate,
}: CircuitCanvasProps) {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const trackingGates = (wireGates ?? gates).slice().sort((a, b) => a.step - b.step);
  const visualColumns = buildVisualCircuitColumns(sorted);
  const maxVisualColumn = visualColumns.reduce((highest, column) => Math.max(highest, column.column), -1);
  const columns = circuitColumnCount(visualColumns.length, maxVisualColumn);
  const activeGate = activeStep >= 0 ? sorted.find((gate) => gate.step === activeStep) : undefined;
  const measureGates = sorted.filter((gate) => gate.type === 'MEASURE');
  const classicalQubits = classicalWireQubits(qubitCount, trackingGates, measurements);
  const showClassical = classicalQubits.length > 0;
  const classicalRow = qubitCount + 1;
  const rowCount = qubitCount + (showClassical ? 1 : 0);
  const measuredWithoutGate = classicalQubits.filter(
    (qubit) => !measureGates.some((gate) => gate.targets.includes(qubit)),
  );
  const hasRecursion = visualColumns.some((column) => column.recursion);

  const handleDrop = (event: React.DragEvent, qubit: number) => {
    event.preventDefault();
    const droppedGate = event.dataTransfer.getData('text/plain');
    if (isKnownGateType(droppedGate)) onDropGate(droppedGate, qubit);
  };

  const placeSelectedGate = (qubit: number) => {
    if (selectedGate) onDropGate(selectedGate, qubit);
  };

  const removeVisualGate = (displayGate: CircuitGate) => {
    onRemoveGate(displayGate.id);
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

          {showClassical &&
            Array.from({ length: columns }, (_, column) =>
              (['incoming', 'outgoing'] as const).map((half) => (
                <span
                  aria-hidden="true"
                  className={`circuit-wire ${half} classical`}
                  key={`c-wire-${column}-${half}`}
                  style={{ gridColumn: column + 2, gridRow: classicalRow }}
                />
              )),
            )}

          {showClassical &&
            measureGates.flatMap((gate) => {
              const column = visualColumnIndexForStep(visualColumns, gate.step);
              if (column === undefined) return [];
              return gate.targets.map((qubit) => (
                <span
                  aria-hidden="true"
                  className="circuit-measure-drop"
                  key={`drop-${gate.id}-${qubit}`}
                  style={{ gridColumn: column + 2, gridRow: `${qubit + 1} / ${classicalRow + 1}` }}
                >
                  <span className="circuit-measure-bit">{qubit}</span>
                </span>
              ));
            })}

          {showClassical &&
            measuredWithoutGate.map((qubit) => (
              <span
                aria-hidden="true"
                className="circuit-measure-drop"
                key={`runtime-drop-${qubit}`}
                style={{ gridColumn: columns + 1, gridRow: `${qubit + 1} / ${classicalRow + 1}` }}
              >
                <span className="circuit-measure-bit">{qubit}</span>
              </span>
            ))}

          {visualColumns.filter((column) => column.cycleGate).map((column) => (
            <span
              className={`circuit-cycle-slice ${columnIsActive(column, activeStep) ? 'active' : ''}`}
              key={column.cycleGate!.id}
              style={{ gridColumn: column.column + 2, gridRow: `1 / ${rowCount + 1}` }}
              title={`Logical cycle ${column.cycleGate!.cycle ?? ''} (INCREASECYCLE advances the stage; it does not loop)`}
            >
              {column.cycleGate!.cycle ?? ''}
            </span>
          ))}

          {visualColumns.flatMap((column) =>
            column.displayGates
              .filter((gate) => gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE')
              .map((gate) => (
                <span
                  className="circuit-checkpoint"
                  key={gate.id}
                  style={{ gridColumn: column.column + 2, gridRow: 1 }}
                >
                  {gate.type === 'SAVE_STATE' ? 'save' : 'load'}
                </span>
              )),
          )}

          {visualColumns.flatMap((column) =>
            column.displayGates.filter(needsConnector).map((gate) => {
              const { min, max } = gateSpanQubits(gate);
              return (
                <span
                  className={`circuit-connector ${columnIsActive(column, activeStep) ? 'active' : ''}`}
                  key={`link-${gate.id}`}
                  style={{ gridColumn: column.column + 2, gridRow: `${min + 1} / ${max + 2}` }}
                />
              );
            }),
          )}

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

          {showClassical && (
            <div className="circuit-label-cell circuit-classical-label" style={{ gridColumn: 1, gridRow: classicalRow }}>
              <span className="circuit-q">c</span>
              <span className="circuit-c-width">/{qubitCount}</span>
            </div>
          )}

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

          {visualColumns.flatMap((column) => {
            const depth = recursionDepthForColumn(column, activeStep, { circuitComplete });
            const active = columnIsActive(column, activeStep);
            const done = columnIsDone(column, activeStep);
            return column.displayGates.flatMap((gate) =>
              Array.from({ length: qubitCount }, (_, qubit) => {
                if (!gateTouchesQubit(gate, qubit)) return null;
                const isTarget = gate.targets.includes(qubit);
                return (
                  <span
                    className={`circuit-slot ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                    key={`${gate.id}-${qubit}`}
                    style={{ gridColumn: column.column + 2, gridRow: qubit + 1 }}
                    title={
                      depth !== undefined && column.recursion
                        ? recursionDepthTitle(column, depth)
                        : undefined
                    }
                  >
                    <span className="circuit-gate-stack">
                      {isTarget && depth !== undefined ? (
                        <span aria-hidden="true" className="circuit-depth-badge">
                          {recursionDepthLabel(depth)}
                        </span>
                      ) : null}
                      <CircuitGlyph
                        active={active}
                        gate={gate}
                        onRemove={isTarget ? () => removeVisualGate(gate) : undefined}
                        qubit={qubit}
                      />
                    </span>
                  </span>
                );
              }),
            );
          })}
        </div>
      </div>
      <p className="canvas-tip">
        {hasRecursion
          ? 'A recursive call draws as one gate with a light-green D{n} above it. Step through to watch DEPTH count down; when the call finishes the badge hides. Forward gates stay black/red; inverse (dg/inv) stay blue/purple.'
          : 'Qubit wires stay single, and a measured qubit can still take later gates. The double stroke down to c marks the time of that measurement and the bit where the result lands. Inverse gates wear a dagger: blue in general, purple on the active step. Active steps use a red outline; measured particles turn red on their wire.'}
      </p>
    </section>
  );
}
