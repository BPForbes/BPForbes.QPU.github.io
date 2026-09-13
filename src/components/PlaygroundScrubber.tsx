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

export const playgroundScrubStep = (deltaY: number): -1 | 1 => (deltaY > 0 ? 1 : -1);

const overflowAllowsScroll = (value: string): boolean => value === 'auto' || value === 'scroll';

export const canElementScroll = (
  element: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
  deltaY: number,
  overflowY = 'auto',
): boolean => {
  if (!overflowAllowsScroll(overflowY)) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  return element.scrollTop > 1;
};
