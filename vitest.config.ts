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
    },
  },
  test: {
    globals: true,
    include: ['src-svelte/test/unit/**/*.test.ts'],
    environment: 'jsdom',
    css: true,
  },
});
