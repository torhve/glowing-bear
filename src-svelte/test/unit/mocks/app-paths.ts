// Test stub for the SvelteKit virtual module `$app/paths` — available to unit
// tests that mount components importing it (ConnectionForm, TopBar) or call it
// from a module (notifications, faviconBadge).
//
// `asset` mirrors what the built app asks for at runtime. Measured in both the
// root build and the `BASE_PATH=/glowing-bear` build: the connect form's logo
// renders `src="./glowing-bear.svg"` in each, and the browser resolves it
// against the document — `/glowing-bear.svg` at the origin root,
// `/glowing-bear/glowing-bear.svg` under the base path. The base is carried by
// the document URL, not by the string, so one build serves either deployment.
// The resolution is the document's depth too: at `/bear/some/deep/path` it lands
// under that path. Measured to matter nowhere, because a page at an unmatched
// route never connects, so it never builds a notification or a sound URL.
export function asset(path: string): string {
    return `./${path.replace(/^\/+/, '')}`;
}
export function resolve(..._parts: string[]): string {
    return _parts.join('/');
}
export const base = '';
export const assets = '';
export const build = '';
export const cached = false;
export const prerendered = new Set<string>();
