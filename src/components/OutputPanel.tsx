import { basisLabel } from '../simulator/engine';
import { formatComplex } from '../simulator/complex';
import { physics } from '../simulator/physics/PhysicsEngine';
import { Complex } from '../simulator/complex';
import { MeasurementMap } from '../simulator/types';
// Renders measurement readouts mapped from simulation indices.
type OutputPanelProps = {
  state: Complex[];
  qubitCount: number;
  measurements: MeasurementMap;
  log: string[];
  qubitLabels?: string[];
};

export function OutputPanel({ state, qubitCount, measurements, log, qubitLabels = [] }: OutputPanelProps) {
  const probabilities = physics.probabilities(physics.fromAmplitudes(state, qubitCount));
  const rows = state.map((amplitude, index) => ({ amplitude, index, probability: probabilities[index] }));
  const nonZero = rows.filter(({ amplitude }) => Math.abs(amplitude.re) > 1e-8 || Math.abs(amplitude.im) > 1e-8);

  return (
    <section className="panel output" aria-labelledby="output-title">
      <div className="section-heading">
        <p className="eyebrow">Output panel</p>
        <h2 id="output-title">Execution results</h2>
      </div>
      <div className="measurements">
        {Array.from({ length: qubitCount }, (_, qubit) => (
          <span className="measurement-pill" key={qubit}>{qubitLabels[qubit] ?? `q${qubit}`}: {measurements[qubit] ?? '—'}</span>
        ))}
      </div>
      <h3>Final state vector</h3>
      <div className="state-vector">
        {nonZero.map(({ amplitude, index }) => (
          <code key={index}>{formatComplex(amplitude)} |{basisLabel(index, qubitCount)}⟩</code>
        ))}
      </div>
      <details className="truth-table-panel">
        <summary>Outcome truth table / probabilities</summary>
        <div className="truth-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Amplitude</th>
                <th>Probability</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ amplitude, index, probability }) => (
                <tr className={probability > 1e-8 ? 'possible' : ''} key={index}>
                  <td>|{basisLabel(index, qubitCount)}⟩</td>
                  <td><code>{formatComplex(amplitude)}</code></td>
                  <td>{(probability * 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <h3>Execution log</h3>
      <ol className="log-list">
        {log.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}
      </ol>
    </section>
  );
}
