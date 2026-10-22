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
import { codeOf, sourceFiles } from './sourceText';

const SRC_ROOT = 'src-svelte/src';
const OWNER = 'src-svelte/src/lib/lineIdentity.ts';
const PREFIX = 'weechat:';


/** The quoted literals in a file that spell the prefix. */
function prefixLiterals(file: string): string[] {
    return codeOf(file)
        .match(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g)
        ?.filter((literal) => literal.includes(PREFIX)) ?? [];
}

describe('the line-id prefix is spelled in one file', () => {
    it('finds no hand-written prefix in any other source file', () => {
        const offenders = sourceFiles(SRC_ROOT)
            .filter((file) => file !== OWNER)
            .filter((file) => prefixLiterals(file).length > 0)
            .map((file) => `${file}: ${prefixLiterals(file).join(', ')}`);

        expect(
            offenders,
            `'${PREFIX}' belongs in ${OWNER}; build or parse the id through its exports ` +
            'so a new site cannot disagree with the read boundary, the history dedupe or the merge order',
        ).toEqual([]);
    });

    it('keeps the owner spelling it, so the check above is not vacuous', () => {
        expect(prefixLiterals(OWNER), 'the owner still defines the prefix').toContain(
            `'${PREFIX}'`,
        );
    });
});
