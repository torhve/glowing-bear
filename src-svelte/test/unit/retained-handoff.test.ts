/**
 * Task 6 — handing the retained window to a new session.
 *
 * The defect this exists for is invisible from the UI until it bites twice. A
 * successful reconnect used to leave the snapshot in place: nothing released it,
 * and `captureRetainedState` refuses a second capture while one exists. So the
 * NEXT outage re-displayed the FIRST outage's transcript — the conversation the
 * user had been reading since reconnecting was replaced by an older one. Every
 * spec here is about that boundary.
 *
 * The other half is identity. Only a buffer whose store key is present in the
 * new authoritative list is seeded. A relay that rebuilt its buffers hands back
 * different instances under the same names, and 4.10.1 line ids restart from a
 * low counter, so merging by name would delete real lines.
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
import {
    applyRetainedHandoff,
    captureRetainedState,
    getRetainedSnapshot,
    retainedBufferCount,
} from '#lib/stores/retainedChat.ts';
import { historyOutcomes, historyUnavailable, setHistoryOutcome, clearHistoryOutcomes } from '#lib/stores/historyState.ts';
import { getActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { conversationKeyFor, readDraft, writeDraft, resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

const CHANNEL = 'irc.gbtest.#glowing-bear';
const CORE = 'core.weechat';
const KEY_CHANNEL = '1791000000000401';
const KEY_CORE = '1791000000000402';
const KEY_GONE = '1791000000000403';

function seed(key: string, fullName: string, shortName: string, number: number, lineCount = 0): BufferData {
    const buffer = createBuffer({
        pointers: [key],
        full_name: fullName,
        short_name: shortName,
        number,
        local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
    });
    for (let i = 1; i <= lineCount; i++) {
        buffer.lines.push(
            createBufferLine({
                buffer: key,
                date: 1760000000000 + i,
                prefix: `<nick${i}>`,
                message: `message ${i}`,
                tags_array: ['irc_privmsg'],
                displayed: 1,
                highlight: 0,
                id: i,
                bufferType: buffer.type,
            }),
        );
    }
    buffers.update((current) => ({ ...current, [key]: buffer }));
    return buffer;
}

/** Freeze a session, then perform the wipe a loss performs. */
function loseSession(): void {
    const result = captureRetainedState(1);
    if (!result.captured) throw new Error(`capture failed: ${result.reason}`);
    buffers.set({});
    activeBufferId.set('');
}

/** A new session publishes its authoritative buffer list. */
function bootstrap(keys: string[]): void {
    for (const key of keys) {
        const known = key === KEY_GONE ? null : key;
        if (!known) continue;
        const fullName = key === KEY_CORE ? CORE : CHANNEL;
        const shortName = key === KEY_CORE ? 'weechat' : '#glowing-bear';
        seed(key, fullName, shortName, key === KEY_CORE ? 1 : 10, 0);
    }
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    applyRetainedHandoff(); // release anything a previous test left behind
    clearActiveConnectionProfile();
    clearHistoryOutcomes();
});

describe('applyRetainedHandoff: a reconnect ends the snapshot', () => {
    it('releases the snapshot, so the next loss captures the current session', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();
        expect(retainedBufferCount()).toBe(1);

        bootstrap([KEY_CHANNEL, KEY_CORE]);
        const outcome = applyRetainedHandoff();

        expect(outcome?.seeded, 'the conversation was carried into the new session').toBe(1);
        expect(getRetainedSnapshot(), 'a snapshot that outlives its session reappears on the next loss').toBeNull();
    });

    it('is a no-op with nothing retained, and cannot run twice', () => {
        expect(applyRetainedHandoff()).toBeNull();

        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 1);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();
        bootstrap([KEY_CHANNEL]);
        expect(applyRetainedHandoff()).not.toBeNull();
        expect(applyRetainedHandoff(), 'the second call has no snapshot to hand off').toBeNull();
    });

    it('carries the last conversation the reader was in, not the first retained one', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 1);
        seed(KEY_CORE, CORE, 'weechat', 1, 1);
        setActiveBuffer(KEY_CORE); // the reader browsed to core before the loss
        loseSession();

        bootstrap([KEY_CHANNEL, KEY_CORE]);
        const outcome = applyRetainedHandoff();

        expect(outcome?.activeKey).toBe(KEY_CORE);
        expect(outcome?.fellBack, 'the conversation survived, so no fallback was needed').toBe(false);
        expect(get(activeBufferId)).toBe(KEY_CORE);
    });

    it('falls back to a live conversation when the retained one is gone', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 2);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        // The new session has core but not the channel: the conversation closed.
        bootstrap([]);
        seed(KEY_CORE, CORE, 'weechat', 1, 0);
        const outcome = applyRetainedHandoff();

        expect(outcome?.closedOnServer).toBe(1);
        expect(outcome?.fellBack).toBe(true);
        expect(outcome?.activeKey).toBe(KEY_CORE);
        expect(getRetainedSnapshot()).toBeNull();
    });
});

describe('seeding: only an instance the new session actually has', () => {
    it('merges the retained window into the live buffer', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        bootstrap([KEY_CHANNEL]);
        applyRetainedHandoff();

        const lines = get(buffers)[KEY_CHANNEL].lines;
        expect(lines.map((line) => line.text)).toEqual(['message 1', 'message 2', 'message 3']);
        expect(new Set(lines.map((line) => line.lineId)).size, 'one row per line').toBe(3);
    });

    it('does not duplicate a line the new session already fetched', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        // Bootstrap published the same lines before the handoff ran.
        buffers.set({});
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        applyRetainedHandoff();

        const lines = get(buffers)[KEY_CHANNEL].lines;
        expect(lines, 'a recycled line id must not render the same row twice').toHaveLength(3);
    });

    it('refuses to seed a buffer the new session does not have under that key', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        // Same name, different instance: a rebuilt relay. Seeding by name would
        // merge a frozen window into a buffer whose line ids restarted.
        seed(KEY_GONE, CHANNEL, '#glowing-bear', 10, 1);
        const rebuilt = get(buffers)[KEY_GONE];
        expect(rebuilt.lines).toHaveLength(1);

        const outcome = applyRetainedHandoff();
        expect(outcome?.seeded, 'identity is the store key, not the conversation name').toBe(0);
        expect(get(buffers)[KEY_GONE].lines).toHaveLength(1);
    });

    it('claims nothing about this session: a retained window is not a fetch', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 4);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        bootstrap([KEY_CHANNEL]);
        applyRetainedHandoff();

        const buffer = get(buffers)[KEY_CHANNEL];
        expect(buffer.lines, 'the transcript continues across the outage').toHaveLength(4);
        // Counting the seeded window as this session's fetch is what closed the
        // history gate after an overnight outage: the buffer held a full stale
        // window, the gate read it as "already requested enough", and the lines
        // that arrived while the app was away were never asked for.
        expect(buffer.requestedLines, 'holding lines is not the same as fetching them').toBe(0);
        expect(buffer.newestWindowFetched, 'the frozen window is the window as of the outage').toBe(false);
        expect(buffer.allLinesFetched, 'completeness belongs to this session, not the frozen window').toBe(false);
    });
    it('seeds the seen-set so a replayed line cannot render twice later', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        bootstrap([KEY_CHANNEL]);
        applyRetainedHandoff();

        const buffer = get(buffers)[KEY_CHANNEL];
        const seen = [...(buffer.lineIdsSeen ?? [])];
        expect(seen.length, 'the seeded window is what the replay guard knows about').toBe(3);
        expect(new Set(seen)).toEqual(new Set(buffer.lines.map((line) => line.lineId)));
    });
});

describe('history outcomes do not cross a generation', () => {
    it('records what a request did rather than inferring it from line counts', () => {
        setHistoryOutcome(KEY_CHANNEL, 'failed');
        expect(get(historyOutcomes)[KEY_CHANNEL]).toBe('failed');

        // A new session can reuse the id. An outcome from the dead one must not
        // describe a buffer that never existed in this generation.
        clearHistoryOutcomes();
        expect(get(historyOutcomes)[KEY_CHANNEL], 'absent is not the same as failed').toBeUndefined();
    });

    it('does not churn the store when the outcome is unchanged', () => {
        setHistoryOutcome(KEY_CHANNEL, 'loading');
        const before = get(historyOutcomes);
        setHistoryOutcome(KEY_CHANNEL, 'loading');
        expect(get(historyOutcomes)).toBe(before);
    });
});

describe('reading anchor and drafts across the handoff', () => {
    it('carries the reading anchor when the new session has none of its own', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        const original = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        // The reader was partway down: the boundary sits on the second line.
        original.readBoundaryKnown = true;
        original.readBoundaryId = original.lines[1].lineId;
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        bootstrap([KEY_CHANNEL]);
        applyRetainedHandoff();

        const buffer = get(buffers)[KEY_CHANNEL];
        expect(buffer.readBoundaryId, 'the reader lands where they left off, not at the bottom').toBe(original.lines[1].lineId);
        expect(buffer.readBoundaryKnown).toBe(true);
    });

    it('lets a live boundary outrank a remembered one', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        const original = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 3);
        original.readBoundaryKnown = true;
        original.readBoundaryId = original.lines[0].lineId;
        setActiveBuffer(KEY_CHANNEL);
        loseSession();

        bootstrap([KEY_CHANNEL]);
        // This session already fetched lines and resolved a boundary of its own
        // before the handoff ran.
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 2);
        const liveAnchor = get(buffers)[KEY_CHANNEL].lines[1].lineId;
        buffers.update((live) => ({
            ...live,
            [KEY_CHANNEL]: { ...live[KEY_CHANNEL], readBoundaryKnown: true, readBoundaryId: liveAnchor },
        }));
        applyRetainedHandoff();

        const buffer = get(buffers)[KEY_CHANNEL];
        expect(buffer.readBoundaryId, 'a live boundary is a fact about this generation').toBe(liveAnchor);
        expect(buffer.lines, 'the retained window is still merged in').toHaveLength(3);
    });

    it('keeps an unsent draft filed under the conversation that closed', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        const profileKey = getActiveConnectionProfile()!.key;
        const closedRef = { profileKey, conversationKey: CHANNEL };

        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 2);
        setActiveBuffer(KEY_CHANNEL);
        writeDraft(closedRef, 'half a sentence');
        loseSession();

        // The channel is gone; the handoff lands on core instead.
        seed(KEY_CORE, CORE, 'weechat', 1, 0);
        const outcome = applyRetainedHandoff();
        expect(outcome?.fellBack).toBe(true);

        const fallbackKey = conversationKeyFor(get(buffers)[KEY_CORE]);
        expect(readDraft(closedRef)?.text, 'the text belongs to the conversation it was typed in').toBe('half a sentence');
        expect(readDraft({ profileKey, conversationKey: fallbackKey! }), 'and is not moved into the fallback').toBeNull();
    });
});

describe('the failed-history state is narrow', () => {
    /** A buffer whose history request failed and which renders nothing. */
    function emptyFailed(): BufferData {
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 0);
        setHistoryOutcome(KEY_CHANNEL, 'failed');
        return buffer;
    }

    it('renders when a request failed and the buffer shows nothing', () => {
        const buffer = emptyFailed();
        expect(historyUnavailable(buffer, get(historyOutcomes))).toBe(true);
    });

    it('does not render while a fetch is still in flight', () => {
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 0);
        setHistoryOutcome(KEY_CHANNEL, 'loading');
        expect(historyUnavailable(buffer, get(historyOutcomes)), 'not yet loaded is not broken').toBe(false);
    });

    it('does not render when no fetch has been attempted', () => {
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 0);
        expect(historyUnavailable(buffer, get(historyOutcomes)), 'absent is not failed').toBe(false);
    });

    it('does not render when the relay says that is all there is', () => {
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 0);
        setHistoryOutcome(KEY_CHANNEL, 'failed');
        buffer.allLinesFetched = true;
        expect(historyUnavailable(buffer, get(historyOutcomes)), 'an authoritative empty transcript is not a failure').toBe(false);
    });

    it('does not render when something is already on screen', () => {
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 10, 2);
        setHistoryOutcome(KEY_CHANNEL, 'failed');
        expect(historyUnavailable(buffer, get(historyOutcomes)), 'older history is missing, the visible history is not').toBe(false);
    });

    it('does not render for no buffer at all', () => {
        setHistoryOutcome(KEY_CHANNEL, 'failed');
        expect(historyUnavailable(null, get(historyOutcomes))).toBe(false);
    });
});
