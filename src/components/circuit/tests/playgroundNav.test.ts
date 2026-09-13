import { describe, expect, it } from 'vitest';
import {
  adjacentPlaygroundView,
  canElementScroll,
  isPlaygroundViewId,
  playgroundPageDomId,
  playgroundScrubStep,
  PLAYGROUND_VIEWS,
} from '../../PlaygroundScrubber';

describe('playground pages', () => {
  it('exposes a discrete page list for hamburger jumps and vertical scrubbing', () => {
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
    PLAYGROUND_VIEWS.forEach((view) => {
      expect(view.label.length).toBeGreaterThan(0);
      expect(isPlaygroundViewId(view.id)).toBe(true);
      expect(playgroundPageDomId(view.id)).toBe(`playground-page-${view.id}`);
    });
    expect(isPlaygroundViewId('builder')).toBe(true);
    expect(isPlaygroundViewId('embed')).toBe(false);
    expect(adjacentPlaygroundView('builder', 1)).toBe('docs');
    expect(adjacentPlaygroundView('docs', -1)).toBe('builder');
    expect(adjacentPlaygroundView('builder', -1)).toBeNull();
    expect(adjacentPlaygroundView('more', 1)).toBeNull();
  });

  it('treats vertical wheel or finger movement as a page step only when the lane cannot scroll further', () => {
    expect(playgroundScrubStep(80)).toBe(1);
    expect(playgroundScrubStep(-40)).toBe(-1);
    expect(canElementScroll({ clientHeight: 400, scrollHeight: 400, scrollTop: 0 }, 50)).toBe(false);
    expect(canElementScroll({ clientHeight: 400, scrollHeight: 900, scrollTop: 0 }, 50)).toBe(true);
    expect(canElementScroll({ clientHeight: 400, scrollHeight: 900, scrollTop: 500 }, 50)).toBe(false);
    expect(canElementScroll({ clientHeight: 400, scrollHeight: 900, scrollTop: 0 }, -50)).toBe(false);
    expect(canElementScroll({ clientHeight: 400, scrollHeight: 900, scrollTop: 0 }, 50, 'visible')).toBe(false);
  });
});
