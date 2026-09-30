import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'path';

// Standalone config for the E2E performance benchmarks (kept out of the
// regular E2E suite). Run with:
//   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts
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
        command: 'npm run dev',
        cwd: '../..',
        url: 'http://localhost:8001',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
