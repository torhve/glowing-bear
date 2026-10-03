import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Vitest uses svelte() plugin directly (not sveltekit()). `#lib` and `#components`
// resolve through package.json "imports", so no path aliases are needed here.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // jsdom component tests need Svelte's DOM runtime rather than its SSR exports.
    conditions: ['browser'],
    alias: {
      '@tauri-apps/plugin-notification': path.resolve('./src-svelte/test/unit/mocks/tauri-plugin-notification.ts'),
      '$app/paths': path.resolve('./src-svelte/test/unit/mocks/app-paths.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src-svelte/test/unit/**/*.test.ts'],
    environment: 'jsdom',
    // Vitest built a fresh jsdom for each of the 49 test files — 21s of a 5.3s run.
    // vmThreads reuses one jsdom per worker while still isolating each file's module
    // graph; `isolate: false` is faster again but leaks vi.mock() between files.
    pool: 'vmThreads',
    css: true,
  },
});
