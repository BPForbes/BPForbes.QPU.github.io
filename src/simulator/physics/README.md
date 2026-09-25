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
├── dynamics/Hamiltonian.ts optional e^{−iHt/ħ} evolution
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
- Logical `CYCLE`/`INCREASECYCLE` stages are not physical time; decoherence
  uses `PhysicalTimingModel` gate durations.
- `RESET` is physical. Density matrices get the reset channel
  ρ → |0⟩⟨0| ⊗ Tr_q ρ; state vectors follow one measure-and-flip trajectory
  of it (random only when the wire is uncertain), which averages to the channel.

## Not yet done

- QPU source syntax for measurement bases and noise models (compiler work).
- Density-matrix mode rejects gate-expression IF predicates and custom gates
  that add wires or measure internally.
- The UI does not yet expose a physics inspector or noisy runs.
