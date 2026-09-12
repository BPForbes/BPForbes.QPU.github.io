import { describe, expect, it } from 'vitest';
import { GITHUB_PAGES_BASE, resolveAppBase } from './siteBase';

describe('siteBase', () => {
  it('uses the renamed GitHub Pages project path for production builds', () => {
    expect(GITHUB_PAGES_BASE).toBe('/BPForbes.QPU.github.io/');
    expect(resolveAppBase({ command: 'build' })).toBe(GITHUB_PAGES_BASE);
    expect(resolveAppBase({ command: 'serve', isPreview: true })).toBe(GITHUB_PAGES_BASE);
  });

  it('keeps the local Vite/Vitest server on the site root', () => {
    expect(resolveAppBase({ command: 'serve' })).toBe('/');
    expect(resolveAppBase({ command: 'serve', isPreview: false })).toBe('/');
  });
});
