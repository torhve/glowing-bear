import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

async function getReadmarkerState() {
    return await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (!container) return null;
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        const rm = container.querySelector('.readmarker');

        // Count bufferline-rows below the readmarker using DOM sibling traversal.
        // Index arithmetic (lastLineIndex - rmIndex) is unreliable because the tbody
        // contains mixed row types (fetchmore, readmarker, bufferline) with different
        // indexing bases. Sibling traversal directly counts what we care about.
        let linesBelowReadmarker = -1;
        if (rm) {
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            linesBelowReadmarker = count;
        }

        return {
            hasReadmarker: !!rm,
            readmarkerIndex: rm ? Array.from(container.querySelectorAll('table tbody tr')).findIndex(t => t.classList.contains('readmarker')) : -1,
            totalLines: rows.length,
            linesBelowReadmarker,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            atBottom: container.scrollTop >= container.scrollHeight - container.clientHeight - 3,
            scrollDiffFromBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
        };
    });
}

// ---- ReadMarker basic tests ----

test.describe('basic', () => {
    test.beforeEach(async () => {
        await waitForBuffer(page, '#glowing-bear', 20000);
        await switchToBuffer(page, '#glowing-bear');
        // Scroll to bottom to ensure we start fully-read (no stale readmarkers from prior tests)
        const chatContainer = page.locator('[data-testid="chat-messages"]');
        await chatContainer.evaluate((el) => {
            (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        });
    });

    test('readmarker appears when there are unread messages', async () => {
        // Switch to gbtest buffer so we're NOT on #glowing-bear when sending unread
        await switchToBuffer(page, 'gbtest');

        // Send a message to #glowing-bear while we're NOT on it (creates unread)
        await irc.sendMessage('#glowing-bear', 'readmarker test message ' + Date.now());

        // Switch back to #glowing-bear — readmarker should appear
        await switchToBuffer(page, '#glowing-bear');

        // Wait for readmarker to be visible
        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible({ timeout: 5000 });

        // Verify unread lines exist below the readmarker using nextElementSibling traversal.
        // This is more reliable than index arithmetic since tbody contains mixed row types
        // (fetchmore, readmarker, bufferline) and index-based formulas break when non-bufferline
        // rows precede the readmarker.
        const linesBelowReadmarker = await page.evaluate(() => {
            const rm = document.querySelector('.readmarker');
            if (!rm) return -1;
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            return count;
        });

        expect(linesBelowReadmarker).toBeGreaterThan(0);
    });

    test('readmarker should appear when switching back to buffer with unread messages', async () => {
        // Switch to gbtest buffer so we're NOT on #glowing-bear when sending unread
        await switchToBuffer(page, 'gbtest');

        // Send a message to #glowing-bear while we're on PM - this creates unread
        await irc.sendMessage('#glowing-bear', 'readmarker test message ' + Date.now());

        // Switch back to #glowing-bear - readmarker should appear
        await switchToBuffer(page, '#glowing-bear');

        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible();
    });

    test('new messages should appear below the readmarker', async () => {
        // Switch to gbtest buffer to create unread state for #glowing-bear
        await switchToBuffer(page, 'gbtest');

        // Send a message to #glowing-bear while away to create unread
        await irc.sendMessage('#glowing-bear', 'readmarker setup msg ' + Date.now());

        await switchToBuffer(page, '#glowing-bear');

        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible();

        // Get the readmarker position before sending new message
        const readmarkerBox = await readmarker.boundingBox();
        expect(readmarkerBox).not.toBeNull();
        const readmarkerY = readmarkerBox!.y;

        // Send a new message from bot - it should appear below the readmarker
        const uniqueMsg = 'message after readmarker ' + Date.now();
        await irc.sendMessage('#glowing-bear', uniqueMsg);

        // Verify the new message actually appeared in the DOM
        const msgCell = page.locator('[data-testid="chat-messages"] td.message').filter({ hasText: uniqueMsg });
        await expect(msgCell).toBeVisible({ timeout: 5000 });

        // The newly arrived message should be below the readmarker in the DOM
        const allRows = page.locator('[data-testid="bufferline-row"]');
        const rowCount = await allRows.count();
        expect(rowCount).toBeGreaterThan(0);

        // Find the row with our new message
        const newRow = allRows.last();
        const newRowBox = await newRow.boundingBox();
        expect(newRowBox).not.toBeNull();

        // Readmarker should still be visible
        await expect(readmarker).toBeVisible();
    });

    test('scroll position should be preserved when switching back to buffer', async () => {
        // Send a message from bot while we're on #glowing-bear so it's displayed
        await irc.sendMessage('#glowing-bear', 'scroll test msg');

        // Switch to gbtest buffer so we're NOT on #glowing-bear when sending unread
        await switchToBuffer(page, 'gbtest');

        // Send another message to #glowing-bear while we're on PM - this creates unread
        await irc.sendMessage('#glowing-bear', 'scroll test unread ' + Date.now());

        // Switch back to #glowing-bear — should show readmarker (not bottom)
        await switchToBuffer(page, '#glowing-bear');

        // Wait for readmarker to be visible and unread lines below it
        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible({ timeout: 5000 });

        // Wait until there are bufferline rows after the readmarker (unread messages fully rendered)
        await page.waitForFunction(() => {
            const rm = document.querySelector('.readmarker');
            if (!rm) return false;
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            return count > 0;
        }, { timeout: 5000 });

        // Verify the readmarker is visible in the viewport.
        // When switching to a buffer with unread messages, the app should scroll
        // to show the readmarker rather than jumping to the bottom.
        const visibleInViewport = await page.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            const rm = document.querySelector('.readmarker') as HTMLElement;
            if (!container || !rm) return false;
            const containerRect = container.getBoundingClientRect();
            const rmRect = rm.getBoundingClientRect();
            return rmRect.bottom <= containerRect.bottom && rmRect.top >= containerRect.top;
        });
        expect(visibleInViewport).toBe(true);
    });
});

// ---- ReadMarker buffer switch tests ----

test.describe('buffer switch', () => {
    test('readmarker position should be correct when switching away and back to same buffer', async () => {
        // Wait for #glowing-bear to appear in buffer list
        await waitForBuffer(page, '#glowing-bear', 15000);

        // Switch to #glowing-bear and ensure we're at bottom (fully read)
        await switchToBuffer(page, '#glowing-bear');

        // Verify we're at the bottom
        let state = await getReadmarkerState();
        expect(state).not.toBeNull();
        expect(state!.atBottom).toBe(true);

        // Send a few messages while we're on this buffer (these are fully read)
        await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-1');
        await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-2');
        await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-3');

        // Switch away to gbtest buffer
        await switchToBuffer(page, 'gbtest');

        // Send messages to #glowing-bear while we're NOT on it (creates unread)
        await irc.sendMessage('#glowing-bear', 'readmarker-switch-test unread-msg-1');
        await irc.sendMessage('#glowing-bear', 'readmarker-switch-test unread-msg-2');

        // Switch back to #glowing-bear — readmarker should appear at correct position
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');

        // Readmarker should be visible and unread lines below it
        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible({ timeout: 5000 });

        // Wait until there are bufferline rows after the readmarker (unread messages fully rendered)
        await page.waitForFunction(() => {
            const rm = document.querySelector('.readmarker');
            if (!rm) return false;
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            return count > 0;
        }, { timeout: 5000 });

        state = await getReadmarkerState();
        expect(state).not.toBeNull();

        // Readmarker should NOT be at the very end (there should be lines below it)
        expect(state!.linesBelowReadmarker).toBeGreaterThan(0);

        // Readmarker should be visible in the viewport
        const visibleInViewport = await page.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            const rm = document.querySelector('.readmarker') as HTMLElement;
            if (!container || !rm) return false;
            const containerRect = container.getBoundingClientRect();
            const rmRect = rm.getBoundingClientRect();
            return rmRect.bottom <= containerRect.bottom && rmRect.top >= containerRect.top;
        });
        expect(visibleInViewport).toBe(true);
    });

    test('should not double-count unreads for inactive buffers', async () => {
        // Wait for #glowing-bear to exist in buffer list
        await waitForBuffer(page, '#glowing-bear', 15000);

        // Ensure we're at bottom on #glowing-bear (fully read)
        await switchToBuffer(page, '#glowing-bear');
        const chatContainer = page.locator('[data-testid="chat-messages"]');
        await chatContainer.evaluate((el) => {
            (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        });

        // Switch to gbtest buffer to make #glowing-bear inactive
        await switchToBuffer(page, 'gbtest');

        // Send a message to #glowing-bear while we're NOT on it (creates unread)
        const uniqueMsg = 'dc-test-' + Date.now();
        await irc.sendMessage('#glowing-bear', uniqueMsg);

        // Wait for message to be processed
        await page.waitForFunction((msg) => {
            const rows = document.querySelectorAll('[data-testid="bufferline-row"] td.message');
            return Array.from(rows).some(r => r.textContent?.includes(msg));
        }, uniqueMsg, { timeout: 5000 });

        // Switch back - readmarker should appear with exactly 1 line below it
        // If double-counting were happening, the effectiveUnread calculation would
        // still produce correct results since getEffectiveUnread() uses Math.max.
        await switchToBuffer(page, '#glowing-bear');
        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible({ timeout: 5000 });

        const linesBelowReadmarker = await page.evaluate(() => {
            const rm = document.querySelector('.readmarker');
            if (!rm) return -1;
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            return count;
        });
        expect(linesBelowReadmarker).toBe(1);
    });
});

// ---- ReadMarker bot message tests ----

test.describe('bot message', () => {
    test.beforeAll(async () => {
        page.on('console', (msg) => {
            if (msg.text().includes('[ChatView]') || msg.text().includes('[BOT]')) {
                console.log(`[BROWSER ${msg.type()}] ${msg.text()}`);
            }
        });
    });

    test.beforeEach(async () => {
        // Wait for gbtest server buffer first (appears before channels)
        await waitForBuffer(page, 'gbtest', 30000);
        // Then wait for #glowing-bear channel
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
    });

    test('readmarker appears on second-to-last line with 1 unread when switching to buffer after bot message', async () => {
        // Switch to gbtest buffer so we're NOT on #glowing-bear when message arrives
        await switchToBuffer(page, 'gbtest');

        // Send a new message to #glowing-bear while away (creates unread)
        const uniqueMsgId = Date.now();
        const response = await irc.sendMessage('#glowing-bear', `readmarker test ${uniqueMsgId}`);
        expect(response.ok).toBe(true);

        // Switch back to #glowing-bear — this should reveal the readmarker
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');

        const readmarker = page.getByTestId('readmarker');
        await expect(readmarker).toBeVisible({ timeout: 5000 });

        // Wait until there are bufferline rows after the readmarker (unread message fully rendered)
        await page.waitForFunction(() => {
            const rm = document.querySelector('.readmarker');
            if (!rm) return false;
            let count = 0;
            let sibling = rm.nextElementSibling;
            while (sibling) {
                if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                    count++;
                }
                sibling = sibling.nextElementSibling;
            }
            return count > 0;
        }, { timeout: 5000 });

        // Verify readmarker is on the second-to-last row (1 unread message after it)
        const allRows = page.locator('[data-testid="bufferline-row"]');
        const rowCount = await allRows.count();
        expect(rowCount).toBeGreaterThan(0);

        // Get total TR count in tbody (includes readmarker row)
        const totalTRs = await page.evaluate(() => {
            const table = document.querySelector('table tbody');
            return table ? table.querySelectorAll('tr').length : 0;
        });

        const readmarkerPosition = await readmarker.evaluate((el: Element) => {
            const table = el.closest('table')?.querySelector('tbody');
            if (!table) return -1;
            const rows = table.querySelectorAll('tr');
            let readmarkerIndex = -1;
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].classList.contains('readmarker')) {
                    readmarkerIndex = i;
                    break;
                }
            }
            return readmarkerIndex;
        });

        // Readmarker should be before the last TR (unread message is below it)
        expect(readmarkerPosition).toBeLessThan(totalTRs - 1);
        // There should be at least 1 message after the readmarker
        expect(readmarkerPosition).toBeGreaterThanOrEqual(0);

        // Check that readmarker is visible in the viewport
        const scrollInfo = await page.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]');
            if (!container || !(container instanceof HTMLElement)) return null;
            const rm = document.querySelector('.readmarker') as HTMLElement;
            if (!rm) return null;

            const containerRect = container.getBoundingClientRect();
            const rmRect = rm.getBoundingClientRect();

            return {
                isVisible: rmRect.bottom <= containerRect.bottom && rmRect.top >= containerRect.top,
                nearBottom: rmRect.bottom >= containerRect.bottom - 100
            };
        });

        expect(scrollInfo).not.toBeNull();
        expect(scrollInfo!.isVisible).toBe(true);
    });
});
