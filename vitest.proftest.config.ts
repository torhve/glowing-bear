import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Config for the *profiling* workloads (src-svelte/test/unit/prof/).
// Separate from vitest.perf.config.ts so the measured benchmarks stay untouched.
//   NODE_OPTIONS=--cpu-prof npx vitest run --config vitest.proftest.config.ts
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
        include: ['src-svelte/test/unit/prof/**/*.bench.ts'],
        environment: 'jsdom',
        testTimeout: 300000,
    },
});
