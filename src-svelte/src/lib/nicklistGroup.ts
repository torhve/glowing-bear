/**
 * The nicklist group that holds a buffer's ungrouped nicks.
 *
 * WeeChat sends named groups, and the nicks that belong to none live in the root
 * one. The key it is stored under is read by three places that never talk to each
 * other: the legacy handler walks a nicklist by it, the API reducer invents it
 * when a group arrives without a name, and the component sorts it first and draws
 * no divider beneath it. Spelling it twice means one of them can be renamed
 * alone, which turns the root group into just another group — sitting mid-list
 * with a divider over it, and invisible to the lookups still asking for the old
 * name. A group someone names `root` collides with this one: the legacy protocol
 * keys groups by name, so that is upstream's model rather than a choice here.
 */
export const ROOT_GROUP_KEY = 'root';

/** True for the group holding the buffer's ungrouped nicks. */
export function isRootGroup(key: string): boolean {
    return key === ROOT_GROUP_KEY;
}

/** The key an incoming group is filed under: no name means the root group. */
export function nickGroupKey(name: string | undefined | null): string {
    return name || ROOT_GROUP_KEY;
}
