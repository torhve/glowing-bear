import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { getConfigValue, setSettings } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

// Config values reach the client only through the legacy handshake's config
// blob — the API relay (until WeeChat 5.0's /api/options) has no config
// endpoint. This spec therefore runs on the legacy relay (port 9001).
test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        port: '9001',
        settings: { protocol: 'legacy', autoconnect: false },
    });
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

test('should have wconfig populated after connect', async () => {
    // Config fetches happen asynchronously after connect — poll until populated
    await expect(async () => {
        const val = await getConfigValue(page, 'weechat.look.buffer_time_format');
        expect(val).toBeTruthy();
        expect(val.length).toBeGreaterThan(0);
    }).toPass({ timeout: 10000, intervals: [500] });
});

test('should have completion config available for client-side nick completion', async () => {
    // completeNick reads these; the legacy transport must deliver them.
    await expect(async () => {
        const completer = await getConfigValue(page, 'weechat.completion.nick_completer');
        expect(completer).toBeTruthy();
    }).toPass({ timeout: 10000, intervals: [500] });
});

// Skipped: requires Promise-based command response handling that doesn't work
// across Playwright's page.evaluate boundary (WS callbacks resolve inside browser
// but can't be awaited from the test runner). Needs architecture change: expose
// fetchConfValue results via window-level flags or use REST API polling.
test.skip('should set a weechat option via relay and reflect in wconfig', async () => {
});

// Skipped: same reason as above, plus flaky disconnect/reconnect behavior
test.skip('should persist setting across reconnect', async () => {
});

// Skipped: same reason as above — need to verify error handling on invalid /set
test.skip('should handle invalid option gracefully', async () => {
});
