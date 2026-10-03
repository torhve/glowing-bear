import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import BufferSearchModal from '#components/BufferSearchModal.svelte';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { switchBuffer } from '#lib/stores/connectionManager.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    switchBuffer: vi.fn(async () => true),
}));

const components: Record<string, unknown>[] = [];

// Mount the real component and retain its owner so each test tears down its effects.
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}


// Build search results without needing an external WeeChat relay.
function channel(id: string, number: number): BufferData {
    return createBuffer({
        pointers: [id], full_name: `irc.${id}`, short_name: id, number,
        local_variables: { type: 'channel' },
    });
}

// Publish a buffer switch just as the model does, including its buffer-store notification.
function showBuffer(id: string, values: BufferData[]) {
    activeBufferId.set(id);
    buffers.set(Object.fromEntries(values.map(value => [value.id, value])));
    flushSync();
}

// Let promise continuations and nested animation frames finish without wall-clock waits.
async function settleFrames() {
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // These browser APIs are absent from jsdom; their behavior is not under test here.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: vi.fn() });
    showBuffer('', []);
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    showBuffer('', []);
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover');
});

it('selects the remaining search result on Enter after narrowing a keyboard selection', async () => {
    const values = [1, 2, 3, 4].map(i => channel(`channel-${i}`, i));
    showBuffer(values[0]!.id, values);
    const onBufferSelect = vi.fn();
    const target = render(BufferSearchModal, { onBufferSelect });
    const input = target.querySelector<HTMLInputElement>('input[placeholder="Search buffers..."]')!;
    for (let i = 0; i < 3; i++) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        flushSync();
    }
    input.value = 'channel-1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('.buffer-search-results button')).toHaveLength(1);

    // Capture the original event-handler exception as an assertion failure, not an unhandled jsdom error.
    const errors: string[] = [];
    const captureError = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault(); };
    window.addEventListener('error', captureError);
    try {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settleFrames();
        expect(errors).toEqual([]);
        expect(switchBuffer).toHaveBeenCalledWith('channel-1');
        expect(onBufferSelect).toHaveBeenCalledOnce();

        // A buffer can disappear while the search is open, without an input event.
        for (let i = 0; i < 3; i++) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            flushSync();
        }
        buffers.set({ [values[0]!.id]: values[0]! });
        flushSync();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settleFrames();
        expect(errors).toEqual([]);
        expect(switchBuffer).toHaveBeenLastCalledWith('channel-1');
        expect(onBufferSelect).toHaveBeenCalledTimes(2);

        buffers.set({});
        flushSync();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settleFrames();
        expect(errors).toEqual([]);
        expect(switchBuffer).toHaveBeenCalledTimes(2);
    } finally {
        window.removeEventListener('error', captureError);
    }
});
