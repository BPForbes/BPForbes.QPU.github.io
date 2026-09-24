import { getGateDefinition } from '../../simulator/gates/registry';
import type { CircuitGate } from '../../simulator/types';
import { glyphKindFor, glyphLabelFor, type CircuitGlyphKind } from '../circuitLayout';
import { conditionBadgeLabel } from './branchVisuals';

type CircuitGlyphProps = {
  gate: CircuitGate;
  qubit: number;
  active?: boolean;
  branchOutcome?: 'taken' | 'skipped' | 'pending';
  /** Canvas-only label override (e.g. REC for collapsed multi-op recursion). */
  labelOverride?: string;
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

const MeasureMeter = () => (
  <svg aria-hidden="true" className="glyph-svg glyph-meter" viewBox="0 0 24 24">
    <path d="M4.8 17.2a7.2 7.2 0 0 1 14.4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M12 17.2L17.4 8.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="17.2" r="1.25" fill="currentColor" />
  </svg>
);

const glyphContent = (kind: CircuitGlyphKind, label: string) => {
  if (kind === 'plus') return <PlusTarget />;
  if (kind === 'swap') return <SwapMark />;
  if (kind === 'measure') return <MeasureMeter />;
  if (kind === 'control') return <span className="glyph-control-dot" />;
  return <span>{label}</span>;
};

export function CircuitGlyph({
  gate,
  qubit,
  active = false,
  branchOutcome = 'pending',
  labelOverride,
  onRemove,
}: CircuitGlyphProps) {
  const kind = labelOverride ? 'box' : glyphKindFor(gate, qubit);
  const definition = getGateDefinition(String(gate.type));
  const forwardLabel = labelOverride
    ?? glyphLabelFor(gate, qubit, definition?.label ?? String(gate.type));
  const label = !labelOverride && gate.inverse && kind === 'box' ? `${forwardLabel}†` : forwardLabel;
  const badge = conditionBadgeLabel(gate);
  const branchClass = gate.condition
    ? branchOutcome === 'taken'
      ? ' branch-taken'
      : branchOutcome === 'skipped'
        ? ' branch-skipped'
        : ''
    : '';
  const className = `circuit-glyph glyph-${kind}${label.length > 2 && kind === 'box' ? ' glyph-wide' : ''}${!labelOverride && gate.inverse ? ' inverse' : ''}${gate.condition ? ' conditioned' : ''}${active ? ' active' : ''}${branchClass}`;
  const conditionNote = gate.condition
    ? ` if q${gate.condition.qubit}=${gate.condition.equals}`
    : '';
  const branchNote = gate.branch
    ? ` (${gate.branch.kind.toUpperCase()} ${branchOutcome})`
    : '';
  const title = labelOverride
    ? `${labelOverride} recursive call${conditionNote}${branchNote}`
    : `${gate.type}${gate.inverse ? '†' : ''}${kind === 'control' ? ' control' : ''}${conditionNote}${branchNote}`;

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
        {gate.inverse && kind !== 'box' ? <span className="glyph-dagger">†</span> : null}
        {badge && kind === 'box' ? <span className="glyph-condition">{badge}</span> : null}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {glyphContent(kind, label)}
      {gate.inverse && kind !== 'box' ? <span className="glyph-dagger">†</span> : null}
      {badge && kind === 'box' ? <span className="glyph-condition">{badge}</span> : null}
    </span>
  );
}
