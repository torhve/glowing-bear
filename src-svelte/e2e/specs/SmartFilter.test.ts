import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { reconnect } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { weechatFilter } from '../helpers/weechat-fifo';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

const FILTER_NAME = 'e2e_smf';
let MARKER = '';
// Module scope: the control line is re-checked after the reconnect re-fetch.
const control = `smf-control-${Date.now()}`;

// Regression: a WeeChat message filter (tags: "*" = any line) makes the
// server store matching lines with displayed:false — verified on 4.10.1, the
// API exposes that flag for both realtime buffer_line_added events and
// history, while the legacy relay simply never sent such lines. The client
// must skip them (isServerHiddenLine). This spec pins that on the new API
// against gbtest.
test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    // Unique per run: stale marker lines from earlier runs stay in the live
    // buffer history and would match a fixed marker.
    MARKER = `E2E-SMART-FILTER-MARKER-${Date.now()}`;
    // Idempotent: a filter left behind by an interrupted run is replaced.
    weechatFilter.remove(FILTER_NAME);
    expect(weechatFilter.add(FILTER_NAME, MARKER)).toBe(true);
    await page.waitForTimeout(500); // let WeeChat register the filter
});

test.afterAll(async () => {
    weechatFilter.remove(FILTER_NAME);
    await page.close();
});

test('smart-filtered lines are not displayed; other lines are', async () => {
    await irc.sendMessage('#glowing-bear', MARKER);
    await irc.sendMessage('#glowing-bear', control);
    // The control message proves the channel round-trip works.
    await expect(page.getByText(control, { exact: false })).toBeVisible({ timeout: 10000 });
    // The filtered marker must never have been rendered (it was sent first).
    await expect(page.getByText(MARKER, { exact: false })).toHaveCount(0);
});

test('filtered lines stay out of the view after a reconnect re-fetches history', async () => {
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    // History now contains the marker line with displayed:false — the client
    // must have skipped it while the control line round-trips normally.
    await expect(page.getByText(control, { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(MARKER, { exact: false })).toHaveCount(0);
});

test('lines matching the filter display again after it is removed', async () => {
    weechatFilter.remove(FILTER_NAME);
    await page.waitForTimeout(500);
    const marker = `${MARKER}-released`;
    await irc.sendMessage('#glowing-bear', marker);
    await expect(page.getByText(marker, { exact: false })).toBeVisible({ timeout: 10000 });
});
