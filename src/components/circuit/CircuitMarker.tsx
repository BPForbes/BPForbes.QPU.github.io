import type { CSSProperties } from 'react';

type CircuitMarkerProps = {
  /** Short tag drawn above the line: S (SAVE_STATE), L (LOAD_STATE), IC (INCREASECYCLE). */
  label: string;
  /** Full description for the tooltip and screen readers. */
  description: string;
  active?: boolean;
  style: CSSProperties;
};

/**
 * Whole-register timeline marker: a dashed vertical line across every wire
 * with a short tag above it. Used for checkpoints and cycle boundaries, which
 * are simulator markers rather than gates (and never loops).
 */
export function CircuitMarker({ label, description, active = false, style }: CircuitMarkerProps) {
  return (
    <span
      aria-label={description}
      className={`circuit-marker${active ? ' active' : ''}`}
      role="img"
      style={style}
      title={description}
    >
      <span aria-hidden="true" className="circuit-marker-label">{label}</span>
    </span>
  );
}
