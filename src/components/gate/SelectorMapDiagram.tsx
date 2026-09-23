/**
 * Miniature circuit diagram of the gate the workbench is about to place.
 *
 * Rows are the workbench's display wires; control rows get a filled dot and
 * the target row gets the gate symbol, so learners can see which selector
 * maps to which part of a standard diagram before adding the gate.
 */
type SelectorMapDiagramProps = {
  qubitCount: number;
  target: number;
  controls: number[];
  swapPartner?: number;
  symbol: string;
};

const ROW = 28;
const LEFT = 34;
const GATE_X = 118;
const RIGHT = 196;

export function SelectorMapDiagram({ qubitCount, target, controls, swapPartner, symbol }: SelectorMapDiagramProps) {
  const rows = Array.from({ length: qubitCount }, (_, qubit) => qubit);
  const touched = [target, ...controls, ...(swapPartner === undefined ? [] : [swapPartner])];
  const top = Math.min(...touched);
  const bottom = Math.max(...touched);
  const y = (qubit: number) => ROW / 2 + qubit * ROW;
  const roleFor = (qubit: number) => {
    if (qubit === target) return swapPartner === undefined ? 'Target: changed' : 'Target: swapped';
    if (qubit === swapPartner) return 'Control B: swapped';
    const controlIndex = controls.indexOf(qubit);
    if (controlIndex === 0) return 'Control A: read';
    if (controlIndex === 1) return 'Control B: read';
    if (controlIndex > 1) return 'Input: read';
    return '';
  };

  return (
    <svg
      aria-label="How the selected wires map onto the circuit diagram"
      className="selector-map"
      role="img"
      viewBox={`0 0 320 ${qubitCount * ROW}`}
    >
      {rows.map((qubit) => (
        <g key={qubit}>
          <text className="selector-map-wire-label" x={4} y={y(qubit) + 4}>q{qubit}</text>
          <line className="selector-map-wire" x1={LEFT} x2={RIGHT} y1={y(qubit)} y2={y(qubit)} />
          <text className={`selector-map-role ${qubit === target || qubit === swapPartner ? 'writes' : 'reads'}`} x={RIGHT + 8} y={y(qubit) + 4}>
            {roleFor(qubit)}
          </text>
        </g>
      ))}
      {bottom > top ? <line className="selector-map-link" x1={GATE_X} x2={GATE_X} y1={y(top)} y2={y(bottom)} /> : null}
      {controls.map((qubit) => <circle className="selector-map-control" cx={GATE_X} cy={y(qubit)} key={qubit} r={5} />)}
      {swapPartner === undefined ? (
        symbol === '⊕' ? (
          <g className="selector-map-target">
            <circle cx={GATE_X} cy={y(target)} r={9} />
            <line x1={GATE_X - 9} x2={GATE_X + 9} y1={y(target)} y2={y(target)} />
            <line x1={GATE_X} x2={GATE_X} y1={y(target) - 9} y2={y(target) + 9} />
          </g>
        ) : (
          <g className="selector-map-target">
            <rect height={20} rx={4} width={Math.max(22, symbol.length * 9 + 10)} x={GATE_X - Math.max(22, symbol.length * 9 + 10) / 2} y={y(target) - 10} />
            <text textAnchor="middle" x={GATE_X} y={y(target) + 4}>{symbol}</text>
          </g>
        )
      ) : (
        [target, swapPartner].map((qubit) => (
          <g className="selector-map-target swap" key={qubit}>
            <line x1={GATE_X - 6} x2={GATE_X + 6} y1={y(qubit) - 6} y2={y(qubit) + 6} />
            <line x1={GATE_X - 6} x2={GATE_X + 6} y1={y(qubit) + 6} y2={y(qubit) - 6} />
          </g>
        ))
      )}
    </svg>
  );
}
