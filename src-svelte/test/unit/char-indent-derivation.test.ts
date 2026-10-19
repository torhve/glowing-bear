import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, createBuffer } from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

// Characterization tests for B1: `indent` is derived from the buffer type in
// three places, and the three sets are not the same.
//
//   models.ts  createBuffer            ["channel", "private", "query"]
//   handlers.ts handleBufferUpdate     ["channel", "private"]
//   handlers.ts handleBufferLocalvarChanged  ["channel", "private"]
//
// These tests pin what the code does TODAY. They are not an endorsement of it —
// the second and third assertions describe a query buffer losing an indent it
// was created with. They exist so that the eventual fix has something to be
// measured against, and so a reviewer can see the divergence instead of being
// told about it.

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                notifyDMs: true, notifyHighlights: true, notificationSoundMode: 'off',
                notificationSoundCustom: null, notificationVolume: 50,
                joinPartsTTL: 30, joinPartsThreshold: 50, joinPartsBufferLimit: 100,
                joinPartsHide: false, joinPartsHideCore: false, joinPartsHideQueries: false,
                joinPartsHideOther: false, joinPartsHideAll: false,
                joinPartsHideAllTemp: false, joinPartsHideTempTimer: null,
                joinPartsHideTempRestore: null,
                hotkeyList: [],
                openNewBufferTab: true, autocolor: true, colorNicks: true,
                timestamp: true, timestampFormat: '%H:%M',
                bufferLineTimes: false, hideJoinParts: false,
                embedLinks: false, autoplay: false, showNickList: true,
                testSetting: false,
            });
            return () => {};
        },
        set: () => {},
        update: () => {},
    },
}));

vi.mock('#lib/notifications.ts', () => ({
    playNotificationSound: vi.fn(),
    createHighlight: vi.fn(),
    createDM: vi.fn(),
    createMention: vi.fn(),
    onDisconnect: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

// jsdom exposes no localStorage here; buffer resume is unrelated to indent.
vi.mock('#lib/stores/bufferResume.ts', () => ({
    shouldResume: vi.fn(() => false),
    getLastBuffer: vi.fn(() => null),
    recordLastBuffer: vi.fn(),
}));

const { handleBufferInfo, handleBufferLocalvarChanged } = await import('#lib/stores/handlers.ts');

/** One `_buffer_*` / `_buffer_info` hdata row for a buffer of a given type. */
function bufferRow(id: string, name: string, type: string): ProtocolMessage {
    return {
        objects: [
            {
                content: [
                    {
                        pointers: [id],
                        id,
                        local_variables: { plugin: 'irc', server: 'test', type },
                        notify: 3,
                        number: 1,
                        full_name: `irc.test.${name}`,
                        short_name: name,
                        title: '',
                        hidden: 0,
                        type,
                    },
                ],
            },
        ],
    } as unknown as ProtocolMessage;
}

/** A `_buffer_localvar_changed` event that carries no new type of its own. */
function localvarChanged(id: string, vars: Record<string, string>): ProtocolMessage {
    return {
        objects: [{ content: [{ pointers: [id], local_variables: vars }] }],
    } as unknown as ProtocolMessage;
}

function buffer(id: string): BufferData {
    const b = get(buffers)[id];
    if (!b) throw new Error(`buffer ${id} missing from the store`);
    return b;
}

describe('B1 characterization: indent derivation disagrees between its three writers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
    });

    it('creation treats a query buffer as indentable', () => {
        const created = createBuffer({
            pointers: ['0x100'],
            full_name: 'irc.test.franky',
            short_name: 'franky',
            number: 1,
            local_variables: { plugin: 'irc', server: 'test', type: 'query' },
        });
        expect(created.type).toBe('query');
        expect(created.indent).toBe(true);
    });

    it('a _buffer_* update rewrites that query buffer to indent: false', () => {
        const created = createBuffer({
            pointers: ['0x100'],
            full_name: 'irc.test.franky',
            short_name: 'franky',
            number: 1,
            local_variables: { plugin: 'irc', server: 'test', type: 'query' },
        });
        buffers.set({ '0x100': created });
        expect(buffer('0x100').indent).toBe(true);

        // The same buffer, reported again with the same type. Nothing about it
        // changed; only the derivation differs.
        handleBufferInfo(bufferRow('0x100', 'franky', 'query'));

        expect(buffer('0x100').type).toBe('query');
        expect(buffer('0x100').indent).toBe(false);
    });

    it('a localvar event rewrites it the same way, even when it carries no type at all', () => {
        const created = createBuffer({
            pointers: ['0x101'],
            full_name: 'irc.test.franky',
            short_name: 'franky',
            number: 1,
            local_variables: { plugin: 'irc', server: 'test', type: 'query' },
        });
        buffers.set({ '0x101': created });
        expect(buffer('0x101').indent).toBe(true);

        // `lv.type` falls back to buffer.type, so the type stays 'query'.
        handleBufferLocalvarChanged(localvarChanged('0x101', { pinned: 'true' }));

        expect(buffer('0x101').type).toBe('query');
        expect(buffer('0x101').indent).toBe(false);
    });

    it('channel and private agree across all three writers — only query diverges', () => {
        for (const type of ['channel', 'private']) {
            const id = `0x2${type.length}`;
            const created = createBuffer({
                pointers: [id],
                full_name: `irc.test.${type}`,
                short_name: type,
                number: 1,
                local_variables: { plugin: 'irc', server: 'test', type },
            });
            buffers.set({ [id]: created });
            const atCreation = created.indent;

            handleBufferInfo(bufferRow(id, type, type));
            const afterUpdate = buffer(id).indent;

            handleBufferLocalvarChanged(localvarChanged(id, { pinned: 'true' }));
            const afterLocalvar = buffer(id).indent;

            expect({ atCreation, afterUpdate, afterLocalvar }).toEqual({
                atCreation: true,
                afterUpdate: true,
                afterLocalvar: true,
            });
        }
    });
});
