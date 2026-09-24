import { uiTips } from '../../data/learning/learningHelp';
import { customPaletteGates, preconfiguredPaletteGates } from '../../simulator/gates/registry';
import { GateType } from '../../simulator/types';
import { GateBlock } from './GateBlock';
type GatePaletteProps = {
  selectedGate: GateType | null;
  inverse: boolean;
  onToggleInverse: () => void;
  onSelectGate: (gate: GateType) => void;
};

export function GatePalette({ selectedGate, inverse, onToggleInverse, onSelectGate }: GatePaletteProps) {
  const preconfigured = preconfiguredPaletteGates();
  const custom = customPaletteGates();

  return (
    <div className="palette-sections">
      <div className="palette-section">
        <button className={`inverse-toggle${inverse ? ' on' : ''}`} onClick={onToggleInverse} title={uiTips.inverseToggle} type="button">
          {inverse ? 'Inverse on · drop dagger' : 'Inverse off · drop forward gate'}
        </button>
        <h3 className="palette-section-title">Preconfigured</h3>
        <div className="palette">
          {preconfigured.map((gate) => (
            <GateBlock
              draggable
              key={gate.id}
              onClick={() => onSelectGate(gate.id)}
              onDragStart={onSelectGate}
              selected={selectedGate === gate.id}
              type={gate.id}
            />
          ))}
        </div>
      </div>

      <div className="palette-section">
        <h3 className="palette-section-title">Custom gates</h3>
        {custom.length === 0 ? (
          <p className="palette-empty">Register a process as a custom gate below to add it here.</p>
        ) : (
          <div className="palette palette-custom">
            {custom.map((gate) => (
              <GateBlock
                draggable
                key={gate.id}
                onClick={() => onSelectGate(gate.id)}
                onDragStart={onSelectGate}
                selected={selectedGate === gate.id}
                type={gate.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
