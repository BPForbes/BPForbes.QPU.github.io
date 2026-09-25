import { useMemo, useState } from 'react';
import { physics } from '../simulator/physics/PhysicsEngine';
import type { ControlPulse, PulseEnvelope, QubitPhysicsProfile } from '../simulator/physics';

// Energy, frequency, and resonance readouts for one qubit profile. Every value comes from the
// Physics Engine (physics.frequency); the panel only converts units for display (GHz/ns internally).

const ELECTRON_MASS = 9.1093837015e-31;

const fixed = (value: number | undefined, digits = 3) =>
  (value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));

const scientific = (value: number) => (Number.isFinite(value) ? value.toExponential(3) : '—');

type FrequencyPanelProps = {
  profile: QubitPhysicsProfile;
};

export function FrequencyPanel({ profile }: FrequencyPanelProps) {
  const [detuningMHz, setDetuningMHz] = useState(0);
  const [rabiMHz, setRabiMHz] = useState(25);
  const [pulseNs, setPulseNs] = useState(20);
  const [envelopeKind, setEnvelopeKind] = useState<PulseEnvelope['kind']>('square');
  const [electronSpeed, setElectronSpeed] = useState(1e6);

  const readout = useMemo(() => {
    try {
      const hertz = physics.frequency.toHertz(profile.transitionFrequency);
      const envelope: PulseEnvelope = envelopeKind === 'square'
        ? { kind: 'square' }
        : envelopeKind === 'gaussian'
          ? { kind: 'gaussian', sigma: pulseNs / 4 }
          : { kind: 'drag', sigma: pulseNs / 4, beta: 0.1 };
      const pulse: ControlPulse = {
        target: 0,
        carrierFrequency: profile.transitionFrequency + detuningMHz / 1000,
        amplitude: rabiMHz / 1000,
        phase: 0,
        duration: pulseNs,
        envelope,
      };
      const diagnostics = physics.frequency.driveDiagnostics(profile, pulse);
      // Simulate the pulse on |0⟩ in the rotating frame with the (explicit) rotating-wave approximation.
      const driven = physics.evolvePhysical(
        physics.createState(1),
        { defaultProfile: profile, frame: 'rotating', approximation: 'rwa' },
        { start: 0, duration: pulseNs, pulses: [pulse] },
      );
      return {
        ok: true as const,
        hertz,
        gap: physics.frequency.energyGap(hertz),
        wavelength: physics.frequency.photonWavelength(hertz),
        thermal: profile.temperature ? physics.frequency.thermalExcitedPopulation(hertz, profile.temperature) : 0,
        diagnostics,
        simulatedExcitation: physics.probabilityOfOne(driven, 0),
      };
    } catch (caught) {
      return { ok: false as const, error: (caught as Error).message };
    }
  }, [profile, detuningMHz, rabiMHz, pulseNs, envelopeKind]);

  const deBroglie = useMemo(() => {
    try {
      return physics.frequency.deBroglieWavelengthForMass(ELECTRON_MASS, electronSpeed);
    } catch {
      return undefined;
    }
  }, [electronSpeed]);

  if (!readout.ok) return <p className="physics-error" role="alert">{readout.error}</p>;
  const { hertz, gap, wavelength, thermal, diagnostics, simulatedExcitation } = readout;

  return (
    <div className="physics-frequency">
      <dl className="physics-metrics">
        <dt>Transition frequency f₀₁</dt>
        <dd>{fixed(profile.transitionFrequency, 4)} GHz ({scientific(hertz)} Hz)</dd>
        <dt>Energy gap ΔE = hf₀₁</dt>
        <dd>{scientific(gap)} J = {fixed(physics.frequency.joulesToElectronVolts(gap) * 1e6, 3)} µeV</dd>
        <dt>Photon wavelength c/f</dt>
        <dd>{fixed(wavelength * 100, 3)} cm</dd>
        <dt>Thermal |1⟩ population</dt>
        <dd>{profile.temperature ? `${scientific(thermal)} at ${fixed(profile.temperature * 1000, 1)} mK` : '0 (no temperature set)'}</dd>
      </dl>

      <div className="physics-noise-form">
        <label>
          Drive offset from nominal f₀₁ (MHz)
          <input onChange={(event) => setDetuningMHz(Number(event.target.value))} step={1} type="number" value={detuningMHz} />
        </label>
        <label>
          Rabi Ω/2π (MHz)
          <input min={0} onChange={(event) => setRabiMHz(Number(event.target.value))} step={1} type="number" value={rabiMHz} />
        </label>
        <label>
          Pulse (ns)
          <input min={0.1} onChange={(event) => setPulseNs(Number(event.target.value))} step={1} type="number" value={pulseNs} />
        </label>
        <label>
          Envelope
          <select onChange={(event) => setEnvelopeKind(event.target.value as PulseEnvelope['kind'])} value={envelopeKind}>
            <option value="square">Square</option>
            <option value="gaussian">Gaussian</option>
            <option value="drag">DRAG</option>
          </select>
        </label>
      </div>

      <dl className="physics-metrics">
        <dt>Drive frequency</dt>
        <dd>{fixed(diagnostics.driveFrequency, 4)} GHz</dd>
        <dt>Detuning Δ/2π</dt>
        <dd>{fixed(diagnostics.detuning * 1000, 2)} MHz ({diagnostics.regime})</dd>
        <dt>Generalized Rabi √(Ω²+Δ²)/2π</dt>
        <dd>{fixed(diagnostics.effectiveRabiFrequency * 1000, 2)} MHz</dd>
        <dt>Resonant rotation angle</dt>
        <dd>{fixed((diagnostics.resonantRotationAngle * 180) / Math.PI, 1)}°</dd>
        <dt>Max transfer Ω²/(Ω²+Δ²)</dt>
        <dd>{fixed(diagnostics.maxExcitationProbability)}</dd>
        {diagnostics.acStarkShift !== undefined && (
          <>
            <dt>AC Stark shift</dt>
            <dd>{fixed(diagnostics.acStarkShift * 1000, 3)} MHz</dd>
          </>
        )}
        <dt>Simulated P(1) after pulse</dt>
        <dd>{fixed(simulatedExcitation)} (rotating frame, RWA)</dd>
      </dl>

      <h4>Particle wavelength (educational)</h4>
      <div className="physics-noise-form">
        <label>
          Electron speed (m/s)
          <input min={1} onChange={(event) => setElectronSpeed(Number(event.target.value))} step={1000} type="number" value={electronSpeed} />
        </label>
      </div>
      <p className="physics-note">
        de Broglie λ = h/p = {deBroglie === undefined ? '—' : `${fixed(deBroglie * 1e9, 4)} nm`}. The circuit simulator models
        information-carrying states, not wave packets moving through space, so this does not affect gate execution.
      </p>
    </div>
  );
}
