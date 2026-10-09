import { expect, test } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { disconnect, reconnect, sendWeechatCommand } from '../helpers/connection';
import { expectInputFocused, waitForInputCaret, waitForInputValue } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * Per-conversation composer drafts, in a browser.
 *
 * The unit suite proves the store contract. These flows prove the parts only a
 * browser can: a real textarea keeping its caret across a switch, a real unmount
 * and remount across a reconnect, and a restored draft resizing the composer
 * without the chat viewport reacting to it.
 *
 * It sends no channel messages and asserts no channel-derived content, so it
 * belongs to the parallel UI-only pass. The second conversation is a free buffer
 * created and closed by this spec, so the shared gbtest channel is untouched.
 */

const DRAFTS_BUFFER = 'gbtest-drafts';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false },
    });
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await sendWeechatCommand(page, `/buffer add ${DRAFTS_BUFFER}`);
    await waitForBuffer(page, DRAFTS_BUFFER, 15000);
});

test.afterAll(async () => {
    // Leave the shared fixture as it started.
    await sendWeechatCommand(page, `/buffer close ${DRAFTS_BUFFER}`).catch(() => {});
    await page.close();
});

const input = () => page.getByTestId('message-input');

async function type(text: string): Promise<void> {
    const field = input();
    await field.focus();
    await expectInputFocused(page);
    await field.fill(text);
    await waitForInputValue(page, text);
}

async function composerValue(): Promise<string> {
    return input().inputValue();
}

/** Clear the composer without leaving text behind in the conversation's draft. */
async function clearComposer(): Promise<void> {
    await input().fill('');
    await waitForInputValue(page, '');
}

function chatGeometry(): Promise<{ scrollTop: number; diffFromBottom: number }> {
    return page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="chat-messages"]')!;
        return { scrollTop: el.scrollTop, diffFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight };
    });
}

test.beforeEach(async () => {
    await switchToBuffer(page, '#glowing-bear');
    await clearComposer();
    await switchToBuffer(page, DRAFTS_BUFFER);
    await clearComposer();
    await switchToBuffer(page, '#glowing-bear');
    await clearComposer();
});

test('each conversation keeps its own unfinished text', async () => {
    await type('half a message in glowing-bear');

    await switchToBuffer(page, DRAFTS_BUFFER);
    // A new conversation does not inherit the previous one's draft.
    expect(await composerValue()).toBe('');

    await type('a different unfinished line');

    await switchToBuffer(page, '#glowing-bear');
    expect(await composerValue()).toBe('half a message in glowing-bear');

    await switchToBuffer(page, DRAFTS_BUFFER);
    expect(await composerValue()).toBe('a different unfinished line');
});

test('switching back restores the caret where the reader left it', async () => {
    await type('hello world');
    // Move the caret with the keyboard rather than setting it from outside: the
    // point is where the reader actually left it.
    await input().press('ArrowLeft');
    await input().press('ArrowLeft');
    await input().press('ArrowLeft');
    await waitForInputCaret(page, 'hello world'.length - 3);

    await switchToBuffer(page, DRAFTS_BUFFER);
    await switchToBuffer(page, '#glowing-bear');

    expect(await composerValue()).toBe('hello world');
    await waitForInputCaret(page, 'hello world'.length - 3);
});

test('a reconnect that hands out new runtime ids restores the draft', async () => {
    await type('survives a reconnect');

    await reconnect(page, { port: '9010' });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    await waitForInputValue(page, 'survives a reconnect');
});

test('an explicit disconnect and reconnect restores the draft', async () => {
    await type('survives a disconnect');

    await disconnect(page);
    await reconnect(page, { port: '9010' });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    await waitForInputValue(page, 'survives a disconnect');
});

test('closing and reopening a conversation brings its draft back', async () => {
    await switchToBuffer(page, DRAFTS_BUFFER);
    await type('unfinished when the buffer closed');

    await sendWeechatCommand(page, `/buffer close ${DRAFTS_BUFFER}`);
    await expect(page.getByTestId('buffer-item').filter({ hasText: DRAFTS_BUFFER })).toHaveCount(0, { timeout: 10000 });

    await sendWeechatCommand(page, `/buffer add ${DRAFTS_BUFFER}`);
    await waitForBuffer(page, DRAFTS_BUFFER, 15000);
    await switchToBuffer(page, DRAFTS_BUFFER);

    await waitForInputValue(page, 'unfinished when the buffer closed');
});

async function resetScrollWrites(): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __gbScrollWrites?: number };
        if (w.__gbScrollWrites !== undefined) {
            w.__gbScrollWrites = 0;
            return;
        }
        w.__gbScrollWrites = 0;
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        if (!desc?.set) return;
        Object.defineProperty(Element.prototype, 'scrollTop', {
            get: desc.get,
            set(value: number) {
                if ((this as HTMLElement).matches?.('[data-testid="chat-messages"]')) {
                    w.__gbScrollWrites!++;
                }
                desc.set!.call(this, value);
            },
            configurable: true,
        });
    });
}

async function scrollWrites(): Promise<number> {
    return page.evaluate(() => (window as unknown as { __gbScrollWrites?: number }).__gbScrollWrites ?? -1);
}

function viewportState(): Promise<{ mode: string; pinActivations: number }> {
    return page.evaluate(() => {
        const state = (window as { __chatFollowState?: () => { mode: string; pinActivations: number } }).__chatFollowState?.();
        return { mode: state?.mode ?? 'unknown', pinActivations: state?.pinActivations ?? -1 };
    });
}

test('a growing composer does not upset the read mode the reader chose', async () => {
    // Park the reader above the tail with real wheel gestures, so the view is in
    // reading mode and any later scroll is the application's doing, not theirs.
    const box = await page.getByTestId('chat-messages').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    for (let step = 0; step < 3; step++) {
        await page.mouse.wheel(0, -240);
        await page.waitForFunction(() => {
            const el = document.querySelector<HTMLElement>('[data-testid="chat-messages"]')!;
            return el.scrollHeight - el.scrollTop - el.clientHeight >= 200;
        }, { timeout: 10000 });
    }

    await resetScrollWrites();
    const before = await viewportState();
    expect(before.mode).toBe('reading');

    // The composer grows by eight lines. That is a layout change the viewport
    // controller observes, and observing it must not turn into a scroll write or a
    // follow pin on a view the reader is holding.
    await type(Array.from({ length: 8 }, (_, i) => `composer line ${i + 1}`).join('\n'));

    expect(await scrollWrites()).toBe(0);
    const after = await viewportState();
    expect(after.mode).toBe('reading');
    expect(after.pinActivations).toBe(before.pinActivations);
});

test('a draft is not written to any persistent storage', async () => {
    await type('text that must stay in memory');

    const stored = await page.evaluate(() => {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) keys.push(key);
        }
        return keys;
    });
    expect(stored.some((key) => /draft/i.test(key))).toBe(false);

    // The keys that DO persist are input history and last-buffer resume, which
    // predate this feature and are a separate privacy surface.
    const draftTextStored = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if ((localStorage.getItem(key) ?? '').includes('text that must stay in memory')) return key;
        }
        return null;
    });
    expect(draftTextStored).toBeNull();
});
