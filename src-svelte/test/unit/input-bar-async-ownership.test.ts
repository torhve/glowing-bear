import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { readDraft, resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

// The upload is mocked at its network boundary so the test drives the real preview
// dialog and its real insert callback, with only Imgur replaced.
vi.mock('#lib/imgur.ts', () => ({
    uploadImage: vi.fn(() => Promise.resolve({ link: 'https://img.example/kept.png', deletehash: 'dh' })),
    deleteImage: vi.fn(() => Promise.resolve()),
}));

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    getActiveTransport: vi.fn(() => 'legacy'),
}));

const RELAY = 'https://relay.example:443';

const components: Record<string, unknown>[] = [];

function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

function openConversation(name: string, nicks: string[] = []): string {
    const fullName = `irc.libera.#${name}`;
    const buffer: BufferData = createBuffer({
        pointers: [name],
        full_name: fullName,
        short_name: `#${name}`,
        number: 1,
        local_variables: { type: 'channel' },
    });
    buffer.nicklist = {
        '000': {
            group: '000',
            nicks: nicks.map((nick, index) => ({
                name: nick,
                visible: 1,
                sortingKey: nick.toLowerCase(),
                prefix: '',
                prefixColor: '',
                color: 0,
                active: 1,
                spokeAt: nicks.length - index,
            })),
        },
    };
    buffers.update((current) => ({ ...current, [name]: buffer }));
    setActiveBuffer(name);
    flushSync();
    return fullName;
}

function inputIn(target: HTMLElement): HTMLTextAreaElement {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    return input!;
}

function click(target: HTMLElement, testid: string): void {
    const button = target.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
    expect(button, `${testid} button`).toBeDefined();
    button!.click();
    flushSync();
}

/**
 * Dispatch a paste the way the browser does. jsdom gives a ClipboardEvent no
 * clipboardData, so the DataTransfer the handler reads is attached by hand.
 */
function paste(target: HTMLElement, data: {
    files: File[];
    items: Array<{ kind: string; type: string; getAsFile: () => File | null; getAsString: (cb: (s: string | null) => void) => void }> | null;
    text: string;
}): void {
    const input = inputIn(target);
    input.focus();
    const clipboardData = {
        files: data.files,
        items: data.items,
        getData: (kind: string) => (kind.startsWith('text') ? data.text : ''),
    };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(event);
    flushSync();
}

function pasteText(target: HTMLElement, text: string): void {
    paste(target, { files: [], items: null, text });
}

function pasteImage(target: HTMLElement): void {
    paste(target, {
        files: [],
        items: [{
            kind: 'file',
            type: 'image/png',
            getAsFile: () => null,
            getAsString: (cb) => cb('data:image/png;base64,iVBORw0KGgo='),
        }],
        text: '',
    });
}

// The paste handler awaits clipboard reads of its own, so a test has to let both its
// promise chain and Svelte's flush finish.
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    flushSync();
}

function multilinePreviewText(target: HTMLElement): string {
    return target.querySelector('[data-testid="multiline-paste-preview"]')?.textContent ?? '';
}

function draftOf(conversationKey: string): string {
    return readDraft({ profileKey: RELAY, conversationKey })?.text ?? '';
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

it('inserts a multi-line paste confirmed in its own conversation', () => {
    const target = render(InputBar, {});
    openConversation('first');

    pasteText(target, 'one\ntwo\nthree');
    expect(multilinePreviewText(target)).toContain('one');

    click(target, 'multiline-paste-join');
    expect(inputIn(target).value).toBe('one two three');
});

it('cancels a multi-line confirmation when the reader switches conversations', () => {
    const target = render(InputBar, {});
    const first = openConversation('first');

    pasteText(target, 'one\ntwo\nthree');
    expect(multilinePreviewText(target)).toContain('one');

    openConversation('second');

    // Nothing was inserted into the conversation the reader moved to, and the
    // question the old conversation asked is no longer on screen. The paste itself
    // was never accepted, so it is discarded rather than silently committed to
    // either draft.
    expect(inputIn(target).value).toBe('');
    expect(multilinePreviewText(target)).toBe('');
    expect(draftOf(first)).toBe('');
});

it('files upload links in the conversation they were pasted into', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');

    pasteImage(target);
    await settle();
    expect(target.querySelector('[data-testid="preview-item"]')).not.toBeNull();

    // The reader moves on while the preview is still waiting to be uploaded.
    openConversation('second');

    click(target, 'upload-all-button');
    await settle();

    expect(inputIn(target).value).toBe('');
    expect(draftOf(first)).toBe('https://img.example/kept.png');
});

it('appends upload links to whatever its draft says now', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');

    // The conversation already holds text when the image is pasted.
    const before = inputIn(target);
    before.focus();
    before.value = 'half a message';
    before.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    pasteImage(target);
    await settle();

    openConversation('second');
    click(target, 'upload-all-button');
    await settle();

    // The link joins its own conversation's current text, and the conversation the
    // reader is looking at is untouched.
    expect(inputIn(target).value).toBe('');
    expect(draftOf(first)).toBe('half a message https://img.example/kept.png');
});

it('applies the same claim to the clickable completion control', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first', ['alice', 'bob']);

    const input = inputIn(target);
    input.focus();
    input.value = 'ali';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    click(target, 'nick-complete-button');
    // The reader switches while the completion is being computed.
    openConversation('second');
    await tick();
    flushSync();

    expect(inputIn(target).value).toBe('');
    expect(draftOf(first)).toBe('alice: ');
});
