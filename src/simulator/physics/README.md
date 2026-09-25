# Physics Engine

`PhysicsEngine` (`physics` singleton) is the single authoritative boundary for
quantum mechanics in QPU.

| Layer | Owns |
| --- | --- |
| Compiler | Parsing, recursion expansion, child processes, IF/ELSE syntax |
| Simulator engine (`engine.ts`) | *When* operations run: ordering, conditions, checkpoints, register growth, tracing |
| Gate registry (`gates/`) | *What* an operation is: matrices, inverse rules, metadata, fast-path kernels |
| **Physics engine** (`physics/`) | *How* the state changes and what can be measured about it |
| Particle tracker (`particleTracking.ts`) | What changed, for the Bloch view (consumes `inspectQubit`) |
| UI (`components/`) | Presentation only |

Entanglement, cloning, and teleportation are never special instructions: they
emerge from ordinary gates and are *detected* here.

Every state change goes through this engine by default. Gate definitions build
operators (`gates/operations.ts` turns CNOT/CCNOT/AND/OR/XOR into permutation
operators) and hand them to `physics.applyControlledUnitary`; MEASURE, RESET,
start-state preparation, register growth, IF-predicate classification, and the
UI's single-wire measure all call the engine. Code outside `physics/` calls
the `physics` instance (`import { physics } from '.../physics/PhysicsEngine'`)
and never imports the kernels under `state/`, `measurement/`, `analysis/`,
`noise/`, `dynamics/`, or `numerics/`; raw amplitude arrays are wrapped with
`physics.fromAmplitudes`. `tests/engineBoundary.test.ts` enforces this.

## Layout

```
physics/
├── PhysicsEngine.ts        facade over both state representations
├── state/                  QuantumState, StateVector kernels, DensityMatrix, ReducedState
├── measurement/            X/Y/Z projective measurement and diagnostics
├── analysis/               Bloch, Purity, Entropy, Entanglement, Fidelity, Interference, Phase
├── noise/                  Kraus channels, NoiseModel, T1/T2 decoherence
├── dynamics/Hamiltonian.ts static and time-dependent H (4th-order Magnus)
├── frequency/              energy levels, clock, pulses, drives, couplings, frames
├── validation/             state/operator/channel/qubit checks
├── numerics/               dense linear algebra, Bloch-ball quadrature
└── particleTracking.ts     visualization tracker (observes physics)
```

## Accuracy levels

1. **Simulation state** — state vector, density matrix, collapse, unitary and
   Kraus evolution. Authoritative.
2. **Diagnostics** — purity, entropy, negativity, fidelity, Bloch coordinates.
   Exact derived quantities, covered by tests in `physics/tests/`.
3. **Visualization estimates** — `numerics/blochQuadrature.ts`
   (`rhoExpectation`). Display-only; never feeds state evolution.

## Engine-native execution

`executeCircuit` / `applyGateToState` (in `engine.ts`) keep the register as a
`QuantumState` from preparation to result and return `QuantumExecutionResult`.
Pass `noise` to run as an open system; the state becomes a density matrix only
when a channel can change it. `runCircuit`, `applyGate`, `stepCircuitGate`, and
`runNoisyCircuit` are `Complex[]` compatibility adapters over this path.

## Validation

`validation/Validation.ts` checks states (dimension, normalization; density
matrices Hermitian, trace 1, positive semidefinite), operators (shape,
U†U ≈ I), channels (ΣK†K ≈ I), and qubit indices (in range, distinct). Every
public engine method validates its inputs in development and tests
(`import.meta.env.DEV`); production skips it. The outermost call validates the
input state once, so gate kernels running on unnormalized density-matrix
columns inside the engine are not rejected. `physics.setValidation()` toggles
the automatic checks; `physics.validateState/validateUnitary/validateChannel`
always run.

## Frequency and physical simulation

`frequency/` makes frequency a derived physical quantity. Units: frequencies
are cycles per time unit (GHz for ns), ħ = 1; SI only in the Planck/Boltzmann
helpers (`physics.frequency.*`).

- `QubitPhysicsProfile` { nominal f₀₁, offset, drift, T1, T2, temperature } →
  idle Hamiltonian H₀ = −(ω₀₁/2)Z; free precession Δφ = −∫ω dt.
- `ControlPulse` (carrier, peak Rabi frequency, phase, duration, square /
  Gaussian / DRAG envelope); `calibratedPulse` sets the area for an angle.
- `driveDiagnostics`: detuning, generalized Rabi frequency, axis, rotation,
  max transfer, regime, dispersive AC Stark shift.
- `physics.evolvePhysical(state, system, segment)`: H(t) = idle + ZZ/exchange
  couplings + drives, in the lab or rotating frame, drives `'exact'` or in an
  explicit `'rwa'`. `physics.applyPhysicalDecoherence` applies profile T1/T2
  (thermal via generalized amplitude damping) over the same Δt.
- `executeCircuit(..., { physical })` runs a circuit on the physical clock:
  operations last their durations (logical cycles take none), idle wires
  precess, couplings cause crosstalk, and `gates: 'drive'` turns X/Y/RX/RY
  into calibrated pulses. Off by default; the ideal path is unchanged.
  With the default `gates: 'matrix'`, a gate acts instantly at the start of
  its slot and the wires then evolve for the rest of it, so dynamics *during*
  a gate are modelled only for the drive-pulse gates.

- Leakage (`frequency/Leakage.ts`): a profile `anharmonicity` (α/2π, e.g.
  −0.2 GHz) makes drive pulses on that wire run on a three-level transmon
  (levels (n − ½)ω₀₁ + (α/2)n(n − 1), drive matrix elements √n). The qubit gets
  the exact channel K₀ = PUP, L = |1⟩⟨2|UP; the run reports leaked population
  per wire. `leakageDiagnostics` gives f₁₂, leakage from |0⟩/|1⟩, and the
  leakage-cancelling DRAG β = 1/α. Leaked population returns to |1⟩ when the
  operation ends (|2⟩ decays to |1⟩ and reads out as 1); it is not tracked
  across later gates, and leaky drives on coupled wires are rejected.

Not modelled yet: population that stays in |2⟩ between operations, noise
spectral densities S(ω), and spatial wave packets (de Broglie is educational
only).

## Exposure

Physics reaches users deliberately, not automatically: `MEASURE -BASIS X|Y|Z`
is the only language addition, and the Physics inspector (Particle
visualization page) offers subsystem diagnostics and a noisy run with
per-qubit profiles and a gate-by-gate trace (`executeCircuit`'s `onStep`). Partial
traces, Hamiltonians, and Kraus operators stay API-only.

## Representations and cost

- Pure circuits stay on the O(2^n) state vector (`runCircuit`).
- A density matrix (O(4^n), capped at `MAX_DENSITY_QUBITS`) is created only
  when noise is applied or `runNoisyCircuit` / `toDensityMatrix` is called.
- Expensive metrics (von Neumann entropy of large subsystems, negativity) run
  only when requested; `inspectQubit` stays O(2^n).

## Conventions

- Qubit 0 is the most significant bit of a basis index. Subsystem and operator
  target lists put their first entry in the most significant position.
- Measurement outcome 0 is the +1 eigenstate of the observable
  (|0⟩, |+⟩, |+i⟩). `MEASURE` defaults to Z; `CircuitGate.basis` selects X/Y.
- Bloch vector is (⟨X⟩, ⟨Y⟩, ⟨Z⟩), so ρ = ½(I + xX + yY + zZ).
- Fidelity uses the squared convention F = (Tr √(√ρ σ √ρ))².
- Entanglement is an `EntanglementAssessment` (`entangled` / `separable` /
  `inconclusive`, with the method and, for PPT, the negativity), never a bare
  boolean. Pure registers use the exact reduced-state test. Mixed registers use
  PPT: negative is conclusive for any split, zero is conclusive only for 2×2;
  larger zero-negativity splits and registers past the PPT size limit are
  `inconclusive`. UI must not render `inconclusive` as "not entangled".
- `CYCLE`/`INCREASECYCLE` are *logical* cycles (program stages), never physical
  time; decoherence uses `PhysicalTimingModel` gate durations.
- `RESET` is physical. Density matrices get the reset channel
  ρ → |0⟩⟨0| ⊗ Tr_q ρ; state vectors follow one measure-and-flip trajectory
  of it (random only when the wire is uncertain), which averages to the channel.

## Tests

- `tests/properties.test.ts`: seeded random checks of normalization, U†U
  reversibility, channel trace/positivity, density/state-vector agreement,
  measurement, reduced states, and Hamiltonian unitarity.
- `../tests/legacyRegression.test.ts`: generated circuits compared against a
  frozen copy of the pre-engine simulator (`../tests/support/legacyReference.ts`).
- `tests/engineBoundary.test.ts`: code outside `physics/` only uses the engine.

## Limits

- Density-matrix execution rejects gate-expression IF predicates and custom
  gates that add wires or measure internally.
- Noise models are configured in the Physics inspector or the API, not in QPU
  source.
