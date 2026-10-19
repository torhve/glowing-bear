/**
 * Characterization tests for B5 and B7, both in BufferList.svelte.
 *
 * B5 — BufferList.svelte:171
 *   onkeydown Enter/Space -> handleBufferClick(buffer.id), with no
 *   preventDefault(). Space therefore activates the row AND is left to the
 *   browser, which scrolls the list. BufferLineRow.svelte:298 handles the same
 *   pair for the same kind of activatable row and does call preventDefault(),
 *   and makeKeyboardActivatable() in utils.ts — the shared helper already used
 *   by Nicklist.svelte:143 and ConnectionForm.svelte:233 — does. BufferList's
 *   row is the one site that writes the pattern by hand and omits it.
 *
 * B7 — BufferList.svelte:236
 *   The long-press menu's dismiss layer handles Escape and Enter but does not
 *   stopPropagation(). Its sibling onclick at :235 does. Escape therefore
 *   dismisses the menu AND continues to +page.svelte's global handler, which
 *   blurs the input and, on a second Escape within 500 ms, disconnects.
 *   InputBar.svelte:1390 added stopPropagation for exactly this reason.
 *
 * These pin what happens today. They are the baseline the one-line fixes are
 * measured against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BufferList from '#components/BufferList.svelte';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { switchBuffer } from '#lib/stores/connectionManager.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    switchBuffer: vi.fn(),
    closeBufferOnWeeChat: vi.fn(),
    pinBuffer: vi.fn(),
    unpinBuffer: vi.fn(),
}));

const components: Record<string, unknown>[] = [];

function render(component: Parameters<typeof mount>[0], props: Record<string, unknown>) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

function channel(id: string, name: string): BufferData {
    return createBuffer({
        pointers: [id],
        full_name: `irc.test.${name}`,
        short_name: name,
        number: 1,
        local_variables: { plugin: 'irc', server: 'test', type: 'channel' },
    });
}

/** Open the long-press menu: a touch that is held past the component's 500 ms. */
function openLongPress(target: HTMLElement) {
    const row = target.querySelector<HTMLElement>('[data-testid="buffer-item"]');
    if (!row) throw new Error('no buffer row to press');
    const touch = { clientX: 40, clientY: 60 };
    row.dispatchEvent(
        Object.assign(new Event('touchstart', { bubbles: true }), {
            touches: [touch],
            changedTouches: [touch],
        }) as unknown as TouchEvent,
    );
    vi.advanceTimersByTime(600);
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
    buffers.set({ '0x100': channel('0x100', '#glowing-bear') });
    activeBufferId.set('0x100');
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    buffers.set({});
    activeBufferId.set('');
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('B5 characterization: Space activates a buffer row and is not cancelled', () => {
    it('the row handles Space but leaves the default to the browser', () => {
        const target = render(BufferList, {});
        const row = target.querySelector<HTMLElement>('[data-testid="buffer-item"]');
        expect(row, 'a buffer row').not.toBeNull();

        const event = new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
        });
        row!.dispatchEvent(event);
        flushSync();

        // The activation happened...
        expect(switchBuffer, 'Space activated the row').toHaveBeenCalledWith('0x100');
        // ...and the browser is still free to scroll, because nothing prevented it.
        expect(event.defaultPrevented, 'Space is left to the browser, so it also scrolls').toBe(false);
    });

    it('Enter on the same row is also left uncancelled', () => {
        const target = render(BufferList, {});
        const row = target.querySelector<HTMLElement>('[data-testid="buffer-item"]')!;

        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        row.dispatchEvent(event);
        flushSync();

        expect(event.defaultPrevented).toBe(false);
    });
});

describe('B7 characterization: Escape in the long-press menu reaches the global handler', () => {
    it('the dismiss layer clears the menu and lets the keypress continue', () => {
        const target = render(BufferList, {});
        openLongPress(target);

        const dismiss = target.querySelector<HTMLElement>('[aria-label="Dismiss menu"]');
        expect(dismiss, 'the long-press dismiss layer').not.toBeNull();

        // A document-level listener stands in for +page.svelte's global Escape
        // handler, which is what the leak reaches.
        const seenByGlobalHandler: KeyboardEvent[] = [];
        const listener = (e: KeyboardEvent) => seenByGlobalHandler.push(e);
        document.addEventListener('keydown', listener);
        try {
            dismiss!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            flushSync();
        } finally {
            document.removeEventListener('keydown', listener);
        }

        expect(target.querySelector('[aria-label="Dismiss menu"]'), 'the menu was dismissed').toBeNull();
        expect(seenByGlobalHandler, 'the same Escape also reached the document').toHaveLength(1);
    });

    it('Enter on the dismiss layer leaks the same way', () => {
        const target = render(BufferList, {});
        openLongPress(target);
        const dismiss = target.querySelector<HTMLElement>('[aria-label="Dismiss menu"]')!;

        const seen: KeyboardEvent[] = [];
        const listener = (e: KeyboardEvent) => seen.push(e);
        document.addEventListener('keydown', listener);
        try {
            dismiss.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            flushSync();
        } finally {
            document.removeEventListener('keydown', listener);
        }

        expect(seen).toHaveLength(1);
    });

    it('a click on that same layer does stop, which is what makes the keydown an omission', () => {
        const target = render(BufferList, {});
        openLongPress(target);
        const dismiss = target.querySelector<HTMLElement>('[aria-label="Dismiss menu"]')!;

        const seen: Event[] = [];
        const listener = (e: Event) => seen.push(e);
        document.addEventListener('click', listener);
        try {
            dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            flushSync();
        } finally {
            document.removeEventListener('click', listener);
        }

        expect(seen, 'onclick stops propagation; onkeydown does not').toHaveLength(0);
    });
});
