/**
 * Nothing may spell the line-id prefix by hand outside the module that owns it.
 *
 * `line-identity.test.ts` catches a prefix that drifts between the sites it exercises.
 * It cannot see a site that isn't in the app yet: a new `weechat:${id}` in a file the
 * test doesn't reach compiles, passes every suite, and fails in whichever quiet way the
 * key mismatch fails — a read marker that resolves to no row, a history page that
 * re-inserts live rows, or a fetched row sorted to the tail.
 *
 * So the ban is checked against the source text. Comments are skipped on purpose: the
 * format is worth writing down in prose, and a comment cannot cause the failure this
 * guards against. Only string and template literals are searched, and only for the
 * prefix with its colon — the WeeChat colour name `"weechat"` is a different word.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = 'src-svelte/src';
const OWNER = 'src-svelte/src/lib/lineIdentity.ts';
const PREFIX = 'weechat:';

/** Source with comments removed, tracking strings so a comment inside one is kept. */
function stripComments(source: string): string {
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

function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
        else if (path.endsWith('.ts') || path.endsWith('.svelte')) found.push(path);
    }
    return found;
}

/** The quoted literals in a file that spell the prefix. */
function prefixLiterals(source: string): string[] {
    return stripComments(source)
        .match(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g)
        ?.filter((literal) => literal.includes(PREFIX)) ?? [];
}

describe('the line-id prefix is spelled in one file', () => {
    it('finds no hand-written prefix in any other source file', () => {
        const offenders = sourceFiles(SRC_ROOT)
            .filter((file) => file !== OWNER)
            .filter((file) => prefixLiterals(readFileSync(file, 'utf8')).length > 0)
            .map((file) => `${file}: ${prefixLiterals(readFileSync(file, 'utf8')).join(', ')}`);

        expect(
            offenders,
            `'${PREFIX}' belongs in ${OWNER}; build or parse the id through its exports ` +
            'so a new site cannot disagree with the read boundary, the history dedupe or the merge order',
        ).toEqual([]);
    });

    it('keeps the owner spelling it, so the check above is not vacuous', () => {
        expect(prefixLiterals(readFileSync(OWNER, 'utf8')), 'the owner still defines the prefix').toContain(
            `'${PREFIX}'`,
        );
    });
});
