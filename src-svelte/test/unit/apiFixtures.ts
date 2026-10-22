/**
 * Wire-shaped API fixtures.
 *
 * `BufferSnapshot` and `LineSnapshot` describe what the Relay API sends. A test
 * that builds one by hand has to build all of it: a snapshot missing a field is
 * a snapshot no 4.10.1 relay ever sent, and the reducer under test is being
 * shown something the transport cannot produce.
 *
 * The defaults are the values recorded live in
 * `test/fixtures/api-dossier/frames/probe-lifecycle.jsonl` (gbtest, WeeChat
 * 4.10.1): a pushed line carries `y: -1` and a microsecond ISO `date`; a buffer
 * with nothing set carries empty `modes`, `input_prompt` and `input`,
 * `input_position: 0`, `nicklist: false`, `nicklist_display_groups: true` and
 * `time_displayed: true`. A test overrides only the fields its case is about.
 */
import type { BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

/** A buffer snapshot with every field the relay reports, `id` set by the caller. */
export function apiBuffer(id: number, overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
    return {
        id: id as ApiBufferId,
        name: '',
        shortName: '',
        number: 0,
        contentType: 'formatted',
        semanticType: 'other',
        hidden: false,
        title: '',
        modes: '',
        inputPrompt: '',
        input: '',
        inputPosition: 0,
        inputMultiline: false,
        hasNicklist: false,
        nicklistCaseSensitive: false,
        nicklistDisplayGroups: true,
        timeDisplayed: true,
        localVariables: {},
        lastReadLineId: -1,
        ...overrides,
    };
}

/**
 * A line snapshot. `epochMs` is derived from `date` the way the mapper derives
 * it, so a test that pins a time overrides `date` and gets a matching `epochMs`
 * only by saying so — the two are set together here rather than left to drift.
 */
export function apiLine(id: number, overrides: Partial<LineSnapshot> = {}): LineSnapshot {
    const epochMs = Date.parse('2026-10-04T12:00:00.000Z') + id * 1000;
    return {
        id: id as ApiLineId,
        y: -1,
        date: new Date(epochMs).toISOString(),
        epochMs,
        displayed: true,
        highlight: false,
        notifyLevel: 1,
        prefix: '',
        message: `msg ${id}`,
        tags: ['notify_message'],
        ...overrides,
    };
}
