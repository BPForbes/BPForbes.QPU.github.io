/**
 * Session storage for registered custom gates. Kept free of compiler imports
 * so the compiler can recognise custom gate opcodes without an import cycle.
 */
export type CustomGateRecord = {
  id: string;
  label: string;
  color: string;
  source: string;
  processName: string;
  librarySources: Record<string, string>;
  inputParamNames: string[];
  outputParamNames: string[];
  createdAt: string;
  /** True only when the gate passes all four checks in customGateReversibility.ts. */
  reversible: boolean;
  /** Why the gate failed the check, when it did. */
  reversibilityIssue?: string;
  /** Rules version `reversible` was computed under; older records are re-checked on load. */
  reversibilityCheckVersion?: number;
};

const STORAGE_KEY = 'qpu-custom-gates-v1';

// Custom gates are session-scoped so experiments survive reloads without becoming bundled catalog metadata.
export const readStore = (): CustomGateRecord[] => {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomGateRecord[];
    return Array.isArray(parsed)
      ? parsed.map((record) => ({
          ...record,
          reversible: record.reversible ?? false,
        }))
      : [];
  } catch {
    return [];
  }
};

export const writeStore = (records: CustomGateRecord[]) => {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
};

export const listCustomGateRecords = () => readStore();

export const getCustomGateRecord = (id: string) =>
  readStore().find((record) => record.id.toLowerCase() === id.toLowerCase());

export const removeCustomGateRecord = (id: string) => {
  const next = readStore().filter((record) => record.id.toLowerCase() !== id.toLowerCase());
  writeStore(next);
  return next;
};
