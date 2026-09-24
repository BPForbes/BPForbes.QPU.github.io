import { getGateDefinition, paletteGateIds } from '../../simulator/gates/registry';
import { conditionValueLabel, type CircuitGate, type ConditionValue } from '../../simulator/types';
import {
  predicateFromDraft,
  predicateGateIds,
  predicateInputCount,
  resizePredicateInputs,
  type WrapperDraft,
} from './gateWrappers';

type GateWrapperModalProps = {
  gate: CircuitGate;
  qubitCount: number;
  qubitNames?: (string | undefined)[];
  draft: WrapperDraft;
  onChange: (draft: WrapperDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
};

const wireOption = (qubit: number, qubitNames: (string | undefined)[]) =>
  qubitNames[qubit] ? `q${qubit} · ${qubitNames[qubit]}` : `q${qubit}`;

export function GateWrapperModal({
  gate,
  qubitCount,
  qubitNames = [],
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: GateWrapperModalProps) {
  const gateLabel = String(gate.type) + (gate.inverse ? '†' : '');
  const gateOptions = predicateGateIds(paletteGateIds());
  const predicateDraft = draft.predicateDraft;
  const predicateDefinition = predicateDraft ? getGateDefinition(predicateDraft.gateType) : undefined;
  const preview = draft.branchEnabled && draft.joined && predicateDraft
    ? predicateFromDraft(predicateDraft, qubitNames)
    : undefined;

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

        {draft.branchEnabled ? (
          <>
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
                      // Switching IF↔ELSE flips a Joined test to its complement.
                      predicateDraft: predicateDraft && kind !== draft.branchKind
                        ? { ...predicateDraft, negate: !predicateDraft.negate }
                        : predicateDraft,
                    });
                  }}
                  value={draft.branchKind}
                >
                  <option value="if">IF</option>
                  <option value="else">ELSE</option>
                </select>
              </label>
              <label className="wrapper-field wrapper-toggle">
                <input
                  checked={Boolean(draft.joined)}
                  onChange={(event) => onChange({ ...draft, joined: event.target.checked })}
                  type="checkbox"
                />
                <span>Joined (test a gate)</span>
              </label>
            </div>

            {draft.joined && predicateDraft ? (
              <div className="wrapper-branch-grid">
                <label className="wrapper-field">
                  Gate
                  <select
                    onChange={(event) => onChange({
                      ...draft,
                      predicateDraft: resizePredicateInputs(predicateDraft, event.target.value, qubitCount),
                    })}
                    value={predicateDraft.gateType}
                  >
                    {gateOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>

                {predicateDraft.inputs.map((input, index) => (
                  <label className="wrapper-field" key={`predicate-input-${index}`}>
                    {predicateDraft.inputs.length > 1 ? `Input ${index + 1}` : 'Input'}
                    <select
                      onChange={(event) => {
                        const inputs = predicateDraft.inputs.slice();
                        inputs[index] = Number(event.target.value);
                        onChange({ ...draft, predicateDraft: { ...predicateDraft, inputs } });
                      }}
                      value={input}
                    >
                      {Array.from({ length: qubitCount }, (_, qubit) => (
                        <option key={qubit} value={qubit}>{wireOption(qubit, qubitNames)}</option>
                      ))}
                    </select>
                  </label>
                ))}

                <label className="wrapper-field">
                  Output
                  <select
                    onChange={(event) => onChange({
                      ...draft,
                      predicateDraft: { ...predicateDraft, output: Number(event.target.value) },
                    })}
                    value={predicateDraft.output}
                  >
                    {Array.from({ length: qubitCount }, (_, qubit) => (
                      <option key={qubit} value={qubit}>{wireOption(qubit, qubitNames)}</option>
                    ))}
                  </select>
                </label>

                {predicateDefinition?.supportsReverse ? (
                  <label className="wrapper-field wrapper-toggle">
                    <input
                      checked={predicateDraft.inverse}
                      onChange={(event) => onChange({
                        ...draft,
                        predicateDraft: { ...predicateDraft, inverse: event.target.checked },
                      })}
                      type="checkbox"
                    />
                    <span>Inverse (dg/inv)</span>
                  </label>
                ) : null}

                {predicateDefinition?.supportsPhase ? (
                  <label className="wrapper-field">
                    Phase angle: {predicateDraft.phaseDegrees}°
                    <input
                      max="360"
                      min="0"
                      onChange={(event) => onChange({
                        ...draft,
                        predicateDraft: { ...predicateDraft, phaseDegrees: Number(event.target.value) },
                      })}
                      step="15"
                      type="range"
                      value={predicateDraft.phaseDegrees}
                    />
                  </label>
                ) : null}

                <label className="wrapper-field">
                  Test
                  <select
                    onChange={(event) => onChange({
                      ...draft,
                      predicateDraft: { ...predicateDraft, negate: event.target.value === '!=' },
                    })}
                    value={predicateDraft.negate ? '!=' : '='}
                  >
                    <option value="=">equals</option>
                    <option value="!=">not equal to</option>
                  </select>
                </label>
                <label className="wrapper-field">
                  Value
                  <select
                    onChange={(event) => onChange({
                      ...draft,
                      predicateDraft: { ...predicateDraft, expect: (event.target.value === 's' ? 's' : Number(event.target.value)) as ConditionValue },
                    })}
                    value={predicateDraft.expect}
                  >
                    <option value={1}>1p</option>
                    <option value={0}>0p</option>
                    <option value="s">sp</option>
                  </select>
                </label>
              </div>
            ) : draft.joined ? null : (
              <div className="wrapper-branch-grid">
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
            )}

            {preview ? (
              <p className="wrapper-modal-note">
                Test: {preview.text} {preview.negate ? '≠' : '='} {conditionValueLabel(preview.expect)}.
                The gate runs on a scratch copy just before this step; the circuit itself is unchanged.
              </p>
            ) : null}
          </>
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
