import { describe, it, expect } from 'vitest';
import {
    validateBuffer,
    validateLine,
    validateLineArray,
    validateNickGroup,
    validateHotlistEntry,
    validateEventFrame,
    validateResponseFrame,
    validateHandshakeResponse,
    validateCompletionResponse,
    validateErrorBody,
} from '#lib/api/api-validation.ts';
import {
    deriveSemanticType,
    hotlistCounts,
} from '#lib/api/api-contracts.ts';
import {
    asBufferId,
    asLineId,
    asGroupId,
    asParentGroupId,
    asReadLineId,
    NO_PARENT_GROUP,
    NO_READ_LINE,
} from '#lib/api/api-ids.ts';

// Fixtures below are trimmed real payloads captured live from WeeChat 4.10.1
// (src-svelte/test/fixtures/api-dossier/frames/probe-session.jsonl).

const liveBuffer = {
    id: 1791126593742399, name: 'core.weechat', short_name: 'weechat', number: 1,
    type: 'formatted', hidden: false, title: 'WeeChat 4.10.1 (C) 2003-2026 - https://weechat.org/',
    modes: '', input_prompt: '', input: '', input_position: 0, input_multiline: false,
    nicklist: false, nicklist_case_sensitive: false, nicklist_display_groups: true,
    time_displayed: true, local_variables: { plugin: 'core', name: 'weechat' },
    keys: [], last_read_line_id: -1,
};

const liveLine = {
    id: 10, y: -1, date: '2026-10-04T15:34:09.153069Z', date_printed: '2026-10-04T15:34:09.153069Z',
    displayed: true, highlight: false, notify_level: 0,
    prefix: '\u001b[0m\u001b[38;5;10m\u001b[49m-->', message: '\u001b[38;5;38mgbbot2\u001b[0m has joined',
    tags: ['irc_join', 'irc_smart_filter', 'nick_gbbot2', 'log4'],
};

const liveHotlistEntry = {
    priority: 0, date: '2026-10-04T15:09:53.808755Z',
    buffer_id: 1791126593803023, count: [9, 0, 0, 0],
};

const liveNickGroup = {
    id: 0, parent_group_id: -1, name: 'root', color_name: '', color: '', visible: false,
    groups: [{
        id: 1791126593814529, parent_group_id: 0, name: '000|o',
        color_name: 'weechat.color.nicklist_group', color: '\u001b[32m', visible: true,
        groups: [],
        nicks: [{
            id: 1791128049153705, parent_group_id: 1791126593814529, prefix: '@',
            prefix_color_name: 'lightgreen', prefix_color: '\u001b[92m',
            name: 'gbbot2', color_name: 'bar_fg', color: '\u001b[39m', visible: true,
        }],
    }],
    nicks: [],
};

describe('api-ids boundaries', () => {
    it('accepts real microsecond timestamps and line id zero', () => {
        expect(asBufferId(1791126593742399)).toBe(1791126593742399);
        expect(asLineId(0)).toBe(0); // line id 0 is valid, not "missing"
        expect(asGroupId(0)).toBe(0); // root group id 0 is valid
        expect(asParentGroupId(NO_PARENT_GROUP)).toBe(NO_PARENT_GROUP);
        expect(asReadLineId(NO_READ_LINE)).toBe(NO_READ_LINE);
    });

    it('rejects unsafe, fractional, negative or non-numeric IDs', () => {
        expect(asBufferId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
        expect(asBufferId(1.5)).toBeNull();
        expect(asBufferId(-1)).toBeNull();
        expect(asBufferId('0xdeadbeef')).toBeNull(); // legacy pointer strings
        expect(asLineId(-1)).toBeNull();
        expect(asGroupId(-2)).toBeNull();
        expect(asParentGroupId(undefined)).toBeNull();
    });
});

describe('validateBuffer', () => {
    it('accepts the live buffer body', () => {
        const { value, issues } = validateBuffer(liveBuffer);
        expect(issues).toEqual([]);
        expect(value?.id).toBe(1791126593742399);
        expect(value?.last_read_line_id).toBe(NO_READ_LINE);
        // Omitted lines/nicklist_root stay absent (omitted ≠ empty)
        expect(value && 'lines' in value).toBe(false);
        expect(value && 'nicklist_root' in value).toBe(false);
    });

    it('distinguishes present-empty lines from omitted lines', () => {
        const withEmpty = validateBuffer({ ...liveBuffer, lines: [] });
        expect(withEmpty.value?.lines).toEqual([]);
        const withOne = validateBuffer({ ...liveBuffer, lines: [liveLine] });
        expect(withOne.value?.lines?.length).toBe(1);
    });

    it('tolerates unknown additive fields', () => {
        const { value, issues } = validateBuffer({ ...liveBuffer, future_field: { a: 1 } });
        expect(issues).toEqual([]);
        expect(value?.name).toBe('core.weechat');
    });

    it('rejects malformed required fields with diagnostics', () => {
        const { value, issues } = validateBuffer({ ...liveBuffer, id: '0x1' });
        expect(value).toBeNull();
        expect(issues[0]).toContain('id');
    });

    it('derives semantic type from local_variables', () => {
        expect(deriveSemanticType({ plugin: 'irc', type: 'channel' })).toBe('channel');
        expect(deriveSemanticType({ plugin: 'irc', type: 'private' })).toBe('private');
        expect(deriveSemanticType({ plugin: 'irc', type: 'server' })).toBe('server');
        expect(deriveSemanticType({ plugin: 'core' })).toBe('other');
    });
});

describe('validateLine', () => {
    it('accepts the live line payload', () => {
        const { value, issues } = validateLine(liveLine);
        expect(issues).toEqual([]);
        expect(value?.id).toBe(10);
        expect(value?.y).toBe(-1);
        expect(value?.tags).toContain('irc_join');
    });

    it('rejects invalid dates', () => {
        const { value, issues } = validateLine({ ...liveLine, date: 'not-a-date' });
        expect(value).toBeNull();
        expect(issues.join()).toContain('date');
    });

    it('validates arrays element-wise', () => {
        const { value, issues } = validateLineArray([liveLine, { ...liveLine, message: 42 }]);
        expect(issues.join()).toContain('lines[1]');
        expect(value).toBeNull();
    });
});

describe('validateNickGroup', () => {
    it('accepts the live nested nicklist tree', () => {
        const { value, issues } = validateNickGroup(liveNickGroup);
        expect(issues).toEqual([]);
        expect(value?.id).toBe(0);
        expect(value?.parent_group_id).toBe(NO_PARENT_GROUP);
        expect(value?.groups[0]?.nicks[0]?.name).toBe('gbbot2');
    });
});

describe('validateHotlistEntry', () => {
    it('accepts the live entry and maps count slots in verified order', () => {
        const { value, issues } = validateHotlistEntry(liveHotlistEntry);
        expect(issues).toEqual([]);
        expect(value?.count).toEqual([9, 0, 0, 0]);
        expect(hotlistCounts(value!.count)).toEqual({ low: 9, message: 0, private: 0, highlight: 0 });
    });

    it('rejects malformed count tuples', () => {
        expect(validateHotlistEntry({ ...liveHotlistEntry, count: [1, 2] }).value).toBeNull();
        expect(validateHotlistEntry({ ...liveHotlistEntry, count: [1, 2, 3, -1] }).value).toBeNull();
    });
});

describe('frame validation', () => {
    it('accepts a live response frame', () => {
        const { value, issues } = validateResponseFrame({
            code: 200, message: 'OK', request: 'GET /api/buffers?lines=0&nicks=false',
            request_body: null, request_id: 'b1.0', body_type: 'buffers', body: [liveBuffer],
        });
        expect(issues).toEqual([]);
        expect(value?.request_id).toBe('b1.0');
        expect(value?.body_type).toBe('buffers');
    });

    it('accepts live event frames including source-only names', () => {
        const { value, issues } = validateEventFrame({
            code: 0, message: 'Event', event_name: 'buffer_modes_changed',
            buffer_id: 1791126593803023, body_type: null, body: null,
        });
        expect(issues).toEqual([]);
        expect(value?.event_name).toBe('buffer_modes_changed');
    });

    it('rejects frames with unknown body_type instead of guessing', () => {
        expect(validateResponseFrame({
            code: 200, message: 'OK', request: 'x', request_body: null,
            request_id: null, body_type: 'wat', body: {},
        }).value).toBeNull();
    });

    it('validates handshake, completion and error bodies', () => {
        expect(validateHandshakeResponse({
            password_hash_algo: 'pbkdf2+sha512', password_hash_iterations: 100000, totp: false,
        }).value?.password_hash_iterations).toBe(100000);
        expect(validateHandshakeResponse({
            password_hash_algo: null, password_hash_iterations: 0, totp: false,
        }).value).toBeNull();
        expect(validateCompletionResponse({
            context: 'auto', base_word: 'gbb', position_replace: 0, add_space: false, list: ['gbbot2: '],
        }).value?.list).toEqual(['gbbot2: ']);
        expect(validateErrorBody({ error: 'Buffer not found' }).value?.error).toBe('Buffer not found');
        expect(validateErrorBody({ message: 'no error key' }).value).toBeNull();
    });
});
