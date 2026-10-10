/**
 * Retained-view capture and handoff.
 *
 * The retained view exists so a relay outage leaves the loaded chat readable.
 * That only holds if three things are true, and each is a way this feature has
 * historically been broken:
 *
 *   - the snapshot is captured once, from stores that have already drained
 *     their line batch, and a second wipe cannot replace it with an emptier one;
 *   - the snapshot shares no mutable object with the live stores it came from,
 *     so a late callback from the dead session cannot edit what the user reads;
 *   - the handoff only merges a retained buffer into a live one when the
 *     buffer *instance* survived, because 4.10.1 line ids restart from a low
 *     counter and a recycled id would delete a real line.
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
import { clearActiveConnectionProfile, getActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import type { BufferData, PluginMetadata } from '#lib/types.ts';
import {
    captureRetainedState,
    getRetainedSnapshot,
    hasRetainedViewFor,
    hasRetainedViewForActiveProfile,
    mergeRetainedLines,
    planRetainedHandoff,
    releaseRetainedSnapshot,
    retainedBufferCount,
    retainedLineIds,
} from '#lib/stores/retainedChat.ts';

const CHANNEL = 'irc.gbtest.#glowing-bear';
const CORE = 'core.weechat';

/** Store keys stand in for what the transports really use: `String(apiBufferId)`
 *  on the API path, a WeeChat pointer on the legacy path. Both are per-session
 *  buffer identities, which is exactly what the handoff reasons about. */
const KEY_CHANNEL = '1791000000000101';
const KEY_CORE = '1791000000000102';
const KEY_QUERIED = '1791000000000103';

function seed(key: string, fullName: string, shortName: string, number: number): BufferData {
    const buffer = createBuffer({
        pointers: [key],
        full_name: fullName,
        short_name: shortName,
        number,
        local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
    });
    buffers.update((current) => ({ ...current, [key]: buffer }));
    return buffer;
}

function addLine(key: string, id: number, text: string): void {
    buffers.update((current) => {
        const buffer = current[key];
        if (!buffer) return current;
        buffer.lines.push(
            createBufferLine({
                buffer: key,
                date: 1760000000000 + id,
                prefix: `<${text}>`,
                message: `message ${text}`,
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

function live(key: string): BufferData {
    return get(buffers)[key];
}

function connectProfile(host = 'relay.example', port = 443): string {
    setActiveConnectionProfile(host, port, undefined, true);
    return getActiveConnectionProfile()!.key;
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    releaseRetainedSnapshot('explicit-leave');
    clearActiveConnectionProfile();
});

describe('capture', () => {
    it('retains the loaded buffers, their lines, and the viewed conversation', () => {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        seed(KEY_CORE, CORE, 'core', 0);
        addLine(KEY_CHANNEL, 10, 'alice');
        addLine(KEY_CHANNEL, 11, 'bob');
        setActiveBuffer(KEY_CHANNEL);

        const outcome = captureRetainedState(1);
        expect(outcome.captured).toBe(true);

        const snapshot = getRetainedSnapshot();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.buffers.size).toBe(2);
        expect(snapshot!.activeKey).toBe(KEY_CHANNEL);
        expect(snapshot!.buffers.get(KEY_CHANNEL)!.lines.map((l) => l.lineId)).toEqual([
            'weechat:10',
            'weechat:11',
        ]);
    });

    it('refuses to capture without a profile, so content cannot be shown without a relay owner', () => {
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);

        const outcome = captureRetainedState(1);
        expect(outcome).toEqual({ captured: false, reason: 'no-profile' });
        expect(getRetainedSnapshot()).toBeNull();
    });

    it('refuses to capture an empty session, which would look like a preserved chat and show nothing', () => {
        connectProfile();
        const outcome = captureRetainedState(1);
        expect(outcome).toEqual({ captured: false, reason: 'no-buffers' });
        expect(getRetainedSnapshot()).toBeNull();
    });

    it('keeps the first capture when a duplicate wipe runs, instead of swapping in an emptier one', () => {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        expect(captureRetainedState(1).captured).toBe(true);
        const firstToken = getRetainedSnapshot()!.token;

        // The facade's disconnect calls both transports' wipe, and legacy's
        // retry timer wipes again. By then the stores are already cleared.
        buffers.set({});
        activeBufferId.set('');

        const second = captureRetainedState(2);
        expect(second.captured).toBe(false);
        expect(second.reason).toBe('already-captured');
        expect(getRetainedSnapshot()!.token).toBe(firstToken);
        expect(retainedBufferCount()).toBe(1);
        expect(getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!.lines).toHaveLength(1);
    });

    it('shares no mutable container with the live stores it was captured from', () => {
        connectProfile();
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        buffer.title = createBuffer({ pointers: ['x'], full_name: 't', short_name: 't' }).title;
        buffer.nameClasses.push('live-only');
        buffer.localVariables = { pinned: 'true' };
        setActiveBuffer(KEY_CHANNEL);

        expect(captureRetainedState(1).captured).toBe(true);
        const retained = getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!;

        // A late callback from the dead session mutating the live buffer must
        // not reach the view the user is reading.
        live(KEY_CHANNEL).nameClasses.push('after-capture');
        live(KEY_CHANNEL).lines[0]!.tags.push('after-capture');
        live(KEY_CHANNEL).localVariables!.pinned = 'false';
        live(KEY_CHANNEL).nicklist.root = { name: 'root', visible: 'root', nicks: [] };

        expect(retained.presentation.nameClasses).not.toContain('after-capture');
        expect(retained.lines[0]!.tags).not.toContain('after-capture');
        expect(retained.presentation.localVariables).toEqual({ pinned: 'true' });
        expect(retained.nicklist.root).toBeUndefined();
    });

    it('drops plugin metadata, which can carry a function', () => {
        connectProfile();
        const buffer = seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        const metadata: PluginMetadata[] = [
            {
                // Executable state: a snapshot must not outlive the session
                // that produced it.
                content: function () {},
                nsfw: false,
                name: 'embed',
                className: 'c',
                visible: true,
            },
        ];
        live(KEY_CHANNEL).lines[0]!.metadata = metadata;
        setActiveBuffer(KEY_CHANNEL);

        captureRetainedState(1);
        const retained = getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!;
        expect(retained.lines[0]!.metadata).toBeUndefined();
    });

    it('refuses to capture for a different relay while a snapshot is held', () => {
        connectProfile('relay.example', 443);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        expect(captureRetainedState(1).captured).toBe(true);

        // A capture for another endpoint must not silently replace the held
        // view; the caller has to release it explicitly first.
        connectProfile('other.example', 9001);
        const outcome = captureRetainedState(2);
        expect(outcome.captured).toBe(false);
        expect(outcome.reason).toBe('already-captured');
        expect(getRetainedSnapshot()!.profileKey).toBe('https://relay.example:443');
    });
});

describe('profile ownership', () => {
    it('only reports a retained view for the profile that owns it', () => {
        connectProfile('relay.example', 443);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);

        expect(hasRetainedViewFor('https://relay.example:443')).toBe(true);
        expect(hasRetainedViewFor('https://other.example:443')).toBe(false);
        expect(hasRetainedViewFor(null)).toBe(false);
        expect(hasRetainedViewFor(undefined)).toBe(false);
    });

    // The transports ask this before raising a disconnect toast, so the question
    // they ask has to be the same one the banner answers.
    it('reports the active profile view without the caller naming it', () => {
        connectProfile('relay.example', 443);
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);

        expect(hasRetainedViewForActiveProfile()).toBe(true);

        // A different relay is a different session: the retained view says nothing
        // about it, so that profile's loss must still be announced.
        setActiveConnectionProfile('other.example', 443, undefined, true);
        expect(hasRetainedViewForActiveProfile()).toBe(false);

        clearActiveConnectionProfile();
        expect(hasRetainedViewForActiveProfile()).toBe(false);
    });
});

describe('handoff', () => {
    function captureOneSession(): void {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        seed(KEY_CORE, CORE, 'core', 0);
        addLine(KEY_CHANNEL, 10, 'alice');
        addLine(KEY_CHANNEL, 11, 'bob');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);
    }

    it('seeds a retained buffer whose store key survived, and marks the ones that did not', () => {
        captureOneSession();

        // New generation: the channel buffer is the same instance, the core
        // buffer is gone. A bootstrap delivers metadata with no lines.
        buffers.set({});
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);

        const plan = planRetainedHandoff(Object.keys(get(buffers)));
        expect(plan).not.toBeNull();
        expect([...plan!.seed.keys()]).toEqual([KEY_CHANNEL]);
        expect(plan!.closedOnServer.map((b) => b.fullName)).toEqual([CORE]);
    });

    it('does not merge a reappearing conversation that arrived under a new key', () => {
        captureOneSession();

        // Same name, different buffer instance: on 4.10.1 its line ids restart
        // from a low counter, so merging by id could delete a real line.
        const reopened = '1791999999999999';
        buffers.set({});
        seed(reopened, CHANNEL, '#glowing-bear', 1);

        const plan = planRetainedHandoff(Object.keys(get(buffers)));
        expect(plan!.seed.size).toBe(0);
        expect(plan!.closedOnServer.map((b) => b.fullName)).toContain(CHANNEL);
    });

    it('carries the viewed conversation forward when it survived', () => {
        captureOneSession();
        buffers.set({});
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        seed(KEY_CORE, CORE, 'core', 0);

        const plan = planRetainedHandoff(Object.keys(get(buffers)));
        expect(plan!.activeKey).toBe(KEY_CHANNEL);
        expect(plan!.activeFellBack).toBe(false);
    });

    it('falls back in the same order a fresh connect uses when the conversation is gone', () => {
        captureOneSession();

        buffers.set({});
        seed(KEY_CORE, CORE, 'core', 0);
        seed(KEY_QUERIED, 'irc.gbtest.#other', '#other', 2);

        const plan = planRetainedHandoff(Object.keys(get(buffers)));
        // `shouldResume` matches the last-viewed buffer by full name; the
        // retained one no longer exists, so core.weechat wins over the first
        // entry in the list.
        expect(plan!.activeKey).toBe(KEY_CORE);
        expect(plan!.activeFellBack).toBe(true);
    });

    it('reports no plan when nothing was retained', () => {
        expect(planRetainedHandoff([KEY_CHANNEL])).toBeNull();
    });
});

describe('line merge', () => {
    function retainedChannel(): void {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 10, 'alice');
        addLine(KEY_CHANNEL, 11, 'bob');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);
    }

    it('keeps retained order and appends only live lines that are not already on screen', () => {
        retainedChannel();
        const retained = getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!;

        // A replay of `bob` plus one genuinely new line.
        const liveLines = [11, 12].map(
            (id) =>
                createBufferLine({
                    buffer: KEY_CHANNEL,
                    date: 1760000000000 + id,
                    prefix: `<n${id}>`,
                    message: `message ${id}`,
                    tags_array: ['irc_privmsg'],
                    displayed: 1,
                    highlight: 0,
                    id,
                    bufferType: 'channel',
                }),
        );

        const merged = mergeRetainedLines(retained, liveLines);
        expect(merged.map((l) => l.lineId)).toEqual(['weechat:10', 'weechat:11', 'weechat:12']);
    });

    it('leaves the retained snapshot untouched, so an abandoned handoff still has a view', () => {
        retainedChannel();
        const retained = getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!;
        mergeRetainedLines(retained, [
            createBufferLine({
                buffer: KEY_CHANNEL,
                date: 1760000000099,
                message: 'new',
                tags_array: [],
                displayed: 1,
                highlight: 0,
                id: 99,
                bufferType: 'channel',
            }),
        ]);
        expect(retained.lines).toHaveLength(2);
    });

    it('carries trimmed ids so a replayed line cannot render twice', () => {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 10, 'alice');
        const buffer = live(KEY_CHANNEL);
        // The transport's seen-set is a superset: an id trimmed off screen
        // stays behind, and that is the direction of error that avoids a
        // duplicate row.
        buffer.lineIdsSeen = new Set(['weechat:10', 'weechat:7']);
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);

        const retained = getRetainedSnapshot()!.buffers.get(KEY_CHANNEL)!;
        expect(retained.lines).toHaveLength(1);
        expect(retainedLineIds(retained)).toEqual(new Set(['weechat:10', 'weechat:7']));

        const replayed = createBufferLine({
            buffer: KEY_CHANNEL,
            date: 1760000000007,
            message: 'message 7',
            tags_array: ['irc_privmsg'],
            displayed: 1,
            highlight: 0,
            id: 7,
            bufferType: 'channel',
        });
        expect(mergeRetainedLines(retained, [replayed])).toHaveLength(1);
    });
});

describe('release', () => {
    it('clears the view and is idempotent against a second release', () => {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);
        expect(retainedBufferCount()).toBe(1);

        releaseRetainedSnapshot('handoff');
        expect(getRetainedSnapshot()).toBeNull();
        expect(retainedBufferCount()).toBe(0);

        // The facade's disconnect reaches both transports; the second release
        // must not throw or resurrect anything.
        releaseRetainedSnapshot('explicit-leave');
        expect(getRetainedSnapshot()).toBeNull();
    });

    it('lets a later session capture after an explicit release', () => {
        connectProfile();
        seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 1);
        addLine(KEY_CHANNEL, 1, 'alice');
        setActiveBuffer(KEY_CHANNEL);
        captureRetainedState(1);
        releaseRetainedSnapshot('explicit-leave');

        buffers.set({});
        seed(KEY_QUERIED, 'irc.gbtest.#second', '#second', 3);
        setActiveBuffer(KEY_QUERIED);
        expect(captureRetainedState(2).captured).toBe(true);
        expect(retainedBufferCount()).toBe(1);
        expect(getRetainedSnapshot()!.token).toBeGreaterThan(1);
    });
});
