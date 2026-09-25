/**
 * Physical constants (exact 2019 SI values) and the simulator's time units.
 *
 * Simulation frequencies are cycles per simulator time unit, so with the default
 * nanosecond time unit a frequency of 5 means 5 GHz and ω = 2πf is in rad/ns.
 * The Hamiltonians use ħ = 1 in those units, matching physics.evolve().
 * SI (J, Hz, K, m) appears only in the Planck–Einstein and thermal helpers.
 */
export const PLANCK = 6.62607015e-34; // J·s
export const HBAR = PLANCK / (2 * Math.PI); // J·s
export const BOLTZMANN = 1.380649e-23; // J/K
export const SPEED_OF_LIGHT = 299_792_458; // m/s
export const ELECTRON_VOLT = 1.602176634e-19; // J
export const ELECTRON_MASS = 9.1093837015e-31; // kg

export type PhysicalUnits = {
  /** Length of one simulator time unit in seconds (1e-9: durations in ns, frequencies in GHz). */
  timeUnitSeconds: number;
};

export const DEFAULT_UNITS: PhysicalUnits = { timeUnitSeconds: 1e-9 };

/** Simulator frequency (cycles per time unit) → Hz. */
export const toHertz = (frequency: number, units: PhysicalUnits = DEFAULT_UNITS) => frequency / units.timeUnitSeconds;

/** Hz → simulator frequency (cycles per time unit). */
export const fromHertz = (hertz: number, units: PhysicalUnits = DEFAULT_UNITS) => hertz * units.timeUnitSeconds;

/** ω = 2πf, in radians per the same time unit as f. */
export const angularFrequency = (frequency: number) => 2 * Math.PI * frequency;
