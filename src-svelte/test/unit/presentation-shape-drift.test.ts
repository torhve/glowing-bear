/**
 * The sidebar row shape has four copies, and only three of them are checked by the
 * compiler.
 *
 * `rowFor` maps a buffer to the row the sidebar renders, `copyPresentation` copies that
 * same shape into a retained snapshot, `sameRow` decides whether two rows are equal, and
 * `RetainedPresentation` restates the field list a third time. A field added to
 * `BufferPresentation` is a compile error if `rowFor` or `copyPresentation` forgets it —
 * both have a declared return type. It is *not* an error if `sameRow` forgets it, and that
 * is the one that costs the user something: a row whose only change is the un-comparison
 * field looks unchanged, the projection keeps the old row, and the sidebar goes stale with
 * nothing logged. The same goes for a field `copyPresentation` forgets to deep-copy: the
 * retained snapshot keeps pointing at arrays the live session mutates afterwards, so the
 * view of a lost connection edits itself.
 *
 * So both are pinned by enumerating the fields the projection actually emits — not a
 * hand-written list, which would drift exactly like the code it checks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { sidebarRows } from '#lib/stores/bufferProjections.ts';
import { setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { captureRetainedState, getRetainedSnapshot, releaseRetainedSnapshot } from '#lib/stores/retainedChat.ts';
import type { BufferData, BufferPresentation } from '#lib/types.ts';

const KEY = '1';

function seedBuffer(): BufferData {
    const buffer = createBuffer({
        pointers: [KEY],
        full_name: 'irc.gbtest.#glowing-bear',
        short_name: '#glowing-bear',
        number: 3,
        local_variables: { type: 'channel', plugin: 'irc', server: 'gbtest' },
    });
    buffer.nameClasses = ['buffer-name', 'channel'];
    buffers.update((current) => ({ ...current, [buffer.id]: buffer }));
    setActiveBuffer(buffer.id);
    return buffer;
}

function rowOf(id: string): BufferPresentation {
    const row = get(sidebarRows).find((candidate) => candidate.id === id);
    if (!row) throw new Error(`the sidebar projected no row for ${id}`);
    return row;
}

/** A value that differs from `current` in whatever way that field's type allows. */
function nextValue(current: unknown): unknown {
    if (Array.isArray(current)) return [...current];
    if (current && typeof current === 'object') return { ...(current as Record<string, string>) };
    if (typeof current === 'boolean') return !current;
    if (typeof current === 'number') return current + 1;
    if (typeof current === 'string') return `${current}-2`;
    return 'set';
}

function changeField<K extends keyof BufferData>(key: K, value: BufferData[K]): void {
    buffers.update((current) => {
        const buffer = current[KEY];
        if (!buffer) throw new Error('the seeded buffer disappeared');
        return { ...current, [KEY]: { ...buffer, [key]: value } };
    });
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    releaseRetainedSnapshot('test-reset');
    setActiveConnectionProfile('relay.example', 443, undefined, true);
    seedBuffer();
});

describe('every field the sidebar row carries is compared', () => {
    it('re-projects when the only change is in one field, for every field', () => {
        // Enumerated from the emitted row, so a field added to the shape joins this loop
        // on its own instead of waiting for someone to remember the test.
        const keys = Object.keys(rowOf(KEY)) as (keyof BufferPresentation)[];
        expect(keys.length, 'the row carries the whole presentation shape').toBeGreaterThan(15);

        const pristine = { ...get(buffers)[KEY]! };

        // A fresh buffer object every time. `rowFor` caches rows per buffer *object*, so
        // handing it the same object returns the cached row without comparing anything —
        // that is the documented rule for in-place mutation, not what this checks. Both
        // transports publish a cloned buffer, and the comparison that then decides whether
        // the sidebar repaints is `sameRow` against the row held for the id.
        const publish = (overrides: Partial<BufferData> = {}) => {
            buffers.set({ [KEY]: { ...pristine, ...overrides } });
        };

        for (const key of keys) {
            // `hidden` decides membership, not row content, and `id` is identity: a
            // different id is a different buffer, not a changed row. Neither is the drift
            // this loop looks for.
            if (key === 'hidden' || key === 'id') continue;

            publish();
            const before = rowOf(KEY);

            const value = nextValue(pristine[key]) as never;
            publish({ [key]: value } as never);
            const after = rowOf(KEY);

            expect(
                after === before,
                `${String(key)} changed but the projection handed back the same row — sameRow does not compare it`,
            ).toBe(false);
            expect(after[key], `${String(key)} reached the row`).toEqual(value);
        }
    });
});

describe('the retained copy is the same shape and owns its data', () => {
    it('carries every field the live row carries', () => {
        const live = rowOf(KEY);
        const captured = captureRetainedState(1);
        if (!captured.captured) throw new Error(`capture failed: ${captured.reason}`);

        const retained = getRetainedSnapshot()!.buffers.get(KEY)!;
        expect(
            Object.keys(retained.presentation).sort(),
            'a field the live row renders but the snapshot omits is invisible after a loss',
        ).toEqual(Object.keys(live).sort());
        expect(retained.presentation, 'and the values match at capture time').toEqual(live);
    });

    it('does not keep arrays the live session can still mutate', () => {
        const buffer = get(buffers)[KEY]!;
        const captured = captureRetainedState(1);
        if (!captured.captured) throw new Error(`capture failed: ${captured.reason}`);

        const retained = getRetainedSnapshot()!.buffers.get(KEY)!;
        const before = {
            nameClasses: [...retained.presentation.nameClasses],
            title: [...retained.presentation.title],
            localVariables: { ...retained.presentation.localVariables! },
        };

        // What the live session does to those arrays afterwards.
        buffer.nameClasses.push('unread-heavy');
        buffer.title.push({ text: 'late title part', style: 'default' } as never);
        buffer.localVariables!.server = 'elsewhere';

        expect(retained.presentation.nameClasses, 'the snapshot kept its own list').toEqual(before.nameClasses);
        expect(retained.presentation.title, 'the snapshot kept its own title').toEqual(before.title);
        expect(retained.presentation.localVariables, 'the snapshot kept its own variables').toEqual(before.localVariables);
    });
});
