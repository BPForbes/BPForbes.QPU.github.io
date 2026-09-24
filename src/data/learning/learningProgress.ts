/**
 * Optional learner-controlled checkpoint progress for the six-step path.
 *
 * Progress is never inferred from running a circuit — the learner marks each
 * step manually. Nothing is gated; jump to any step at any time.
 */
export type LearningProgress = {
  completedSteps: number[];
};

const STORAGE_KEY = 'qpu-learning-progress-v1';

const emptyProgress = (): LearningProgress => ({ completedSteps: [] });

export const readLearningProgress = (): LearningProgress => {
  try {
    if (typeof localStorage === 'undefined') return emptyProgress();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProgress();
    const parsed = JSON.parse(raw) as LearningProgress;
    if (!Array.isArray(parsed.completedSteps)) return emptyProgress();
    return {
      completedSteps: parsed.completedSteps
        .filter((step) => Number.isInteger(step) && step >= 1 && step <= 6)
        .map(Number),
    };
  } catch {
    return emptyProgress();
  }
};

export const writeLearningProgress = (progress: LearningProgress) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      completedSteps: [...new Set(progress.completedSteps)].sort((a, b) => a - b),
    }));
  } catch {
    // Progress is optional; skip persistence when storage is blocked or full.
  }
};

export const toggleLearningStep = (step: number, completed: boolean): LearningProgress => {
  const current = readLearningProgress();
  const completedSteps = completed
    ? [...new Set([...current.completedSteps, step])]
    : current.completedSteps.filter((entry) => entry !== step);
  const next = { completedSteps: completedSteps.sort((a, b) => a - b) };
  writeLearningProgress(next);
  return next;
};

export const suggestNextLearningStep = (progress: LearningProgress): number | null => {
  for (let step = 1; step <= 6; step += 1) {
    if (!progress.completedSteps.includes(step)) return step;
  }
  return null;
};
