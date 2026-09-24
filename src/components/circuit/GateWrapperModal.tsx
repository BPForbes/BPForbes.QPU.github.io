import { conditionValueLabel, type CircuitGate } from '../../simulator/types';
import type { WrapperDraft } from './gateWrappers';

type GateWrapperModalProps = {
  gate: CircuitGate;
  qubitCount: number;
  draft: WrapperDraft;
  onChange: (draft: WrapperDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
};

export function GateWrapperModal({
  gate,
  qubitCount,
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: GateWrapperModalProps) {
  const gateLabel = String(gate.type) + (gate.inverse ? '†' : '');

  return (
    <div className="wrapper-modal-root" role="presentation">
      <button aria-label="Dismiss wrapper dialog" className="menu-backdrop" onClick={onCancel} type="button" />
      <div
        aria-labelledby="wrapper-modal-title"
        aria-modal="true"
        className="wrapper-modal"
        role="dialog"
      >
        <div className="wrapper-modal-heading">
          <p className="eyebrow">Gate wrappers</p>
          <h2 id="wrapper-modal-title">{gateLabel} on q{gate.targets[0] ?? 0}</h2>
          <p className="wrapper-modal-note">
            Tag recursion and IF/ELSE the same way you pick gates from the palette. Save keeps the values;
            Delete clears the wrappers and leaves the gate.
          </p>
        </div>

        <label className="wrapper-field wrapper-toggle">
          <input
            checked={draft.recursionEnabled}
            onChange={(event) => onChange({ ...draft, recursionEnabled: event.target.checked })}
            type="checkbox"
          />
          <span>Recursive wrapper</span>
        </label>
        {draft.recursionEnabled ? (
          <label className="wrapper-field">
            Depth
            <input
              min={1}
              onChange={(event) => onChange({ ...draft, depth: Math.max(1, Number(event.target.value) || 1) })}
              type="number"
              value={draft.depth}
            />
          </label>
        ) : null}

        <label className="wrapper-field wrapper-toggle">
          <input
            checked={draft.branchEnabled}
            onChange={(event) => onChange({ ...draft, branchEnabled: event.target.checked })}
            type="checkbox"
          />
          <span>IF / ELSE wrapper</span>
        </label>
        {draft.branchEnabled && draft.predicate ? (
          <p className="wrapper-modal-note">
            {gate.branch?.kind === 'else' ? 'ELSE' : 'IF'} {draft.predicate.text}
            {draft.predicate.negate ? ' ≠ ' : ' = '}
            {conditionValueLabel(draft.predicate.expect)}. This gate-expression test comes from the
            protocol text; edit it there. Untick to remove it.
          </p>
        ) : draft.branchEnabled ? (
          <div className="wrapper-branch-grid">
            <label className="wrapper-field">
              Kind
              <select
                onChange={(event) => {
                  const kind = event.target.value === 'else' ? 'else' : 'if';
                  onChange({
                    ...draft,
                    branchKind: kind,
                    conditionEquals: kind === 'else' ? 0 : 1,
                  });
                }}
                value={draft.branchKind}
              >
                <option value="if">IF</option>
                <option value="else">ELSE</option>
              </select>
            </label>
            <label className="wrapper-field">
              Classical bit
              <select
                onChange={(event) => onChange({ ...draft, conditionQubit: Number(event.target.value) })}
                value={draft.conditionQubit}
              >
                {Array.from({ length: qubitCount }, (_, qubit) => (
                  <option key={qubit} value={qubit}>q{qubit} → c</option>
                ))}
              </select>
            </label>
            <label className="wrapper-field">
              Equals
              <select
                onChange={(event) => onChange({
                  ...draft,
                  conditionEquals: Number(event.target.value) === 0 ? 0 : 1,
                })}
                value={draft.conditionEquals}
              >
                <option value={1}>1</option>
                <option value={0}>0</option>
              </select>
            </label>
          </div>
        ) : null}

        <div className="wrapper-modal-actions">
          <button className="wrapper-save" onClick={onSave} type="button">Save</button>
          <button onClick={onCancel} type="button">Cancel</button>
          <button className="wrapper-delete" onClick={onDelete} type="button">Delete wrappers</button>
        </div>
      </div>
    </div>
  );
}
