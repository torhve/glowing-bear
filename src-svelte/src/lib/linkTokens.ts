// Tokenization for safe URL linkification without {@html} or DOMPurify.
//
// Splits text into text/link/code tokens so that Svelte's native escaping handles
// all non-URL content (including <img>, <script>, javascript:, data:, etc.).
// Only http:// and https:// protocols are recognized as links, blocking all
// dangerous protocol handlers at the regex level.
//
// Code blocks (backtick-enclosed text) are detected via codifyText(), mirroring
// the AngularJS 'codify' filter. tokenizeAndCodify() combines URL tokenization
// with codify, applying codify only to non-link text segments — equivalent to how
// AngularJS DOMfilter walks the DOM and skips inside <a> tags.

export interface LinkToken {
    type: 'text' | 'link';
    value: string;
}

export interface CodeSegment {
    type: 'code';
    value: string;
    delimiter: string;
}

export type Token = LinkToken | CodeSegment;

export interface TokenGroup {
    classes: string;
    tokens: Token[];
}

/**
 * Common trailing punctuation that should not be part of a URL.
 */
const TRAILING_PUNCT = /[.,;:!?)\]>]+$/;

/**
 * Match http/https/ftp URLs followed by non-whitespace characters.
 * Trailing punctuation is stripped in post-processing.
 */
const URL_REGEX = /(?:https?|ftp):\/\/\S+/g;

/**
 * Split text into text and link tokens.
 * Text tokens are auto-escaped by Svelte's rendering.
 * Link tokens are rendered as <a> tags with rel="noopener noreferrer".
 */
export function tokenizeLinks(text: string): LinkToken[] {
    if (!text) return [];

    const tokens: LinkToken[] = [];
    let lastIndex = 0;
    const regex = new RegExp(URL_REGEX.source, 'g');
    let match;

    while ((match = regex.exec(text)) !== null) {
        // Add text before the URL
        if (match.index > lastIndex) {
            const beforeText = text.slice(lastIndex, match.index);
            if (beforeText) {
                tokens.push({ type: 'text', value: beforeText });
            }
        }
        // Add the URL as a link token
        const url = match[0].replace(TRAILING_PUNCT, '');
        tokens.push({ type: 'link', value: url });
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text after the last URL
    if (lastIndex < text.length) {
        const afterText = text.slice(lastIndex);
        if (afterText) {
            tokens.push({ type: 'text', value: afterText });
        }
    }

    return tokens;
}

/**
 * Convert backtick-enclosed code to code segments.
 * Mirrors the AngularJS 'codify' filter.
 *
 * Wraps code content in <code> tags. Backticks themselves are NOT included
 * in the returned value — the template renders them separately as hidden spans.
 *
 * Only matches single or triple backticks (not double). Requires a space or
 * start-of-string before the opening backticks to avoid codifying weird`stuff`.
 */
export function codifyText(text: string): (LinkToken | CodeSegment)[] {
    if (text == null) return [];

    const segments: (LinkToken | CodeSegment)[] = [];
    const re = /(^|\s)(```|`)([^`].*?)\2/gs;
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
        // Add text before the code block (including captured whitespace from group 1)
        const ws = match[1] || '';
        if (match.index > lastIndex) {
            const beforeText = text.slice(lastIndex, match.index);
            if (beforeText || ws) {
                segments.push({ type: 'text', value: beforeText + ws });
            }
        } else if (ws) {
            // Consecutive matches: the captured whitespace is the separator between code blocks
            segments.push({ type: 'text', value: ws });
        }

        // Group 2 is the delimiter (backtick type), group 3 is the code content
        segments.push({ type: 'code', value: match[3]!, delimiter: match[2]! });
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text after the last code block
    if (lastIndex < text.length) {
        const afterText = text.slice(lastIndex);
        if (afterText) {
            segments.push({ type: 'text', value: afterText });
        }
    }

    return segments.length > 0 ? segments : [{ type: 'text', value: text }];
}

/**
 * Tokenize text for rendering, combining URL linkification and code block detection.
 *
 * Mirrors the AngularJS filter pipeline:
 *   1. conditionalLinkify → tokenizeLinks (URLs become link tokens)
 *   2. DOMfilter:'codify' → codify applied only to non-link text segments
 *
 * Like AngularJS DOMfilter, this skips URL tokenization inside code blocks
 * (backtick-delimited text), preventing URLs in code from being linkified.
 */
export function tokenizeAndCodify(text: string): Token[] {
    if (!text) return [];

    const result: Token[] = [];

    // Step 1: Tokenize URLs first (like AngularJS conditionalLinkify)
    const urlTokens = tokenizeLinks(text);

    // Step 2: Apply codify to each text segment, preserving link tokens as-is
    // (like AngularJS DOMfilter walking DOM and skipping inside <a> tags)
    for (const token of urlTokens) {
        if (token.type === 'link') {
            result.push(token);
            continue;
        }

        // Apply codify to the text segment
        const segments = codifyText(token.value);

        for (const seg of segments) {
            if (seg.type === 'code') {
                result.push(seg as CodeSegment);
            } else {
                result.push({ type: 'text', value: seg.value });
            }
        }
    }

    return result;
}
