/**
 * What the composer does with each clipboard shape a paste can arrive as.
 *
 * `#lib/clipboardImages.ts` decides what the clipboard holds; these tests are about the
 * handler's own decisions, which no browser-level test can reach deterministically:
 * whether the event was consumed, whether the composer or the preview took the content,
 * and what happens when the clipboard carries neither image nor text.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

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

const components: Record<string, unknown>[] = [];

function render(component: Component<Record<string, unknown>>): HTMLElement {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props: {} }));
    flushSync();
    return target;
}

function openConversation(name: string): void {
    const buffer: BufferData = createBuffer({
        pointers: [name],
        full_name: `irc.libera.#${name}`,
        short_name: `#${name}`,
        number: 1,
        local_variables: { type: 'channel' },
    });
    buffers.update((current) => ({ ...current, [name]: buffer }));
    setActiveBuffer(name);
    flushSync();
}

function inputIn(target: HTMLElement): HTMLTextAreaElement {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    return input!;
}

interface FakeItem {
    kind: string;
    type: string;
    getAsFile: () => File | null;
    getAsString: (callback: (value: string | null) => void) => void;
}

/**
 * Dispatch a paste on the composer, or on the document when `global` is set — the
 * document listener is what catches a paste while focus is somewhere else.
 */
function paste(data: {
    files?: File[];
    items?: FakeItem[] | null;
    text?: string;
}, target: HTMLElement, global = false): Event {
    const clipboardData = {
        files: data.files ?? [],
        items: data.items
            ? Object.assign(data.items.slice(), { length: data.items.length })
            : null,
        getData: (kind: string) => (kind.startsWith('text') ? (data.text ?? '') : ''),
    };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    if (global) {
        inputIn(target).blur();
        document.dispatchEvent(event);
    } else {
        inputIn(target).focus();
        inputIn(target).dispatchEvent(event);
    }
    flushSync();
    return event;
}

/** A `FileReader` that records reads and lets the test decide when they land. */
class RecordingFileReader {
    static reads: RecordingFileReader[] = [];

    result = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
        RecordingFileReader.reads.push(this);
    }

    /**
     * The one read this test expects. Reading `reads[0]` directly is `undefined` under
     * `noUncheckedIndexedAccess`, and naming the broken invariant here is a better
     * failure than a suppressed type error.
     */
    static sole(): RecordingFileReader {
        const [only] = RecordingFileReader.reads;
        if (!only) {
            throw new Error(`expected exactly one FileReader read, got ${RecordingFileReader.reads.length}`);
        }
        return only;
    }

    readAsDataURL(): void {
        /* the read is started; the test finishes it */
    }

    finish(result: string): void {
        this.result = result;
        this.onload?.();
    }
}

const realFileReader = globalThis.FileReader;

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    flushSync();
}

function imageFile(name = 'shot.png'): File {
    return new File([new Uint8Array([1])], name, { type: 'image/png' });
}

beforeEach(() => {
    vi.clearAllMocks();
    toastStore.set([]);
    setActiveConnectionProfile('relay.example', 443, '', true);
    RecordingFileReader.reads = [];
    vi.stubGlobal('FileReader', RecordingFileReader);
    // jsdom has no object URLs; the preview only needs one per file.
    vi.stubGlobal('URL', Object.assign(URL, {
        createObjectURL: () => 'blob:preview',
        revokeObjectURL: () => undefined,
    }));
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    clearActiveConnectionProfile();
    resetConversationDrafts();
    vi.unstubAllGlobals();
    globalThis.FileReader = realFileReader;
});

it('previews an image the clipboard gave as a Firefox file', async () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ files: [imageFile()], items: null, text: '' }, target);
    expect(event.defaultPrevented, 'a paste that became an image is consumed').toBe(true);
    expect(RecordingFileReader.reads).toHaveLength(1);

    RecordingFileReader.sole().finish('data:image/png;base64,AAA');
    await settle();

    expect(target.querySelector('[data-testid="preview-item"]')).not.toBeNull();
    expect(inputIn(target).value, 'an image paste does not write text into the composer').toBe('');
});

it('previews an image Chrome handed over as a file, without reading it first', async () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste(
        {
            items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile(), getAsString: (cb) => cb(null) }],
            text: '',
        },
        target
    );
    expect(event.defaultPrevented).toBe(true);
    expect(RecordingFileReader.reads, 'a file the clipboard already produced needs no read').toHaveLength(0);

    await settle();
    expect(target.querySelector('[data-testid="preview-item"]')).not.toBeNull();
});

it('leaves a clipboard with neither image nor text to the browser', () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ items: [], text: '' }, target);

    // Nothing was inserted, and the default survived: a clipboard reporting no text is
    // the browser's to interpret, and preventing it would swallow an HTML-only paste.
    expect(event.defaultPrevented).toBe(false);
    expect(inputIn(target).value).toBe('');
});

it('consumes a text paste and puts it at the caret', () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ items: [], text: 'hello there' }, target);

    expect(event.defaultPrevented, 'the handler inserts the text itself').toBe(true);
    expect(inputIn(target).value).toBe('hello there');
});

it('asks about a multi-line paste instead of inserting it', () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ items: [], text: 'one\ntwo\nthree' }, target);

    expect(event.defaultPrevented).toBe(true);
    expect(target.querySelector('[data-testid="multiline-paste-preview"]')?.textContent).toContain('one');
    expect(inputIn(target).value).toBe('');
});

it('leaves a global paste alone when the clipboard carries an image', () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ files: [imageFile()], items: null, text: 'a caption' }, target, true);

    // Focus is elsewhere, so the composer must not take the event, and the image must
    // not be read for a paste this handler is rejecting.
    expect(event.defaultPrevented).toBe(false);
    expect(inputIn(target).value).toBe('');
    expect(RecordingFileReader.reads).toHaveLength(0);
    expect(target.querySelector('[data-testid="preview-item"]')).toBeNull();
});

it('takes a global text paste into the composer', () => {
    const target = render(InputBar);
    openConversation('first');

    const event = paste({ items: [], text: 'typed elsewhere' }, target, true);

    expect(event.defaultPrevented).toBe(true);
    expect(inputIn(target).value).toBe('typed elsewhere');
});
