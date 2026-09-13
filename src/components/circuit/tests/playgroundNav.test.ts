import { describe, expect, it } from 'vitest';
import { PLAYGROUND_VIEWS } from '../../PlaygroundScrubber';

describe('playground page scrubber', () => {
  it('exposes a discrete page list that a range slider can scrub', () => {
    expect(PLAYGROUND_VIEWS.length).toBeGreaterThan(3);
    expect(PLAYGROUND_VIEWS.map((view) => view.id)).toEqual([
      'builder',
      'docs',
      'qpu-docs',
      'particles',
      'module-tester',
      'files',
      'more',
    ]);
    PLAYGROUND_VIEWS.forEach((view, index) => {
      expect(view.label.length).toBeGreaterThan(0);
      expect(index).toBeGreaterThanOrEqual(0);
    });
  });
});
