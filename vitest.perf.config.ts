import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Dedicated config for performance benchmarks (kept out of `npm test` so the
// regular suite stays fast and quiet). Run with:
//   npx vitest run --config vitest.perf.config.ts
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve('./src-svelte/src/lib'),
      $components: path.resolve('./src-svelte/src/components'),
      '@tauri-apps/plugin-notification': path.resolve('./src-svelte/test/unit/mocks/tauri-plugin-notification.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src-svelte/test/unit/perf/**/*.bench.ts'],
    environment: 'jsdom',
    testTimeout: 120000,
  },
});
