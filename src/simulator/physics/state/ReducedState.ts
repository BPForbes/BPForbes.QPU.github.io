/**
 * Reduced density matrices ρ_A = Tr_B(ρ_AB) for arbitrary subsystems.
 *
 * `subsystem[0]` is the most significant bit of the reduced index, so
 * reducing onto [0, 1] of a Bell pair returns the usual 4×4 |Φ+⟩⟨Φ+|.
 */
import { complex, type Complex, magnitudeSquared, ZERO } from '../../complex';
import type { DensityMatrix } from './QuantumState';
import { bitMask } from './StateVector';

const validateSubsystem = (qubitCount: number, subsystem: number[]) => {
  if (subsystem.length === 0) throw new RangeError('Subsystem must name at least one qubit.');
  if (new Set(subsystem).size !== subsystem.length) throw new RangeError('Subsystem qubits must be distinct.');
  const invalid = subsystem.filter((qubit) => !Number.isInteger(qubit) || qubit < 0 || qubit >= qubitCount);
  if (invalid.length > 0) {
    throw new RangeError(`Invalid subsystem qubits: ${invalid.join(', ')} (qubitCount=${qubitCount})`);
  }
};

// Splits a basis index into (subsystem index, environment index) with subsystem bits in the requested order.
const splitIndex = (qubitCount: number, subsystem: number[]) => {
  const keepMasks = subsystem.map((qubit) => bitMask(qubit, qubitCount));
  const keepMask = keepMasks.reduce((all, mask) => all | mask, 0);
  const environmentMasks = Array.from({ length: qubitCount }, (_, qubit) => bitMask(qubit, qubitCount))
    .filter((mask) => (mask & keepMask) === 0);
  return (index: number) => {
    let system = 0;
    keepMasks.forEach((mask) => {
      system = (system << 1) | ((index & mask) !== 0 ? 1 : 0);
    });
    let environment = 0;
    environmentMasks.forEach((mask) => {
      environment = (environment << 1) | ((index & mask) !== 0 ? 1 : 0);
    });
    return { system, environment };
  };
};

/**
 * Single-qubit ρ from a pure state in one O(2^n) pass. This is the path the
 * particle view has always used, kept verbatim so Bloch readouts do not drift.
 */
export const singleQubitReducedState = (state: Complex[], qubitCount: number, qubit: number): DensityMatrix => {
  const mask = bitMask(qubit, qubitCount);
  let rho00 = 0;
  let rho11 = 0;
  let rho01re = 0;
  let rho01im = 0;

  for (let index = 0; index < state.length; index += 1) {
    if ((index & mask) !== 0) continue;
    const amp0 = state[index];
    const amp1 = state[index | mask];
    rho00 += magnitudeSquared(amp0);
    rho11 += magnitudeSquared(amp1);
    rho01re += amp0.re * amp1.re + amp0.im * amp1.im;
    rho01im += amp0.im * amp1.re - amp0.re * amp1.im;
  }

  // ρ01 = Σ ψ(…0…) ψ*(…1…); ρ10 is its conjugate.
  return [
    [complex(rho00, 0), complex(rho01re, rho01im)],
    [complex(rho01re, -rho01im), complex(rho11, 0)],
  ];
};

/** ρ_S = Tr_E |ψ⟩⟨ψ| for a pure state vector. */
export const reducedStateFromVector = (state: Complex[], qubitCount: number, subsystem: number[]): DensityMatrix => {
  validateSubsystem(qubitCount, subsystem);
  if (subsystem.length === 1) return singleQubitReducedState(state, qubitCount, subsystem[0]);

  const systemSize = 2 ** subsystem.length;
  const environmentSize = 2 ** (qubitCount - subsystem.length);
  const split = splitIndex(qubitCount, subsystem);
  // Reshape ψ into a systemSize × environmentSize matrix Ψ, then ρ_S = Ψ Ψ†.
  const psi = Array.from({ length: systemSize }, () => Array.from({ length: environmentSize }, () => ZERO));
  state.forEach((amplitude, index) => {
    const { system, environment } = split(index);
    psi[system][environment] = amplitude;
  });

  return Array.from({ length: systemSize }, (_, row) =>
    Array.from({ length: systemSize }, (_, col) => {
      let re = 0;
      let im = 0;
      for (let env = 0; env < environmentSize; env += 1) {
        const a = psi[row][env];
        const b = psi[col][env];
        re += a.re * b.re + a.im * b.im;
        im += a.im * b.re - a.re * b.im;
      }
      return complex(re, im);
    }));
};

/** Generic partial trace ρ_S = Tr_E ρ for a density matrix. */
export const partialTrace = (rho: DensityMatrix, qubitCount: number, subsystem: number[]): DensityMatrix => {
  validateSubsystem(qubitCount, subsystem);
  const systemSize = 2 ** subsystem.length;
  const split = splitIndex(qubitCount, subsystem);
  const parts = Array.from({ length: rho.length }, (_, index) => split(index));
  const out = Array.from({ length: systemSize }, () => Array.from({ length: systemSize }, () => ({ re: 0, im: 0 })));

  for (let i = 0; i < rho.length; i += 1) {
    for (let j = 0; j < rho.length; j += 1) {
      if (parts[i].environment !== parts[j].environment) continue;
      const cell = out[parts[i].system][parts[j].system];
      cell.re += rho[i][j].re;
      cell.im += rho[i][j].im;
    }
  }

  return out.map((row) => row.map((value) => complex(value.re, value.im)));
};
