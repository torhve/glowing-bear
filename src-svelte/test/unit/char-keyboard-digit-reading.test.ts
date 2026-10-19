/**
 * Characterization tests for B6: two adjacent buffer-navigation handlers in the
 * same file read the same keys in two different ways.
 *
 *   +page.svelte:271  handleQuickKeys     e.code.match(/^Digit(\d)$/)
 *                     comment at :270: "Use e.code to extract digit — this works
 *                     on all keyboard layouts"
 *   +page.svelte:301  handleJumpToBuffer  const code = e.keyCode || e.which
 *                     digit = code - 48, and Alt+J is matched as code === 74
 *
 * `e.code` names the physical key; `keyCode` names the value that key produced,
 * which depends on the layout. So the two handlers disagree on any keyboard where
 * a digit is not Shift-free, and on the numpad:
 *
 *   - AZERTY's physical 1 key reports code 'Digit1' and keyCode 38 ('&').
 *     Quick keys switch buffers; the jump aborts instead.
 *   - The numpad reports code 'Numpad1' and keyCode 49.
 *     The jump switches buffers; quick keys ignore it entirely.
 *
 * These pin today's behaviour on both sides of each pair. They are the baseline
 * the B6 fix is measured against, not a claim about which handler is right.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import Page from '../../src/routes/+page.svelte';
import { buffers, connected, createBuffer } from '#lib/stores/models.ts';
import { switchBuffer } from '#lib/stores/connectionManager.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import type { BufferData } from '#lib/types.ts';

// This mock must cover every export `+page.svelte` imports from the facade: the
// component's debug-global block reads them all at module scope, so a missing key
// fails the render rather than going unnoticed.
vi.mock('#lib/stores/connectionManager.ts', () => ({
    connect: vi.fn(),
    fetchMoreLines: vi.fn(),
    sendWeeChatCommand: vi.fn(),
    disconnect: vi.fn(),
    requestNicklist: vi.fn(),
    switchBuffer: vi.fn(),
    getSession: vi.fn(),
    getWs: vi.fn(),
    initFocusReconnect: vi.fn(),
    cleanupFocusReconnect: vi.fn(),
    setHotlistPollInterval: vi.fn(),
    pendingRetry: vi.fn(() => ({ active: false })),
}));

vi.mock('#lib/notifications.ts', () => ({
    initNotifications: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    onDisconnect: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

vi.mock('#lib/tauriWindow.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/tauriWindow.ts')>();
    return { ...actual, showWindow: vi.fn() };
});

const components: Record<string, unknown>[] = [];

function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

/**
 * Dispatch a keydown carrying a physical key and the value that key produced.
 * jsdom ignores keyCode in the KeyboardEvent init dict, so it is set explicitly.
 * The pair is the whole point: `code` is layout-independent, `keyCode` is not.
 */
function key(code: string, keyCode: number, alt = false) {
    const e = new KeyboardEvent('keydown', { code, altKey: alt, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    Object.defineProperty(e, 'which', { value: keyCode });
    document.dispatchEvent(e);
}

function channel(id: string, number: number): BufferData {
    return createBuffer({
        pointers: [id], full_name: `irc.${id}`, short_name: id, number,
        local_variables: { type: 'channel' },
    });
}

beforeEach(() => {
    connected.set(true);
    updateSettings({ enableQuickKeys: true });
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    buffers.set({});
    connected.set(false);
    vi.clearAllMocks();
});

describe('B6 characterization: the same digits, read two ways', () => {
    it('Alt+J jump aborts on a layout where the 1 key does not produce a 1', () => {
        render(Page, {});
        const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
        buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
        flushSync();

        key('KeyJ', 74, true); // arm the jump
        // AZERTY: physical key 1, value '&'. The physical key says "1".
        key('Digit1', 38);
        key('Digit2', 50);

        // The first key was not a digit as far as `keyCode` was concerned, which
        // aborts the jump; the second key then has nothing armed.
        expect(switchBuffer).not.toHaveBeenCalled();
    });

    it('Alt+1 quick keys switch on that same key, because they read the physical one', () => {
        render(Page, {});
        const first = channel('channel-a', 1);
        buffers.set({ '0x1': first });
        flushSync();

        // Same physical key, same produced value, opposite outcome.
        key('Digit1', 38, true);

        expect(switchBuffer).toHaveBeenCalledWith(first.id);
    });

    it('Alt+J jump accepts numpad digits', () => {
        render(Page, {});
        // The jump resolves a number to the Nth visible buffer, like the quick keys.
        const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
        const target = list[11]!;
        buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
        flushSync();

        key('KeyJ', 74, true);
        key('Numpad1', 49);
        key('Numpad2', 50);

        expect(switchBuffer).toHaveBeenCalledWith(target.id);
    });

    it('Alt+1 quick keys ignore the numpad entirely', () => {
        render(Page, {});
        const first = channel('channel-a', 1);
        buffers.set({ '0x1': first });
        flushSync();

        key('Numpad1', 49, true);

        expect(switchBuffer).not.toHaveBeenCalled();
    });

    it('Alt+J itself is matched by value too, so a layout that moves J moves the shortcut', () => {
        render(Page, {});
        // 12 buffers, so that if arming had worked the following 1-2 would land
        // on the 12th one.
        const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
        buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
        flushSync();

        // Physical KeyJ, but reported as some other value: the arm test is
        // `code === 74`, so arming depends on the character, not the key.
        key('KeyJ', 106, true);
        key('Digit1', 49);
        key('Digit2', 50);

        expect(switchBuffer).not.toHaveBeenCalled();
    });
});
