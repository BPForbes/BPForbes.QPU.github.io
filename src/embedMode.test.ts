import { describe, expect, it, vi } from 'vitest';
import { PLAYGROUND_VIEWS } from './components/PlaygroundScrubber';
import {
  EMBED_MESSAGE_SOURCE,
  GUEST_FEATURES,
  HOST_MESSAGE_SOURCE,
  announceGuestReady,
  applyEmbedClass,
  detectFramedWindow,
  guestReadyPayload,
  isHostSetViewMessage,
  readEmbedFlag,
  readViewLocation,
  readViewParam,
  pushViewInLocation,
  replaceViewInLocation,
  writeViewParam,
} from './embedMode';

describe('embedMode', () => {
  it('treats embed=1 and embed=true as guest launches', () => {
    expect(readEmbedFlag('?embed=1')).toBe(true);
    expect(readEmbedFlag('embed=true')).toBe(true);
    expect(readEmbedFlag('?view=builder')).toBe(false);
    expect(readEmbedFlag('')).toBe(false);
  });

  it('detects a framed window and treats cross-origin access errors as framed', () => {
    const framed = { self: {} as Window, top: {} as Window };
    expect(detectFramedWindow(framed)).toBe(true);

    const top = {} as Window;
    expect(detectFramedWindow({ self: top, top })).toBe(false);

    const blocked = {
      self: {} as Window,
      get top(): Window {
        throw new Error('blocked');
      },
    };
    expect(detectFramedWindow(blocked)).toBe(true);
  });

  it('toggles the document embed class from the current window', () => {
    const doc = { documentElement: { classList: { toggle: vi.fn() } } };
    const win = {
      location: { search: '?embed=1' },
      self: {} as Window,
      top: {} as Window,
    };

    expect(applyEmbedClass(doc as unknown as Document, win as unknown as Window)).toBe(true);
    expect(doc.documentElement.classList.toggle).toHaveBeenCalledWith('embed-mode', true);
  });

  it('announces readiness only to a parent frame', () => {
    const top = { postMessage: vi.fn() };
    const child = { self: {}, parent: top, postMessage: vi.fn() };
    announceGuestReady(child as unknown as Window);
    expect(top.postMessage).toHaveBeenCalledWith(guestReadyPayload('builder'), '*');

    const standalone = { postMessage: vi.fn() } as unknown as Window & { parent: Window; self: Window };
    standalone.parent = standalone;
    standalone.self = standalone;
    announceGuestReady(standalone);
    expect(standalone.postMessage).not.toHaveBeenCalled();
  });

  it('reads playground views from the Pages embed URL without dropping embed=1', () => {
    expect(readViewParam('?embed=1')).toBeNull();
    expect(readViewParam('?embed=1&view=particles')).toBe('particles');
    expect(readViewParam('view=module-tester')).toBe('module-tester');
    expect(readViewParam('?embed=1&view=not-a-page')).toBeNull();
    expect(writeViewParam('?embed=1', 'docs')).toBe('?embed=1&view=docs');
    expect(writeViewParam('?embed=true&view=builder', 'files')).toBe('?embed=true&view=files');
  });

  it('uses GitHub Pages-safe hash routes without dropping embed mode', () => {
    const replaceState = vi.fn();
    const href = replaceViewInLocation(
      { href: 'https://bpforbes.github.io/BPForbes.QPU.github.io/?embed=1', search: '?embed=1' },
      'qpu-docs',
      { replaceState },
    );
    expect(href).toBe('/BPForbes.QPU.github.io/?embed=1#/qpu-docs');
    expect(replaceState).toHaveBeenCalledWith(null, '', href);

    const pushState = vi.fn();
    const pushedHref = pushViewInLocation(
      { href: 'https://bpforbes.github.io/BPForbes.QPU.github.io/?view=docs', search: '?view=docs' },
      'module-tester',
      { pushState },
    );
    expect(pushedHref).toBe('/BPForbes.QPU.github.io/#/correction-lab');
    expect(pushState).toHaveBeenCalledWith(null, '', pushedHref);
    expect(readViewLocation({ hash: '#/correction-lab', search: '' })).toBe('module-tester');
    expect(readViewLocation({ hash: '', search: '?view=particles' })).toBe('particles');
  });

  it('advertises playground pages and lab features to the portfolio host', () => {
    const payload = guestReadyPayload('builder');
    expect(payload.source).toBe(EMBED_MESSAGE_SOURCE);
    expect(payload.views).toEqual(PLAYGROUND_VIEWS);
    expect(payload.features).toEqual(GUEST_FEATURES);
    expect(payload.features).toEqual(expect.arrayContaining(['circuit-diagram', 'play-sequence', 'run-all']));
    expect(payload.features).not.toContain('page-scrub');
  });

  it('accepts setView commands from the portfolio host', () => {
    expect(isHostSetViewMessage({ source: HOST_MESSAGE_SOURCE, type: 'setView', view: 'particles' })).toBe(true);
    expect(isHostSetViewMessage({ source: EMBED_MESSAGE_SOURCE, type: 'setView', view: 'particles' })).toBe(false);
    expect(isHostSetViewMessage({ source: HOST_MESSAGE_SOURCE, type: 'setView', view: 'nope' })).toBe(false);
  });
});
