import { useState } from 'react';

// Step-by-step view of a noisy (or physical) run next to the ideal run. The inspector computes every value
// with the Physics Engine while the runs execute; this component only lays the steps out.

export type TraceQubit = {
  wire: number;
  label: string;
  /** Actual f₀₁ at this point on the physical clock (physical runs only). */
  frequency?: number;
  pOne: number;
  purity: number;
  /** Population leaked to |2⟩ so far. */
  leakage?: number;
};

export type TraceStep = {
  label: string;
  physicalTime?: number;
  /** Fidelity of the noisy register with the ideal register after the same gate. */
  fidelity: number;
  qubits: TraceQubit[];
};

const fixed = (value: number | undefined, digits = 3) =>
  (value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));

function FidelityStrip({ steps, current }: { steps: TraceStep[]; current: number }) {
  const width = 100;
  const height = 24;
  // Fidelity usually stays near 1, so the vertical axis spans only the run's own range.
  const lowest = Math.min(...steps.map((step) => step.fidelity));
  const floor = Math.max(0, Math.min(lowest, 0.999) - (1 - Math.min(lowest, 0.999)) * 0.1);
  const x = (index: number) => (steps.length === 1 ? width / 2 : (index / (steps.length - 1)) * width);
  const y = (fidelity: number) => height - ((Math.max(floor, Math.min(1, fidelity)) - floor) / (1 - floor)) * height;
  const points = steps.map((step, index) => `${x(index)},${y(step.fidelity)}`).join(' ');
  return (
    <figure className="physics-strip-figure">
      <svg aria-hidden="true" className="physics-strip" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <polyline points={points} />
        <line x1={x(current)} x2={x(current)} y1={0} y2={height} />
      </svg>
      <figcaption className="physics-note">Fidelity with ideal, axis {floor.toFixed(3)} to 1</figcaption>
    </figure>
  );
}

export function PhysicalTrace({ steps }: { steps: TraceStep[] }) {
  const [requested, setIndex] = useState(steps.length - 1);
  if (steps.length === 0) return null;
  const index = Math.min(Math.max(requested, 0), steps.length - 1);
  const step = steps[index];
  const physical = step.physicalTime !== undefined;
  const leaks = step.qubits.some((qubit) => qubit.leakage !== undefined);

  return (
    <div className="physics-trace">
      <div className="physics-trace-controls">
        <button disabled={index === 0} onClick={() => setIndex(index - 1)} type="button">Previous gate</button>
        <input
          aria-label="Gate in the noisy run"
          max={steps.length - 1}
          min={0}
          onChange={(event) => setIndex(Number(event.target.value))}
          type="range"
          value={index}
        />
        <button disabled={index === steps.length - 1} onClick={() => setIndex(index + 1)} type="button">Next gate</button>
      </div>
      <FidelityStrip current={index} steps={steps} />
      <dl className="physics-metrics">
        <dt>After gate</dt>
        <dd>{index + 1} of {steps.length}: {step.label}</dd>
        {physical && (
          <>
            <dt>Physical time</dt>
            <dd>{fixed(step.physicalTime, 1)} ns</dd>
          </>
        )}
        <dt>Fidelity with ideal</dt>
        <dd>{fixed(step.fidelity, 4)}</dd>
      </dl>
      <div className="physics-table-wrap">
        <table className="physics-table">
          <thead>
            <tr>
              <th scope="col">Qubit</th>
              {physical && <th scope="col">f₀₁ now (GHz)</th>}
              <th scope="col">P(1)</th>
              <th scope="col">Purity</th>
              {leaks && <th scope="col">Leaked so far</th>}
            </tr>
          </thead>
          <tbody>
            {step.qubits.map((qubit) => (
              <tr key={qubit.wire}>
                <th scope="row">{qubit.label}</th>
                {physical && <td>{fixed(qubit.frequency, 6)}</td>}
                <td>{fixed(qubit.pOne)}</td>
                <td>{fixed(qubit.purity)}</td>
                {leaks && <td>{qubit.leakage === undefined ? '0' : qubit.leakage.toExponential(2)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
