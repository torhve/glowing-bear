// Wire → normalized-snapshot mapping and event dispatch (phase 6 glue).
//
// The session hands raw frames to the orchestrator; this module validates
// (api-validation), maps to the normalized contracts (api-contracts), and
// calls exactly one ApiReducers method per event. Invalid payloads never
// reach feature reducers — they surface via reducers.unhandled() so state is
// either fully applied or untouched.

import type {
    RestBuffer, RestHotlistEntry, RestLine, RestNick, RestNickGroup,
} from '#lib/weechat-rest-types.ts';
import {
    validateBuffer, validateLine, validateLineArray, validateNick,
    validateNickGroup, validateHotlistEntry,
} from '#lib/api/api-validation.ts';
import {
    asBufferId, asLineId, asNickId, asGroupId, asParentGroupId, asReadLineId,
    NO_READ_LINE, type ApiBufferId,
} from '#lib/api/api-ids.ts';
import {
    deriveSemanticType,
    type BufferSnapshot, type HotlistSnapshot, type LineSnapshot,
    type NickGroupSnapshot, type NickSnapshot, type ApiReducers,
} from '#lib/api/api-contracts.ts';
import type { ApiSessionEvent } from '#lib/api/api-session.ts';

export function mapBuffer(wire: RestBuffer): BufferSnapshot | null {
    const id = asBufferId(wire.id);
    if (id === null) return null;
    const lastRead = asReadLineId(wire.last_read_line_id);
    return {
        id,
        name: wire.name,
        shortName: wire.short_name,
        number: wire.number,
        contentType: wire.type,
        semanticType: deriveSemanticType(wire.local_variables),
        hidden: wire.hidden,
        title: wire.title,
        modes: wire.modes,
        inputPrompt: wire.input_prompt,
        input: wire.input,
        inputPosition: wire.input_position,
        inputMultiline: wire.input_multiline,
        hasNicklist: wire.nicklist,
        nicklistCaseSensitive: wire.nicklist_case_sensitive,
        nicklistDisplayGroups: wire.nicklist_display_groups,
        timeDisplayed: wire.time_displayed,
        localVariables: wire.local_variables,
        lastReadLineId: lastRead === null ? NO_READ_LINE : lastRead,
    };
}

export function mapLine(wire: RestLine): LineSnapshot | null {
    const id = asLineId(wire.id);
    if (id === null) return null;
    const epochMs = Date.parse(wire.date);
    return {
        id,
        y: typeof wire.y === 'number' ? wire.y : -1,
        date: wire.date,
        datePrinted: wire.date_printed,
        epochMs: Number.isNaN(epochMs) ? 0 : epochMs,
        displayed: wire.displayed,
        highlight: wire.highlight,
        notifyLevel: wire.notify_level,
        prefix: wire.prefix,
        message: wire.message,
        tags: wire.tags,
    };
}

export function mapNick(wire: RestNick): NickSnapshot | null {
    const id = asNickId(wire.id);
    const parent = asParentGroupId(wire.parent_group_id);
    if (id === null || parent === null) return null;
    return {
        id,
        parentGroupId: parent,
        prefix: wire.prefix,
        prefixColorName: wire.prefix_color_name,
        prefixColor: wire.prefix_color,
        name: wire.name,
        colorName: wire.color_name,
        color: wire.color,
        visible: wire.visible,
    };
}

export function mapNickGroup(wire: RestNickGroup): NickGroupSnapshot | null {
    const id = asGroupId(wire.id);
    const parent = asParentGroupId(wire.parent_group_id);
    if (id === null || parent === null) return null;
    return {
        id,
        parentGroupId: parent,
        name: wire.name,
        colorName: wire.color_name,
        color: wire.color,
        visible: wire.visible,
    };
}

export function mapHotlistEntry(wire: RestHotlistEntry): HotlistSnapshot | null {
    const counts = wire.count;
    if (!Array.isArray(counts) || counts.length < 4) return null;
    return {
        priority: wire.priority,
        date: wire.date,
        counts: {
            low: counts[0] ?? 0,
            message: counts[1] ?? 0,
            private: counts[2] ?? 0,
            highlight: counts[3] ?? 0,
        },
    };
}

/** GET /api/buffers body → BufferSnapshot[] (invalid entries are skipped
 *  with a reason, never half-applied). */
export function mapBufferList(body: unknown, reducers: ApiReducers): BufferSnapshot[] | null {
    if (!Array.isArray(body)) {
        reducers.unhandled('buffers response is not an array');
        return null;
    }
    const out: BufferSnapshot[] = [];
    for (const raw of body) {
        const v = validateBuffer(raw);
        if (!v.value) {
            reducers.unhandled(`invalid buffer payload: ${v.issues.join('; ')}`);
            continue;
        }
        const snap = mapBuffer(v.value);
        if (snap === null) {
            reducers.unhandled(`invalid buffer id in payload for ${String((v.value as RestBuffer).name)}`);
            continue;
        }
        out.push(snap);
    }
    return out;
}

/** GET /api/hotlist body → Map keyed by buffer id. */
export function mapHotlist(body: unknown, reducers: ApiReducers): Map<ApiBufferId, HotlistSnapshot> | null {
    const map = new Map<ApiBufferId, HotlistSnapshot>();
    if (!Array.isArray(body)) {
        reducers.unhandled('hotlist response is not an array');
        return null;
    }
    for (const raw of body) {
        const v = validateHotlistEntry(raw);
        if (!v.value) {
            reducers.unhandled(`invalid hotlist entry: ${v.issues.join('; ')}`);
            continue;
        }
        const id = asBufferId(v.value.buffer_id);
        const snap = mapHotlistEntry(v.value);
        if (id === null || snap === null) {
            reducers.unhandled('invalid hotlist buffer_id or counts');
            continue;
        }
        map.set(id, snap);
    }
    return map;
}

/**
 * Route one session event to exactly one reducer method. Payload validation
 * happens here; a failed payload calls unhandled() and leaves state alone.
 * buffer_opened carries optional lines/nicks sub-resources — absent is passed
 * as undefined (distinct from present-empty).
 */
export function dispatchEvent(event: ApiSessionEvent, reducers: ApiReducers): void {
    const bufferId = asBufferId(event.buffer_id);

    switch (event.event_name) {
    case 'buffer_opened': {
        if (bufferId === null) { reducers.unhandled('buffer_opened with invalid buffer_id'); return; }
        const body = event.body;
        if (body === null || typeof body !== 'object') { reducers.unhandled('buffer_opened without body'); return; }
        const v = validateBuffer(body);
        if (!v.value) { reducers.unhandled(`buffer_opened invalid: ${v.issues.join('; ')}`); return; }
        const snap = mapBuffer(v.value);
        if (snap === null) { reducers.unhandled('buffer_opened invalid id'); return; }
        let lines: LineSnapshot[] | undefined;
        if (v.value.lines !== undefined) {
            const lv = validateLineArray(v.value.lines);
            if (!lv.value) { reducers.unhandled(`buffer_opened invalid lines: ${lv.issues.join('; ')}`); return; }
            lines = lv.value.map(mapLine).filter((l): l is LineSnapshot => l !== null);
        }
        let groups: NickGroupSnapshot[] | undefined;
        let nicks: NickSnapshot[] | undefined;
        if (v.value.nicklist_root !== undefined) {
            groups = collectGroups(v.value.nicklist_root);
            if (groups !== undefined) {
                nicks = collectNicks(v.value.nicklist_root);
            }
        }
        reducers.bufferOpened(snap, lines, groups, nicks);
        return;
    }
    case 'buffer_closing':
        if (bufferId === null) { reducers.unhandled('buffer_closing with invalid buffer_id'); return; }
        reducers.bufferClosing(bufferId);
        return;
    case 'buffer_closed':
        if (bufferId === null) { reducers.unhandled('buffer_closed with invalid buffer_id'); return; }
        reducers.bufferClosed(bufferId);
        return;
    case 'buffer_title_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const title = typeof event.body === 'string' ? event.body
            : (isObj(event.body) && typeof event.body.title === 'string') ? event.body.title : null;
        if (title === null) { reducers.unhandled('buffer_title_changed without title'); return; }
        reducers.bufferTitleChanged(bufferId, title);
        return;
    }
    case 'buffer_localvar_set': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        if (!isObj(event.body) || typeof event.body.name !== 'string' || typeof event.body.value !== 'string') {
            reducers.unhandled('buffer_localvar_set without name/value'); return;
        }
        reducers.bufferLocalvarSet(bufferId, event.body.name, event.body.value);
        return;
    }
    case 'buffer_localvar_removed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const name = typeof event.body === 'string' ? event.body
            : (isObj(event.body) && typeof event.body.name === 'string') ? event.body.name : null;
        if (name === null) { reducers.unhandled('buffer_localvar_removed without name'); return; }
        reducers.bufferLocalvarRemoved(bufferId, name);
        return;
    }
    case 'buffer_modes_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const modes = typeof event.body === 'string' ? event.body
            : (isObj(event.body) && typeof event.body.modes === 'string') ? event.body.modes : null;
        if (modes === null) { reducers.unhandled('buffer_modes_changed without modes'); return; }
        reducers.bufferModesChanged(bufferId, modes);
        return;
    }
    case 'buffer_input_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        if (!isObj(event.body) || typeof event.body.input !== 'string') {
            reducers.unhandled('buffer_input_changed without input'); return;
        }
        const pos = typeof event.body.cursor_pos === 'number' ? event.body.cursor_pos : 0;
        reducers.bufferInputChanged(bufferId, event.body.input, pos);
        return;
    }
    case 'buffer_line_added': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const v = validateLine(event.body);
        if (!v.value) { reducers.unhandled(`buffer_line_added invalid: ${v.issues.join('; ')}`); return; }
        const line = mapLine(v.value);
        if (line === null) { reducers.unhandled('buffer_line_added invalid id'); return; }
        reducers.lineAdded(bufferId, line);
        return;
    }
    case 'buffer_line_data_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const v = validateLine(event.body);
        if (!v.value) { reducers.unhandled(`buffer_line_data_changed invalid: ${v.issues.join('; ')}`); return; }
        const line = mapLine(v.value);
        if (line === null) { reducers.unhandled('buffer_line_data_changed invalid id'); return; }
        reducers.lineDataChanged(bufferId, line);
        return;
    }
    case 'nicklist_group_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const v = validateNickGroup(event.body);
        if (!v.value) { reducers.unhandled(`nicklist_group_changed invalid: ${v.issues.join('; ')}`); return; }
        const group = mapNickGroup(v.value);
        if (group === null) { reducers.unhandled('nicklist_group_changed invalid ids'); return; }
        reducers.nickGroupChanged(bufferId, group);
        return;
    }
    case 'nicklist_group_removed':
    case 'nicklist_group_removing': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const groupId = asGroupId(event.body);
        if (groupId === null) { reducers.unhandled('nicklist group removal without group id'); return; }
        reducers.nickGroupRemoved(bufferId, groupId);
        return;
    }
    case 'nicklist_nick_changed': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const v = validateNick(event.body);
        if (!v.value) { reducers.unhandled(`nicklist_nick_changed invalid: ${v.issues.join('; ')}`); return; }
        const nick = mapNick(v.value);
        if (nick === null) { reducers.unhandled('nicklist_nick_changed invalid ids'); return; }
        reducers.nickChanged(bufferId, nick);
        return;
    }
    case 'nicklist_nick_removed':
    case 'nicklist_nick_removing': {
        if (bufferId === null) { reducers.unhandled(`${event.event_name} with invalid buffer_id`); return; }
        const nickId = asNickId(event.body);
        if (nickId === null) { reducers.unhandled('nick removal without nick id'); return; }
        reducers.nickRemoved(bufferId, nickId);
        return;
    }
    default:
        // nicklist_group_added / nicklist_nick_added / input_changed /
        // input_prompt_changed and any future events: full snapshots are
        // fetched on demand; concrete handling lands with phases 8–9.
        reducers.unhandled(`unrouted event: ${event.event_name}`);
    }
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flatten the nick tree under a root group into a list (tree structure is
 *  preserved through parentGroupId on each snapshot). */
/** Depth-first flatten of the nick tree into a group list (root first), so
 *  reducers keep server display order without walking the tree themselves. */
function collectGroups(node: RestNickGroup): NickGroupSnapshot[] | undefined {
    const out: NickGroupSnapshot[] = [];
    const walk = (n: RestNickGroup): boolean => {
        const mapped = mapNickGroup(n);
        if (mapped === null) return false;
        out.push(mapped);
        for (const child of n.groups ?? []) {
            if (!walk(child)) return false;
        }
        return true;
    };
    return walk(node) ? out : undefined;
}

/** Apply a GET /api/buffers/{id}/nicks nick_group tree through the group/nick
 *  upsert reducers (groups first so display keys register, then nicks). */
export function applyNicklistRoot(
    body: unknown,
    bufferId: ApiBufferId,
    reducers: ApiReducers,
): boolean {
    const v = validateNickGroup(body);
    if (!v.value) {
        reducers.unhandled(`nicklist root invalid: ${v.issues.join('; ')}`);
        return false;
    }
    const groups = collectGroups(v.value);
    if (!groups) {
        reducers.unhandled('nicklist root has invalid group ids');
        return false;
    }
    for (const group of groups) reducers.nickGroupChanged(bufferId, group);
    for (const nick of collectNicks(v.value)) reducers.nickChanged(bufferId, nick);
    return true;
}

function collectNicks(group: RestNickGroup): NickSnapshot[] {
    const out: NickSnapshot[] = [];
    const walk = (g: RestNickGroup) => {
        for (const n of g.nicks ?? []) {
            const snap = mapNick(n);
            if (snap !== null) out.push(snap);
        }
        for (const sub of g.groups ?? []) walk(sub);
    };
    walk(group);
    return out;
}
