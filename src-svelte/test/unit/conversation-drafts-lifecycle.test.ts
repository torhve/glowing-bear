/**
 * Draft identity across lifecycle transitions.
 *
 * A draft belongs to a conversation, and a conversation is named, not numbered.
 * These tests pin the three transitions that could break that: a confirmed rename,
 * a buffer close, and a reconnect that hands out fresh runtime ids and possibly
 * different names. None of them may lose text or move it through a reused id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { flushSync, mount, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, removeBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { handleBufferRenamed } from '#lib/stores/handlers.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { ProtocolMessage } from '#lib/types.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import {
    readDraft,
    renameConversationDraft,
    resetConversationDrafts,
    writeDraft,
} from '#lib/stores/conversationDrafts.ts';
import { toastStore } from '#lib/toast.ts';

// Rename reporting is asserted through the toast store rather than the OS layer.
vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    getActiveTransport: vi.fn(() => 'legacy'),
}));

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

const RELAY = 'https://relay.example:443';
const API_BUFFER_ID = 1759000000000099 as ApiBufferId;

const components: Record<string, unknown>[] = [];

function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

function openConversation(key: string, fullName: string, shortName: string): void {
    seedBuffer(key, fullName, shortName);
    setActiveBuffer(key);
    flushSync();
}

function seedBuffer(key: string, fullName: string, shortName: string): void {
    buffers.update((current) => ({
        ...current,
        [key]: createBuffer({
            pointers: [key],
            full_name: fullName,
            short_name: shortName,
            number: 1,
            local_variables: { type: 'channel' },
        }),
    }));
}

function draftOf(conversationKey: string): string {
    return readDraft({ profileKey: RELAY, conversationKey })?.text ?? '';
}

function typeInto(target: HTMLElement, text: string): void {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    input!.focus();
    input!.value = text;
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
}

function composerValue(target: HTMLElement): string {
    return target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]')?.value ?? '';
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

describe('rename migration', () => {
    it('moves the draft and its selection to the confirmed new name', () => {
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'half a sentence', 4, 4);

        expect(renameConversationDraft('irc.libera.#old', 'irc.libera.#new')).toBe('moved');

        expect(draftOf('irc.libera.#new')).toBe('half a sentence');
        expect(readDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#new' })).toMatchObject({
            selectionStart: 4,
            selectionEnd: 4,
        });
        // Moved, not copied: the old name is no longer a conversation this connection has.
        expect(readDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' })).toBeNull();
    });

    it('keeps both drafts when the new name already has unfinished text', () => {
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'from the old name', 0, 0);
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#new' }, 'from the new name', 0, 0);

        expect(renameConversationDraft('irc.libera.#old', 'irc.libera.#new')).toBe('conflict');

        // Neither overwritten nor concatenated. The reader decides which one wins.
        expect(draftOf('irc.libera.#old')).toBe('from the old name');
        expect(draftOf('irc.libera.#new')).toBe('from the new name');
    });

    it('does nothing when the old name has no draft', () => {
        expect(renameConversationDraft('irc.libera.#old', 'irc.libera.#new')).toBe('noop');
    });

    it('does not migrate when no relay is active', () => {
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'text', 0, 0);
        clearActiveConnectionProfile();

        expect(renameConversationDraft('irc.libera.#old', 'irc.libera.#new')).toBe('noop');
        expect(draftOf('irc.libera.#old')).toBe('text');
    });
});

describe('rename through each transport', () => {
    it('legacy buffer_renamed migrates the draft', () => {
        seedBuffer('0x2', 'irc.libera.#old', '#old');
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'typed before the rename', 6, 6);

        handleBufferRenamed({
            id: '_buffer_renamed',
            objects: [{
                pointer: '0x0',
                content: [{ pointers: ['0x2'], full_name: 'irc.libera.#renamed', short_name: '#renamed' }],
            }],
        } as unknown as ProtocolMessage);

        expect(get(buffers)['0x2']?.fullName).toBe('irc.libera.#renamed');
        expect(draftOf('irc.libera.#renamed')).toBe('typed before the rename');
        expect(draftOf('irc.libera.#old')).toBe('');
    });

    it('API buffer snapshot rename migrates the draft', () => {
        const key = String(API_BUFFER_ID);
        const reducers = createApiStoreReducers();
        const snapshot: BufferSnapshot = {
            id: API_BUFFER_ID,
            name: 'irc.libera.#old',
            shortName: '#old',
            number: 2,
            contentType: 'formatted',
            semanticType: 'channel',
            hidden: false,
            title: '#old',
            modes: '',
            inputPrompt: '<nicks>',
            input: '',
            inputPosition: 0,
            inputMultiline: false,
            hasNicklist: true,
            nicklistCaseSensitive: false,
            nicklistDisplayGroups: true,
            timeDisplayed: true,
            localVariables: { type: 'channel', plugin: 'irc', server: 'libera', channel: '#old' },
            lastReadLineId: -1,
        };
        reducers.buffers([snapshot]);
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'typed before the rename', 6, 6);

        reducers.bufferUpdated({ ...snapshot, name: 'irc.libera.#renamed', shortName: '#renamed' });

        expect(get(buffers)[key]?.fullName).toBe('irc.libera.#renamed');
        expect(draftOf('irc.libera.#renamed')).toBe('typed before the rename');
        expect(draftOf('irc.libera.#old')).toBe('');
    });

    it('reports a rename that collides with an existing draft', () => {
        seedBuffer('0x2', 'irc.libera.#old', '#old');
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'from the old name', 0, 0);
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#renamed' }, 'from the new name', 0, 0);

        handleBufferRenamed({
            id: '_buffer_renamed',
            objects: [{
                pointer: '0x0',
                content: [{ pointers: ['0x2'], full_name: 'irc.libera.#renamed', short_name: '#renamed' }],
            }],
        } as unknown as ProtocolMessage);

        const toasts = get(toastStore);
        expect(toasts.length).toBe(1);
        expect(toasts[0]!.message).toContain('already had unfinished text');
    });
});

describe('close, reconnect, and the fallback composer', () => {
    it('keeps a nonempty draft when the buffer is closed and reopened', () => {
        const target = render(InputBar, {});
        openConversation('chan', 'irc.libera.#chan', '#chan');
        typeInto(target, 'unfinished while open');

        removeBuffer('chan', false);
        activeBufferId.set('');
        flushSync();

        // Closing drops the runtime alias; the text stays under the conversation's name.
        expect(draftOf('irc.libera.#chan')).toBe('unfinished while open');

        openConversation('chan', 'irc.libera.#chan', '#chan');
        expect(composerValue(target)).toBe('unfinished while open');
    });

    it('does not guess across a rename that happened while nobody was connected', () => {
        writeDraft({ profileKey: RELAY, conversationKey: 'irc.libera.#old' }, 'written before the gap', 0, 0);

        // The relay comes back with only the new name, and no rename event was seen.
        const target = render(InputBar, {});
        openConversation('chan', 'irc.libera.#renamed', '#renamed');

        // The draft is not silently adopted by a conversation with a different name.
        expect(composerValue(target)).toBe('');
        expect(draftOf('irc.libera.#old')).toBe('written before the gap');
    });

    it('keeps a missing conversation draft out of the composer', () => {
        const target = render(InputBar, {});
        openConversation('first', 'irc.libera.#first', '#first');
        typeInto(target, 'belongs to #first');

        // No conversation is active: the composer is empty rather than showing
        // whichever draft happens to be in the map.
        activeBufferId.set('');
        buffers.set({});
        flushSync();
        expect(composerValue(target)).toBe('');

        expect(draftOf('irc.libera.#first')).toBe('belongs to #first');
    });

    it('rebinds from authoritative names after a reconnect, not from runtime ids', () => {
        const target = render(InputBar, {});
        openConversation('runtime-1', 'irc.libera.#chan', '#chan');
        typeInto(target, 'written before the reconnect');

        // A reconnect hands the same conversation a different runtime id.
        buffers.set({});
        activeBufferId.set('');
        openConversation('runtime-2', 'irc.libera.#chan', '#chan');

        expect(composerValue(target)).toBe('written before the reconnect');
    });
});
