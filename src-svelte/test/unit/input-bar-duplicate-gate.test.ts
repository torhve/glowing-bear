/**
 * The duplicate-link gate in the composer.
 *
 * The rule this file pins: Enter asks, the answer decides, and nothing in between may
 * lose the reader's text. Every test here drives `InputBar` the way the browser does —
 * focus, type, Enter — and reads the result through the composer's own DOM and the
 * mocked transport's call list. No test reads `pendingDuplicate` or any other internal.
 *
 * Two things jsdom cannot do, and the tests say so rather than pretending:
 *
 *   - `showPopover()` is stubbed inert by `test/unit/setup.ts` and `:popover-open`
 *     matches nothing, so `isPopoverOpen()` is always false here. A popover's state is
 *     therefore never an assertion in this file; `src-svelte/e2e/specs/
 *     InputBar-duplicateLink.test.ts` covers the popover itself.
 *   - A closed `<dialog>` is not focusable in jsdom, so the dialog's Edit button never
 *     takes focus and a browser's "Enter activates the focused button" cannot be
 *     reproduced. The second-Enter test is written the hard way instead: Enter is
 *     dispatched straight at the composer, which is the worst case for the reader's
 *     text, and the composer still sends nothing.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { flushSync } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { sendMessage, sendWeeChatCommand } from '#lib/stores/connectionManager.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';
import { mountHarness } from './helpers/mountComponent.ts';

/** Flip to make the matcher throw, for the fail-open test. */
const scan = vi.hoisted(() => ({ fail: false }));

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    getActiveTransport: vi.fn(() => 'legacy'),
    requestLegacyCompletion: vi.fn(() => Promise.resolve([])),
}));

// Wrapped rather than replaced, so only the fail-open test diverges from the real matcher.
vi.mock('#lib/duplicateLinks.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/duplicateLinks.ts')>();
    const find = vi.fn((pending: string, lines: BufferLine[]) => {
        if (scan.fail) throw new Error('the scan exploded');
        return actual.findDuplicateLinks(pending, lines);
    });
    return { ...actual, findDuplicateLinks: find };
});

const { render, teardown, unmountLast } = mountHarness();

let bufferCounter = 0;

/** A buffer whose retained lines hold `link`, posted by `nick`. */
function openBuffer(link: string, nick = '<alice>'): string {
    const id = `buf${++bufferCounter}`;
    const buffer: BufferData = createBuffer({
        pointers: [id],
        full_name: `irc.libera.#${id}`,
        short_name: `#${id}`,
        number: bufferCounter,
        local_variables: { type: 'channel' },
    });
    buffer.lines = [
        plainLine(`older chatter in #${id}`),
        {
            ...plainLine(`earlier ${link} with a comment`),
            prefixtext: nick,
            shortTime: '09:12',
            date: 1700003520000,
        },
    ];
    activeBufferId.set(id);
    buffers.set({ [id]: buffer });
    flushSync();
    return id;
}

function plainLine(text: string): BufferLine {
    return {
        prefix: [],
        content: [],
        date: 1700000000,
        shortTime: '08:00',
        buffer: 'unknown',
        tags: [],
        highlight: false,
        displayed: true,
        prefixtext: '',
        text,
        showHiddenBrackets: false,
    };
}

function inputIn(target: HTMLElement): HTMLTextAreaElement {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    return input!;
}

// Type exactly as the browser does: focus, set value, fire the event `bind:value` listens to.
function typeInto(target: HTMLElement, text: string): HTMLTextAreaElement {
    const input = inputIn(target);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return input;
}

// jsdom does not populate the deprecated keyCode/which the composer's handler reads.
function pressEnter(input: HTMLTextAreaElement): void {
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: 13 });
    Object.defineProperty(event, 'which', { value: 13 });
    input.focus();
    input.dispatchEvent(event);
    flushSync();
}

async function pressEnterAndSettle(input: HTMLTextAreaElement): Promise<void> {
    pressEnter(input);
    // handleSend is async (Relay API delivery): let its awaits settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
}

function clickButton(target: HTMLElement, testid: string): void {
    const button = target.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
    expect(button, testid).toBeDefined();
    button!.click();
    flushSync();
}

function rows(target: HTMLElement): Element[] {
    return [...target.querySelectorAll('[data-testid="duplicate-link-row"]')];
}

function sentTexts(): string[] {
    return vi.mocked(sendMessage).mock.calls.map((call) => String(call[0]));
}

function noticeIn(target: HTMLElement): string | null {
    return target.querySelector('[data-testid="composer-notice"]')?.textContent ?? null;
}

beforeEach(() => {
    vi.clearAllMocks();
    scan.fail = false;
    vi.mocked(sendMessage).mockResolvedValue(true);
    setActiveConnectionProfile('relay.example', 443, '', true);
});

afterEach(async () => {
    await teardown();
    activeBufferId.set('');
    buffers.set({});
    clearActiveConnectionProfile();
    resetConversationDrafts();
    // The gate is on by default; a test that switched it off must not leave it off.
    updateSettings({ warnDuplicateLinks: true });
});

it('asks before sending a link this buffer already holds', async () => {
    openBuffer('https://x.dev/gb-gate-1/page');
    const target = render(InputBar, {});
    const input = typeInto(target, 'here is https://x.dev/gb-gate-1/page again');

    await pressEnterAndSettle(input);

    expect(sentTexts(), 'Enter must not deliver a link the buffer already has').toEqual([]);
    expect(vi.mocked(sendWeeChatCommand)).not.toHaveBeenCalled();
    expect(inputIn(target).value, 'a refusal may not take the text').toBe('here is https://x.dev/gb-gate-1/page again');

    const found = rows(target);
    expect(found, 'the dialog must name the earlier post').toHaveLength(1);
    const row = found[0]!.textContent ?? '';
    expect(row).toContain('<alice>');
    expect(row).toContain('09:12');
    expect(row).toContain('https://x.dev/gb-gate-1/page');
    expect(row).toContain('earlier https://x.dev/gb-gate-1/page with a comment');
});

it('sends nothing on a second Enter while the question is still open', async () => {
    openBuffer('https://x.dev/gb-gate-2/page');
    const target = render(InputBar, {});
    const input = typeInto(target, 'see https://x.dev/gb-gate-2/page');

    await pressEnterAndSettle(input);
    expect(rows(target)).toHaveLength(1);

    // The browser would hand this Enter to the dialog's focused Edit button. jsdom keeps
    // focus on the composer, because a closed `<dialog>` is unfocusable there, so this
    // dispatch is the harder case: Enter reaches the composer a second time.
    pressEnter(inputIn(target));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts(), 'a second Enter must not deliver the message either way').toEqual([]);
    expect(inputIn(target).value).toBe('see https://x.dev/gb-gate-2/page');
    expect(rows(target), 'the question stays open and is re-asked, not answered silently').toHaveLength(1);
});

it('keeps the exact text and sends nothing when the reader chooses Edit', async () => {
    openBuffer('https://x.dev/gb-gate-3/page');
    const target = render(InputBar, {});
    const text = 'look at https://x.dev/gb-gate-3/page ?';
    await pressEnterAndSettle(typeInto(target, text));

    clickButton(target, 'duplicate-link-edit');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts()).toEqual([]);
    expect(inputIn(target).value).toBe(text);
    expect(document.activeElement, 'Edit returns the caret to the composer').toBe(inputIn(target));
    expect(rows(target), 'closing empties the scan').toHaveLength(0);
});

it('sends the text exactly once when the reader chooses Send anyway', async () => {
    openBuffer('https://x.dev/gb-gate-4/page');
    const target = render(InputBar, {});
    const text = 'posting https://x.dev/gb-gate-4/page on purpose';
    await pressEnterAndSettle(typeInto(target, text));
    expect(sentTexts()).toEqual([]);

    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts(), 'the answer sends the scanned text once').toEqual([text]);
    expect(inputIn(target).value).toBe('');
    expect(rows(target)).toHaveLength(0);
});

it('sends straight away when the warning is switched off', async () => {
    updateSettings({ warnDuplicateLinks: false });
    openBuffer('https://x.dev/gb-gate-5/page');
    const target = render(InputBar, {});
    const text = 'posting https://x.dev/gb-gate-5/page without being asked';

    await pressEnterAndSettle(typeInto(target, text));

    expect(sentTexts()).toEqual([text]);
    expect(rows(target), 'no dialog when the reader turned the check off').toHaveLength(0);
});

it('judges a normal message but not a WeeChat command typed into this buffer', async () => {
    openBuffer('https://x.dev/gb-gate-6/page');
    const target = render(InputBar, {});

    // A `/msg` carries a link aimed at another conversation. Judging it against the
    // buffer it happens to be typed in would warn about a post this buffer never gets.
    const command = '/msg other https://x.dev/gb-gate-6/page';
    await pressEnterAndSettle(typeInto(target, command));

    expect(rows(target)).toHaveLength(0);
    expect(sentTexts()).toEqual([command]);

    // The same link typed as a message is judged, in the same composer instance.
    await pressEnterAndSettle(typeInto(target, 'and https://x.dev/gb-gate-6/page too'));
    expect(rows(target)).toHaveLength(1);
    expect(sentTexts(), 'the message is still held back').toEqual([command]);
});

it('keeps the text and sends nothing when the text changed while the dialog was open', async () => {
    openBuffer('https://x.dev/gb-gate-7/page');
    const target = render(InputBar, {});
    await pressEnterAndSettle(typeInto(target, 'see https://x.dev/gb-gate-7/page'));

    const edited = 'see https://x.dev/gb-gate-7/page — wait, different message';
    typeInto(target, edited);

    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts(), 'a scan of text the reader has since rewritten must not be sent').toEqual([]);
    expect(inputIn(target).value).toBe(edited);
    expect(rows(target)).toHaveLength(0);
    expect(noticeIn(target), 'the composer must explain the refusal it just made')
        .toContain('nothing was sent');
});

it('adds the message to neither buffer when the buffer changed while the dialog was open', async () => {
    const first = openBuffer('https://x.dev/gb-gate-8/page');
    const second: BufferData = createBuffer({
        pointers: ['buf-b'],
        full_name: 'irc.libera.#buf-b',
        short_name: '#buf-b',
        number: 99,
        local_variables: { type: 'channel' },
    });
    second.lines = [plainLine('the other conversation has its own lines')];
    buffers.set({ ...get(buffers), 'buf-b': second });
    flushSync();

    const target = render(InputBar, {});
    await pressEnterAndSettle(typeInto(target, 'see https://x.dev/gb-gate-8/page'));
    expect(rows(target)).toHaveLength(1);

    expect(setActiveBuffer('buf-b'), 'the switch the test arranges').toBe(true);
    flushSync();

    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts(), 'the pending scan belongs to a buffer that is no longer on screen').toEqual([]);
    expect((get(buffers)[first]?.lines ?? []).map((line) => line.text)).toEqual([
        `older chatter in #${first}`,
        'earlier https://x.dev/gb-gate-8/page with a comment',
    ]);
    expect((get(buffers)['buf-b']?.lines ?? []).map((line) => line.text))
        .toEqual(['the other conversation has its own lines']);
    expect(rows(target)).toHaveLength(0);
    expect(noticeIn(target), 'the composer must explain the refusal it just made')
        .toContain('nothing was sent');
});

it('keeps the text and says so when the conversation went away while the dialog was open', async () => {
    openBuffer('https://x.dev/gb-gate-9/page');
    const target = render(InputBar, {});
    const text = 'see https://x.dev/gb-gate-9/page';
    await pressEnterAndSettle(typeInto(target, text));

    // A dropped session empties the live buffer table, which is what the composer reads
    // liveness from, so this attempt is refused for the plain reason: there is no session
    // to send into.
    buffers.set({});
    flushSync();

    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(sentTexts()).toEqual([]);
    expect(noticeIn(target), 'the composer must explain the refusal it just made')
        .toContain('Not connected');
});

it('leaves no scan behind when the composer unmounts, so the next one asks again', async () => {
    openBuffer('https://x.dev/gb-gate-10/page');
    const text = 'see https://x.dev/gb-gate-10/page';

    const first = render(InputBar, {});
    await pressEnterAndSettle(typeInto(first, text));
    expect(rows(first)).toHaveLength(1);

    // A disconnect swaps the chat view for the connection form, unmounting the composer.
    void unmountLast();
    flushSync();

    const second = render(InputBar, {});
    expect(rows(second), 'a scan never survives the composer that made it').toHaveLength(0);
    expect(inputIn(second).value, 'the text survives, because it is the reader’s').toBe(text);

    await pressEnterAndSettle(inputIn(second));
    expect(sentTexts()).toEqual([]);
    expect(rows(second), 'the rebuilt composer re-asks rather than replaying the old answer').toHaveLength(1);
});

it('delivers the text when the scan itself fails', async () => {
    scan.fail = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    openBuffer('https://x.dev/gb-gate-11/page');
    const target = render(InputBar, {});
    const text = 'https://x.dev/gb-gate-11/page must still get through';

    await pressEnterAndSettle(typeInto(target, text));

    expect(sentTexts(), 'a duplicate check must never be the reason a message is not delivered').toEqual([text]);
    expect(rows(target)).toHaveLength(0);
    expect(inputIn(target).value).toBe('');
    errorLog.mockRestore();
});

it('clears the explanation when a later send answers it', async () => {
    openBuffer('https://x.dev/gb-gate-12/page');
    const target = render(InputBar, {});

    // Ask, then refuse the answer by editing the text: the refusal has to be readable.
    await pressEnterAndSettle(typeInto(target, 'see https://x.dev/gb-gate-12/page'));
    typeInto(target, 'see https://x.dev/gb-gate-12/page — edited while asked');
    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(noticeIn(target), 'the refusal must explain itself').toContain('nothing was sent');

    // A send that goes through is what answers that explanation.
    await pressEnterAndSettle(typeInto(target, 'nothing here is a link'));
    expect(sentTexts()).toEqual(['nothing here is a link']);
    expect(noticeIn(target), 'a send that landed may not leave the old refusal standing').toBeNull();
});

it('clears the explanation when the reader moves to another conversation', async () => {
    openBuffer('https://x.dev/gb-gate-13/page');
    const other: BufferData = createBuffer({
        pointers: ['buf-gate-13-other'],
        full_name: 'irc.libera.#gb-gate-13-other',
        short_name: '#gb-gate-13-other',
        number: 130,
        local_variables: { type: 'channel' },
    });
    buffers.set({ ...get(buffers), 'buf-gate-13-other': other });
    flushSync();

    const target = render(InputBar, {});
    await pressEnterAndSettle(typeInto(target, 'see https://x.dev/gb-gate-13/page'));
    typeInto(target, 'see https://x.dev/gb-gate-13/page — edited while asked');
    clickButton(target, 'duplicate-link-send-anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(noticeIn(target), 'the refusal must explain itself').toContain('nothing was sent');

    // The explanation belongs to the conversation it was raised in, not to wherever the
    // reader moved to.
    setActiveBuffer('buf-gate-13-other');
    flushSync();
    expect(noticeIn(target), 'a conversation the reader left keeps no explanation open').toBeNull();
    expect(sentTexts(), 'moving may not send anything either').toEqual([]);
});

it('clears the offline explanation once the relay answers again', async () => {
    const id = openBuffer('https://x.dev/gb-gate-14/page');
    const held = { ...get(buffers) };
    const target = render(InputBar, {});

    // No live conversation to send into, so Enter refuses and says why.
    buffers.set({});
    flushSync();
    await pressEnterAndSettle(typeInto(target, 'typed while the relay was gone'));
    expect(sentTexts()).toEqual([]);
    expect(noticeIn(target)).toContain('Not connected');

    // The relay answering again makes that explanation describe a connection that is gone.
    buffers.set(held);
    activeBufferId.set(id);
    flushSync();
    expect(noticeIn(target), 'a live composer may not keep the offline refusal').toBeNull();
});
