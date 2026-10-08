import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import Page from '../../src/routes/+page.svelte';
import { buffers, createBuffer } from '#lib/stores/models.ts';
import { switchBuffer } from '#lib/stores/connectionManager.ts';
import type { BufferData } from '#lib/types.ts';

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

// Mount the real page component and retain its owner so each test tears down its effects.
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

// Dispatch a keydown on document with a reliable legacy keyCode (jsdom ignores
// keyCode in the KeyboardEvent init dict, so set it explicitly).
function key(code: string, keyCode: number, alt = false) {
    const e = new KeyboardEvent('keydown', { code, altKey: alt, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    Object.defineProperty(e, 'which', { value: keyCode });
    document.dispatchEvent(e);
}

// Channel-shaped buffers with the numbers the jump mode targets.
function channel(id: string, number: number): BufferData {
    return createBuffer({
        pointers: [id], full_name: `irc.${id}`, short_name: id, number,
        local_variables: { type: 'channel' },
    });
}

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    buffers.set({});
    vi.clearAllMocks();
});

it('Alt+J then two digits jumps to the buffer with that number', () => {
    render(Page, {});
    // Jump target 12 is the 12th visible buffer (1-based, like the quick keys).
    const list = Array.from({ length: 12 }, (_, i) => channel(`channel-${i + 1}`, i + 1));
    const target = list[11]!;
    buffers.set(Object.fromEntries(list.map((b) => [b.id, b])));
    flushSync();

    // Plain digits without Alt+J must not trigger the jump.
    key('Digit1', 49);
    key('Digit2', 50);
    expect(switchBuffer).not.toHaveBeenCalled();

    key('KeyJ', 74, true); // Alt+J activates jump mode
    key('Digit1', 49);
    key('Digit2', 50);
    expect(switchBuffer).toHaveBeenCalledWith(target.id);
});

it('a non-digit key aborts the Alt+J jump', () => {
    render(Page, {});
    const b12 = channel('channel-a', 12);
    buffers.set({ [b12.id]: b12 });
    flushSync();

    key('KeyJ', 74, true);
    key('Digit1', 49);
    key('KeyA', 65); // abort
    key('Digit2', 50);
    expect(switchBuffer).not.toHaveBeenCalled();
});
