import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { expectInputFocused } from '../helpers/input';
import { waitForRowCountAtLeast } from '../helpers/waits';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    // Leave the shared gbtest state as it started: the free buffer was only for
    // this spec.
    await page.close();
});

/**
 * Type a command in the input bar and press Enter to send it to WeeChat.
 */
async function typeCommand(cmd: string) {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await input.fill(cmd);
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
}

// WeeChat names an /exec buffer "exec.<name>", so the short name the app shows
// is prefixed — the `-name` value alone never appears in the buffer list.
const EXEC_NAME = 'gbtest-free-history';
const SHORT_NAME = 'exec.gbtest-free-history';

test('a free buffer shows its rows without a fetch-more affordance', async () => {
    // A free buffer (/exec -nf) has live-only rows: there is no older history.
    await typeCommand(`/exec -nf -name ${EXEC_NAME} echo free-row-1`);
    // Stop the timer so the row set stays stable while we assert on it.
    await typeCommand(`/exec -stop ${EXEC_NAME}`);

    await waitForBuffer(page, SHORT_NAME, 15000);
    await switchToBuffer(page, SHORT_NAME);

    // The exec output and its “end of command” line arrive as separate relay events,
    // so the row set is not complete the moment the buffer opens.
    await waitForRowCountAtLeast(page, 2);

    const rowCount = await page.locator('[data-testid="bufferline-row"]').count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // The "Fetch more lines" affordance must not appear for a free buffer.
    await expect(page.getByText('Fetch more lines')).not.toBeVisible({ timeout: 5000 });
});

test('switching away and back adds no duplicate rows to a free buffer', async () => {
    await switchToBuffer(page, SHORT_NAME);
    const before = await page.locator('[data-testid="bufferline-row"]').count();
    expect(before).toBeGreaterThanOrEqual(1);

    await switchToBuffer(page, '#glowing-bear');
    await switchToBuffer(page, SHORT_NAME);

    const after = await page.locator('[data-testid="bufferline-row"]').count();
    expect(after).toBe(before);

    // Leave the shared gbtest state as it started.
    await typeCommand(`/buffer close ${SHORT_NAME}`);
});
