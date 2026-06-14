import { writable, get } from 'svelte/store';

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
    
    history.set({ ...current, [bufferId]: bufHistory });
}

export function getHistoryUp(bufferId: string, currentLine: string): string {
    const current = get(history);
    const bufHistory = current[bufferId];
    
    if (!bufHistory) return '';
    
    // Save current line (the one we're leaving behind) only if user typed something new
    if (bufHistory.pos >= bufHistory.lines.length && currentLine !== '') {
        bufHistory.lines.push(currentLine);
    }
    
    if (bufHistory.pos <= 0) {
        return currentLine;
    }
    
    bufHistory.pos--;
    return bufHistory.lines[bufHistory.pos] || '';
}

export function getHistoryDown(bufferId: string, currentLine: string): string {
    const current = get(history);
    const bufHistory = current[bufferId];
    
    if (!bufHistory) return '';
    
    // If already at the end, save current line and clear input
    if (bufHistory.pos >= bufHistory.lines.length) {
        if (currentLine !== '') {
            bufHistory.lines.push(currentLine);
        }
        bufHistory.pos = bufHistory.lines.length;
        return '';
    }
    
    bufHistory.pos++;
    
    if (bufHistory.pos >= bufHistory.lines.length) {
        return '';
    }
    
    return bufHistory.lines[bufHistory.pos] || '';
}
