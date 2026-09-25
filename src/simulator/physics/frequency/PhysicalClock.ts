/**
 * Accumulated physical time. The simulator engine decides when an operation
 * happens and how long it lasts (PhysicalTimingModel); the clock records the
 * elapsed time that coherent evolution and decoherence both use. Logical
 * cycles (INCREASECYCLE) never advance it.
 */
export type PhysicalClock = {
  /** Elapsed physical time in simulator time units. */
  elapsedTime: number;
};

export const startClock = (elapsedTime = 0): PhysicalClock => {
  if (!Number.isFinite(elapsedTime) || elapsedTime < 0) throw new RangeError(`Invalid start time ${elapsedTime}.`);
  return { elapsedTime };
};

export const advanceClock = (clock: PhysicalClock, duration: number): PhysicalClock => {
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`Duration must be non-negative (got ${duration}).`);
  return { elapsedTime: clock.elapsedTime + duration };
};
