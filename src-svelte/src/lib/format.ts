/**
 * Rendering helpers for values that several components show.
 *
 * These are presentation, not state: they belong away from the stores that
 * produce the numbers, so a component can format a value without importing a
 * connection store to get at it.
 */

/**
 * Render a byte count for a human reader.
 *
 * One decimal at every unit. The two copies this replaced agreed on bytes and
 * kilobytes and disagreed only at megabytes — the connection-stats popover used
 * two decimals and the upload preview used one. That split looked like drift
 * rather than a decision, so the shorter form is now canonical and the popover
 * reads `12.3 MB` where it read `12.34 MB`.
 *
 * Units advance at 1024, matching how the relay's own traffic is counted, and
 * there is no gigabyte tier: a session that transfers a gigabyte is a problem to
 * diagnose, not a number to format prettily.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
