import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { expectInputFocused } from '../helpers/input';
import { waitForRowCountAtLeast } from '../helpers/waits';

/**
 * A free buffer is an ordinary buffer for history: a wider newest-N window
 * delivers more of its content (api-dossier `probes/probe-free-buffer-depth.mjs`
 * — a 501-row `/exec` buffer answers `lines=-40` with 40 rows and `lines=-1000`
 * with all 501). So a deep free buffer must page upward like a channel, and a
 * page must never deliver a row twice.
 *
 * The planted rows are `seq 1 300`, whose WeeChat rendering is `N. N` — unique,
 * ordered text that can only come from this probe, so it doubles as the
 * duplicate detector that relay.list (WeeChat's own churny status log) cannot
 * serve.
 */

const EXEC_NAME = 'gbtest-deep';
const SHORT_NAME = `exec.${EXEC_NAME}`;
const ROW_TOTAL = 300;

let page: import('@playwright/test').Page;

async function typeCommand(cmd: string) {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await input.fill(cmd);
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
}

/** The number carried by a `N. N` row; the time cell can lead the row text. */
async function rowNumbers(page: import('@playwright/test').Page): Promise<number[]> {
    const rows = page.locator('[data-testid="bufferline-row"]');
    const total = await rows.count();
    const numbers: number[] = [];
    for (let i = 0; i < total; i++) {
        const text = (await rows.nth(i).innerText()).trim();
        const m = /(?:^|[\t\n])(\d+)\. (\d+)$/.exec(text);
        if (m) numbers.push(Number(m[2]));
    }
    return numbers;
}

/** Page upward until the first planted row is on screen or the control is gone. */
async function pageToTop(page: import('@playwright/test').Page) {
    const fetchMore = page.getByTestId('fetch-more-lines');
    for (let round = 0; round < 8; round++) {
        const top = (await rowNumbers(page))[0];
        if (top === 1) return;
        if (await fetchMore.count() === 0) return;
        const before = top ?? ROW_TOTAL;
        await fetchMore.click();
        // The page is sized to the buffer's retention limit, which starts at the
        // page floor: the first deliberate page can be exactly as wide as the
        // window already on screen and so deliver no new top row. A changed top
        // row is the progress signal; a stalled one is a no-op page to repeat.
        await expect
            .poll(async () => (await rowNumbers(page))[0], { timeout: 10000 })
            .toBeLessThan(before)
            .catch(() => {});
    }
}

async function plantAndSwitch() {
    await switchToBuffer(page, '#glowing-bear');
    // A previous run may have left the buffer behind: /exec -nf -name appends to
    // an existing buffer of the same name, which would stack the planted rows.
    await typeCommand(`/exec -stop ${EXEC_NAME}`);
    await typeCommand(`/buffer close exec.${EXEC_NAME}`);
    await typeCommand(`/exec -nf -name ${EXEC_NAME} seq 1 ${ROW_TOTAL}`);
    await typeCommand(`/exec -stop ${EXEC_NAME}`);

    await waitForBuffer(page, SHORT_NAME, 15000);
    await switchToBuffer(page, SHORT_NAME);
    await waitForRowCountAtLeast(page, 20);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await waitForTransport(page, 'api');
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test('a deep free buffer pages upward without duplicates (API)', async () => {
    await plantAndSwitch();

    // 300 planted rows outrun the initial window, so a page must be offered.
    await expect(page.getByTestId('fetch-more-lines')).toBeVisible();

    await pageToTop(page);

    const numbers = await rowNumbers(page);
    expect(numbers[0], 'the top row must be the first planted row').toBe(1);
    expect(numbers.length, 'every planted row must be retained').toBe(ROW_TOTAL);
    expect(new Set(numbers).size, 'no row may be delivered twice').toBe(ROW_TOTAL);
    expect(numbers, 'rows must arrive oldest-first').toEqual([...numbers].sort((a, b) => a - b));

    // The window is now complete: asking again is impossible, so the control is
    // gone — and a re-open keeps the full window.
    await expect(page.getByTestId('fetch-more-lines')).toHaveCount(0);
    await switchToBuffer(page, '#glowing-bear');
    await switchToBuffer(page, SHORT_NAME);
    await expect.poll(async () => (await rowNumbers(page)).length).toBe(ROW_TOTAL);
});

test('a deep free buffer pages upward without duplicates (legacy)', async ({ browser }) => {
    const legacyPage = await createConnectedPage(browser, {
        port: '9001',
        settings: { protocol: 'legacy' },
    });
    await waitForTransport(legacyPage, 'legacy');

    const save = page;
    page = legacyPage;
    try {
        await plantAndSwitch();

        await expect(page.getByTestId('fetch-more-lines')).toBeVisible();
        await pageToTop(page);

        const numbers = await rowNumbers(page);
        expect(numbers[0], 'the top row must be the first planted row').toBe(1);
        expect(numbers.length, 'every planted row must be retained').toBe(ROW_TOTAL);
        expect(new Set(numbers).size, 'no row may be delivered twice').toBe(ROW_TOTAL);
        expect(numbers, 'rows must arrive oldest-first').toEqual([...numbers].sort((a, b) => a - b));
        await expect(page.getByTestId('fetch-more-lines')).toHaveCount(0);
    } finally {
        page = save;
        await legacyPage.close();
    }
});
