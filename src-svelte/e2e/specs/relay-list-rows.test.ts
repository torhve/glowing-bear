import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForRowCountAtLeast } from '../helpers/waits';

/**
 * Regression guard for issue #11: relay.list rendered empty.
 *
 * `relay.list` is a free buffer (WeeChat bufferType 1) that WeeChat fills itself
 * and re-renders on every relay client connect or disconnect. Its rows predate
 * this connection, so the only thing that can put them on screen is the initial
 * newest-window request — which the free-buffer history rule used to refuse
 * outright, leaving the buffer blank until a client happened to connect while
 * you were watching.
 *
 * Both transports are covered because both answer a line request for this buffer
 * Both transports are covered because both answer a line request for this buffer:
 * `GET /api/buffers/<id>/lines?lines=-100` returns its whole current window
 * (api-dossier: `probes/probe-free-buffer-window.mjs`), and the legacy relay's
 * `own_lines/last_line(-N)/data` answers with the same rows. gbtest runs the API
 * relay on 9010 and the legacy relay on 9001.
 */

const RELAY_LIST = 'relay.list';

/** Text of every row that is not blank — relay.list carries blank separator rows. */
async function nonEmptyRowTexts(page: import('@playwright/test').Page) {
    const rows = page.locator('[data-testid="bufferline-row"]');
    const total = await rows.count();
    const texts: string[] = [];
    for (let i = 0; i < total; i++) {
        const text = (await rows.nth(i).innerText()).trim();
        if (text) texts.push(text);
    }
    return texts;
}

async function openRelayList(page: import('@playwright/test').Page) {
    await waitForBuffer(page, RELAY_LIST, 15000);
    await switchToBuffer(page, RELAY_LIST);

    // The rows are already in WeeChat's buffer before this connection asks for
    // them, so opening the buffer is the whole user action.
    await waitForRowCountAtLeast(page, 1);

    // Not merely placeholder rows for an empty transcript: relay.list always
    // carries WeeChat's own status text (api-dossier: its window opens with the
    // "Actions (letter+enter):" header and lists every client WeeChat has seen).
    const texts = await nonEmptyRowTexts(page);
    expect(texts.length, 'a free buffer that already had rows must show them').toBeGreaterThan(0);

    // A free buffer has nothing older than this window, so it must not offer
    // paging.
    await expect(page.getByText('Fetch more lines')).not.toBeVisible({ timeout: 5000 });

    return texts;
}

test.describe.configure({ mode: 'serial' });
test.describe('relay.list rows (issue #11)', () => {
    test('the API transport renders relay.list', async ({ browser }) => {
        const page = await createConnectedPage(browser, { port: '9010' });
        await waitForTransport(page, 'api');

        const texts = await openRelayList(page);

        // Re-opening must still show the window. No duplicate-window assertion
        // here: relay.list is WeeChat's own status log and legitimately repeats
        // text, so row text cannot prove anything about it. The deterministic
        // duplicate guard lives in FreeBufferPaging.test.ts, on planted rows.
        await switchToBuffer(page, '#glowing-bear');
        await switchToBuffer(page, RELAY_LIST);
        await waitForRowCountAtLeast(page, 1);
        const after = await nonEmptyRowTexts(page);
        expect(after.length, 'the window must survive a re-open').toBeGreaterThanOrEqual(texts.length);

        await page.close();
    });

    test('the legacy transport renders relay.list', async ({ browser }) => {
        const page = await createConnectedPage(browser, {
            port: '9001',
            settings: { protocol: 'legacy' },
        });
        await waitForTransport(page, 'legacy');

        await openRelayList(page);

        await page.close();
    });
});
