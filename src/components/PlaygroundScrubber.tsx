export type PlaygroundViewId = 'builder' | 'docs' | 'qpu-docs' | 'files' | 'particles' | 'module-tester' | 'more';

export type PlaygroundViewOption = {
  id: PlaygroundViewId;
  label: string;
};

export const PLAYGROUND_VIEWS: PlaygroundViewOption[] = [
  { id: 'builder', label: 'Circuit builder' },
  { id: 'docs', label: 'Wiki / docs' },
  { id: 'qpu-docs', label: 'QPU docs' },
  { id: 'particles', label: 'Particles' },
  { id: 'module-tester', label: 'Correction lab' },
  { id: 'files', label: 'Files' },
  { id: 'more', label: 'More' },
];

export const PLAYGROUND_VIEW_IDS = PLAYGROUND_VIEWS.map((view) => view.id);

export const isPlaygroundViewId = (value: unknown): value is PlaygroundViewId =>
  typeof value === 'string' && PLAYGROUND_VIEW_IDS.includes(value as PlaygroundViewId);

export const playgroundPageDomId = (id: PlaygroundViewId): string => `playground-page-${id}`;

export const adjacentPlaygroundView = (current: PlaygroundViewId, delta: number): PlaygroundViewId | null => {
  const index = PLAYGROUND_VIEWS.findIndex((view) => view.id === current);
  if (index < 0) return null;
  return PLAYGROUND_VIEWS[index + delta]?.id ?? null;
};
