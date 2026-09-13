/**
 * Detect when the workbench is running as a guest inside another page.
 *
 * The portfolio lab window loads this app in an iframe with `?embed=1`
 * from https://bpforbes.github.io/BPForbes.QPU.github.io/?embed=1.
 * Cross-origin frames also trip the framed-window check, so a forgotten
 * query string still gets the compact chrome.
 */
import { isPlaygroundViewId, PLAYGROUND_VIEWS, type PlaygroundViewId } from './components/PlaygroundScrubber';

export const EMBED_MESSAGE_SOURCE = 'qpu-guest';
export const HOST_MESSAGE_SOURCE = 'qpu-host';

export const GUEST_FEATURES = [
  'circuit-diagram',
  'play-sequence',
  'page-scrub',
  'run-all',
] as const;

export type GuestFeature = (typeof GUEST_FEATURES)[number];

export type GuestReadyPayload = {
  source: typeof EMBED_MESSAGE_SOURCE;
  type: 'ready';
  view: PlaygroundViewId;
  views: typeof PLAYGROUND_VIEWS;
  features: readonly GuestFeature[];
};

export type HostSetViewMessage = {
  source: typeof HOST_MESSAGE_SOURCE;
  type: 'setView';
  view: PlaygroundViewId;
};

const searchParams = (search: string): URLSearchParams =>
  new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

export const readEmbedFlag = (search: string): boolean => {
  const value = searchParams(search).get('embed');
  return value === '1' || value === 'true';
};

export const readViewParam = (search: string): PlaygroundViewId | null => {
  const params = searchParams(search);
  const value = params.get('view') ?? params.get('page');
  return isPlaygroundViewId(value) ? value : null;
};

export const writeViewParam = (search: string, view: PlaygroundViewId): string => {
  const params = searchParams(search);
  params.set('view', view);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
};

export const replaceViewInLocation = (
  loc: Pick<Location, 'href' | 'search'>,
  view: PlaygroundViewId,
  historyApi: Pick<History, 'replaceState'> = history,
): string => {
  const next = new URL(loc.href);
  next.search = writeViewParam(loc.search, view);
  const href = `${next.pathname}${next.search}${next.hash}`;
  historyApi.replaceState(null, '', href);
  return href;
};

export const detectFramedWindow = (win: Pick<Window, 'self' | 'top'>): boolean => {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
};

export const isEmbedMode = (win: Window = window): boolean => (
  readEmbedFlag(win.location.search) || detectFramedWindow(win)
);

export const applyEmbedClass = (doc: Document = document, win: Window = window): boolean => {
  const embed = isEmbedMode(win);
  doc.documentElement.classList.toggle('embed-mode', embed);
  return embed;
};

export const guestReadyPayload = (view: PlaygroundViewId): GuestReadyPayload => ({
  source: EMBED_MESSAGE_SOURCE,
  type: 'ready',
  view,
  views: PLAYGROUND_VIEWS,
  features: GUEST_FEATURES,
});

export const announceGuestReady = (win: Window = window, view: PlaygroundViewId = 'builder'): void => {
  if (win.parent === win.self) {
    return;
  }

  win.parent.postMessage(guestReadyPayload(view), '*');
};

export const isHostSetViewMessage = (data: unknown): data is HostSetViewMessage => {
  if (typeof data !== 'object' || data === null) return false;
  if (!('source' in data) || !('type' in data) || !('view' in data)) return false;
  return data.source === HOST_MESSAGE_SOURCE && data.type === 'setView' && isPlaygroundViewId(data.view);
};
