// Test stub for the SvelteKit virtual module `$app/paths` — available to unit
// tests that mount components importing it (ConnectionForm, TopBar). The app
// runs with an empty base path, so `asset` is the identity in tests.
export function asset(path: string): string {
    return path;
}
export function resolve(..._parts: string[]): string {
    return _parts.join('/');
}
export const base = '';
export const assets = '';
export const build = '';
export const crawlable = true;
