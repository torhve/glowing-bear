import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source text as a checker sees it.
 *
 * Two guards scan the repository for a shape that must not appear — the WeeChat line-id
 * prefix spelled by hand, the composer looked up by its test id. Both have to ignore
 * comments: writing the banned shape down in prose is how a module explains what it
 * replaced, and a comment cannot cause the runtime failure either guard exists to catch.
 */

/** Every `.ts` and `.svelte` file under a directory. */
export function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
        else if (path.endsWith('.ts') || path.endsWith('.svelte')) found.push(path);
    }
    return found;
}

/** Source with comments removed, tracking strings so a comment inside one is kept. */
export function stripComments(source: string): string {
    let out = '';
    let quote: string | null = null;
    let inBlock = false;
    let inLine = false;

    for (let i = 0; i < source.length; i += 1) {
        const char = source[i]!;
        const next = source[i + 1];

        if (inLine) {
            if (char === '\n') {
                inLine = false;
                out += char;
            }
            continue;
        }
        if (inBlock) {
            if (char === '*' && next === '/') {
                inBlock = false;
                i += 1;
            }
            continue;
        }
        if (quote) {
            out += char;
            if (char === '\\') {
                out += next ?? '';
                i += 1;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            inLine = true;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlock = true;
            i += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') quote = char;
        out += char;
    }
    return out;
}

/** The code of a source file, comments gone. */
export function codeOf(path: string): string {
    return stripComments(readFileSync(path, 'utf8'));
}
