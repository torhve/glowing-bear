import { writable, get } from 'svelte/store';

// Max entries per buffer's input history to prevent unbounded growth.
const maxHistoryEntries = 50;

/**
 * Trims history lines to maxHistoryEntries, adjusting position index
 * to keep cursor within valid bounds after truncation.
 */
function trimHistory(lines: string[], pos: number): { lines: string[]; pos: number } {
    if (lines.length <= maxHistoryEntries) return { lines, pos };
    const removed = lines.length - maxHistoryEntries;
    const trimmed = lines.slice(removed);
    let newPos = pos - removed;
    if (newPos < 0) newPos = 0;
    if (newPos > trimmed.length) newPos = trimmed.length;
    return { lines: trimmed, pos: newPos };
}

export interface BufferHistory {
    lines: string[];
    pos: number;
}

const history = writable<Record<string, BufferHistory>>({});

export function addToHistory(bufferId: string, line: string) {
    const current = get(history);
    const bufHistory = current[bufferId] || { lines: [], pos: 0 };

    bufHistory.lines.push(line);
    bufHistory.pos = bufHistory.lines.length;
    const trimmed = trimHistory(bufHistory.lines, bufHistory.pos);

    history.set({ ...current, [bufferId]: trimmed });
}

export function getHistoryUp(bufferId: string, currentLine: string): string {
    const current = get(history);
    let bufHistory = current[bufferId];

    if (!bufHistory) return '';

    // Save current line (the one we're leaving behind) only if user typed something new
    if (bufHistory.pos >= bufHistory.lines.length && currentLine !== '') {
        bufHistory = { lines: [...bufHistory.lines, currentLine], pos: bufHistory.lines.length + 1 };
    }

    if (bufHistory.pos <= 0) {
        return currentLine;
    }

    const newPos = bufHistory.pos - 1;
    const trimmed = trimHistory(bufHistory.lines, newPos);
    history.set({ ...current, [bufferId]: trimmed });
    return trimmed.lines[trimmed.pos] || '';
}

export function getHistoryDown(bufferId: string, currentLine: string): string {
    const current = get(history);
    let bufHistory = current[bufferId];

    if (!bufHistory) return '';

    // If already at the end, save current line and clear input
    if (bufHistory.pos >= bufHistory.lines.length) {
        if (currentLine !== '') {
            bufHistory = { lines: [...bufHistory.lines, currentLine], pos: bufHistory.lines.length + 1 };
        } else {
            bufHistory = { ...bufHistory, pos: bufHistory.lines.length };
        }
    }

    const newPos = bufHistory.pos + 1;

    if (newPos >= bufHistory.lines.length) {
        const trimmed = trimHistory(bufHistory.lines, newPos);
        history.set({ ...current, [bufferId]: trimmed });
        return '';
    }

    const trimmed = trimHistory(bufHistory.lines, newPos);
    history.set({ ...current, [bufferId]: trimmed });
    return trimmed.lines[trimmed.pos] || '';
}
