import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Vitest uses svelte() plugin directly (not sveltekit()), so it doesn't
// inherit aliases from svelte.config.js — must define them here.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $components: path.resolve('./src/components'),
    },
  },
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    environment: 'jsdom',
  },
});
