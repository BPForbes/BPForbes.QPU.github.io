import { Fragment } from 'react';
import { isKnownGateType } from '../simulator/gates/registry';
import type { ParticleSnapshot } from '../simulator/physics/particleTracking';
import { CircuitGate, GateType, MeasurementMap, ParticleStartState } from '../simulator/types';
import {
  branchOutcomeFor,
  branchOutcomeNote,
  conditionFeedKeyword,
  conditionFeedLabel,
  conditionFeedTest,
} from './circuit/branchVisuals';
import { CircuitGlyph } from './circuit/CircuitGlyph';
import { CircuitMarker } from './circuit/CircuitMarker';
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
  wireKetLabel,
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
  /** When set, canvas gate clicks open the wrapper modal for this tool instead of removing. */
  selectedWrapper?: string | null;
  measurements?: MeasurementMap;
  startStates?: ParticleStartState[];
  /** Protocol parameter name per wire (e.g. A, B, C); shown beside q{n} and in IF/ELSE labels. */
  qubitNames?: (string | undefined)[];
  /** Live per-qubit particle snapshots; wire kets update from these as the run progresses. */
  particleSnapshots?: ParticleSnapshot[];
  onDropGate: (gate: GateType, qubit: number) => void;
  /** Primary gate click: wrap, edit wrappers, or remove depending on App state. */
  onActivateGate: (gate: CircuitGate) => void;
};

const gateTouchesQubit = (gate: CircuitGate, qubit: number) => gate.targets.includes(qubit) || gate.controls.includes(qubit);

export function CircuitCanvas({
  qubitCount,
  gates,
  wireGates,
  activeStep,
  circuitComplete = false,
  selectedGate,
  selectedWrapper = null,
  measurements = {},
  startStates = [],
  particleSnapshots = [],
  qubitNames = [],
  onDropGate,
  onActivateGate,
}: CircuitCanvasProps) {
  const sorted = gates.slice().sort((a, b) => a.step - b.step);
  const trackingGates = (wireGates ?? gates).slice().sort((a, b) => a.step - b.step);
  const visualColumns = buildVisualCircuitColumns(sorted);
  const maxVisualColumn = visualColumns.reduce((highest, column) => Math.max(highest, column.column), -1);
  const columns = circuitColumnCount(visualColumns.length, maxVisualColumn);
  const activeGate = activeStep >= 0 ? sorted.find((gate) => gate.step === activeStep) : undefined;
  const measureGates = sorted.filter((gate) => gate.type === 'MEASURE');
  const classicalQubits = classicalWireQubits(qubitCount, trackingGates, measurements);
  const conditionedSourceQubits = sorted
    .map((gate) => gate.condition?.qubit)
    .filter((qubit): qubit is number => qubit !== undefined && qubit >= 0 && qubit < qubitCount);
  const classicalLaneQubits = [...new Set([...classicalQubits, ...conditionedSourceQubits])].sort((a, b) => a - b);
  const showClassical = classicalLaneQubits.length > 0;
  const classicalRow = qubitCount + 1;
  const hasBranches = sorted.some((gate) => Boolean(gate.condition));
  /** Extra row under c so IF/ELSE pills sit below the classical time wire. */
  const pillRow = showClassical && hasBranches ? classicalRow + 1 : undefined;
  const rowCount = qubitCount + (showClassical ? 1 : 0) + (pillRow ? 1 : 0);
  const measuredWithoutGate = classicalLaneQubits.filter(
    (qubit) => !measureGates.some((gate) => gate.targets.includes(qubit)),
  );
  const hasRecursion = visualColumns.some((column) => column.recursion);
  const conditionedDisplayGates = visualColumns.flatMap((column) =>
    column.displayGates.filter((gate) => gate.condition && gate.targets.length > 0),
  );
  /** Timeline markers (S / L / IC) run across the quantum wires and the c bus, not the label row. */
  const markerEndRow = qubitCount + (showClassical ? 2 : 1);
  const snapshotByQubit = new Map(particleSnapshots.map((entry) => [entry.qubit, entry]));
  /** Multi-op recursive calls collapse to one REC box spanning every wire the body touches. */
  const isSpanningRec = (column: (typeof visualColumns)[number]) =>
    Boolean(column.recursion && column.displayLabel && column.recursion.qubits.length > 0);
  const hasRecCaption = visualColumns.some(isSpanningRec);

  const handleDrop = (event: React.DragEvent, qubit: number) => {
    event.preventDefault();
    const droppedGate = event.dataTransfer.getData('text/plain');
    if (isKnownGateType(droppedGate)) onDropGate(droppedGate, qubit);
  };

  const placeSelectedGate = (qubit: number) => {
    if (selectedGate) onDropGate(selectedGate, qubit);
  };

  const activateVisualGate = (displayGate: CircuitGate) => {
    onActivateGate(displayGate);
  };

  return (
    <section className="panel circuit-panel" aria-labelledby="circuit-title">
      <div className="section-heading">
        <p className="eyebrow">Circuit canvas</p>
        <h2 id="circuit-title">Standard circuit diagram</h2>
      </div>
      <div className="canvas-scroll">
        <div
          className={`circuit-board${hasRecCaption ? ' has-rec-caption' : ''}`}
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

          {showClassical &&
            conditionedDisplayGates.map((gate) => {
              const column = visualColumnIndexForStep(visualColumns, gate.step);
              if (column === undefined) return null;
              const target = gate.targets[0];
              const outcome = branchOutcomeFor(gate, measurements);
              const sourceName = gate.condition ? qubitNames[gate.condition.qubit] : undefined;
              const label = conditionFeedLabel(gate, sourceName);
              const note = branchOutcomeNote(outcome);
              return (
                <Fragment key={`cond-feed-${gate.id}`}>
                  {/* Classical control rises from the c bus to the gate on its own straight rail. */}
                  <span
                    aria-hidden="true"
                    className={`circuit-condition-feed ${outcome}`}
                    style={{ gridColumn: column + 2, gridRow: `${target + 1} / ${classicalRow + 1}` }}
                    title={label}
                  />
                  {pillRow !== undefined ? (
                    <span
                      className={`circuit-condition-pill ${outcome}`}
                      style={{ gridColumn: column + 2, gridRow: pillRow }}
                      title={note ? `${label} · ${note}` : label}
                    >
                      <span className="circuit-condition-keyword">{conditionFeedKeyword(gate)}</span>
                      <span className="circuit-condition-test">{conditionFeedTest(gate, sourceName)}</span>
                      {note ? <span className="circuit-condition-note">{note}</span> : null}
                    </span>
                  ) : null}
                </Fragment>
              );
            })}

          {visualColumns.filter((column) => column.cycleGate).map((column) => (
            <CircuitMarker
              active={columnIsActive(column, activeStep)}
              description={`INCREASECYCLE → logical cycle ${column.cycleGate!.cycle ?? ''} (advances the stage; it does not loop)`}
              key={column.cycleGate!.id}
              label="IC"
              style={{ gridColumn: column.column + 2, gridRow: `1 / ${markerEndRow}` }}
            />
          ))}

          {visualColumns.flatMap((column) =>
            column.displayGates
              .filter((gate) => gate.type === 'SAVE_STATE' || gate.type === 'LOAD_STATE')
              .map((gate) => {
                const save = gate.type === 'SAVE_STATE';
                return (
                  <CircuitMarker
                    active={columnIsActive(column, activeStep)}
                    description={`${gate.type} ${gate.checkpoint ?? ''} — ${save ? 'snapshots' : 'restores'} the whole state here`}
                    key={gate.id}
                    label={save ? 'S' : 'L'}
                    style={{ gridColumn: column.column + 2, gridRow: `1 / ${markerEndRow}` }}
                  />
                );
              }),
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
            const ket = wireKetLabel(snapshotByQubit.get(qubit), startStates[qubit]);
            return (
              <div className="circuit-label-cell" key={`label-${qubit}`} style={{ gridColumn: 1, gridRow: qubit + 1 }}>
                <span className="circuit-q">
                  q{qubit}
                  {qubitNames[qubit] ? <span className="circuit-q-name">{qubitNames[qubit]}</span> : null}
                </span>
                <span className="circuit-ket">{ket}</span>
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

          <div className={`circuit-drop-layer ${selectedGate ? 'ready' : ''} ${selectedWrapper ? 'wrapping' : ''}`}>
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
            if (isSpanningRec(column) && column.recursion) {
              const gate = column.displayGates[0];
              const wires = column.recursion.qubits;
              const depths = Object.values(column.recursion.depthByStep);
              const deepest = depths.length > 0 ? Math.min(...depths) : column.recursion.rootDepth;
              // Adjoint half of the frame keeps the blue/purple inverse semantics on the collapsed box.
              const inverseActive = active && Boolean(activeGate?.inverse);
              return [
                <span
                  className="circuit-rec-caption"
                  key={`rec-caption-${gate.id}`}
                  style={{ gridColumn: column.column + 2, gridRow: 1 }}
                  title={`${column.recursion.process} · compile-time expansion, DEPTH ${column.recursion.rootDepth} down to ${deepest}`}
                >
                  <span className="circuit-rec-caption-name">{column.recursion.process}</span>
                  <span className="circuit-rec-caption-range">
                    {recursionDepthLabel(column.recursion.rootDepth)} → {recursionDepthLabel(deepest)}
                  </span>
                </span>,
                <span
                  className={`circuit-slot circuit-rec-slot ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                  key={`${gate.id}-rec`}
                  style={{ gridColumn: column.column + 2, gridRow: `${wires[0] + 1} / ${wires[wires.length - 1] + 2}` }}
                  title={depth !== undefined ? recursionDepthTitle(column, depth) : undefined}
                >
                  <span className="circuit-gate-stack circuit-rec-stack">
                    {depth !== undefined ? (
                      <span aria-hidden="true" className="circuit-depth-badge">
                        {recursionDepthLabel(depth)}
                      </span>
                    ) : null}
                    <CircuitGlyph
                      activateLabel={
                        selectedWrapper
                          ? `Apply ${selectedWrapper.toUpperCase()} wrapper to ${gate.type}`
                          : `Edit wrappers on ${column.displayLabel}`
                      }
                      active={active}
                      gate={gate}
                      inverseOverride={inverseActive}
                      labelOverride={column.displayLabel}
                      onActivate={() => activateVisualGate(gate)}
                      qubit={wires[0]}
                    />
                  </span>
                </span>,
              ];
            }
            return column.displayGates.flatMap((gate) =>
              Array.from({ length: qubitCount }, (_, qubit) => {
                if (!gateTouchesQubit(gate, qubit)) return null;
                const isTarget = gate.targets.includes(qubit);
                const outcome = branchOutcomeFor(gate, measurements);
                return (
                  <span
                    className={`circuit-slot ${active ? 'active' : ''} ${done ? 'done' : ''} ${gate.condition ? `branch-${outcome}` : ''}`}
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
                        activateLabel={
                          selectedWrapper
                            ? `Apply ${selectedWrapper.toUpperCase()} wrapper to ${gate.type}`
                            : gate.condition || gate.recursion
                              ? `Edit wrappers on ${gate.type}`
                              : `Remove ${gate.type}`
                        }
                        active={active}
                        branchOutcome={outcome}
                        gate={gate}
                        labelOverride={isTarget ? column.displayLabel : undefined}
                        onActivate={isTarget ? () => activateVisualGate(gate) : undefined}
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
        {selectedWrapper
          ? `Wrapper tool ${selectedWrapper.toUpperCase()} is selected — click a gate to set DEPTH or IF/ELSE. Click the same wrapper again to cancel.`
          : hasRecursion
            ? 'A recursive call draws as one gate with a teal D{n} above it. Click a wrapped gate to edit DEPTH or IF/ELSE. Forward gates stay black/red; inverse (dg/inv) stay blue/purple.'
            : hasBranches
              ? 'IF/ELSE gates stay on their wire; a yellow double line drops from each to the c bus, labelled underneath. Once the bit is measured the branch shows ✓ taken or ⊘ skipped (faded, dashed). Click a wrapped gate to edit.'
              : 'Pick REC / IF / ELSE in the palette to tag gates. Wire kets update live (|0⟩, |1⟩, |+⟩, |−⟩). Inverse gates wear a dagger: blue in general, purple on the active step.'}
      </p>
    </section>
  );
}
