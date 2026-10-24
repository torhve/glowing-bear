/**
 * The identity key a retained line is known by.
 *
 * WeeChat numbers every line, and that number is what the app keys rows on: the read
 * boundary stores it, the API history window dedupes against it and sorts a fetched page
 * against the rows already held, and a reconnect carries it across. It is this prefix
 * plus the number, produced by both transports and read back out again, so six places
 * had to spell or match the same string by hand with nothing checking they still did. A
 * prefix that drifts at one of them compiles cleanly and fails quietly in one of three
 * ways: the boundary lookup matches no row, so the read marker and the unread badge go
 * missing; the dedupe matches nothing, so a history page re-inserts rows the live session
 * already showed; or the parse returns no number, so a fetched row lands at the tail and
 * the transcript reads out of order.
 *
 * `test/unit/line-identity.test.ts` pins every producer against every consumer. Keep new
 * sites on these names. `ChatView.svelte`'s `line:` fallback is a render key for rows
 * WeeChat gave no id to, not an identity, and deliberately does not live here.
 */
const WEECHAT_LINE_ID_PREFIX = 'weechat:';

/** The identity of one of WeeChat's line numbers. */
export function weechatLineId(id: string | number): string {
    return `${WEECHAT_LINE_ID_PREFIX}${String(id)}`;
}

// Built from the prefix rather than written again: the parse is the other half of the
// same key, and a literal here is the drift the module exists to prevent. The prefix has
// no regex metacharacters in it.
const WEECHAT_LINE_ID_PATTERN = new RegExp(`^${WEECHAT_LINE_ID_PREFIX}(\\d+)$`);

/** WeeChat's number back out of a line id, or null for the content-hash fallback. */
export function weechatLineNumber(lineId: string | undefined): number | null {
    if (!lineId) return null;
    const match = WEECHAT_LINE_ID_PATTERN.exec(lineId);
    return match === null ? null : Number(match[1]);
}
