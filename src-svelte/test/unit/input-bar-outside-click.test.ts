import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { mountHarness } from './helpers/mountComponent.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(),
    sendWeeChatCommand: vi.fn(),
}));

const { render, teardown } = mountHarness();

// Toggle the color picker exactly as the Ctrl+K readline binding does.
function pressCtrlK(target: HTMLElement) {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]')!;
    const e = new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: 75 });
    Object.defineProperty(e, 'which', { value: 75 });
    input.dispatchEvent(e);
    flushSync();
}

// A click on a node that is not inside the input bar.
function clickOutside() {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    await teardown();
    vi.clearAllTimers();
    vi.useRealTimers();
});

it('does not leak an outside-click handler when the color picker closes before its listener is installed', () => {
    const target = render(InputBar, {});
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]')!;
    input.focus();

    // Open and close the picker before the deferred listener installation fires.
    pressCtrlK(target);
    expect(target.querySelector('[data-testid="color-00"]')).not.toBeNull();
    pressCtrlK(target);
    expect(target.querySelector('[data-testid="color-00"]')).toBeNull();

    // The deferred installation of the previous run may now happen.
    vi.advanceTimersByTime(1);
    flushSync();

    // Open the format toolbar. A leaked outside-click handler would close it
    // on the next outside click even though no picker is open.
    target.querySelector<HTMLButtonElement>('[data-testid="format-toggle"]')!.click();
    flushSync();
    expect(target.querySelector('[data-testid="format-bold"]')).not.toBeNull();

    clickOutside();
    expect(target.querySelector('[data-testid="format-bold"]')).not.toBeNull();
});
