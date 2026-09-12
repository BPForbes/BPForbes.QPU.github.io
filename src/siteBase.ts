/**
 * GitHub Pages project-site prefix after the repo rename from
 * `BPForbes.github.io` to `BPForbes.QPU.github.io`.
 *
 * A user/org site (`username.github.io`) is served at `/`. A project
 * site is served at `/<repo>/`. Vite's default `base: '/'` therefore
 * emits `/assets/...` URLs that 404 on
 * https://bpforbes.github.io/BPForbes.QPU.github.io/ and leave a
 * blank page because the JS bundle never loads.
 */
export const GITHUB_PAGES_BASE = '/BPForbes.QPU.github.io/';

export const resolveAppBase = (options: {
  command: 'build' | 'serve';
  isPreview?: boolean;
}): string => (
  options.command === 'build' || options.isPreview ? GITHUB_PAGES_BASE : '/'
);
