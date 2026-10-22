import type { BufferType } from '#lib/types.ts';

/**
 * The name-derived facts about a buffer, decided once.
 *
 * Three events describe a buffer: `buffer_opened` builds it, `buffer_updated`
 * revises it, and `buffer_info` patches it. Each of the four places that derived
 * these facts copied some of the same four expressions, so a change to one
 * of them leaves a buffer labelled correctly by the event that created it and
 * differently by the event that revised it — a sidebar row that renames on an
 * update, or a row that sorts out of its server group because one copy kept the
 * old key.
 */

/** Characters WeeChat puts in front of a channel-ish name. */
const NAME_SIGILS = ['#', '&', '+'];

/**
 * The name without its leading sigil.
 *
 * A name that was only a sigil trims to an empty string, which the sidebar would
 * render as nothing, so it becomes a space. A name that was empty to begin with
 * has no label at all and stays null.
 */
export function trimmedBufferName(shortName: string): string | null {
    return shortName.replace(/^[#&+]/, '') || (shortName ? ' ' : null);
}

/** The sigil itself, or `''` for a name that has none. */
export function bufferNamePrefix(shortName: string): string {
    return NAME_SIGILS.includes(shortName.charAt(0)) ? shortName.charAt(0) : '';
}

/**
 * The key a buffer sorts under within its server. A server buffer carries no
 * channel name, so it sorts on `plugin.server` alone; everything else sorts on
 * the name too. Lowercased so a relay that capitalises differently still groups.
 */
export function bufferServerSortKey(
    plugin: string,
    server: string,
    type: BufferType,
    shortName: string,
): string {
    return `${plugin}.${server}${type === 'server' ? '' : '.' + shortName}`.toLowerCase();
}

/** `pinned` arrives as a WeeChat local variable, spelled `"true"` rather than typed. */
export function isPinnedBuffer(localVariables: Record<string, string> | undefined): boolean {
    return localVariables?.pinned === 'true';
}
