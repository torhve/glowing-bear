import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { getConfigValue, reconnect, sendWeechatCommand } from '../helpers/connection';

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

// All three of these sat skipped behind "requires Promise-based command response handling that
// doesn't work across Playwright's page.evaluate boundary (WS callbacks resolve inside browser but
// can't be awaited from the test runner)". Nothing has to be awaited out of the page. The client's
// copy of WeeChat's options is filled exactly once per handshake — `fetchConfValue` is called for
// buffer_time_format, nick_completer and nick_add_space during init and nowhere else
// (legacyConnection.ts:542-544) — so what a `/set` owes is a *later* handshake, and a later
// handshake is a poll on a value the test can already read.
const TIME_FORMAT_KEY = 'weechat.look.buffer_time_format';

/** Re-connect the way this file is connected: the legacy relay, which is the one that carries config. */
function reconnectLegacy(page: import('@playwright/test').Page) {
    return reconnect(page, { port: '9001', extraSettings: { protocol: 'legacy' } });
}

test('an option set over the relay is what the next handshake reads back', async () => {
    await expect(async () => {
        expect(await getConfigValue(page, TIME_FORMAT_KEY)).toBeTruthy();
    }).toPass({ timeout: 15000, intervals: [500] });

    const original = await getConfigValue(page, TIME_FORMAT_KEY);
    const changed = original === '[%H:%M:%S]' ? '[%H:%M]' : '[%H:%M:%S]';

    try {
        await sendWeechatCommand(page, `/set ${TIME_FORMAT_KEY} ${changed}`);
        await reconnectLegacy(page);

        // Not the value WeeChat was told to hold — the value this client now believes, read out of
        // the store the renderers use.
        await expect(async () => {
            expect(await getConfigValue(page, TIME_FORMAT_KEY)).toBe(changed);
        }).toPass({ timeout: 20000, intervals: [500] });
    } finally {
        // The fixture outlives this file, and this option is the timestamp format every later spec
        // draws, so it goes back whether the assertion held or not.
        await sendWeechatCommand(page, `/set ${TIME_FORMAT_KEY} ${original}`);
        await reconnectLegacy(page);
        await expect(async () => {
            expect(await getConfigValue(page, TIME_FORMAT_KEY)).toBe(original);
        }).toPass({ timeout: 20000, intervals: [500] });
    }
});

test('a refused option is refused, and the session keeps working', async () => {
    const junk = 'weechat.look.gbtest_no_such_option';

    await sendWeechatCommand(page, `/set ${junk} zzz`);

    // WeeChat answers a `/set` for an option that does not exist in the buffer it was typed into.
    // The transport is the thing to watch: one refused command is not a reason to drop a session,
    // and it is not a reason the next handshake cannot read the options that do exist.
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => await getConfigValue(page, junk)).toBeUndefined();

    await reconnectLegacy(page);
    await expect(async () => {
        expect(await getConfigValue(page, TIME_FORMAT_KEY)).toBeTruthy();
    }).toPass({ timeout: 15000, intervals: [500] });
});
