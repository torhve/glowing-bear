import { isRelayStatusBuffer, isSyncing } from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

/**
 * The unread and notification tally, shared by both transports.
 *
 * This rule used to exist twice: inline in the legacy line handler, and as a
 * private `tallyLine` in the API reducers whose own comment described it as a
 * port of the legacy rules. Two copies of a counting rule, each tested on its
 * own side and never against each other, is how the three copies of the line
 * trim drifted apart, so the port became the one implementation.
 * `tally-parity.test.ts` drove the same line through both transports across
 * every gate below and confirmed they already agreed before anything was
 * merged.
 *
 * This is counter bookkeeping after a line has been decoded, not part of either
 * wire protocol. Each transport still parses, orders, and delivers its own
 * frames; only the arithmetic applied to a decoded line is shared.
 *
 * The rules, and why each one is there:
 *
 * - Relay status buffers (`relay.list`) never tally. WeeChat re-renders them
 *   whenever a relay client comes and goes, so their rows are not evidence that
 *   the reader missed anything.
 * - The active buffer never tallies: the user is looking at it, and its rows
 *   stay below the fixed session boundary.
 * - `notifyLevel >= 1` feeds `localUnread`, the badge counter. It is not a
 *   line-position proxy and it is never gated by sync state: the alert path in
 *   each transport rings for these lines even while syncing, and
 *   `getEffectiveUnread` max-merges the local tally with hotlist counts, so
 *   baseline-covered lines cannot inflate the badge while lines that raced past
 *   the baseline still badge (alert ⇒ badge invariant).
 * - `unread` and `notification` are the read-boundary counters, and they stay
 *   deferred while the sync phase is open with an unknown boundary: they are
 *   the input to boundary resolution, and the hotlist baseline is authoritative
 *   for the sync snapshot.
 * - Only `notify_level === 1` (a message) feeds `unread`, and only when the
 *   buffer's own notify setting allows message-level notifications.
 *   `notify_level >= 2` feeds `notification` instead, never both.
 * - A `notify_level >= 2` line counts as a notification only when the buffer
 *   wants notifications at all and the line is either a highlight or belongs to
 *   a private/query buffer. WeeChat names PM buffers 'query', not 'private'.
 *
 * `buffer.notify` defaults to 3 ('all'). WeeChat >= 5.0.0 reports the per-buffer
 * level in buffer snapshots and `buffer_notify_changed` events, which set it; on
 * 4.10.1 it stays 'all' and hotlist baselines correct the counts.
 */
export function tallyUnreadLine(
    buffer: BufferData,
    line: { notifyLevel: number; highlight: boolean },
    activeId: string,
    sawUnreadLine: (bufferId: string) => void,
): void {
    if (isRelayStatusBuffer(buffer)) return;
    if (buffer.id === activeId) return;

    if (line.notifyLevel >= 1) {
        buffer.localUnread = (buffer.localUnread || 0) + 1;
        sawUnreadLine(buffer.id);
    }

    // The boundary-resolution counters stay deferred to the hotlist baseline
    // while the boundary is unknown.
    if (isSyncing() && buffer.readBoundaryKnown === false) return;

    if (buffer.notify > 1 && line.notifyLevel === 1) {
        buffer.unread++;
    }

    if (line.notifyLevel >= 2) {
        const isPrivate = buffer.type === 'private' || buffer.type === 'query';
        if (buffer.notify !== 0 && (line.highlight || isPrivate)) {
            buffer.notification++;
        }
    }
}
