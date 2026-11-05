/**
 * Find links the reader is about to post that this buffer already holds.
 *
 * Send-time only. `InputBar` calls it on Enter and nothing else does: a `$derived`,
 * an `$effect` or a store subscription running this would re-scan up to 4 096 stored
 * lines for every incoming message.
 *
 * Links come from `#lib/linkTokens.ts`, the tokenizer `LinkifiedText` renders with, so
 * the matcher sees exactly the links the chat turns into `<a>` elements. A URL finder
 * written here instead would let the warning disagree with what the reader sees.
 */
import { tokenizeLinks } from '#lib/linkTokens.ts';
import type { BufferLine } from '#lib/types.ts';

/** Rows the dialog shows at once. A longer list is a wall, not a warning. */
const MAX_MATCHES = 3;

/** One previous post that carries one of the pending links. */
export interface DuplicateMatch {
    /** The URL as the buffer holds it, so the dialog can show why it matched. */
    url: string;
    /** The line itself — the dialog reads `prefixtext`, `shortTime`, `date` and `text` from it. */
    line: BufferLine;
}

/** Tracking parameters the comparison ignores. A closed list: adding one is a decision. */
function isTrackingParam(name: string): boolean {
    const key = name.toLowerCase();
    return key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'mc_cid' || key === 'mc_id';
}

/**
 * The narrow normalised form two links are compared in.
 *
 * Narrow on purpose: a warning that fires on a *different* link trains the reader to
 * dismiss the dialog. Everything not named here — path case, any other query parameter,
 * the difference between `/` and `/index.html` — stays significant. The `#fragment` is
 * dropped because it selects a place inside one page. A URL the parser cannot read keeps
 * its own text as its key, so it can only ever match itself.
 */
function linkKey(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    // `http` and `https` name the same link only when everything below them is equal.
    const schemeGroup = scheme === 'https' ? 'http' : scheme;
    // A trailing slash on a bare host is the same page as the bare host.
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const query = [...parsed.searchParams]
        .filter(([name]) => !isTrackingParam(name))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');
    // `parsed.port` is the explicit port; a default one is already gone from the URL.
    return `${schemeGroup}|${parsed.hostname}|${parsed.port}|${path}|${query}`;
}

/**
 * One newest-first pass over `lines` for the links in `pending`.
 *
 * Returns at most `MAX_MATCHES` matches, and none when the composer holds no link — the
 * common send, which costs one `includes` on a short string. Nothing is cached or kept
 * between sends: each match references the line the buffer already owns.
 */
export function findDuplicateLinks(pending: string, lines: BufferLine[]): DuplicateMatch[] {
    if (!pending.includes('://')) return [];

    const rawTokens = new Set<string>();
    const keys = new Map<string, string>();
    for (const token of tokenizeLinks(pending)) {
        if (token.type !== 'link') continue;
        rawTokens.add(token.value);
        const key = linkKey(token.value);
        if (!keys.has(key)) keys.set(key, token.value);
    }
    if (keys.size === 0) return [];

    const matches: DuplicateMatch[] = [];
    for (let i = lines.length - 1; i >= 0 && matches.length < MAX_MATCHES; i--) {
        const line = lines[i];
        // A line with no `://` cannot hold a link, and tokenizing 4 096 of them is the
        // cost this prefilter exists to avoid.
        if (!line || line.isDateSeparator === true || !line.text.includes('://')) continue;
        for (const token of tokenizeLinks(line.text)) {
            if (token.type !== 'link') continue;
            // An exact repost is checked raw first so it never pays for a normalisation.
            if (!rawTokens.has(token.value) && !keys.has(linkKey(token.value))) continue;
            matches.push({ url: token.value, line });
            break;
        }
    }
    return matches;
}
