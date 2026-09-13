import { getGateDefinition } from '../../simulator/gates/registry';
import type { CircuitGate } from '../../simulator/types';
import { glyphKindFor, type CircuitGlyphKind } from '../circuitLayout';

type CircuitGlyphProps = {
  gate: CircuitGate;
  qubit: number;
  active?: boolean;
  onRemove?: () => void;
};

const PlusTarget = () => (
  <svg aria-hidden="true" className="glyph-svg" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8.25" fill="#fff" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 6.4v11.2M6.4 12h11.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const SwapMark = () => (
  <svg aria-hidden="true" className="glyph-svg" viewBox="0 0 24 24">
    <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" strokeWidth="2.1" />
  </svg>
);

const glyphContent = (kind: CircuitGlyphKind, label: string) => {
  if (kind === 'plus') return <PlusTarget />;
  if (kind === 'swap') return <SwapMark />;
  if (kind === 'control') return <span className="glyph-control-dot" />;
  return <span>{label}</span>;
};

export function CircuitGlyph({ gate, qubit, active = false, onRemove }: CircuitGlyphProps) {
  const kind = glyphKindFor(gate, qubit);
  const definition = getGateDefinition(String(gate.type));
  const label = definition?.label ?? gate.type;
  const className = `circuit-glyph glyph-${kind}${label.length > 2 && kind === 'box' ? ' glyph-wide' : ''}${active ? ' active' : ''}`;
  const title = `${gate.type}${kind === 'control' ? ' control' : ''}`;

  if (onRemove) {
    return (
      <button
        aria-label={`Remove ${title}`}
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        title={title}
        type="button"
      >
        {glyphContent(kind, label)}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {glyphContent(kind, label)}
    </span>
  );
}
