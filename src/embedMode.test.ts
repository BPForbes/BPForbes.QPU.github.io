import { describe, expect, it, vi } from 'vitest';
import {
  EMBED_MESSAGE_SOURCE,
  announceGuestReady,
  applyEmbedClass,
  detectFramedWindow,
  readEmbedFlag,
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
    expect(top.postMessage).toHaveBeenCalledWith(
      { source: EMBED_MESSAGE_SOURCE, type: 'ready' },
      '*',
    );

    const standalone = { postMessage: vi.fn() } as unknown as Window & { parent: Window; self: Window };
    standalone.parent = standalone;
    standalone.self = standalone;
    announceGuestReady(standalone);
    expect(standalone.postMessage).not.toHaveBeenCalled();
  });
});
