// Filter functions for Glowing Bear
// Ported from AngularJS filters.js

/**
 * Wraps text in backticks (simplified codify filter).
 */
export function codify(text: string | undefined): string {
    if (text === undefined) return '';
    return '`' + text + '`';
}

/**
 * Converts hex color codes (#RRGGBB) to styled spans.
 */
export function inlinecolour(text: string | undefined): string {
    if (text === undefined) return '';
    return text.replace(
        /(#(?:[0-9a-fA-F]{6}))/g,
        '<span style="color: $1">$1</span>',
    );
}

/**
 * Truncates text from the beginning with ellipsis if it exceeds the limit.
 */
export function prefixlimit(text: string | undefined, limit: number): string {
    if (text === undefined) return '';
    if (text.length <= limit) return text;
    return text.substring(0, limit) + '...';
}
