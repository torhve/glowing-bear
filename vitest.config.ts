import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Vitest uses svelte() plugin directly (not sveltekit()), so it doesn't
// inherit the $lib/$components aliases declared in vite.config.ts — define them here.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // jsdom component tests need Svelte's DOM runtime rather than its SSR exports.
    conditions: ['browser'],
    alias: {
      $lib: path.resolve('./src-svelte/src/lib'),
      $components: path.resolve('./src-svelte/src/components'),
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
