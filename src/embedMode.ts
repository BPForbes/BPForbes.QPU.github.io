/**
 * Detect when the workbench is running as a guest inside another page.
 *
 * The portfolio lab window loads this app in an iframe with `?embed=1`.
 * Cross-origin frames also trip the framed-window check, so a forgotten
 * query string still gets the compact chrome.
 */
export const EMBED_MESSAGE_SOURCE = 'qpu-guest';

export const readEmbedFlag = (search: string): boolean => {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('embed');
  return value === '1' || value === 'true';
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

export const announceGuestReady = (win: Window = window): void => {
  if (win.parent === win.self) {
    return;
  }

  win.parent.postMessage({ source: EMBED_MESSAGE_SOURCE, type: 'ready' }, '*');
};
