import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { getConfigValue, setSettings, sendWeechatCommand } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await setSettings(page, { autoconnect: false });
    setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});

test('should have wconfig populated after connect', async () => {
    // Config fetches happen asynchronously after connect — poll until populated
    await expect(async () => {
        const val = await getConfigValue(page, 'weechat.look.buffer_time_format');
        expect(val).toBeTruthy();
        expect(val.length).toBeGreaterThan(0);
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
