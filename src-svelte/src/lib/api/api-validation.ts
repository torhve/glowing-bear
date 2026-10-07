// Runtime validation at the network boundary for WeeChat Relay API payloads.
//
// Policy (migration contract §5/§7): validate required fields, enums, flags,
// arrays and numeric ID boundaries; ALLOW unknown additive fields (WeeChat may
// extend payloads); collect diagnostics instead of throwing so one malformed
// payload cannot crash the session. A validator returns the typed value or
// null plus human-readable issues for logging.

import type {
    HandshakeResponse,
    VersionResponse,
    RestBuffer,
    RestLine,
    RestNickGroup,
    RestNick,
    RestHotlistEntry,
    RestScript,
    CompletionResponse,
    RestErrorResponse,
    WebSocketEvent,
    WebSocketResponse,
    ApiBodyType,
} from '#lib/weechat-rest-types.ts';
import {
    asBufferId,
    asLineId,
    asGroupId,
    asNickId,
    asParentGroupId,
    asReadLineId,
    NO_READ_LINE,
} from '#lib/api/api-ids.ts';

export interface Validated<T> {
    value: T | null;
    issues: string[];
}

function ok<T>(value: T): Validated<T> {
    return { value, issues: [] };
}

function fail<T>(issues: string[]): Validated<T> {
    return { value: null, issues };
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, key: string, issues: string[]): string | undefined {
    const v = o[key];
    if (typeof v === 'string') return v;
    issues.push(`${key}: expected string, got ${typeof v}`);
    return undefined;
}

function reqNumber(o: Record<string, unknown>, key: string, issues: string[]): number | undefined {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    issues.push(`${key}: expected number, got ${typeof v}`);
    return undefined;
}

function reqBoolean(o: Record<string, unknown>, key: string, issues: string[]): boolean | undefined {
    const v = o[key];
    if (typeof v === 'boolean') return v;
    issues.push(`${key}: expected boolean, got ${typeof v}`);
    return undefined;
}

function optBoolean(o: Record<string, unknown>, key: string, issues: string[], dflt: boolean): boolean {
    const v = o[key];
    if (v === undefined) return dflt;
    if (typeof v === 'boolean') return v;
    issues.push(`${key}: expected boolean, got ${typeof v}`);
    return dflt;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/* Dates are validated for shape AND parseability; the raw string is retained
 * so display code can reformat without losing provenance. */
function isoDate(o: Record<string, unknown>, key: string, issues: string[]): string | undefined {
    const v = reqString(o, key, issues);
    if (v === undefined) return undefined;
    if (!ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
        issues.push(`${key}: not an ISO-8601 timestamp: ${JSON.stringify(v)}`);
        return undefined;
    }
    return v;
}

/**
 * An ISO timestamp a relay may omit entirely.
 *
 * Absent is fine; present-but-malformed is still an error, because a garbage
 * timestamp renders as an invalid date instead of failing loudly.
 */
function optIsoDate(o: Record<string, unknown>, key: string, issues: string[]): string | undefined {
    if (o[key] === undefined) return undefined;
    return isoDate(o, key, issues);
}

const BODY_TYPES = new Set<string>([
    'buffers', 'buffer', 'lines', 'line', 'nick_group', 'nick',
    'hotlist', 'completion', 'scripts', 'json',
]);

const COLOR_MODES = new Set(['ansi', 'weechat', 'strip']);

// --- Top-level frames ---

/* Response frame: {code, message, request, request_body, request_id,
 * body_type, body}. Unknown extra fields are tolerated. */
export function validateResponseFrame(raw: unknown): Validated<WebSocketResponse> {
    if (!isRecord(raw)) return fail(['frame: expected object']);
    const issues: string[] = [];
    const code = reqNumber(raw, 'code', issues);
    const message = reqString(raw, 'message', issues);
    const request = reqString(raw, 'request', issues);
    if (code === undefined || message === undefined || request === undefined) {
        return fail(issues);
    }
    const bodyType = raw.body_type;
    if (bodyType !== null && bodyType !== undefined &&
        !(typeof bodyType === 'string' && BODY_TYPES.has(bodyType))) {
        issues.push(`body_type: unknown value ${JSON.stringify(bodyType)}`);
        return fail(issues);
    }
    return ok({
        code,
        message,
        request,
        request_body: raw.request_body ?? null,
        request_id: typeof raw.request_id === 'string' ? raw.request_id : null,
        body_type: (bodyType ?? null) as ApiBodyType | null,
        body: raw.body ?? null,
    });
}

export function validateEventFrame(raw: unknown): Validated<WebSocketEvent> {
    if (!isRecord(raw)) return fail(['event: expected object']);
    const issues: string[] = [];
    if (raw.code !== 0 || raw.message !== 'Event') {
        return fail(['event: code/message mismatch for an event frame']);
    }
    const eventName = reqString(raw, 'event_name', issues);
    const bufferId = asBufferId(raw.buffer_id);
    if (eventName === undefined) return fail(issues);
    if (bufferId === null) {
        issues.push(`buffer_id: expected positive safe integer, got ${JSON.stringify(raw.buffer_id)}`);
        return fail(issues);
    }
    const bodyType = raw.body_type;
    if (bodyType !== null && bodyType !== undefined &&
        !(typeof bodyType === 'string' && BODY_TYPES.has(bodyType))) {
        issues.push(`body_type: unknown value ${JSON.stringify(bodyType)}`);
        return fail(issues);
    }
    return ok({
        code: 0,
        message: 'Event',
        event_name: eventName,
        buffer_id: bufferId,
        body_type: (bodyType ?? null) as ApiBodyType | null,
        body: raw.body ?? null,
    });
}

export function validateErrorBody(raw: unknown): Validated<RestErrorResponse> {
    if (!isRecord(raw)) return fail(['error body: expected object']);
    const issues: string[] = [];
    const error = reqString(raw, 'error', issues);
    if (error === undefined) return fail(issues);
    return ok({ error });
}

// --- Auth / version ---

export function validateHandshakeResponse(raw: unknown): Validated<HandshakeResponse> {
    if (!isRecord(raw)) return fail(['handshake: expected object']);
    const issues: string[] = [];
    const algo = raw.password_hash_algo;
    if (algo !== null && typeof algo !== 'string') {
        issues.push('password_hash_algo: expected string or null');
    }
    const iterations = reqNumber(raw, 'password_hash_iterations', issues);
    if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1)) {
        issues.push(`password_hash_iterations: invalid count ${iterations}`);
    }
    const totp = reqBoolean(raw, 'totp', issues);
    if (iterations === undefined || totp === undefined || issues.length) return fail(issues);
    return ok({
        password_hash_algo: typeof algo === 'string' ? algo : null,
        password_hash_iterations: iterations,
        totp,
    });
}

export function validateVersionResponse(raw: unknown): Validated<VersionResponse> {
    if (!isRecord(raw)) return fail(['version: expected object']);
    const issues: string[] = [];
    const weechatVersion = reqString(raw, 'weechat_version', issues);
    const relayApiVersion = reqString(raw, 'relay_api_version', issues);
    const relayApiNumber = reqNumber(raw, 'relay_api_version_number', issues);
    if (weechatVersion === undefined || relayApiVersion === undefined || relayApiNumber === undefined) {
        return fail(issues);
    }
    return ok({
        weechat_version: weechatVersion,
        weechat_version_git: typeof raw.weechat_version_git === 'string' ? raw.weechat_version_git : '',
        weechat_version_number: typeof raw.weechat_version_number === 'number' ? raw.weechat_version_number : 0,
        relay_api_version: relayApiVersion,
        relay_api_version_number: relayApiNumber,
    });
}

// --- Buffers / lines / nicks ---

export function validateBuffer(raw: unknown): Validated<RestBuffer> {
    if (!isRecord(raw)) return fail(['buffer: expected object']);
    const issues: string[] = [];
    const id = asBufferId(raw.id);
    if (id === null) {
        issues.push(`id: expected positive safe integer, got ${JSON.stringify(raw.id)}`);
        return fail(issues);
    }
    const name = reqString(raw, 'name', issues);
    const shortName = reqString(raw, 'short_name', issues);
    const type = reqString(raw, 'type', issues);
    if (type !== undefined && type !== 'formatted' && type !== 'free') {
        issues.push(`type: unknown buffer content type ${JSON.stringify(type)}`);
    }
    const number = reqNumber(raw, 'number', issues);
    if (name === undefined || shortName === undefined || type === undefined || number === undefined) {
        return fail(issues);
    }
    reqBoolean(raw, 'hidden', issues);
    const lastReadLineId = asReadLineId(raw.last_read_line_id);
    if (lastReadLineId === null) {
        issues.push(`last_read_line_id: expected integer >= -1, got ${JSON.stringify(raw.last_read_line_id)}`);
    }
    if (raw.local_variables !== undefined && !isRecord(raw.local_variables)) {
        issues.push('local_variables: expected object');
    }
    // notify is a WeeChat >= 5.0.0 field; validate only when present.
    let notify: RestBuffer['notify'];
    if (raw.notify !== undefined) {
        if (raw.notify === 'none' || raw.notify === 'highlight' || raw.notify === 'message' || raw.notify === 'all') {
            notify = raw.notify;
        } else {
            issues.push(`notify: unknown level ${JSON.stringify(raw.notify)}`);
        }
    }
    // Omitted vs present-empty is significant: only validate when present.
    let lines: RestLine[] | undefined;
    if (raw.lines !== undefined) {
        const validated = validateLineArray(raw.lines);
        issues.push(...validated.issues);
        if (validated.value === null) return fail(issues);
        lines = validated.value;
    }
    let nicklistRoot: RestNickGroup | undefined;
    if (raw.nicklist_root !== undefined) {
        const validated = validateNickGroup(raw.nicklist_root);
        issues.push(...validated.issues);
        if (validated.value === null) return fail(issues);
        nicklistRoot = validated.value;
    }
    if (issues.length) return fail(issues);
    return ok({
        id,
        name,
        short_name: shortName,
        number,
        type: type as RestBuffer['type'],
        hidden: typeof raw.hidden === 'boolean' ? raw.hidden : false,
        title: typeof raw.title === 'string' ? raw.title : '',
        modes: typeof raw.modes === 'string' ? raw.modes : '',
        input_prompt: typeof raw.input_prompt === 'string' ? raw.input_prompt : '',
        input: typeof raw.input === 'string' ? raw.input : '',
        input_position: typeof raw.input_position === 'number' ? raw.input_position : 0,
        input_multiline: optBoolean(raw, 'input_multiline', issues, false),
        nicklist: optBoolean(raw, 'nicklist', issues, false),
        nicklist_case_sensitive: optBoolean(raw, 'nicklist_case_sensitive', issues, false),
        nicklist_display_groups: optBoolean(raw, 'nicklist_display_groups', issues, true),
        time_displayed: optBoolean(raw, 'time_displayed', issues, true),
        local_variables: isRecord(raw.local_variables)
            ? Object.fromEntries(Object.entries(raw.local_variables).map(([k, v]) => [k, String(v)]))
            : {},
        keys: Array.isArray(raw.keys) ? raw.keys as RestBuffer['keys'] : [],
        last_read_line_id: lastReadLineId ?? NO_READ_LINE,
        ...(notify !== undefined ? { notify } : {}),
        ...(lines !== undefined ? { lines } : {}),
        ...(nicklistRoot !== undefined ? { nicklist_root: nicklistRoot } : {}),
    });
}

export function validateLine(raw: unknown): Validated<RestLine> {
    if (!isRecord(raw)) return fail(['line: expected object']);
    const issues: string[] = [];
    const id = asLineId(raw.id);
    if (id === null) {
        issues.push(`id: expected integer >= 0, got ${JSON.stringify(raw.id)}`);
        return fail(issues);
    }
    const date = isoDate(raw, 'date', issues);
    // WeeChat 4.10.1 serialised `date_printed`; WeeChat 5.0 removed it from the
    // API relay's line object. Requiring it made a 5.0 relay's EVERY line —
    // history and live `buffer_line_added` alike — fail validation and get
    // dropped, i.e. an empty chat with no error the user can see.
    const datePrinted = optIsoDate(raw, 'date_printed', issues);
    const prefix = reqString(raw, 'prefix', issues);
    const message = reqString(raw, 'message', issues);
    if (date === undefined || prefix === undefined || message === undefined) {
        return fail(issues);
    }
    if (typeof raw.y !== 'number' || !Number.isInteger(raw.y)) {
        issues.push(`y: expected integer, got ${JSON.stringify(raw.y)}`);
    }
    if (raw.displayed !== undefined && typeof raw.displayed !== 'boolean') {
        issues.push('displayed: expected boolean');
    }
    if (raw.highlight !== undefined && typeof raw.highlight !== 'boolean') {
        issues.push('highlight: expected boolean');
    }
    if (raw.notify_level !== undefined && (typeof raw.notify_level !== 'number' || !Number.isInteger(raw.notify_level))) {
        issues.push('notify_level: expected integer');
    }
    if (raw.tags !== undefined &&
        (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string'))) {
        issues.push('tags: expected string array');
    }
    if (issues.length) return fail(issues);
    return ok({
        id,
        y: typeof raw.y === 'number' ? raw.y : -1,
        date,
        ...(datePrinted !== undefined ? { date_printed: datePrinted } : {}),
        displayed: typeof raw.displayed === 'boolean' ? raw.displayed : true,
        highlight: typeof raw.highlight === 'boolean' ? raw.highlight : false,
        notify_level: typeof raw.notify_level === 'number' ? raw.notify_level : 0,
        prefix,
        message,
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    });
}

export function validateLineArray(raw: unknown): Validated<RestLine[]> {
    if (!Array.isArray(raw)) return fail(['lines: expected array']);
    const lines: RestLine[] = [];
    const issues: string[] = [];
    raw.forEach((entry, i) => {
        const v = validateLine(entry);
        if (v.value) lines.push(v.value);
        else issues.push(...v.issues.map((s) => `lines[${i}] ${s}`));
    });
    if (issues.length) return fail(issues);
    return ok(lines);
}

export function validateNick(raw: unknown): Validated<RestNick> {
    if (!isRecord(raw)) return fail(['nick: expected object']);
    const issues: string[] = [];
    const id = asNickId(raw.id);
    const parent = asParentGroupId(raw.parent_group_id);
    const name = reqString(raw, 'name', issues);
    if (id === null) {
        issues.push(`id: expected positive safe integer, got ${JSON.stringify(raw.id)}`);
        return fail(issues);
    }
    if (parent === null) {
        issues.push(`parent_group_id: expected integer >= -1, got ${JSON.stringify(raw.parent_group_id)}`);
        return fail(issues);
    }
    if (name === undefined) return fail(issues);
    if (issues.length) return fail(issues);
    return ok({
        id,
        parent_group_id: parent,
        prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
        prefix_color_name: typeof raw.prefix_color_name === 'string' ? raw.prefix_color_name : '',
        prefix_color: typeof raw.prefix_color === 'string' ? raw.prefix_color : '',
        name,
        color_name: typeof raw.color_name === 'string' ? raw.color_name : '',
        color: typeof raw.color === 'string' ? raw.color : '',
        visible: typeof raw.visible === 'boolean' ? raw.visible : true,
    });
}

export function validateNickGroup(raw: unknown): Validated<RestNickGroup> {
    if (!isRecord(raw)) return fail(['nick_group: expected object']);
    const issues: string[] = [];
    const id = asGroupId(raw.id);
    const parent = asParentGroupId(raw.parent_group_id);
    if (id === null) {
        issues.push(`id: expected integer >= 0, got ${JSON.stringify(raw.id)}`);
        return fail(issues);
    }
    if (parent === null) {
        issues.push(`parent_group_id: expected integer >= -1, got ${JSON.stringify(raw.parent_group_id)}`);
        return fail(issues);
    }
    const groups: RestNickGroup[] = [];
    if (raw.groups !== undefined) {
        if (!Array.isArray(raw.groups)) {
            issues.push('groups: expected array');
            return fail(issues);
        }
        raw.groups.forEach((g, i) => {
            const v = validateNickGroup(g);
            if (v.value) groups.push(v.value);
            else issues.push(...v.issues.map((s) => `groups[${i}] ${s}`));
        });
    }
    const nicks: RestNick[] = [];
    if (raw.nicks !== undefined) {
        if (!Array.isArray(raw.nicks)) {
            issues.push('nicks: expected array');
            return fail(issues);
        }
        raw.nicks.forEach((n, i) => {
            const v = validateNick(n);
            if (v.value) nicks.push(v.value);
            else issues.push(...v.issues.map((s) => `nicks[${i}] ${s}`));
        });
    }
    if (issues.length) return fail(issues);
    return ok({
        id,
        parent_group_id: parent,
        name: typeof raw.name === 'string' ? raw.name : '',
        color_name: typeof raw.color_name === 'string' ? raw.color_name : '',
        color: typeof raw.color === 'string' ? raw.color : '',
        visible: typeof raw.visible === 'boolean' ? raw.visible : true,
        groups,
        nicks,
    });
}

// --- Hotlist ---

/* count order verified live + from gui-hotlist.h: [low, message, private, highlight] */
export function validateHotlistEntry(raw: unknown): Validated<RestHotlistEntry> {
    if (!isRecord(raw)) return fail(['hotlist entry: expected object']);
    const issues: string[] = [];
    const bufferId = asBufferId(raw.buffer_id);
    if (bufferId === null) {
        issues.push(`buffer_id: expected positive safe integer, got ${JSON.stringify(raw.buffer_id)}`);
        return fail(issues);
    }
    const priority = reqNumber(raw, 'priority', issues);
    if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 3)) {
        issues.push(`priority: expected 0..3, got ${priority}`);
    }
    if (!isoDate(raw, 'date', issues)) return fail(issues);
    if (!Array.isArray(raw.count) || raw.count.length !== 4 ||
        raw.count.some((c) => typeof c !== 'number' || !Number.isInteger(c) || c < 0)) {
        issues.push(`count: expected 4 non-negative integers [low,message,private,highlight], got ${JSON.stringify(raw.count)}`);
        return fail(issues);
    }
    if (priority === undefined || issues.length) return fail(issues);
    return ok({
        priority,
        date: raw.date as string,
        buffer_id: bufferId,
        count: raw.count as number[],
    });
}

// --- Scripts / completion ---

export function validateScript(raw: unknown): Validated<RestScript> {
    if (!isRecord(raw)) return fail(['script: expected object']);
    const issues: string[] = [];
    const name = reqString(raw, 'name', issues);
    if (name === undefined || issues.length) return fail(issues);
    return ok({
        name,
        version: typeof raw.version === 'string' ? raw.version : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        author: typeof raw.author === 'string' ? raw.author : '',
        license: typeof raw.license === 'string' ? raw.license : '',
    });
}

export function validateCompletionResponse(raw: unknown): Validated<CompletionResponse> {
    if (!isRecord(raw)) return fail(['completion: expected object']);
    const issues: string[] = [];
    const context = reqString(raw, 'context', issues);
    const baseWord = reqString(raw, 'base_word', issues);
    const positionReplace = reqNumber(raw, 'position_replace', issues);
    const addSpace = reqBoolean(raw, 'add_space', issues);
    if (context === undefined || baseWord === undefined || positionReplace === undefined || addSpace === undefined) {
        return fail(issues);
    }
    if (issues.length) return fail(issues);
    if (!Array.isArray(raw.list) || raw.list.some((s) => typeof s !== 'string')) {
        issues.push('list: expected string array');
        return fail(issues);
    }
    return ok({
        context,
        base_word: baseWord,
        position_replace: positionReplace,
        add_space: addSpace,
        list: raw.list as string[],
    });
}

// --- Query parameter helpers ---

export function isValidColorMode(mode: string): mode is 'ansi' | 'weechat' | 'strip' {
    return COLOR_MODES.has(mode);
}
