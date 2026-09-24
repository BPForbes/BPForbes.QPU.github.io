import { gateSpanQubits, MAX_SLOT_REM, MIN_SLOT_REM, needsConnector } from '../circuitLayout';
import { CircuitGlyph } from './CircuitGlyph';
import { CircuitMarker } from './CircuitMarker';
import { recursionDepthLabel, sourceGateLabel, type RecursionFrame } from './recursionVisuals';

type RecursionFrameViewProps = {
  frame: RecursionFrame;
  /** Simulator step under the playhead; the matching gate draws active (red, or purple if inverse). */
  activeStep: number;
  /** Protocol parameter name per simulator wire (A, B, C…). */
  qubitNames?: (string | undefined)[];
};

/**
 * One unrolled level of a collapsed REC/TREC call, drawn with the canvas
 * circuit vocabulary: forward body, adjoint body, the INCREASECYCLE slice,
 * then the tail call to the next depth. Recursion is compile-time expansion,
 * so the frame ends in a downward RECUR marker, never a backward wire.
 */
export function RecursionFrameView({ frame, activeStep, qubitNames = [] }: RecursionFrameViewProps) {
  const first = Math.min(...frame.qubits);
  const last = Math.max(...frame.qubits);
  const wires = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const rowOf = (qubit: number) => qubit - first + 1;
  const bodyColumns = frame.body.length;
  const cycleColumn = frame.cycleGate ? bodyColumns : undefined;
  const recurColumn = bodyColumns + (frame.cycleGate ? 1 : 0);
  const wiredColumns = recurColumn;
  const columns = recurColumn + 1;
  const annotationRow = wires.length + 1;
  const nextDepth = frame.depth - 1;
  const hasInverse = frame.inverseStart < bodyColumns;

  return (
    <div className="recursion-frame">
      <div className="recursion-frame-title">
        <strong>{frame.process}</strong>
        <span>
          DEPTH {frame.depth} · LEVEL {frame.level} · {frame.mode === 'tco' ? 'TCO' : 'STACK'}
        </span>
      </div>
      <div className="canvas-scroll">
        <div
          className="circuit-board recursion-frame-board"
          style={{
            ['--columns' as string]: columns,
            ['--qubits' as string]: wires.length,
            ['--rows' as string]: wires.length + 1,
            ['--slot-min' as string]: `${MIN_SLOT_REM}rem`,
            ['--slot-max' as string]: `${MAX_SLOT_REM}rem`,
          }}
        >
          {wires.map((qubit) => (
            <div className="circuit-label-cell" key={`label-${qubit}`} style={{ gridColumn: 1, gridRow: rowOf(qubit) }}>
              <span className="circuit-q">
                {qubitNames[qubit] ?? `q${qubit}`}
                {qubitNames[qubit] ? <span className="circuit-q-name">q{qubit}</span> : null}
              </span>
            </div>
          ))}

          {wires.map((qubit) => (
            <span
              aria-hidden="true"
              className="circuit-wire quantum"
              key={`wire-${qubit}`}
              style={{ gridColumn: `2 / ${wiredColumns + 2}`, gridRow: rowOf(qubit) }}
            />
          ))}

          {frame.body.filter(needsConnector).map((gate) => {
            const column = frame.body.indexOf(gate);
            const { min, max } = gateSpanQubits(gate);
            return (
              <span
                className={`circuit-connector ${gate.step === activeStep ? 'active' : ''}`}
                key={`link-${gate.id}`}
                style={{ gridColumn: column + 2, gridRow: `${rowOf(min)} / ${rowOf(max) + 1}` }}
              />
            );
          })}

          {frame.body.flatMap((gate, column) =>
            wires
              .filter((qubit) => gate.targets.includes(qubit) || gate.controls.includes(qubit))
              .map((qubit) => (
                <span
                  className="circuit-slot"
                  key={`${gate.id}-${qubit}`}
                  style={{ gridColumn: column + 2, gridRow: rowOf(qubit) }}
                >
                  <CircuitGlyph
                    active={gate.step === activeStep}
                    forwardLabel={sourceGateLabel(gate)}
                    gate={gate}
                    qubit={qubit}
                  />
                </span>
              )),
          )}

          {cycleColumn !== undefined && frame.cycleGate ? (
            <CircuitMarker
              active={frame.cycleGate.step === activeStep}
              description={`INCREASECYCLE → logical cycle ${frame.cycleGate.cycle ?? ''} (advances the stage; it does not loop)`}
              detail={frame.cycleGate.cycle !== undefined ? String(frame.cycleGate.cycle) : undefined}
              label="IC"
              style={{ gridColumn: cycleColumn + 2, gridRow: `1 / ${annotationRow}` }}
            />
          ) : null}

          <span
            className="recursion-frame-recur"
            style={{ gridColumn: recurColumn + 2, gridRow: `1 / ${wires.length + 1}` }}
            title={nextDepth > 0
              ? `Tail call expands the next frame at DEPTH ${nextDepth} (compile time, not a runtime jump back).`
              : 'DEPTH reaches 0: EXIT WHEN ends the expansion.'}
          >
            <span className="recursion-frame-recur-word">RECUR</span>
            <span aria-hidden="true" className="recursion-frame-recur-arrow">↓</span>
            <span className="recursion-frame-recur-depth">{recursionDepthLabel(nextDepth)}</span>
            {nextDepth <= 0 ? <span className="recursion-frame-recur-exit">exit</span> : null}
          </span>

          {frame.inverseStart > 0 ? (
            <span
              className="recursion-frame-region forward"
              style={{ gridColumn: `2 / ${frame.inverseStart + 2}`, gridRow: annotationRow }}
            >
              forward →
            </span>
          ) : null}
          {hasInverse ? (
            <span
              className="recursion-frame-region inverse"
              style={{ gridColumn: `${frame.inverseStart + 2} / ${bodyColumns + 2}`, gridRow: annotationRow }}
            >
              ← inverse
            </span>
          ) : null}
          {frame.cycleGate ? (
            <span
              className="recursion-frame-region cycle"
              style={{ gridColumn: `${recurColumn + 1} / ${recurColumn + 3}`, gridRow: annotationRow }}
            >
              INCREASECYCLE
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
