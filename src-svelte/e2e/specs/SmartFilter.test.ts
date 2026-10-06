import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { reconnect } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { weechatFilter } from '../helpers/weechat-fifo';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

// Unique per run: WeeChat echoes the filter name into the core buffer, and a fixed
// name would match an earlier run's echo line.
const FILTER_NAME = `e2e_smf_${Date.now()}`;
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
    await waitForFilterChange(FILTER_NAME, 'added');
});

test.afterAll(async () => {
    weechatFilter.remove(FILTER_NAME);
    await page.close();
});

// WeeChat echoes filter changes into the core buffer (Filter "x" added / Filter "x"
// deleted). That echo is the only observable proof the server has applied the command,
// which is what the old 500 ms sleep was guessing at.
async function waitForFilterChange(name: string, verb: 'added' | 'deleted') {
    await switchToBuffer(page, 'weechat');
    await expect(page.getByText(`Filter "${name}" ${verb}`, { exact: false })).toBeVisible({ timeout: 10000 });
    await switchToBuffer(page, '#glowing-bear');
}

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
    await waitForFilterChange(FILTER_NAME, 'deleted');
    const marker = `${MARKER}-released`;
    await irc.sendMessage('#glowing-bear', marker);
    await expect(page.getByText(marker, { exact: false })).toBeVisible({ timeout: 10000 });
});
