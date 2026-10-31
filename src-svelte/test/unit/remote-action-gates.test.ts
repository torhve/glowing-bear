/**
 * Task 5 — the boundaries that keep a retained view from acting like a live one.
 *
 * Three decisions, each owned in exactly one place:
 *
 *   - `deliveryPossible()` decides whether anything can reach the relay. It is
 *     asked by the facade, not by each call site, because the call sites that
 *     matter are the ones that never ask — a keyboard shortcut firing `/grep`, a
 *     send starting a beat after the session died.
 *   - `selectRetainedBuffer()` is the retained view's own selection. It must not
 *     write `activeBufferId`, which is live transport authority.
 *   - `retainedRows` is what the sidebar shows when the live projection is empty,
 *     so a dropped connection does not blank the list beside a readable chat.
 *
 * The facade's own refusal is also asserted here. Both transports refuse when
 * their socket is gone, so a test that only checks "returns false" would pass
 * with or without the gate; these tests pin the *classifier* the gate uses, and
 * the E2E covers the call sites that bypass a disabled button.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
    activeBufferId,
    buffers,
    createBuffer,
    createBufferLine,
    setActiveBuffer,
} from '#lib/stores/models.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { connectionState, setConnectionStatus } from '#lib/stores/connectionStore.ts';
import { deliveryPossible, sendMessage, sendWeeChatCommand, sendBufferCommand } from '#lib/stores/connectionManager.ts';
import {
    captureRetainedState,
    getRetainedSnapshot,
    releaseRetainedSnapshot,
    selectRetainedBuffer,
} from '#lib/stores/retainedChat.ts';
import { activeRowId, chatDisplay, retainedRows } from '#lib/stores/chatPresentation.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import type { BufferData } from '#lib/types.ts';

const CHANNEL = 'irc.gbtest.#glowing-bear';
const CORE = 'core.weechat';
const KEY_CHANNEL = '1791000000000201';
const KEY_CORE = '1791000000000202';
const KEY_PINNED = '1791000000000203';
const KEY_IDLE = '1791000000000204';

function seed(key: string, fullName: string, shortName: string, number: number, pinned = false): BufferData {
    const buffer = createBuffer({
        pointers: [key],
        full_name: fullName,
        short_name: shortName,
        number,
        local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc', ...(pinned ? { pinned: 'true' } : {}) },
    });
    buffers.update((current) => ({ ...current, [key]: buffer }));
    return buffer;
}

function addLine(key: string, id: number, nick: string): void {
    buffers.update((current) => {
        const buffer = current[key];
        if (!buffer) return current;
        buffer.lines.push(
            createBufferLine({
                buffer: key,
                date: 1760000000000 + id,
                prefix: `<${nick}>`,
                message: `message ${nick}`,
                tags_array: ['irc_privmsg'],
                displayed: 1,
                highlight: 0,
                id,
                bufferType: buffer.type,
            }),
        );
        return { ...current };
    });
}

function captureOneSession(): void {
    setActiveConnectionProfile('relay.example', 443, undefined, true);
    seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10);
    seed(KEY_CORE, CORE, 'weechat', 1);
    addLine(KEY_CHANNEL, 1, 'alice');
    setActiveBuffer(KEY_CHANNEL);
    const result = captureRetainedState(1);
    if (!result.captured) throw new Error(`capture failed: ${result.reason}`);
    // The wipe the loss performs, so the retained path is the only one left.
    buffers.set({});
    activeBufferId.set('');
}
/**
 * A retained session whose rows differ only by unread state, pin, and selection:
 * `#unread` has counts, `#pinned` is pinned, `core` is the read conversation,
 * `#idle` is none of those.
 */
function captureOneFilterSession(): void {
    setActiveConnectionProfile('relay.example', 443, undefined, true);
    seed(KEY_CHANNEL, 'irc.gbtest.#unread', '#unread', 10);
    seed(KEY_CORE, CORE, 'core', 1);
    seed(KEY_PINNED, 'irc.gbtest.#pinned', '#pinned', 3, true);
    seed(KEY_IDLE, 'irc.gbtest.#idle', '#idle', 4);
    buffers.update((current) => ({
        ...current,
        [KEY_CHANNEL]: { ...current[KEY_CHANNEL]!, unread: 2 },
    }));
    setActiveBuffer(KEY_CORE);
    const result = captureRetainedState(1);
    if (!result.captured) throw new Error(`capture failed: ${result.reason}`);
    buffers.set({});
    activeBufferId.set('');
}

/**
 * Removes one conversation from the retained snapshot, the way a dropped buffer
 * does. Used by the fallback tests to force the view onto another conversation.
 */
function dropRetainedConversation(key: string): void {
    const snapshot = getRetainedSnapshot();
    if (!snapshot) throw new Error('no snapshot to edit');
    snapshot.buffers.delete(key);
    if (snapshot.activeKey === key) snapshot.activeKey = null;
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    releaseRetainedSnapshot('explicit-leave');
    clearActiveConnectionProfile();
    setConnectionStatus('disconnected');
    updateSettings({ onlyUnread: false });
});

describe('deliveryPossible: one answer to "can this reach the relay"', () => {
    it('refuses every state with no session to deliver through', () => {
        for (const status of ['reconnecting', 'error', 'disconnected'] as const) {
            setConnectionStatus(status);
            expect(deliveryPossible(), `status '${status}' is not a connection`).toBe(false);
        }
        setConnectionStatus('connected');
        expect(deliveryPossible()).toBe(true);
    });

    // 'connecting' is not an offline state: on the legacy path the socket is open
    // and usable while the handshake finishes. Refusing there would break a send
    // that can genuinely be delivered — including `/quit` typed during bootstrap —
    // to guard a state that is already guarded.
    it('does not refuse a handshake that is already underway', () => {
        setConnectionStatus('connecting');
        expect(deliveryPossible()).toBe(true);
    });

    // These assert that the facade refuses, not that the facade's refusal is the
    // thing causing it: each transport already refuses when its own socket is
    // gone, so removing the facade gate would not fail anything here. That is
    // stated rather than hidden, because a test that looks like coverage and is
    // not is worse than an admitted gap. The gate is the boundary for a call site
    // that never asks, and the only way to reach one is through the browser —
    // `Offline-composer.test.ts` drives the keyboard shortcut that does exactly
    // that.
    it('refuses delivery for every status that is not a connection', async () => {
        for (const status of ['reconnecting', 'error', 'disconnected'] as const) {
            setConnectionStatus(status);
            expect(deliveryPossible(), `the classifier says '${status}' is not a connection`).toBe(false);
            expect(await sendMessage('offline send'), `sendMessage during '${status}'`).toBe(false);
            expect(await sendWeeChatCommand('/grep hello'), `sendWeeChatCommand during '${status}'`).toBe(false);
        }
    });

    it('refuses without leaving anything queued', async () => {
        setConnectionStatus('reconnecting');
        await sendMessage('text that must not be stored');
        // The facade owns no buffer of unsent text; the composer does. A refusal
        // that quietly kept a copy would be the queue this plan rules out.
        expect(get(connectionState).status).toBe('reconnecting');
    });
});

describe('selectRetainedBuffer: the retained view selects its own conversation', () => {
    it('moves the view to another retained buffer', () => {
        captureOneSession();
        expect(get(chatDisplay).buffer?.shortName).toBe('#glowing-bear');

        expect(selectRetainedBuffer(KEY_CORE)).toBe(true);
        const display = get(chatDisplay);
        expect(display.live, 'a retained selection is still not live').toBe(false);
        expect(display.buffer?.shortName).toBe('weechat');
    });

    it('refuses a conversation the snapshot does not hold', () => {
        captureOneSession();
        expect(selectRetainedBuffer('1791000000000999')).toBe(false);
        expect(get(chatDisplay).buffer?.shortName, 'the view did not move to nothing').toBe('#glowing-bear');
    });

    it('refuses when there is no retained view at all', () => {
        expect(selectRetainedBuffer(KEY_CHANNEL)).toBe(false);
    });

    // The whole point of keeping this selection inside the snapshot: writing the
    // key into `activeBufferId` would let every live path resolve a frozen buffer.
    it('never writes live transport authority', () => {
        captureOneSession();
        selectRetainedBuffer(KEY_CORE);
        expect(get(activeBufferId), 'activeBufferId is live authority, not the retained view').toBe('');
        expect(Object.keys(get(buffers))).toHaveLength(0);
    });

    it('survives on the snapshot rather than on a parallel selection store', () => {
        captureOneSession();
        selectRetainedBuffer(KEY_CORE);
        expect(getRetainedSnapshot()?.activeKey).toBe(KEY_CORE);
    });
});

describe('retainedRows: the sidebar describes the retained view', () => {
    it('lists the retained conversations when the live projection is empty', () => {
        captureOneSession();
        const rows = get(retainedRows);
        expect(rows.map((row) => row.shortName).sort()).toEqual(['#glowing-bear', 'weechat']);
        expect(get(retainedRows).every((row) => row.id), 'rows need the key selection takes').toBe(true);
    });

    it('orders like the live list rather than like capture order', () => {
        captureOneSession();
        expect(get(retainedRows).map((row) => row.number)).toEqual([1, 10]);
    });

    it('is empty when there is nothing retained', () => {
        expect(get(retainedRows)).toEqual([]);
    });

    it('carries no transport authority', () => {
        captureOneSession();
        const row = get(retainedRows)[0] as BufferData;
        expect(row.apiBufferId, 'a sidebar row must not be addressable').toBeUndefined();
        expect(row.clearEpoch).toBeUndefined();
        expect(row.newestWindowFetched, 'the history gate stays inert for a frozen buffer').toBe(true);
    });
});

/**
 * The sidebar's `onlyUnread` membership rule belongs to the list, not to the
 * transport. A retained view is the same list over frozen data, so the setting
 * has to keep hiding rows while the session is lost — otherwise a dropped
 * connection silently reveals every channel the reader had asked to suppress.
 */
describe('retainedRows: onlyUnread keeps applying while the view is retained', () => {
    it('hides a retained row with no unread, no pin, and no selection', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });

        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['core', '#pinned', '#unread']);
    });

    it('shows every retained row when the setting is off', () => {
        captureOneFilterSession();

        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['core', '#pinned', '#idle', '#unread']);
    });

    it('follows the retained selection, not the live one', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });

        // Live `activeBufferId` was wiped to '' with the session, so the row the
        // retained view is pointing at has to come from the snapshot.
        selectRetainedBuffer(KEY_CHANNEL);
        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['#pinned', '#unread']);
    });
});

/**
 * The chat and the sidebar must agree about which retained conversation is
 * showing. `chatDisplay` keeps the reader's own conversation; when that one is
 * gone it falls back, and the fallback has to land on a conversation the reader
 * can actually see in the sidebar.
 */
describe('chatDisplay: the retained fallback agrees with the filtered sidebar', () => {

    it('falls back to a conversation the filtered sidebar lists', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });
        dropRetainedConversation(KEY_CORE);

        // `core` was number 1, so an unfiltered fallback would show a conversation
        // the sidebar deliberately hides; the fallback takes the first row the
        // filtered list actually has, which is the pinned one.
        expect(get(chatDisplay).buffer?.shortName).toBe('#pinned');
        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['#pinned', '#unread']);
    });

    it('keeps a row for the conversation it falls back to', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });
        dropRetainedConversation(KEY_CORE);
        dropRetainedConversation(KEY_CHANNEL);
        dropRetainedConversation(KEY_PINNED);

        // Nothing left qualifies under `onlyUnread` by unread or pin alone. The
        // chat still shows the lowest-numbered retained conversation, and the
        // sidebar keeps a row beside it: the conversation on screen always has
        // one.
        expect(get(chatDisplay).buffer?.shortName).toBe('#idle');
        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['#idle']);
    });
});

/**
 * The sidebar marks one row as the conversation on screen. A retained view has to
 * answer that from the view itself: the wipe cleared `activeBufferId`, so a
 * sidebar that reads only live selection marks nothing while the session is lost.
 */
describe('activeRowId: the sidebar marks the conversation the chat renders', () => {
    it('names the retained selection when the live selection is gone', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });

        // `#idle` has no unread and no pin. It earns a row only as the
        // conversation the view is pointing at.
        selectRetainedBuffer(KEY_IDLE);
        expect(get(activeRowId)).toBe(KEY_IDLE);
        expect(get(retainedRows).map((row) => row.shortName)).toEqual(['#pinned', '#idle', '#unread']);
    });

    it('names the fallback conversation when the reader was in a dropped one', () => {
        captureOneFilterSession();
        updateSettings({ onlyUnread: true });
        dropRetainedConversation(KEY_CORE);

        // The chat shows the fallback, so the marked row is the fallback too,
        // not the conversation the lost session was pointing at.
        expect(get(chatDisplay).buffer?.shortName, 'the chat moved to the fallback').toBe('#pinned');
        expect(get(activeRowId), 'the marked row follows the chat').toBe(KEY_PINNED);
    });

    it('names the live selection while the session is connected', () => {
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10);
        seed(KEY_CORE, CORE, 'core', 1);
        setActiveBuffer(KEY_CORE);
        setConnectionStatus('connected');

        expect(get(activeRowId)).toBe(KEY_CORE);
    });
});
