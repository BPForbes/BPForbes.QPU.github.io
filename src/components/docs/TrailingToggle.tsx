import { useId } from 'react';

type TrailingToggleProps = {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

/** Settings row whose switch sits at the trailing end, after the label and description. */
export function TrailingToggle({ label, description, checked, onChange }: TrailingToggleProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span id={labelId}>{label}</span>
        {description ? <small id={descriptionId}>{description}</small> : null}
      </div>
      <button
        aria-checked={checked}
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={labelId}
        className="toggle-switch"
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}
