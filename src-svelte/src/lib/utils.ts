import { get } from 'svelte/store';
import { buffers, activeBufferId, wconfig } from '$lib/stores/models';
import type { BufferData, Nick } from '$lib/types';

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

/* eslint-disable @typescript-eslint/no-explicit-any -- nick/group types from WeeChat protocol */
function getNicklistByTime(buffer: any): any[] {
    const newlist: any[] = [];
    for (const groupIdx in buffer.nicklist) {
        if (groupIdx === 'root' || buffer.nicklist[groupIdx]?.nicks) {
            newlist.push(...buffer.nicklist[groupIdx].nicks);
        }
    }
    newlist.sort((a, b) => (b.spokeAt || 0) - (a.spokeAt || 0));
    return newlist;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Check if buffer matches search
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- buffer type from WeeChat protocol
export function bufferMatchesSearch(buffer: any, search: string): boolean {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
        (buffer.fullName || '').toLowerCase().includes(searchLower) ||
        (buffer.shortName || '').toLowerCase().includes(searchLower) ||
        (buffer.trimmedName || '').toLowerCase().includes(searchLower)
    );
}

// Get filtered buffers
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- buffer array return type
export function getFilteredBuffers(search: string, onlyUnread: boolean, orderByServer: boolean): any[] {
    const allBuffers = get(buffers);

    return sortBuffers(
        Object.values(allBuffers)
            .filter((b: any) => !b.hidden)
            .filter((b: any) => bufferMatchesSearch(b, search))
            .filter((b: any) => !onlyUnread || b.unread > 0 || b.notification > 0 || b.active || b.pinned),
        orderByServer
    );
}

/**
 * Sort buffers: pinned first, then highlights, then unreads, then by number.
 * Optionally groups by server when orderByServer is true.
 */
export function sortBuffers(buffers: BufferData[], orderByServer: boolean): BufferData[] {
    const sorted = [...buffers];
    sorted.sort((a, b) => {
        // Pinned buffers always on top
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

        // Highlights (notification > 0) before unreads
        const aHighlight = a.notification > 0 ? 2 : 0;
        const bHighlight = b.notification > 0 ? 2 : 0;
        if (aHighlight !== bHighlight) return bHighlight - aHighlight;

        // Unreads before inactive
        const aUnread = a.unread > 0 ? 1 : 0;
        const bUnread = b.unread > 0 ? 1 : 0;
        if (aUnread !== bUnread) return bUnread - aUnread;

        // By number (or serverSortKey if grouped)
        if (orderByServer) {
            return a.serverSortKey.localeCompare(b.serverSortKey) || a.number - b.number;
        }
        return a.number - b.number;
    });
    return sorted;
}

/**
 * Parse a relay URL string into host, port, and path.
 */
export function parseRelayUrl(raw: string, defaultPort: string | number = 443): { host: string; port: number; path: string } {
    let host = raw;
    let port = typeof defaultPort === 'string' ? (parseInt(defaultPort, 10) || 443) : defaultPort;
    if (port < 1 || port > 65535) port = 443;
    let path = 'weechat';
    const match = raw.match(/^(\[[0-9a-f:]+\]|[^\]]+):(\d+)(\/.*)?$/i);
    if (match) {
        host = match[1] || host;
        port = parseInt(match[2] || '', 10) || port;
        path = match[3]?.slice(1) || 'weechat';
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
export function getBufferIconName(buffer: BufferData): 'hash' | 'user' | 'server' | 'monitor' | 'square' | null {
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
export function getDisplayName(buffer: BufferData): string {
    return buffer.trimmedName || buffer.fullName || buffer.shortName;
}

/**
 * Check if any popover dialog is currently open.
 */
export function isPopoverOpen(): boolean {
    return document.querySelector('dialog[popover]:popover-open') !== null;
}
