/**
 * The banner model and the chat's data source — the two things that decide
 * whether an outage replaces readable chat with the connection form.
 *
 * Both are pure derivations over transport state, which is the point: a transport
 * publishes, presentation reads, and neither can write to the other. These tests
 * therefore drive real stores and assert on what the UI would be told, not on
 * component internals.
 *
 * The load-bearing cases are the ones where a naive implementation looks fine:
 *   - a snapshot from a DIFFERENT relay must not keep the shell mounted;
 *   - the countdown must disappear while an attempt is actually in flight,
 *     otherwise the banner promises a retry that is already running;
 *   - a retained buffer must not carry `apiBufferId`, or a frozen view becomes
 *     an addressable live one.
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
import { connectionState, connectionStats, setConnectionStatus, setErrors, setNextReconnectAt } from '#lib/stores/connectionStore.ts';
import { settings, updateSettings } from '#lib/stores/settings.ts';
import {
    captureRetainedState,
    markCaptureIntent,
    releaseRetainedSnapshot,
    retainedSnapshot,
} from '#lib/stores/retainedChat.ts';
import { chatDisplay } from '#lib/stores/chatPresentation.ts';
import { connectionBanner } from '#lib/stores/connectionPresentation.ts';
import type { BufferData } from '#lib/types.ts';

const KEY_CHANNEL = '1791000000000101';
const KEY_CORE = '1791000000000102';

function makeLine(bufferKey: string, text: string, id: number) {
    return createBufferLine({
        buffer: bufferKey,
        date: 1760000000000 + id,
        prefix: '<test>',
        message: text,
        tags_array: ['irc_privmsg'],
        displayed: 1,
        highlight: 0,
        id,
    });
}

function seed(key: string, fullName: string, shortName: string, number: number): BufferData {
    const buffer = createBuffer({
        pointers: [key],
        full_name: fullName,
        short_name: shortName,
        number,
        local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
    });
    buffer.lines = [
        makeLine(key, `${shortName}-one`, 1000),
        makeLine(key, `${shortName}-two`, 1001),
    ];
    return buffer;
}

/** A live session with two buffers, one of which the user is reading. */
function openSession(): void {
    buffers.set({
        [KEY_CHANNEL]: seed(KEY_CHANNEL, 'irc.gbtest.#glowing-bear', '#glowing-bear', 1),
        [KEY_CORE]: seed(KEY_CORE, 'core.weechat', 'core', 0),
    });
    setActiveBuffer(KEY_CHANNEL);
}

/**
 * The outage, as a transport performs it: capture with declared intent, then
 * wipe the live stores the snapshot was taken from.
 */
function loseSession(generation = 7): void {
    markCaptureIntent();
    captureRetainedState(generation);
    buffers.set({});
    activeBufferId.set('');
}

function profile(host = 'relay.example', port = 9001, tls = false): void {
    setActiveConnectionProfile(host, port, undefined, tls);
}

beforeEach(() => {
    releaseRetainedSnapshot('explicit-leave');
    clearActiveConnectionProfile();
    buffers.set({});
    activeBufferId.set('');
    connectionState.set({
        status: 'disconnected',
        errors: {
            passwordError: false, tlsError: false, securityError: false, oldWeechatError: false,
            hashAlgorithmDisagree: false, clockSkewError: false, errorMessage: false,
            uploadError: false, serverUnreachable: false, protocolUnansweredError: false,
        },
        userDisconnect: false,
        wasEverConnected: false,
        reconnectAttempts: 0,
        lastReconnectAt: 0,
        nextReconnectAt: undefined,
    });
    updateSettings({ useTotp: false });
});

describe('chatDisplay: what the chat renders', () => {
    it('prefers live data whenever it exists', () => {
        openSession();
        const display = get(chatDisplay);
        expect(display.live).toBe(true);
        expect(display.buffer?.shortName).toBe('#glowing-bear');
    });

    it('falls back to the retained conversation when the transport wiped its stores', () => {
        profile();
        openSession();
        loseSession();

        const display = get(chatDisplay);
        expect(display.live, 'a retained view is not live data and must say so').toBe(false);
        expect(display.buffer?.shortName).toBe('#glowing-bear');
        expect(display.buffer?.lines.map((l) => l.text)).toEqual(['#glowing-bear-one', '#glowing-bear-two']);
    });

    it('shows some chat rather than an empty one when the read conversation is gone', () => {
        profile();
        openSession();
        // The user was reading core, then that buffer disappears.
        activeBufferId.set(KEY_CORE);
        loseSession();
        const snapshot = get(retainedSnapshot);
        snapshot?.buffers.delete(String(snapshot.activeKey ?? ''));
        if (snapshot) snapshot.activeKey = null;

        const display = get(chatDisplay);
        expect(display.buffer?.shortName).toBe('#glowing-bear');
    });

    it('renders nothing when there is neither live data nor a snapshot', () => {
        const display = get(chatDisplay);
        expect(display.buffer).toBeNull();
        expect(display.live).toBe(false);
    });

    it('rebuilds a BufferData without transport authority fields', () => {
        profile();
        openSession();
        // An API-shaped live buffer: these two fields are what an API call and a
        // delayed history response are keyed on.
        const live = get(buffers)[KEY_CHANNEL]!;
        live.apiBufferId = 101;
        live.clearEpoch = 4;
        loseSession();

        const rebuilt = get(chatDisplay).buffer!;
        expect(rebuilt.apiBufferId, 'a frozen view must not look addressable').toBeUndefined();
        expect(rebuilt.clearEpoch, 'a retained buffer has no epoch to validate against').toBeUndefined();
        // requestedLines drives the page's history gate. Reporting the real line
        // count is what keeps a retained buffer from triggering a fetch.
        expect(rebuilt.requestedLines).toBe(rebuilt.lines.length);
    });
});

describe('connectionBanner: what the shell and banner show', () => {
    it('says nothing while connected', () => {
        openSession();
        setConnectionStatus('connected');
        const banner = get(connectionBanner);
        expect(banner.kind).toBe('none');
        expect(banner.shellVisible).toBe(true);
        expect(banner.retained).toBe(false);
    });

    it('keeps the shell mounted through an outage that left a retained view', () => {
        profile();
        openSession();
        loseSession();
        setConnectionStatus('reconnecting');
        setNextReconnectAt(Date.now() + 30_000);

        const banner = get(connectionBanner);
        expect(banner.shellVisible, 'the gate: an outage must not swap chat for the form').toBe(true);
        expect(banner.kind).toBe('reconnecting');
        expect(banner.retained).toBe(true);
        expect(banner.reason.length).toBeGreaterThan(0);
    });

    it('does not keep the shell for a snapshot from a different relay', () => {
        profile('old.example', 9001);
        openSession();
        loseSession();
        // The facade selected a new relay; the old session is not this user's view.
        profile('new.example', 9001);
        setConnectionStatus('reconnecting');

        const banner = get(connectionBanner);
        expect(banner.shellVisible, 'another relay chat is not a reason to hide the form').toBe(false);
        expect(banner.retained).toBe(false);
    });

    it('shows the form for an initial connect that has nothing to retain', () => {
        setConnectionStatus('connecting');
        const banner = get(connectionBanner);
        expect(banner.shellVisible).toBe(false);
        expect(banner.kind).toBe('none');
    });

    it('names the failure in text, not only in colour', () => {
        profile();
        openSession();
        loseSession();
        setErrors({ passwordError: true });
        setConnectionStatus('reconnecting');

        const banner = get(connectionBanner);
        expect(banner.reason.toLowerCase()).toContain('password');
    });

    it('names a rejected login timestamp as a clock problem, not a password problem', () => {
        profile();
        openSession();
        loseSession();
        setErrors({ clockSkewError: true });
        setConnectionStatus('reconnecting');

        const banner = get(connectionBanner);
        expect(banner.reason.toLowerCase()).toContain('timestamp');
        expect(banner.reason.toLowerCase(), 'the fix is a clock, not a credential').not.toContain('password');
    });

    it('reports the countdown only when an attempt is actually waiting', () => {
        profile();
        openSession();
        loseSession();
        setConnectionStatus('reconnecting');
        setNextReconnectAt(Date.now() + 30_000);

        expect(get(connectionBanner).nextRetryAt, 'a scheduled attempt has a time').not.toBeNull();

        // The attempt is now flying: a countdown beside it would promise a retry
        // that is already running.
        setConnectionStatus('connecting');
        expect(get(connectionBanner).nextRetryAt).toBeNull();
        expect(get(connectionBanner).attemptInFlight).toBe(true);
    });

    it('routes a TOTP session to credential entry instead of a generic error', () => {
        profile();
        openSession();
        loseSession();
        updateSettings({ useTotp: true });
        setConnectionStatus('reconnecting');

        const banner = get(connectionBanner);
        expect(banner.kind).toBe('needs-credentials');
        expect(banner.reason.toLowerCase()).toContain('code');
        expect(banner.canRetry, 'a stale single-use code is not a retry').toBe(false);
    });

    it('marks a stopped loop as read-only rather than reconnecting', () => {
        profile();
        openSession();
        loseSession();
        // No scheduleReconnect ran, so the status never became 'reconnecting'.
        setConnectionStatus('disconnected');

        const banner = get(connectionBanner);
        expect(banner.kind).toBe('retained');
        expect(banner.shellVisible).toBe(true);
        expect(banner.nextRetryAt).toBeNull();
    });
});

describe('uptime is a property of a live connection', () => {
    // The stats popover renders `Date.now() - connectedSince`. While a retry loop
    // is running the status is 'reconnecting', and a clock still counting up
    // there describes a session that has already ended — the one thing in the
    // shell that would present a retained view as live.
    it('clears uptime for every non-connected status, not just disconnected', () => {
        setConnectionStatus('connected');
        expect(get(connectionStats).connectedSince).toBeGreaterThan(0);

        setConnectionStatus('reconnecting');
        expect(get(connectionStats).connectedSince, 'a retry loop is not uptime').toBe(0);

        setConnectionStatus('connecting');
        expect(get(connectionStats).connectedSince).toBe(0);

        setConnectionStatus('error');
        expect(get(connectionStats).connectedSince).toBe(0);

        setConnectionStatus('connected');
        expect(get(connectionStats).connectedSince, 'a live connection earns uptime back').toBeGreaterThan(0);
    });
});
