import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, createBuffer } from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

// `indent` is derived from the buffer type, and it used to be derived three
// times with two different answers:
//
//   models.ts   createBuffer                 channel, private, query
//   handlers.ts handleBufferUpdate           channel, private
//   handlers.ts handleBufferLocalvarChanged  channel, private
//
// A query buffer therefore got its indent at creation and lost it at the first
// `_buffer_*` or `_buffer_localvar_changed` that touched it: a PM buffer that
// rendered correctly until something unrelated updated it. All three sites now
// read models.ts bufferTypeIndents().
//
// The two middle tests are the regression net for that fix. They target the
// query type specifically, because query is the one the handler-side lists left
// out — and the localvar case carries no type at all, which is how the wrong
// derivation reached a buffer nobody had re-typed.

vi.mock('#lib/stores/settings.ts', async () => (await import('./helpers/mockSettings.ts')).mockSettings({port: '9001', fontsize: '', noembed: false}));

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

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

describe('indent derivation: one rule for all three writers', () => {
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

    it('a _buffer_* update keeps a query buffer indented', () => {
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
        expect(buffer('0x100').indent).toBe(true);
    });

    it('a localvar event keeps it indented even when it carries no type at all', () => {
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
        expect(buffer('0x101').indent).toBe(true);
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

    it('the type is the `type` local variable copied through, not a checked vocabulary', () => {
        // `relay.raw` reports `debug` — upstream `relay_raw_open` sets its
        // `localvar_set_type` to "debug" — and a plugin can set any string.
        // Both transports copy it verbatim, so an unlisted type survives rather
        // than being rewritten to `other`; only the indent rule is a closed list.
        const created = createBuffer({
            pointers: ['0x901'],
            full_name: 'relay.relay.raw',
            short_name: 'relay.raw',
            number: 0,
            local_variables: { plugin: 'relay', server: 'relay_raw', type: 'debug' },
        });
        expect(created.type).toBe('debug');
        expect(created.indent).toBe(false);
    });
});
