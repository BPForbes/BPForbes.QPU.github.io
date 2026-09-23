/**
 * Form controls for turning cataloged `.qpucir` processes into reusable canvas
 * gates.
 *
 * This panel validates user-supplied labels and source before registering a
 * custom gate, so the palette only receives processes the simulator can compile.
 */
import { useMemo, useState } from 'react';
import { buildProcessCatalogSummaries, getCatalogEntry, getCatalogLibrarySources } from '../../data/catalog';
import {
  listCustomGateRecords,
  registerCustomGate,
  removeCustomGateRecord,
} from '../../simulator/gates/customGateEngine';
import { refreshCustomGateRegistry } from '../../simulator/gates/registry';
import { extractMainProcessName } from '../../simulator/compiler';
import { docHref, docTargets } from '../../data/learning/learningHelp';

type CustomGatePanelProps = {
  protocolSource: string;
  onRegistryChange: () => void;
  registryVersion: number;
};

export function CustomGatePanel({ protocolSource, onRegistryChange, registryVersion }: CustomGatePanelProps) {
  const [gateId, setGateId] = useState('');
  const [selectedCatalog, setSelectedCatalog] = useState('');
  const [customColor, setCustomColor] = useState('');
  const [status, setStatus] = useState('Turn a compiled QPU process into a reusable palette macro.');
  const catalog = useMemo(() => buildProcessCatalogSummaries(), []);
  const customGates = useMemo(() => listCustomGateRecords(), [registryVersion]);

  const sourceForRegistration = () => {
    if (selectedCatalog) {
      return getCatalogEntry(selectedCatalog)?.source ?? protocolSource;
    }
    return protocolSource;
  };

  const register = () => {
    try {
      const id = gateId.trim() || extractMainProcessName(sourceForRegistration()) || 'CustomGate';
      registerCustomGate({
        id,
        source: sourceForRegistration(),
        librarySources: getCatalogLibrarySources(),
        color: customColor.trim() || undefined,
      });
      refreshCustomGateRegistry();
      onRegistryChange();
      setStatus(`Registered custom gate '${id}'. It is now available in the custom palette.`);
      setGateId('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not register custom gate.');
    }
  };

  const remove = (id: string) => {
    removeCustomGateRecord(id);
    refreshCustomGateRegistry();
    onRegistryChange();
    setStatus(`Removed custom gate '${id}'.`);
  };

  return (
    <section className="panel custom-gate-panel" aria-labelledby="custom-gate-title">
      <div className="section-heading">
        <p className="eyebrow">Gate engine</p>
        <h2 id="custom-gate-title">Register custom gates from QPU processes</h2>
      </div>
      <p className="canvas-tip">{status}</p>
      <details className="help-panel">
        <summary>What is a custom gate, and is mine reversible?</summary>
        <p>
          A custom gate replays the gates of a saved process on the wires you choose. Its first PARAMS input maps to
          Control A, the second to Control B, and its first RETURNVALS output to Target particle. Register processes with one
          output; other tokens become extra workspace wires.
        </p>
        <p>
          It is reversible when every gate inside is reversible, it has no MEASURE, it does not SET its output (that inserts a
          hidden RESET that overwrites the target), and every helper wire returns to 0. Place it twice in a row: a reversible
          gate leaves every wire where it started.
        </p>
        <p className="help-links">
          <a className="doc-link" href={docHref(import.meta.env.BASE_URL, docTargets.customGates)} rel="noreferrer" target="_blank">
            {docTargets.customGates.label}
          </a>
        </p>
      </details>
      <div className="custom-gate-form">
        <label>
          Gate id (palette label)
          <input onChange={(event) => setGateId(event.target.value)} placeholder="RSN" value={gateId} />
        </label>
        <label>
          Source process
          <select onChange={(event) => setSelectedCatalog(event.target.value)} value={selectedCatalog}>
            <option value="">Current protocol editor</option>
            {catalog.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}</option>
            ))}
          </select>
        </label>
        <label>
          Color (optional — random if empty)
          <input onChange={(event) => setCustomColor(event.target.value)} placeholder="linear-gradient(...) or #8b5cf6" value={customColor} />
        </label>
        <button onClick={register} type="button">Register custom gate</button>
      </div>
      {customGates.length > 0 && (
        <ul className="custom-gate-list">
          {customGates.map((gate) => (
            <li data-doc={`gate:${gate.id}`} key={gate.id}>
              <span className="custom-gate-swatch" style={{ background: gate.color }} />
              <span>{gate.label}</span>
              <small>{gate.inputParamNames.join(', ')} → {gate.outputParamNames.join(', ')}</small>
              <button onClick={() => remove(gate.id)} type="button">Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
