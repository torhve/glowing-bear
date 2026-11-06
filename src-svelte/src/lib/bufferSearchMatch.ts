/**
 * Matching for the buffer search dialog.
 *
 * The filter that decides which rows appear and the marking that shows a user why a row
 * appeared must use one rule, otherwise a row can show up with nothing on it explaining
 * the match. Both read this file.
 *
 * All of it is plain string work. No widths, no DOM: `topicExcerpt` is given a capacity
 * in characters and the dialog measures what its rows can hold.
 */
import type { BufferPresentation } from '#lib/types.ts';

/** The character that marks a cut. The dialog renders it; it is never part of the excerpt. */
export const CUT_MARKER = '\u2026';

/** A cut costs its ellipsis plus the space that separates it from the kept text. */
const MARKER_CHARS = 2;

/** Below this many characters an excerpt cannot hold a match and its context at once. */
const MIN_TOPIC_CAPACITY = 12;

export interface TextPiece {
    /** Text to render as it is. */
    text: string;
    /** True when this piece is the query. */
    hit: boolean;
}

export interface TopicExcerpt {
    text: string;
    /** True when topic text before the excerpt was cut away. */
    lead: boolean;
    /** True when topic text after the excerpt was cut away. */
    trail: boolean;
}

/** True when anything the dialog searches on for this buffer holds the query. Case does not matter. */
export function bufferMatchesQuery(buffer: BufferPresentation, query: string): boolean {
    const needle = query.toLowerCase();
    if (needle === '') return true;
    return buffer.shortName.toLowerCase().includes(needle) ||
        buffer.fullName.toLowerCase().includes(needle) ||
        (buffer.rtitle || '').toLowerCase().includes(needle) ||
        String(buffer.number).includes(needle);
}

/** True when it is the buffer's channel topic that holds the query. */
export function topicMatchesQuery(buffer: BufferPresentation, query: string): boolean {
    const needle = query.toLowerCase();
    return needle !== '' && (buffer.rtitle || '').toLowerCase().includes(needle);
}

/** Split `text` into plain pieces and query pieces, in order. */
export function splitQueryMatches(text: string, query: string): TextPiece[] {
    const needle = query.toLowerCase();
    if (needle === '' || text === '') return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const pieces: TextPiece[] = [];
    let done = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, done)) {
        if (at > done) pieces.push({ text: text.slice(done, at), hit: false });
        pieces.push({ text: text.slice(at, at + needle.length), hit: true });
        done = at + needle.length;
    }
    if (done < text.length) pieces.push({ text: text.slice(done), hit: false });
    return pieces.length > 0 ? pieces : [{ text, hit: false }];
}

/** Indexes at or before `hit` that open a word, earliest first. */
function wordOpenings(text: string, hit: number): number[] {
    const openings: number[] = [];
    for (let i = 0; i <= hit; i++) {
        if (i === 0 || /\s/.test(text[i - 1] ?? '')) openings.push(i);
    }
    return openings;
}

/**
 * Where to close a window that starts at `open` and may print up to `reach`: the last word
 * end the room can still afford at or after the match, so the reader keeps the most context
 * and the matched word stays whole. Falls back to the match's own end when no word ends in
 * the room.
 */
function wholeWordClose(text: string, reach: number, matchEnd: number): number {
    for (let c = reach; c >= matchEnd; c--) {
        if (c === text.length || /\s/.test(text[c] ?? '')) return c;
    }
    return matchEnd;
}

/** Excerpt text for a window, without the whitespace and separators the cuts orphaned. */
function tidy(body: string, needle: string, trail: boolean): string {
    const text = body.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!trail) return text;
    // A cut that lands on a separator reads as if the topic had ended there. Drop it, but
    // never when the separator is part of the match itself.
    const trimmed = text.replace(/[.,;:!?/]+$/, '');
    return trimmed !== '' && trimmed.toLowerCase().includes(needle) ? trimmed : text;
}

/**
 * The part of a channel topic to show for `query`, cut to `capacity` characters.
 *
 * The window always holds the whole match, and starts as far left as it can so the reader
 * keeps as much of the topic's beginning as the row allows. It closes on a word end when
 * one falls inside the room, and otherwise straight after the match rather than cutting
 * through a word. Null when the topic does not hold the query, or when no window that fits
 * can hold the whole match — a half-shown query explains nothing.
 */
export function topicExcerpt(topic: string, query: string, capacity: number): TopicExcerpt | null {
    const needle = query.toLowerCase();
    if (needle === '' || capacity < MIN_TOPIC_CAPACITY) return null;
    const text = topic.trim();
    if (text === '') return null;
    const hit = text.toLowerCase().indexOf(needle);
    if (hit < 0) return null;
    const matchEnd = hit + needle.length;
    if (text.length <= capacity) return { text, lead: false, trail: false };

    // A hard cut at the match is the last candidate: it fits where a word opening cannot,
    // and it still shows the whole query.
    for (const open of [...wordOpenings(text, hit), hit]) {
        const lead = open > 0;
        const room = capacity - (lead ? MARKER_CHARS : 0);
        if (text.length - open <= room) {
            // The tail reaches the topic's end, so it pays no marker and the room is its own.
            return { text: tidy(text.slice(open), needle, false), lead, trail: false };
        }
        const reach = open + room - MARKER_CHARS;
        if (reach < matchEnd) continue;
        const close = wholeWordClose(text, reach, matchEnd);
        if (close < matchEnd) continue;
        return { text: tidy(text.slice(open, close), needle, true), lead, trail: true };
    }
    return null;
}

/**
 * Room this dialog's own classes take away from a topic line, in pixels. Every number here
 * is a class the component writes on the same row, and each one was checked against a
 * rendered row: at a 672px dialog the topic line measures 596px for a two-digit buffer
 * number and 588px for a three-digit one.
 */
const RESULTS_PADDING_PX = 16;      // .buffer-search-results p-2
const ROW_PADDING_PX = 24;          // .buffer-search-item px-3
const ROW_GAP_PX = 8;               // .gap-2 between the number badge and the text column
const NUMBER_BADGE_PADDING_PX = 12; // .px-1.5 on .buffer-search-number
const UNREAD_BADGE_PADDING_PX = 12; // .px-1.5 on .buffer-search-badge
const UNREAD_BADGE_GAP_PX = 8;      // room kept between the chip and the topic text

/** One character of slack, for rounding and for the row's own last-resort ellipsis. */
const CAPACITY_SAFETY_CHARS = 1;

export interface RowMetrics {
    /** Width of the results box every result row fills. */
    resultsWidth: number;
    /** Width of one character in the topic line's own font. */
    charWidth: number;
    /** Width of one character in the buffer-number badge's font. */
    badgeCharWidth: number;
}

/**
 * How many characters this row's topic line holds.
 *
 * `badgeDigits` is how many digits the row's unread chip prints, or zero when it prints no
 * chip. The chip is drawn over the row's right edge, so it takes room the topic line would
 * otherwise have. Zero capacity when the dialog has not measured itself yet, which leaves
 * the topic line off.
 */
export function topicCapacity(digits: number, metrics: RowMetrics, badgeDigits = 0): number {
    if (metrics.resultsWidth <= 0 || metrics.charWidth <= 0 || metrics.badgeCharWidth <= 0) return 0;
    const chipPx = badgeDigits > 0
        ? badgeDigits * metrics.badgeCharWidth + UNREAD_BADGE_PADDING_PX + UNREAD_BADGE_GAP_PX
        : 0;
    const linePx = metrics.resultsWidth
        - RESULTS_PADDING_PX
        - ROW_PADDING_PX
        - ROW_GAP_PX
        - (digits * metrics.badgeCharWidth + NUMBER_BADGE_PADDING_PX)
        - chipPx;
    return Math.max(0, Math.floor(linePx / metrics.charWidth) - CAPACITY_SAFETY_CHARS);
}
