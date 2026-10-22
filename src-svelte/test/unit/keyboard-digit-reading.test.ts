/**
 * Buffer navigation keys in +page.svelte, read off the physical key.
 *
 * The two adjacent handlers used to read the same keys two different ways:
 *
 *   handleQuickKeys     e.code.match(/^Digit(\d)$/)   — names the physical key
 *   handleJumpToBuffer  e.keyCode || e.which          — names the value that key
 *                       produced: digit = code - 48, Alt+J matched as code === 74
 *
 * keyCode depends on the layout, so the two disagreed wherever a digit is not
 * Shift-free, and on the numpad:
 *
 *   - AZERTY's physical 1 key is 'Digit1' but produces '&', so the jump could
 *     never take a digit; and 'h' sits at the position QWERTY gives J, so the
 *     mode never armed there either.
 *   - The numpad is 'Numpad1'. keyCode only reported it as a digit while NumLock
 *     was on; with NumLock off those keys report page navigation.
 *
 * Both handlers now read e.code. The quick-key half is unchanged by the fix and
 * is kept here as the contrast; the jump half is checked on exactly the layouts
 * the old reading failed.
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

describe('buffer navigation reads the physical key, on both handlers', () => {
    it('Alt+J jump takes a digit on a layout where the 1 key does not produce a 1', () => {
        render(Page, {});
        const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
        const target = list[11]!;
        buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
        flushSync();

        key('KeyJ', 74, true); // arm the jump
        // AZERTY: physical key 1, value '&'. The physical key says "1".
        key('Digit1', 38);
        key('Digit2', 50);

        // 1 then 2 -> buffer number 12. Reading the physical key is what makes
        // this work at all: keyCode reported 38 and 50, so the old check saw
        // neither as a digit and aborted the jump on the first one.
        expect(switchBuffer).toHaveBeenCalledWith(target.id);
    });

    it('Alt+1 quick keys switch on that same key, because they read the physical one', () => {
        render(Page, {});
        const first = channel('channel-a', 1);
        buffers.set({ [first.id]: first });
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
        buffers.set({ [first.id]: first });
        flushSync();

        key('Numpad1', 49, true);

        expect(switchBuffer).not.toHaveBeenCalled();
    });

    it('Alt+J arms on the physical J key, not on the character it produces', () => {
        render(Page, {});
        // 12 buffers, so that if arming worked the following 1-2 would land
        // on the 12th one.
        const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
        const target = list[11]!;
        buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
        flushSync();

        // AZERTY puts 'h' where QWERTY puts J, so the old `code === 74` test
        // never armed the mode on that layout — the shortcut did not exist there.
        // The physical key is KeyJ on both.
        key('KeyJ', 72, true);
        key('Digit1', 49);
        key('Digit2', 50);

        expect(switchBuffer).toHaveBeenCalledWith(target.id);
    });
});
