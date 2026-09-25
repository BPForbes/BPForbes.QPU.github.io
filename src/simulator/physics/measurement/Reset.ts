/**
 * RESET: force one wire to |0⟩.
 *
 * Physically this is the reset channel ρ → |0⟩⟨0|⊗Tr_q(ρ). A state vector
 * cannot hold the mixed result of resetting an entangled wire, so the
 * state-vector path follows one trajectory of that channel the way hardware
 * does it: measure the wire in Z and flip it back with X if it read 1. Averaged
 * over runs this equals the density-matrix reset exactly. When the wire's
 * value is already certain no random draw is consumed and the result is
 * deterministic.
 */
import type { Complex } from '../../complex';
import { MATRIX_X } from '../../gates/matrices';
import { applySingleQubitGate, probabilityOfOne } from '../state/StateVector';
import { measureQubit } from './Measurement';

const CERTAIN = 1e-12;

export const resetStateVector = (
  state: Complex[],
  qubitCount: number,
  qubit: number,
  random: () => number = Math.random,
): Complex[] => {
  const probabilityOne = probabilityOfOne(state, qubitCount, qubit);
  const uncertain = probabilityOne > CERTAIN && probabilityOne < 1 - CERTAIN;
  // A certain wire samples its only possible outcome without touching the random stream.
  const measured = measureQubit(state, qubitCount, qubit, uncertain ? random() : probabilityOne > 0.5 ? 0 : 1);
  return measured.value === 1 ? applySingleQubitGate(measured.state, qubitCount, qubit, MATRIX_X) : measured.state;
};
