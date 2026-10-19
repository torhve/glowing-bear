/**
 * Keyboard handling in BufferList.svelte, at its two activatable surfaces.
 *
 * The long-press menu — fixed, and this is its regression net.
 *   BufferList.svelte:236 handles Escape and Enter on the menu's dismiss layer.
 *   It now stops their propagation, the way its sibling onclick at :235 always
 *   did. Before, the keypress that dismissed the menu also continued to
 *   +page.svelte's global handler, which blurs the input and, on a second
 *   Escape within 500 ms, disconnects. InputBar.svelte:1390 already stopped
 *   propagation for exactly this reason; this layer was the one that did not.
 *
 * The buffer row — fixed, and this is its regression net.
 *   Its keydown used to read Enter/Space and call handleBufferClick(buffer.id)
 *   without cancelling either, so Space activated the row AND was left to the
 *   browser, which scrolls the list. BufferLineRow.svelte:298 handles the same
 *   pair for the same kind of activatable row and did cancel it, and
 *   makeKeyboardActivatable() in utils.ts — the shared helper already used by
 *   Nicklist.svelte:143 and ConnectionForm.svelte:233 — did too. BufferList's
 *   row was the one site writing the pattern by hand, and the one that omitted
 *   it. It now uses the helper.
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

describe('the buffer row cancels the keys it acts on', () => {
    it('Space activates the row and is cancelled', () => {
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
        // ...and the default was cancelled, so Space does not also scroll the list.
        expect(event.defaultPrevented, 'Space is cancelled by the row that acted on it').toBe(true);
    });

    it('Enter on the same row is cancelled too', () => {
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

        expect(event.defaultPrevented).toBe(true);
    });
});

describe('the long-press menu keeps its own Escape and Enter', () => {
    it('the dismiss layer clears the menu and the keypress stops there', () => {
        const target = render(BufferList, {});
        openLongPress(target);

        const dismiss = target.querySelector<HTMLElement>('[aria-label="Dismiss menu"]');
        expect(dismiss, 'the long-press dismiss layer').not.toBeNull();

        // A document-level listener stands in for +page.svelte's global Escape
        // handler — where this keypress used to end up.
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
        expect(seenByGlobalHandler, 'the Escape that dismissed the menu never reached the document').toHaveLength(0);
    });

    it('Enter on the dismiss layer stops there too', () => {
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

        expect(seen).toHaveLength(0);
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
