import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'path';

/**
 * E2E performance benchmark against the PRODUCTION build.
 *
 * The regular bench config runs against `vite dev`, which measures Svelte's
 * development-mode instrumentation as a large share of the flood — a CPU profile
 * of the dev-server flood put `get_stack` + `get_error` (dev-mode stack capture)
 * at ~46% of total samples. That number says nothing about what a user
 * experiences. This config builds the static site and serves it with
 * `vite preview`, so the arm measures the shipped app.
 *
 * Run with:
 *   npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    testDir: './bench',
    testMatch: ['**/*.bench.ts'],
    fullyParallel: false,
    workers: 1,
    timeout: 300000,
    expect: {
        timeout: 10000,
    },
    globalSetup: path.join(__dirname, 'global-setup.ts'),
    globalTeardown: path.join(__dirname, 'global-teardown.ts'),
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:8001',
        trace: 'off',
        screenshot: 'off',
        video: 'off',
        actionTimeout: 2000,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        // The arm script builds before invoking Playwright; preview only serves.
        command: 'npx vite preview --port 8001 --strictPort',
        cwd: '../..',
        url: 'http://localhost:8001',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
