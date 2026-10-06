import { Page, expect } from '@playwright/test';

export async function fillInput(page: Page, testId: string, text: string) {
    await page.getByTestId(testId).fill(text);
}

/**
 * Raw DOM value of the input bar.
 * Read from the textarea itself, not from a Playwright locator, because the
 * specs assert on mIRC control characters that a text matcher would normalize
 * away.
 */
export function rawInputValue(page: Page): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement | null;
        return el?.value ?? '';
    });
}

/**
 * Wait until the input bar's raw value settles to `matcher` (exact string) or
 * matches it (RegExp).
 *
 * The input bar rewrites the textarea from Svelte state after every keystroke
 * (emojify, autolink, formatting insertion), so the value a spec reads right
 * after an action can still be mid-round-trip. Polling the value is the honest
 * version of "wait for the input bar to finish".
 */
export async function waitForInputValue(page: Page, matcher: string | RegExp, timeout = 5000): Promise<void> {
    const poll = expect.poll(() => rawInputValue(page), { timeout });
    if (matcher instanceof RegExp) {
        await poll.toMatch(matcher);
    } else {
        await poll.toBe(matcher);
    }
}

/** Wait until the caret sits at `pos` in the input bar. */
export async function waitForInputCaret(page: Page, pos: number, timeout = 5000): Promise<void> {
    await expect
        .poll(
            () => page.evaluate(() => (document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement | null)?.selectionStart ?? -1),
            { timeout },
        )
        .toBe(pos);
}

/** Wait until the input bar has focus. */
export async function expectInputFocused(page: Page, timeout = 5000): Promise<void> {
    await expect(page.getByTestId('message-input'), 'input bar never took focus').toBeFocused({ timeout });
}

/** Wait until the input bar has lost focus. */
export async function expectInputBlurred(page: Page, timeout = 5000): Promise<void> {
    await expect(page.getByTestId('message-input'), 'input bar kept focus').not.toBeFocused({ timeout });
}

/**
 * Reset the input bar through the app's own test hook and wait until the reset
 * is observable.
 *
 * The hook mutates Svelte state and the textarea in one go; the waits below are
 * what the trailing 50 ms sleep was standing in for.
 */
export async function resetInputState(page: Page): Promise<void> {
    await page.evaluate(() => {
        const reset = (window as typeof window & { __resetFormattingState?: () => void }).__resetFormattingState;
        if (typeof reset === 'function') {
            reset();
        }
    });
    await waitForInputValue(page, '');
    await expect(page.locator('[role="toolbar"]')).toBeHidden();
    await expect(page.locator('.color-picker-popover')).toBeHidden();
}
