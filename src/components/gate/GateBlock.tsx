/**
 * Reusable visual token for a gate in the palette or on the canvas.
 *
 * Gate metadata comes from the registry; this component only handles rendering,
 * selection state, drag payloads, and remove affordances.
 */
import { gateHelp } from '../../data/learning/learningHelp';
import { getGateDefinition } from '../../simulator/gates/registry';
import { GateType } from '../../simulator/types';

type GateBlockProps = {
  type: GateType;
  draggable?: boolean;
  selected?: boolean;
  compact?: boolean;
  onClick?: () => void;
  onDragStart?: (gate: GateType) => void;
};

const fallbackLabels: Record<string, string> = {
  RESET: 'R',
};

export function GateBlock({ type, draggable = false, selected = false, compact = false, onClick, onDragStart }: GateBlockProps) {
  const definition = getGateDefinition(type);
  const label = definition?.label ?? fallbackLabels[type] ?? type;
  const cssClass = definition?.cssClass ?? `gate-${String(type).toLowerCase()}`;
  const customStyle = definition?.color ? { background: definition.color } : undefined;
  const help = gateHelp[type];
  const title = help ? `${type} · ${help.name}: ${help.summary}` : `${type} · custom gate`;

  return (
    <button
      className={`gate ${cssClass} ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
      data-doc={`gate:${type}`}
      draggable={draggable}
      onClick={onClick}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', type);
        onDragStart?.(type);
      }}
      style={customStyle}
      title={title}
      type="button"
      aria-label={`${type} gate`}
    >
      <span>{label}</span>
    </button>
  );
}
