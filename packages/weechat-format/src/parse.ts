/**
 * Text parser and style-only parser.
 *
 * Both share the one authoritative decoder (`decode.ts`) and the one style
 * interpreter (`style.ts`). Ordinary text is scanned as spans: the scanner
 * jumps from one control character to the next and slices once per run, so
 * there is no intermediate normalized string or token array.
 */

import { decodeAt } from './decode.js';
import { applyInstruction, createInitialStyle, stylesEqual } from './style.js';
import type { ParseOptions, Style, StyleParseResult, TextRun } from './types.js';

/** True for `\x19`, `\x1a`, `\x1b`, `\x1c`. */
function isControl(charCode: number): boolean {
    return charCode >= 0x19 && charCode <= 0x1c;
}

/**
 * Parse WeeChat-formatted text into styled runs.
 *
 * - Runs are emitted only when there is text to emit, so empty or
 *   formatting-only input produces an empty array.
 * - Consumed control characters never appear in emitted text.
 * - Adjacent runs are coalesced: equivalent neighbouring styles merge, so a
 *   redundant control does not split a run.
 * - Unicode text is preserved exactly; offsets are UTF-16 indices.
 * - Malformed controls are consumed according to the documented policy and
 *   never throw; ordinary text around them is preserved.
 */
export function parseWeeChatText(input: string, options?: ParseOptions): readonly TextRun[] {
    const runs: TextRun[] = [];
    const onDiagnostic = options?.onDiagnostic;
    let style: Style = createInitialStyle();
    let i = 0;
    let textStart = 0;

    // Text before a control belongs to the previous style.
    const flush = (end: number): void => {
        if (end > textStart) {
            runs.push({ text: input.slice(textStart, end), style });
        }
    };

    while (i < input.length) {
        // Scan ordinary text as a span up to the next control character.
        let next = i;
        while (next < input.length && !isControl(input.charCodeAt(next))) {
            next++;
        }
        if (next >= input.length) {
            break;
        }

        const decoded = decodeAt(input, next);
        if (decoded === null) {
            // Unreachable: isControl() only stops on real control characters.
            i = next + 1;
            continue;
        }

        flush(next);

        const transition = applyInstruction(style, decoded.instruction);
        style = transition.style;
        if (transition.diagnostic !== null && onDiagnostic !== undefined) {
            onDiagnostic({ reason: transition.diagnostic, offset: next, consumed: decoded.consumed });
        }

        i = next + decoded.consumed;
        textStart = i;
    }

    flush(input.length);

    return coalesceRuns(runs);
}

/** Merge adjacent runs whose styles are equivalent. */
function coalesceRuns(runs: TextRun[]): TextRun[] {
    const merged: TextRun[] = [];
    for (const run of runs) {
        const previous = merged[merged.length - 1];
        if (previous !== undefined && stylesEqual(previous.style, run.style)) {
            merged[merged.length - 1] = { text: previous.text + run.text, style: previous.style };
        } else {
            merged.push(run);
        }
    }
    return merged;
}

/**
 * Parse a formatting-only payload (possibly several controls) into a single
 * resulting style, rejecting unexpected text instead of guessing which segment
 * matters. Recognized-but-non-rendering controls (bar references, malformed
 * payloads) are consumed and simply leave the style unchanged; they are
 * reported through `options.onDiagnostic` when provided.
 */
export function parseWeeChatStyle(input: string, options?: ParseOptions): StyleParseResult {
    if (input.length === 0) {
        return { ok: false, reason: 'empty-input', offset: 0 };
    }

    const onDiagnostic = options?.onDiagnostic;
    let style: Style = createInitialStyle();
    let i = 0;

    while (i < input.length) {
        const decoded = decodeAt(input, i);
        if (decoded === null) {
            return { ok: false, reason: 'unexpected-text', offset: i };
        }
        const transition = applyInstruction(style, decoded.instruction);
        style = transition.style;
        if (transition.diagnostic !== null && onDiagnostic !== undefined) {
            onDiagnostic({ reason: transition.diagnostic, offset: i, consumed: decoded.consumed });
        }
        i += decoded.consumed;
    }

    return { ok: true, style };
}
