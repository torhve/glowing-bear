import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Specs that never send channel messages and never assert channel-derived
// content (message rows, nicks, unread badges). They only exercise UI chrome,
// per-context settings, and connection lifecycle in their own browser context,
// so they can run concurrently with each other in a separate parallel pass.
// Everything else shares the live gbtest #glowing-bear state and must stay
// serial (workers=1) to avoid cross-test contamination.
const UI_ONLY_SPECS = [
    'App-layout',
    'AutoconnectSpam',
    'ChatView-mobileSwipe',
    'Connection-form',
    'ConnectionForm-password',
    'DisconnectReconnect',
    'ErrorPage-unmatchedRoute',
    'Hash-params',
    'HashAlgorithmMismatch',
    'InputBar-emojify',
    'InputBar-formatting',
    'InputBar-paste',
    'InputBar-typeToFocus',
    'KeyboardShortcuts',
    'ModalAutoFocus',
    'Nicklist-mobileSwipe',
    'Nicklist-mutuallyExclusive',
    'ReconnectLoopGuard',
    'SettingsModal-customCSS',
    'SettingsModal-fonts',
    'SettingsModal-themes',
    'Toast',
].map((name) => `**/${name}.test.ts`);
export default defineConfig({
    testDir: './specs',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    globalSetup: path.join(__dirname, 'global-setup.ts'),
    globalTeardown: path.join(__dirname, 'global-teardown.ts'),
    reporter: [
        ['html', { outputFolder: process.env.E2E_HTML_REPORT || '../../playwright-report' }],
        ['list'],
    ],
    use: {
        baseURL: 'http://localhost:8001',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'off',
        actionTimeout: 2000,
    },
    projects: [
        {
            // Channel-state-dependent specs: mutually exclusive, run serially
            // (config workers: 1) against the shared gbtest environment.
            name: 'chromium',
            testIgnore: UI_ONLY_SPECS,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            // UI-only specs: run in a second pass with --workers=4 (see the
            // test:e2e npm scripts); fullyParallel is safe because these
            // specs neither mutate nor assert shared WeeChat channel state.
            name: 'chromium-ui',
            testMatch: UI_ONLY_SPECS,
            fullyParallel: true,
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
