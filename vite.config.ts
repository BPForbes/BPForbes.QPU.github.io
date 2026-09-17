/**
 * Vite/Vitest configuration for the React QPU application.
 *
 * The WebLLM package is excluded from dependency pre-bundling because it is
 * loaded dynamically only when browser-based correction assistance is used.
 *
 * Production builds use the GitHub Pages project-site prefix so asset URLs
 * resolve under /BPForbes.QPU.github.io/ instead of the domain root.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { resolveAppBase } from './src/siteBase';

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  base: resolveAppBase({ command, isPreview }),
  optimizeDeps: {
    exclude: ['@mlc-ai/web-llm'],
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 60_000,
  },
}));
