/**
 * Planck–Einstein relation E = hf = ħω and the quantities derived from it.
 * For a qubit the relevant energy is the gap ΔE = E₁ − E₀, so f₀₁ = ΔE / h:
 * frequency is a derived physical quantity, not a free display statistic.
 */
import { BOLTZMANN, ELECTRON_VOLT, PLANCK, SPEED_OF_LIGHT } from './Units';

/** E = hf, in joules, for a frequency in Hz. */
export const photonEnergy = (hertz: number) => PLANCK * hertz;

/** ΔE = h·f₀₁ in joules for a transition frequency in Hz. */
export const energyGap = (transitionHertz: number) => PLANCK * transitionHertz;

/** f₀₁ = (E₁ − E₀)/h in Hz for level energies in joules. Negative when E₁ < E₀. */
export const transitionFrequency = (energy0: number, energy1: number) => (energy1 - energy0) / PLANCK;

export const joulesToElectronVolts = (joules: number) => joules / ELECTRON_VOLT;

/** λ = c/f for the photon that drives a transition, in metres. */
export const photonWavelength = (hertz: number) => SPEED_OF_LIGHT / hertz;

/**
 * Boltzmann (two-level) population of |1⟩ in equilibrium with a bath:
 * p₁ = 1 / (1 + e^{hf/kT}). Zero at T = 0, ½ as T → ∞.
 */
export const thermalExcitedPopulation = (transitionHertz: number, temperatureKelvin: number) => {
  if (!(temperatureKelvin > 0)) return 0;
  const ratio = (PLANCK * transitionHertz) / (BOLTZMANN * temperatureKelvin);
  return ratio > 700 ? 0 : 1 / (1 + Math.exp(ratio));
};

/**
 * de Broglie wavelength λ = h/p in metres. Educational only: the gate-level
 * simulator models information-carrying states, not wave packets in space.
 */
export const deBroglieWavelength = (momentum: number) => {
  if (!(momentum > 0)) throw new RangeError(`Momentum must be positive (got ${momentum}).`);
  return PLANCK / momentum;
};

/** Non-relativistic λ = h/(mv). */
export const deBroglieWavelengthForMass = (mass: number, velocity: number) => deBroglieWavelength(mass * Math.abs(velocity));
