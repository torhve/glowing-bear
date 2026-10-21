/**
 * Who owns the composer's focus across a send.
 *
 * A send that completes blurs the composer: the text is gone, so the composer has
 * no claim on focus. That rule is right when the reader pressed Enter and did
 * nothing else, and wrong when they pressed Enter and immediately reached for the
 * next message — then the blur from the finished send lands on a composer they are
 * typing in, which is what an intermittent E2E focus failure looked like.
 *
 * Delivery is deferred rather than resolved immediately, so "while the send is in
 * flight" is a state a test can actually occupy. Timing is not a substitute here:
 * a real relay round-trip is faster or slower depending on load, and a test that
 * raced it would pass or fail by accident.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { sendMessage } from '#lib/stores/connectionManager.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

const delivery = vi.hoisted(() => {
    const waiting: Array<(value: boolean) => void> = [];
    return {
        defer: () => new Promise<boolean>((resolve) => waiting.push(resolve)),
        /** Resolve every send still waiting on delivery. */
        settle(value: boolean) {
            const pending = waiting.splice(0);
            for (const resolve of pending) resolve(value);
        },
        /** Resolve only the oldest waiting send, so two overlapping sends can land
         * one at a time and a test can say which one landed. */
        settleOne(value: boolean) {
            waiting.shift()?.(value);
        },
    };
});

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => delivery.defer()),
    sendWeechatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    getActiveTransport: vi.fn(() => 'legacy'),
}));

const components: Record<string, unknown>[] = [];

function render(component: Component<Record<string, unknown>>) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props: {} }));
    flushSync();
    return target;
}

let bufferCounter = 0;
function openBuffer(): string {
    const id = `buf${++bufferCounter}`;
    const buffer: BufferData = createBuffer({
        pointers: [id],
        full_name: `irc.libera.#${id}`,
        short_name: `#${id}`,
        number: bufferCounter,
        local_variables: { type: 'channel' },
    });
    activeBufferId.set(id);
    buffers.set({ [id]: buffer });
    flushSync();
    return id;
}

function inputIn(target: HTMLElement): HTMLTextAreaElement {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    return input!;
}

/** Focus and type the way a reader does, so the composer holds both focus and text. */
function typeInto(target: HTMLElement, text: string): HTMLTextAreaElement {
    const input = inputIn(target);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return input;
}

// jsdom does not populate the deprecated keyCode/which the send handler reads.
function pressEnter(input: HTMLTextAreaElement) {
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: 13 });
    Object.defineProperty(e, 'which', { value: 13 });
    input.dispatchEvent(e);
    flushSync();
}

/** Let the deferred delivery resolve and the send's continuation run. */
async function settleSend(value: boolean) {
    delivery.settle(value);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
}

function focusedEl(): Element | null {
    return document.activeElement;
}

beforeEach(() => {
    vi.clearAllMocks();
    toastStore.set([]);
    setActiveConnectionProfile('relay.example', 443, '', true);
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    clearActiveConnectionProfile();
    resetConversationDrafts();
});

it('gives up focus when a send completes and the reader pressed nothing else', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'a message');
    expect(focusedEl(), 'the composer holds focus before Enter').toBe(input);

    pressEnter(input);
    await settleSend(true);

    expect(input.value, 'the send emptied the composer').toBe('');
    expect(focusedEl(), 'an emptied composer gives up focus').not.toBe(input);
});

it('leaves focus the reader took while the send was still in flight', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'first message');
    pressEnter(input);

    // The reader reaches for the next message before the round-trip finishes. This
    // focus is later than the send, so the completed send may not take it back.
    input.blur();
    input.focus();
    input.value = 'second message';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(focusedEl(), 'the reader holds the composer').toBe(input);

    await settleSend(true);

    expect(focusedEl(), 'a finished send blurred a composer being used for the next message').toBe(input);
    expect(input.value, 'the draft the reader typed during delivery is untouched').toBe('second message');
});

it('leaves a composer the reader kept focused and typed into during the send', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'first message');
    pressEnter(input);

    // Focus never left the textarea, so no focus event will ever report this reader:
    // the keystroke is the only evidence the composer is in use again.
    input.value = 'second message';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(focusedEl(), 'the composer held focus the whole time').toBe(input);

    await settleSend(true);

    expect(focusedEl(), 'a finished send blurred a composer the reader kept typing in').toBe(input);
    expect(input.value, 'the keystrokes that arrived during delivery are intact').toBe('second message');
});

it('does not let the first of two overlapping sends end the second one', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'first message');
    pressEnter(input);

    // A second send while the first is still flying (multi-line sends do this).
    input.value = 'second message';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    pressEnter(input);

    // The first send lands; the second is still in flight.
    delivery.settleOne(true);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    // The reader goes back to the composer while the second send is flying. If the
    // first landing declared the composer free, this focus is not recorded and the
    // second send's completion blur takes it away.
    input.blur();
    input.focus();
    flushSync();

    await settleSend(true);

    expect(focusedEl(), 'the first send ending handed the composer back while the second was still flying').toBe(input);
});

it('keeps focus on a failed send so the text can be corrected', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'a message');
    pressEnter(input);
    await settleSend(false);

    expect(focusedEl(), 'a failed send keeps focus where the correction has to happen').toBe(input);
    expect(input.value, 'the unsent text came back').toBe('a message');
});

it('starts the next send with a clean claim so the composer can still be given up', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    // First send: claimed during delivery, so it keeps focus.
    const input = typeInto(target, 'first message');
    pressEnter(input);
    input.value = 'typed during delivery';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await settleSend(true);
    expect(focusedEl(), 'the claimed send kept the composer').toBe(input);

    // Second send: nothing claims it. A claim that carried over would leave the
    // composer holding focus forever after an empty, finished send.
    input.value = 'second message';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    pressEnter(input);
    await settleSend(true);

    expect(input.value, 'the second send emptied the composer').toBe('');
    expect(focusedEl(), 'a later unclaimed send must still give up focus').not.toBe(input);
});

it('survives being torn down while a send is in flight', async () => {
    const target = render(InputBar as Component<Record<string, unknown>>);
    openBuffer();

    const input = typeInto(target, 'a message');
    pressEnter(input);

    // A disconnect tears the chat shell down mid-send. The completion lands on a
    // component that is already gone; it must not throw on the way out.
    await unmount(components.pop() as Record<string, unknown>);
    await settleSend(true);

    expect(input.isConnected, 'the composer node is gone').toBe(false);
});
