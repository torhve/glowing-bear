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
    'ConnectionForm-clockSkew',
    'ConnectionForm-password',
    'DisconnectReconnect',
    'ErrorPage-unmatchedRoute',
    'Hash-params',
    'HashAlgorithmMismatch',
    'InputBar-emojify',
    'InputBar-formatting',
    'InputBar-paste',
    'InputBar-typeToFocus',
    'InputBar-conversationDrafts',
    'KeyboardShortcuts',
    'ModalAutoFocus',
    'Nicklist-mobileSwipe',
    'Nicklist-mutuallyExclusive',
    'ReconnectLoopGuard',
    'SettingsModal-customCSS',
    'SettingsModal-fonts',
    'SettingsModal-themes',
    'Toast',
    'TopBar-bufferListToggle',
].map((name) => `**/${name}.test.ts`);

// The specs whose behaviour depends on engine reflow timing: multi-frame re-wrap,
// delayed media growth, and a pin sequence that has to settle instead of chasing
// the scrollbar. WebKit is the engine those safeguards were written for, so it
// gets its own narrow pass over exactly this set rather than the whole suite.
// It is opt-in because these specs mutate the shared gbtest channel: running
// them in the same pass as the serial chromium project would let two engines
// write the same #glowing-bear state.
// Caret and selection restoration is engine-sensitive: writing a textarea's value
// moves its caret to the end, so restoring a selection has to happen after the
// render that wrote the text. WebKit is the engine where that ordering is worth
// re-checking. It sends no channel messages, so it is safe beside the scroll set.
const SELECTION_SENSITIVE_SPECS = [
    'InputBar-conversationDrafts',
].map((name) => `**/${name}.test.ts`);

const SCROLL_REGRESSION_SPECS = [
    'ChatView-scroll',
    'ChatView-scrollOwnership',
    'ChatView-cappedBufferFollow',
    'ChatView-long-line-scroll',
    'ChatView-long-line-type-scroll',
    'ChatView-scrollFetch',
    'KeyboardShortcuts-pageup-pagedown',
    'ReadMarker-scrollOnPost',
    'PluginEmbed',
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
        ...(process.env.GB_WEBKIT
            ? [{
                // Opt-in only (npm run test:e2e:webkit). Serial, because these
                // specs share the live gbtest channel just like the chromium pass.
                name: 'webkit',
                testMatch: [...SCROLL_REGRESSION_SPECS, ...SELECTION_SENSITIVE_SPECS],
                fullyParallel: false,
                use: { ...devices['Desktop Safari'] },
            }]
            : []),
    ],
    webServer: {
        command: 'npm run dev',
        cwd: '../..',
        url: 'http://localhost:8001',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
