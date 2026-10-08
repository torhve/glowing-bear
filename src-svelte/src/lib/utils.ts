import { get } from 'svelte/store';
import { buffers, activeBufferId, wconfig } from '#lib/stores/models.ts';
import type { BufferData, BufferPresentation, Nick } from '#lib/types.ts';

export interface NickCompletionResult {
    text: string;
    cursor: number;
    iterCandidate: string | null;
}

/* Utilities for nick completion — mirrors AngularJS IrcUtils */

function escapeRegExp(str: string): string {
    return str.replace(/[[\]{}()*+?.,\\^$|#\s-]/g, '\\$&');
}

function _completeSingleNick(candidate: string, nickList: string[]): string | null {
    const lcCandidate = candidate.toLowerCase();
    for (const nick of nickList) {
        if (nick.toLowerCase().startsWith(lcCandidate)) {
            return nick;
        }
    }
    return null;
}

function _nextNick(iterCandidate: string, currentNick: string, nickList: string[]): string {
    const lcIterCandidate = iterCandidate.toLowerCase();
    const lcCurrentNick = currentNick.toLowerCase();
    const matchingNicks: string[] = [];
    let at: number | null = null;

    for (let i = 0; i < nickList.length; ++i) {
        const nick = nickList[i]!;
        const lcNick = nick.toLowerCase();
        if (lcNick.indexOf(lcIterCandidate) === 0) {
            matchingNicks.push(nick);
            if (lcCurrentNick === lcNick) {
                at = matchingNicks.length - 1;
            }
        }
    }

    if (at === null || matchingNicks.length === 0) {
        return currentNick;
    }

    ++at;
    if (at >= matchingNicks.length) {
        at = 0;
    }
    return matchingNicks[at]!;
}

export function completeNick(text: string, caretPos: number, iterCandidate: string | null): NickCompletionResult | null {
    const bufferId = get(activeBufferId);
    if (!bufferId) return null;
    const buffer = get(buffers)[bufferId];
    if (!buffer) return null;

    const nicks = getNicklistByTime(buffer);
    if (nicks.length === 0) return null;

    const searchNickList = nicks.map((el: { name: string }) => el.name);
    const suf = get(wconfig)['weechat.completion.nick_completer'] || ':';
    const addSpace = get(wconfig)['weechat.completion.nick_add_space'];
    const addSpaceChar = (addSpace === undefined || addSpace === 'on') ? ' ' : '';

    const beforeCaret = text.substring(0, caretPos);
    const afterCaret = text.substring(caretPos);

    const nickCharClass = '[a-zA-Z0-9_\\\\\\[\\]{}^`|-]';
    const escapedSuf = escapeRegExp(suf);
    const doIterate = (iterCandidate !== null);

    // Case A: iterating nicks at the beginning
    // Pattern: ^(nickchars)+suf $  (e.g., "nick: " at start)
    let m = beforeCaret.match(new RegExp('^(' + nickCharClass + '+)' + escapedSuf + ' $'));
    if (m) {
        const matchedCurrent = m[1]!;
        if (doIterate) {
            const newNick = _nextNick(iterCandidate!, matchedCurrent, searchNickList);
            let result: string;
            if (suf.endsWith(' ')) {
                result = newNick + suf;
            } else {
                result = newNick + suf + ' ';
            }
            return {
                text: result + afterCaret,
                cursor: result.length,
                iterCandidate: iterCandidate
            };
        }
        return null;
    }

    // Case B: nick completion in the beginning
    // Pattern: ^(nickchars)+$
    m = beforeCaret.match(new RegExp('^(' + nickCharClass + '+)$'));
    if (m) {
        const candidate = m[1]!;
        const newNick = _completeSingleNick(candidate, searchNickList);
        if (newNick === null) return null;
        let result: string;
        if (suf.endsWith(' ')) {
            result = newNick + suf;
        } else {
            result = newNick + suf + ' ';
        }
        let after = afterCaret;
        if (after[0] === ' ') {
            after = after.substring(1);
        }
        return {
            text: result + after,
            cursor: result.length,
            iterCandidate: candidate
        };
    }

    // Case C: iterating nicks in the middle
    // Pattern: ^(.* )(nickchars)+ $
    m = beforeCaret.match(new RegExp('^(.* )(' + nickCharClass + '+) $'));
    if (m) {
        const prefix = m[1]!;
        const matchedCurrent = m[2]!;
        if (doIterate) {
            const newNick = _nextNick(iterCandidate!, matchedCurrent, searchNickList);
            const result = prefix + newNick + addSpaceChar;
            return {
                text: result + afterCaret,
                cursor: result.length,
                iterCandidate: iterCandidate
            };
        }
        return null;
    }

    // Case D: nick completion elsewhere in the middle
    // Pattern: ^(.* )(nickchars)+$
    m = beforeCaret.match(new RegExp('^(.* )(' + nickCharClass + '+)$'));
    if (m) {
        const prefix = m[1]!;
        const candidate = m[2]!;
        const newNick = _completeSingleNick(candidate, searchNickList);
        if (newNick === null) return null;
        const result = prefix + newNick + addSpaceChar;
        let after = afterCaret;
        if (after[0] === ' ') {
            after = after.substring(1);
        }
        return {
            text: result + after,
            cursor: result.length,
            iterCandidate: candidate
        };
    }

    return null;
}

function getNicklistByTime(buffer: BufferData): Nick[] {
    const newlist: Nick[] = [];
    for (const groupIdx in buffer.nicklist) {
        const group = buffer.nicklist[groupIdx];
        if (!group || !group.nicks) continue;
        newlist.push(...group.nicks);
    }
    newlist.sort((a, b) => (b.spokeAt || 0) - (a.spokeAt || 0));
    return newlist;
}



// Check if buffer matches search
export function bufferMatchesSearch(buffer: BufferPresentation, search: string): boolean {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
        (buffer.fullName || '').toLowerCase().includes(searchLower) ||
        (buffer.shortName || '').toLowerCase().includes(searchLower) ||
        (buffer.trimmedName || '').toLowerCase().includes(searchLower)
    );
}

/**
 * Parse a relay URL string into host, port, and path. The path is an optional
 * proxy prefix in front of the Relay API (/api); with the legacy relay retired
 * there is no default endpoint path anymore.
 */
export function parseRelayUrl(raw: string, defaultPort: string | number = 443): { host: string; port: number; path: string } {
    let host = raw;
    let port = typeof defaultPort === 'string' ? (parseInt(defaultPort, 10) || 443) : defaultPort;
    if (port < 1 || port > 65535) port = 443;
    let path = '';
    const match = raw.match(/^(\[[0-9a-f:]+\]|[^\]]+):(\d+)(\/.*)?$/i);
    if (match) {
        host = match[1] || host;
        port = parseInt(match[2] || '', 10) || port;
        path = match[3]?.slice(1) ?? '';
    }
    return { host, port, path };
}

export interface MentionResult {
    text: string;
    caretPos: number;
}

/**
 * Build mention text from input and nick, matching AngularJS addMention behavior.
 * Handles colon suffix logic and nick sequence replacement.
 */
export function buildMentionText(inputText: string, nickName: string, nicklist?: Nick[]): MentionResult {
    let newValue = inputText || '';
    let addColon = newValue.length === 0;

    if (newValue.length > 0) {
        const trimmedValue = newValue.trimEnd();
        if (trimmedValue.endsWith(':')) {
            const lastSpace = trimmedValue.lastIndexOf(' ') + 1;
            const lastWord = trimmedValue.slice(lastSpace, trimmedValue.length - 1);
            if (nicklist) {
                const found = nicklist.some(n => n.name === lastWord);
                if (found) {
                    const colonIndex = newValue.lastIndexOf(':');
                    newValue = newValue.substring(0, colonIndex) + ' ';
                    addColon = true;
                }
            }
        }
        if (newValue.charAt(newValue.length - 1) !== ' ') {
            newValue += ' ';
        }
    }

    newValue += nickName;
    if (addColon) {
        newValue += ': ';
    }

    return { text: newValue, caretPos: newValue.length };
}

/**
 * Insert a nick into the message input at cursor position.
 */
export function insertNickIntoInput(nickName: string): void {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    input.value = before + (needsSpace ? ' ' : '') + nickName + ' ' + after;
    const newPos = start + (needsSpace ? 1 : 0) + nickName.length + 1;
    input.focus();
    input.setSelectionRange(newPos, newPos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Check if a buffer has unread messages or notifications (highlights).
 */
export function hasUnread(buffer: BufferData): boolean {
    return buffer.unread > 0 || buffer.notification > 0;
}

/**
 * Check if a buffer is a free-content buffer (numeric type 1).
 * Free buffers skip date change messages and use different font styling.
 */
export function isFreeBuffer(buffer: BufferData): boolean {
    return buffer.bufferType === 1;
}

/**
 * Determine which icon to show for a buffer in the buffer list.
 * Uses the semantic string type from local_variables, mirroring
 * AngularJS CSS class approach (channel → prefix, private → no icon).
 * Svelte adds icons as a visual enhancement over the original CSS-only approach.
 */
export function getBufferIconName(buffer: BufferPresentation): 'hash' | 'user' | 'server' | 'monitor' | 'square' | null {
    if (buffer.type === 'channel') return 'hash';
    if (buffer.type === 'private' || buffer.type === 'query') return 'user';
    if (buffer.type === 'server') return 'server';
    if (buffer.type === 'relay') return 'monitor';
    return 'square';
}

/**
 * Extract the channel prefix (#, ##, &, +, :, !) from a short name.
 * Mirrors WeeChat IRC channel prefix conventions.
 */
export function getChannelPrefix(shortName: string): string {
    const match = shortName.match(/^#+|^[&+:!]+/);
    return match ? match[0] : '';
}

/**
 * Get the display name for a buffer (short name without prefix).
 * Mirrors AngularJS trimmedName logic, used for display in buffer list.
 */
export function getDisplayName(buffer: BufferPresentation): string {
    return buffer.trimmedName || buffer.fullName || buffer.shortName;
}

/**
 * Check if any popover dialog is currently open.
 */
export function isPopoverOpen(): boolean {
    return document.querySelector('dialog[popover]:popover-open') !== null;
}

/**
 * Check if a buffer has non-empty nicklist data.
 */
export function bufferHasNicklist(buffer: BufferData | null | undefined): boolean {
    if (!buffer?.nicklist) return false;
    // The root group counts too: a buffer whose only nicks are ungrouped still
    // has a nicklist to show.
    return Object.entries(buffer.nicklist).some(([, group]) => group.nicks.length > 0);
}

/** What the buffer called `shortName` looks like at one moment in time. */
export interface BufferAppearance {
    /** Store key of the buffer that was seen. */
    id: string;
    /** Buffer clear counter, so a re-cleared buffer reads as new results. */
    clearEpoch: number;
    lineCount: number;
}

/** Snapshot what the buffer called `shortName` looks like right now, so a later
 *  wait can tell newly produced content from a stale pre-existing buffer. */
export function captureBufferAppearance(shortName: string): BufferAppearance | null {
    for (const [id, buffer] of Object.entries(get(buffers))) {
        if (buffer.shortName === shortName) {
            return { id, clearEpoch: buffer.clearEpoch ?? 0, lineCount: buffer.lines.length };
        }
    }
    return null;
}

/** The id of a buffer named `shortName` whose content differs from `before`,
 *  or null when nothing looks fresh yet. */
function freshBufferId(value: Record<string, BufferData>, shortName: string, before: BufferAppearance | null): string | null {
    for (const [id, buffer] of Object.entries(value)) {
        if (buffer.shortName !== shortName) continue;
        // The name was absent when the action started, so this buffer was opened
        // by the action and its content is fresh by construction.
        if (before === null) return id;
        if (id !== before.id) return id;
        if (buffer.clearEpoch !== before.clearEpoch) return id;
        if (buffer.lines.length !== before.lineCount) return id;
    }
    return null;
}

/** Wait until the buffer named `shortName` shows content that differs from
 *  `before`, then resolve its id — or null after `timeoutMs`. Subscribing to
 *  `buffers` instead of sleeping means a fast WeeChat costs almost nothing,
 *  and the unsubscribe handle is declared before subscribing so an immediate
 *  synchronous match cannot leak or dereference an uninitialised handle. */
export async function waitForFreshBuffer(
    shortName: string,
    before: BufferAppearance | null,
    timeoutMs: number,
): Promise<string | null> {
    return new Promise((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let cleanedUp = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            // The handle may not exist yet when a match arrives during the
            // `subscribe()` call itself; the caller cleans up right after.
            const unsub = unsubscribe;
            if (cleanedUp || unsub === null) return;
            cleanedUp = true;
            unsub();
            if (timer !== null) clearTimeout(timer);
        };
        const settle = (id: string | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (timer !== null) clearTimeout(timer);
            resolve(id);
        };

        timer = setTimeout(() => settle(null), timeoutMs);
        unsubscribe = buffers.subscribe((value) => {
            const id = freshBufferId(value, shortName, before);
            if (id !== null) settle(id);
        });
        if (settled) cleanup();
    });
}

/** Whether `script` (e.g. the `grep` script) is installed, or null when the
 *  listing is unknown. `/api/scripts` reports file names, so the extension is
 *  normalised away before comparing. */
export function scriptInstalled(names: string[] | null, script: string): boolean | null {
    if (names === null) return null;
    const wanted = script.toLowerCase();
    return names.some((name) => name.toLowerCase().split('.')[0] === wanted);
}

/**
 * Create a keyboard event handler that activates on Enter or Space.
 * Standard accessibility pattern for role="button" elements.
 */
export function makeKeyboardActivatable(handler: () => void): (e: KeyboardEvent) => void {
    return (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handler();
        }
    };
}

/**
 * Filter a File array to only image files.
 */
export function filterImageFiles(files: File[]): File[] {
    return files.filter(f => f.type.match(/image.*/));
}

/**
 * Modify a textarea's value using a transformer function, then dispatch an input event.
 * Handles selection range preservation and focus management.
 */
export function modifyTextareaValue(
    selector: string,
    transformer: (value: string, start: number, end: number) => { value: string; cursor: number }
): void {
    const input = document.querySelector<HTMLTextAreaElement>(selector);
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const result = transformer(input.value, start, end);
    input.value = result.value;
    input.focus();
    input.setSelectionRange(result.cursor, result.cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Number of pasted lines (after splitting on newlines) at or above which the
 * multi-line paste confirmation dialog appears. */
export const MULTILINE_PASTE_THRESHOLD = 3;

/** Join a multi-line paste into a single message: split on newlines, trim each
 * line, drop empty lines, join with a single space. */
export function joinMultilineToSingle(text: string): string {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join(' ');
}

