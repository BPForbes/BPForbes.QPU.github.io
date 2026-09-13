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

type PlaygroundScrubberProps = {
  activeView: PlaygroundViewId;
  onSelect: (view: PlaygroundViewId) => void;
  variant?: 'bar' | 'menu';
};

export function PlaygroundScrubber({ activeView, onSelect, variant = 'bar' }: PlaygroundScrubberProps) {
  const index = Math.max(0, PLAYGROUND_VIEWS.findIndex((view) => view.id === activeView));

  return (
    <div className={`playground-scrubber playground-scrubber-${variant}`}>
      <div aria-label="Playground pages" className="playground-scrub-track" role="tablist">
        {PLAYGROUND_VIEWS.map((view) => (
          <button
            aria-selected={view.id === activeView}
            className={view.id === activeView ? 'active' : ''}
            key={view.id}
            onClick={() => onSelect(view.id)}
            role="tab"
            type="button"
          >
            {view.label}
          </button>
        ))}
      </div>
      <label className="playground-scrub-slider">
        <span>Scrub pages</span>
        <input
          aria-label="Scrub playground pages"
          aria-valuemax={PLAYGROUND_VIEWS.length}
          aria-valuemin={1}
          aria-valuenow={index + 1}
          aria-valuetext={PLAYGROUND_VIEWS[index]?.label}
          max={PLAYGROUND_VIEWS.length - 1}
          min={0}
          onChange={(event) => {
            const next = PLAYGROUND_VIEWS[Number(event.target.value)];
            if (next) onSelect(next.id);
          }}
          step={1}
          type="range"
          value={index}
        />
      </label>
    </div>
  );
}
