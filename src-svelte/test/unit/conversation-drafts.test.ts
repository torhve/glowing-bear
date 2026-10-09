import { afterEach, describe, expect, it } from 'vitest';
import {
    connectionProfile,
    activeConnectionProfile,
    clearActiveConnectionProfile,
    getActiveConnectionProfile,
    setActiveConnectionProfile,
} from '#lib/connectionProfile.ts';
import {
    applyDraftClaim,
    claimDraft,
    clearDraft,
    clearProfileDrafts,
    conversationKeyFor,
    draftEntryCount,
    readDraft,
    resetConversationDrafts,
    writeDraft,
    type DraftRef,
} from '#lib/stores/conversationDrafts.ts';
import type { BufferPresentation } from '#lib/types.ts';

// Drafts are module-level on purpose — that is what lets them outlive a component.
// Every test ends from an empty store, so no test depends on the previous one.
afterEach(() => {
    resetConversationDrafts();
    clearActiveConnectionProfile();
});

const PROFILE_A = 'https://relay.example:443';
const PROFILE_B = 'https://other.example:443';

function ref(profileKey: string, conversationKey: string): DraftRef {
    return { profileKey, conversationKey };
}

function buffer(partial: Partial<BufferPresentation>): BufferPresentation {
    return partial as BufferPresentation;
}

describe('connection profile identity', () => {
    it('gives one relay one identity regardless of how the host was spelled', () => {
        const plain = connectionProfile('relay.example', 443, '', true);
        const withScheme = connectionProfile('https://relay.example', 443, '', true);
        const withTrailingSlash = connectionProfile('relay.example/', 443, '', true);
        expect(plain).not.toBeNull();
        expect(withScheme?.key).toBe(plain!.key);
        expect(withTrailingSlash?.key).toBe(plain!.key);
    });

    it('brackets a bare IPv6 literal so it cannot be read as a port', () => {
        const bare = connectionProfile('::1', 8000, '', false);
        const bracketed = connectionProfile('[::1]', 8000, '', false);
        expect(bare?.key).toBe(bracketed?.key);
        expect(bare?.key).toContain('[::1]');
    });

    it('keeps distinct reverse-proxy paths distinct', () => {
        const a = connectionProfile('relay.example', 443, 'gb', true);
        const b = connectionProfile('relay.example', 443, 'mirror', true);
        const none = connectionProfile('relay.example', 443, '', true);
        expect(new Set([a?.key, b?.key, none?.key]).size).toBe(3);
    });

    it('normalizes proxy-path spelling without changing which relay it is', () => {
        const slashes = connectionProfile('relay.example', 443, '/proxy/gb/', true);
        const bare = connectionProfile('relay.example', 443, 'proxy/gb', true);
        const alreadyApi = connectionProfile('relay.example', 443, 'proxy/gb/api', true);
        expect(slashes?.key).toBe(bare!.key);
        // A prefix that already rewrites to the API root is the same endpoint.
        expect(alreadyApi?.key).toBe(bare!.key);
        expect(bare?.prefix).toBe('proxy/gb');
    });

    it('separates plain from TLS and separates ports', () => {
        const tls = connectionProfile('relay.example', 443, '', true);
        const plain = connectionProfile('relay.example', 443, '', false);
        const otherPort = connectionProfile('relay.example', 9001, '', true);
        expect(new Set([tls?.key, plain?.key, otherPort?.key]).size).toBe(3);
    });

    it('never lets the password reach the identity', () => {
        const profile = connectionProfile('relay.example', 443, '', true);
        expect(profile).not.toBeNull();
        expect(JSON.stringify(profile)).not.toContain('password');
        // The identity is built from arguments that do not include a password at all.
        expect(Object.keys(profile!).sort()).toEqual(['host', 'key', 'port', 'prefix', 'tls']);
    });

    it('refuses to invent an identity for arguments that are not an endpoint', () => {
        expect(connectionProfile('', 443, '', true)).toBeNull();
        expect(connectionProfile('   ', 443, '', true)).toBeNull();
        expect(connectionProfile('relay.example', 70000, '', true)).toBeNull();
    });

    it('tracks the active profile from the connection attempt, not from settings', () => {
        setActiveConnectionProfile('relay.example', 443, 'gb', true);
        const active = getActiveConnectionProfile();
        expect(active?.key).toBe(connectionProfile('relay.example', 443, 'gb', true)?.key);
        clearActiveConnectionProfile();
        expect(getActiveConnectionProfile()).toBeNull();
        expect(activeConnectionProfile).toBeDefined();
    });
});

describe('conversation identity', () => {
    it('keys on fullName, which survives a reconnect', () => {
        const before = conversationKeyFor(buffer({ fullName: 'irc.libera.#glowing-bear', server: 'libera', shortName: '#glowing-bear' }));
        const after = conversationKeyFor(buffer({ fullName: 'irc.libera.#glowing-bear', server: 'libera', shortName: '#glowing-bear' }));
        expect(before).toBe(after);
    });

    it('falls back to server plus short name when fullName is unusable', () => {
        expect(conversationKeyFor(buffer({ fullName: '', server: 'libera', shortName: '#dev' }))).toBe('libera/#dev');
    });

    it('returns no identity rather than fabricating one from a runtime id', () => {
        expect(conversationKeyFor(buffer({ fullName: '', server: '', shortName: '' }))).toBeNull();
        expect(conversationKeyFor(null)).toBeNull();
        expect(conversationKeyFor(undefined)).toBeNull();
    });
});

describe('per-conversation drafts', () => {
    it('keeps two conversations independent', () => {
        const a = ref(PROFILE_A, 'irc.libera.#a');
        const b = ref(PROFILE_A, 'irc.libera.#b');
        writeDraft(a, 'draft in a', 4, 4);
        writeDraft(b, 'draft in b', 2, 6);
        expect(readDraft(a)?.text).toBe('draft in a');
        expect(readDraft(b)?.text).toBe('draft in b');
        expect(readDraft(a)?.selectionStart).toBe(4);
        expect(readDraft(b)?.selectionEnd).toBe(6);
    });

    it('keeps the same short name on different servers distinct', () => {
        const libera = ref(PROFILE_A, 'irc.libera.#dev');
        const oftc = ref(PROFILE_A, 'irc.oftc.#dev');
        writeDraft(libera, 'on libera');
        writeDraft(oftc, 'on oftc');
        expect(readDraft(libera)?.text).toBe('on libera');
        expect(readDraft(oftc)?.text).toBe('on oftc');
    });

    it('keeps the same conversation on different relays distinct', () => {
        const a = ref(PROFILE_A, 'irc.libera.#dev');
        const b = ref(PROFILE_B, 'irc.libera.#dev');
        writeDraft(a, 'relay a');
        writeDraft(b, 'relay b');
        expect(readDraft(a)?.text).toBe('relay a');
        expect(readDraft(b)?.text).toBe('relay b');
    });

    it('resolves the same draft after a reconnect changed the runtime id', () => {
        // First connection: the store key is String(apiBufferId) and is 41.
        const runtimeIdBefore = '41';
        const conversation = conversationKeyFor(buffer({
            fullName: 'irc.libera.#dev', server: 'libera', shortName: '#dev',
        }))!;
        writeDraft(ref(PROFILE_A, conversation), 'half-typed');
        expect(readDraft(ref(PROFILE_A, runtimeIdBefore))).toBeNull();

        // Reconnect: the same conversation now arrives under a different runtime id.
        const runtimeIdAfter = '7';
        expect(conversationKeyFor(buffer({
            fullName: 'irc.libera.#dev', server: 'libera', shortName: '#dev',
        }))).toBe(conversation);
        expect(readDraft(ref(PROFILE_A, runtimeIdAfter))).toBeNull();
        expect(readDraft(ref(PROFILE_A, conversation))?.text).toBe('half-typed');
    });

    it('preserves whitespace-only text and does not trim typed spacing', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, '  leading and trailing  ');
        expect(readDraft(r)?.text).toBe('  leading and trailing  ');
        writeDraft(r, '   ');
        expect(readDraft(r)?.text).toBe('   ');
    });

    it('drops an empty draft rather than storing a phantom entry', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, 'text');
        expect(writeDraft(r, '')).toBeNull();
        expect(readDraft(r)).toBeNull();
        expect(draftEntryCount()).toBe(0);
    });

    it('clamps a selection that no longer fits the text', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        const entry = writeDraft(r, 'abc', 99, 99);
        expect(entry?.selectionStart).toBe(3);
        expect(entry?.selectionEnd).toBe(3);
        const shrunk = writeDraft(r, 'ab', 5, 5);
        expect(shrunk?.selectionStart).toBe(2);
    });

    it('bumps a revision on every write so a stale claim can be detected', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        expect(writeDraft(r, 'first')?.revision).toBe(1);
        expect(writeDraft(r, 'second')?.revision).toBe(2);
    });

    it('leaves the revision alone when a write would change nothing', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        const first = writeDraft(r, 'typed', 5, 5);
        // The composer persists from two places (the input event and a mirror
        // effect); the second save of the same state must not look like the draft
        // moved, or every outstanding claim would be voided by a keystroke echo.
        const again = writeDraft(r, 'typed', 5, 5);
        expect(again?.revision).toBe(first?.revision);
        // A different selection is a real change and does bump.
        expect(writeDraft(r, 'typed', 1, 1)?.revision).toBe((first?.revision ?? 0) + 1);
    });

    it('applies a claim only while the draft still matches it', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, 'hi @li');
        const claim = claimDraft(r);
        expect(claim).not.toBeNull();
        const applied = applyDraftClaim(claim!, 'hi @libera', 10, 10);
        expect(applied?.text).toBe('hi @libera');
        expect(applied?.revision).toBe(2);
    });

    it('rejects a claim whose draft moved underneath it', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, 'hi @li');
        const claim = claimDraft(r)!;
        // The user keeps typing while the completion request is in flight.
        writeDraft(r, 'hi @libera and more text');
        expect(applyDraftClaim(claim, 'hi @libera')).toBeNull();
        expect(readDraft(r)?.text).toBe('hi @libera and more text');
    });

    it('rejects a claim captured for a draft that was cleared', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, 'hi @li');
        const claim = claimDraft(r)!;
        clearDraft(r);
        expect(applyDraftClaim(claim, 'hi @libera')).toBeNull();
    });

    it('survives component unmount and live-store resets', () => {
        const r = ref(PROFILE_A, 'irc.libera.#dev');
        writeDraft(r, 'typed before the teardown');
        // Nothing in this module is tied to a component or to the live buffer
        // table, so a remount reads the same entry back.
        expect(draftEntryCount()).toBe(1);
        expect(readDraft(r)?.text).toBe('typed before the teardown');
    });

    it('clears one relay without touching another', () => {
        writeDraft(ref(PROFILE_A, 'irc.libera.#dev'), 'relay a');
        writeDraft(ref(PROFILE_B, 'irc.libera.#dev'), 'relay b');
        clearProfileDrafts(PROFILE_A);
        expect(readDraft(ref(PROFILE_A, 'irc.libera.#dev'))).toBeNull();
        expect(readDraft(ref(PROFILE_B, 'irc.libera.#dev'))?.text).toBe('relay b');
    });

    it('resets the whole store for the next test file', () => {
        writeDraft(ref(PROFILE_A, 'irc.libera.#dev'), 'leak check');
        writeDraft(ref(PROFILE_B, 'irc.libera.#dev'), 'leak check too');
        expect(draftEntryCount()).toBe(2);
        resetConversationDrafts();
        expect(draftEntryCount()).toBe(0);
        expect(readDraft(ref(PROFILE_A, 'irc.libera.#dev'))).toBeNull();
    });
});
