/**
 * The duplicate-link matcher.
 *
 * `findDuplicateLinks` is the whole feature's judgement, so this file pins the judgement
 * rather than its internals: which two URLs the app calls the same link, which text it
 * reads them out of, and what it refuses to read.
 *
 * `#lib/linkTokens.ts` is wrapped in a spy here (the real functions still run) for two
 * claims the matcher makes in its own comments: a composer with no `://` never touches the
 * line list, and a stored line with no `://` is never tokenized. Both are cost claims, and
 * a cost claim that no test checks is a hope. The spy is the only mock in this file, so
 * every other assertion runs against the tokenizer `LinkifiedText` renders with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenizeLinks } from '#lib/linkTokens.ts';
import { findDuplicateLinks } from '#lib/duplicateLinks.ts';
import type { BufferLine } from '#lib/types.ts';

vi.mock('#lib/linkTokens.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/linkTokens.ts')>();
    return { ...actual, tokenizeLinks: vi.fn(actual.tokenizeLinks) };
});

/** A stored chat line, shaped like the ones `models.ts` builds. */
function line(text: string, over: Partial<BufferLine> = {}): BufferLine {
    return {
        prefix: [],
        content: [],
        date: 1700000000,
        shortTime: '14:05',
        buffer: 'irc.libera.#chan',
        tags: ['irc_join'],
        highlight: false,
        displayed: true,
        prefixtext: '<alice>',
        text,
        showHiddenBrackets: false,
        ...over,
    };
}

/** The URL the matcher reported for `pending` against `lines`, or none. */
function matchedUrls(pending: string, lines: BufferLine[]): string[] {
    return findDuplicateLinks(pending, lines).map((match) => match.url);
}

/** A `BufferLine[]` that counts every indexed read the matcher makes. */
function trackedLines(lines: BufferLine[]): { lines: BufferLine[]; reads: number[] } {
    const reads: number[] = [];
    const tracked = new Proxy(lines, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) reads.push(Number(property));
            return Reflect.get(target, property);
        },
    });
    return { lines: tracked as BufferLine[], reads };
}

beforeEach(() => {
    vi.mocked(tokenizeLinks).mockClear();
});

describe('which two URLs the app calls the same link', () => {
    it('ignores the #fragment, because it picks a place inside one page', () => {
        expect(matchedUrls('https://x.dev/a#top', [line('see https://x.dev/a#bottom')]))
            .toEqual(['https://x.dev/a#bottom']);
    });

    it('ignores the tracking parameters it names, whatever their value', () => {
        const stored = [line('see https://x.dev/a')];
        for (const pending of [
            'https://x.dev/a?utm_source=reddit',
            'https://x.dev/a?utm_medium=social&utm_campaign=launch',
            'https://x.dev/a?fbclid=awdQ',
            'https://x.dev/a?gclid=Cjw',
            'https://x.dev/a?mc_cid=7f1&mc_id=44',
        ]) {
            expect(matchedUrls(pending, stored), pending).toEqual(['https://x.dev/a']);
        }
        // The value is not what is ignored — the parameter name is — so two different
        // campaigns of the same name still compare equal.
        expect(matchedUrls('https://x.dev/a?utm_source=reddit', [line('see https://x.dev/a?utm_source=hn')]))
            .toEqual(['https://x.dev/a?utm_source=hn']);
    });

    it('keeps every other query parameter significant', () => {
        expect(matchedUrls('https://x.dev/a?page=2', [line('see https://x.dev/a')])).toEqual([]);
        expect(matchedUrls('https://x.dev/a?ref=a', [line('see https://x.dev/a?ref=b')])).toEqual([]);
        expect(matchedUrls('https://x.dev/a?utm_source=r&page=2', [line('see https://x.dev/a?page=2')]))
            .toEqual(['https://x.dev/a?page=2']);
    });

    it('treats a trailing slash on a bare host as the same page', () => {
        expect(matchedUrls('https://x.dev', [line('see https://x.dev/')])).toEqual(['https://x.dev/']);
        expect(matchedUrls('https://x.dev/', [line('see https://x.dev')])).toEqual(['https://x.dev']);
    });

    it('calls http and https the same link only when host, path and query match', () => {
        expect(matchedUrls('http://x.dev/a', [line('see https://x.dev/a')])).toEqual(['https://x.dev/a']);
        expect(matchedUrls('https://x.dev/a', [line('see http://x.dev/a')])).toEqual(['http://x.dev/a']);
        expect(matchedUrls('http://x.dev/a', [line('see https://x.dev/b')])).toEqual([]);
        expect(matchedUrls('http://x.dev/a?x=1', [line('see https://x.dev/a?x=2')])).toEqual([]);
    });

    it('never calls a different port the same link', () => {
        expect(matchedUrls('https://x.dev:8080/a', [line('see https://x.dev:8443/a')])).toEqual([]);
        expect(matchedUrls('https://x.dev:8080/a', [line('see https://x.dev/a')])).toEqual([]);
        expect(matchedUrls('https://x.dev/a', [line('see https://x.dev:8080/a')])).toEqual([]);
    });

    it('treats a port that the scheme already implies as no port at all', () => {
        // `URL` answers `port: ''` for `http://x.dev:80`, so the explicit `:80` is not an
        // explicit port. Recorded because it is the one place "explicit port" is decided by
        // the parser rather than by this matcher.
        expect(matchedUrls('http://x.dev:80/a', [line('see http://x.dev/a')])).toEqual(['http://x.dev/a']);
        expect(matchedUrls('https://x.dev:443/a', [line('see https://x.dev/a')])).toEqual(['https://x.dev/a']);
        expect(matchedUrls('https://x.dev:80/a', [line('see https://x.dev/a')])).toEqual([]);
    });

    it('does not call / the same page as /index.html', () => {
        expect(matchedUrls('https://x.dev/', [line('see https://x.dev/index.html')])).toEqual([]);
        expect(matchedUrls('https://x.dev/index.html', [line('see https://x.dev/')])).toEqual([]);
    });

    it('reads the host case-insensitively and the path case-sensitively', () => {
        expect(matchedUrls('https://X.DEV/a', [line('see https://x.dev/a')])).toEqual(['https://x.dev/a']);
        expect(matchedUrls('https://x.dev/a', [line('see https://X.DEV/a')])).toEqual(['https://X.DEV/a']);
        expect(matchedUrls('https://x.dev/a', [line('see https://x.dev/A')])).toEqual([]);
    });

    /**
     * The plan says "scheme … case-insensitive". What the app does is narrower: the shared
     * tokenizer only recognises a lowercase `http://`, `https://` or `ftp://`, so a composer
     * holding `HTTPS://X.DEV/a` has no link token at all and the matcher never judges it.
     * `linkKey` does lowercase the scheme, but only for a token the tokenizer already
     * accepted. Recorded rather than fixed, because making `HTTPS://` a link is a change to
     * what the chat linkifies, not to this matcher.
     */
    it('does not treat an uppercase scheme as a link, because the tokenizer reads lowercase schemes only', () => {
        expect(matchedUrls('HTTPS://X.DEV/a', [line('see HTTPS://X.DEV/a')])).toEqual([]);
        expect(matchedUrls('HTTPS://X.DEV/a', [line('see https://x.dev/a')])).toEqual([]);
    });
});

describe('what counts as a link in a line of text', () => {
    it('compares whole tokens, so …/a is not a match inside …/ab', () => {
        expect(matchedUrls('https://x.dev/a', [line('see https://x.dev/ab')])).toEqual([]);
        expect(matchedUrls('https://x.dev/ab', [line('see https://x.dev/a')])).toEqual([]);
    });

    it('does not treat a bare www.x.dev as a link, because the chat does not linkify it', () => {
        expect(matchedUrls('see www.x.dev/a now', [line('see www.x.dev/a')])).toEqual([]);
        expect(matchedUrls('see x.dev/a now', [line('see x.dev/a')])).toEqual([]);
    });

    it('still matches a URL wrapped in <…>', () => {
        expect(matchedUrls('post <https://x.dev/a> now', [line('see https://x.dev/a')]))
            .toEqual(['https://x.dev/a']);
        expect(matchedUrls('see https://x.dev/a', [line('notes <https://x.dev/a> here')]))
            .toEqual(['https://x.dev/a']);
    });

    it('matches a trailing punctuation-free URL when the stored line ends the sentence with one', () => {
        expect(matchedUrls('see https://x.dev/a', [line('posted https://x.dev/a.')])).toEqual(['https://x.dev/a']);
    });

    it('checks ftp:// too, because the chat linkifies it', () => {
        expect(matchedUrls('files at ftp://x.dev/pub', [line('files at ftp://x.dev/pub')]))
            .toEqual(['ftp://x.dev/pub']);
        // ftp is its own scheme group: it does not become http under the pairing rule.
        expect(matchedUrls('ftp://x.dev/pub', [line('files at http://x.dev/pub')])).toEqual([]);
    });

    /**
     * The plan's sentence "a URL inside backticks is not a link" is not what the app does,
     * and this test records what it does instead. `tokenizeLinks` matches `://\S+` and strips
     * only `[.,;:!?)\]>]` from the end, so the closing backtick belongs to the link token —
     * `codify.test.ts` pins the same token (`https://example.com\``) for the chat renderer,
     * and the chat really does draw it as an `<a>`. Consequence: a backticked link only
     * matches a link written the same way, and never matches the plain URL it wraps. That is
     * consistent with the UI, but it is narrower than the plan claimed. The matcher was not
     * changed to make the plan's sentence true.
     */
    it('keeps the closing backtick inside a code-formatted link token, so it matches only its own kind', () => {
        expect(matchedUrls('run `https://x.dev/code` end', [line('see https://x.dev/code')])).toEqual([]);
        expect(matchedUrls('see https://x.dev/code', [line('run `https://x.dev/code` now')])).toEqual([]);
        // Both sides code-formatted: the two tokens are byte-identical, so this is a match,
        // and the URL the dialog is shown carries the backtick.
        expect(matchedUrls('run `https://x.dev/code` end', [line('see `https://x.dev/code` now')]))
            .toEqual(['https://x.dev/code`']);
    });
});

describe('the pass over the buffer', () => {
    it('reports newest match first', () => {
        const lines = [
            line('oldest https://x.dev/a'),
            line('middle https://x.dev/a'),
            line('newest https://x.dev/a'),
        ];
        expect(findDuplicateLinks('https://x.dev/a', lines).map((m) => m.line.text))
            .toEqual(['newest https://x.dev/a', 'middle https://x.dev/a', 'oldest https://x.dev/a']);
    });

    it('stops at three matches', () => {
        const lines = ['one', 'two', 'three', 'four', 'five'].map((n) => line(`${n} https://x.dev/a`));
        const matches = findDuplicateLinks('https://x.dev/a', lines);
        expect(matches).toHaveLength(3);
        expect(matches.map((m) => m.line.text)).toEqual(['five https://x.dev/a', 'four https://x.dev/a', 'three https://x.dev/a']);
    });

    it('skips date separators', () => {
        const matches = findDuplicateLinks('https://x.dev/a', [
            line('Mon 12 Aug 2024 https://x.dev/a', { isDateSeparator: true, prefixtext: '' }),
            line('real post https://x.dev/a'),
        ]);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.line.text).toBe('real post https://x.dev/a');
    });

    it("counts the reader's own message as a previous post", () => {
        const matches = findDuplicateLinks('https://x.dev/a', [
            line('https://x.dev/a', { prefixtext: '<me>' }),
        ]);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.line.prefixtext).toBe('<me>');
    });

    it('reads each line once and stops reading its tokens at the first match', () => {
        // One stored line carries both pending links; the pass records one match for it,
        // because a line is either a previous post of something or it is not.
        const matches = findDuplicateLinks('https://x.dev/a and https://y.dev/b', [
            line('both https://x.dev/a then https://y.dev/b'),
        ]);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.url).toBe('https://x.dev/a');
    });

    it('returns [] for a composer with no ://, without reading the line list', () => {
        const tracked = trackedLines([line('https://x.dev/a'), line('plain'), line('plain too')]);
        expect(findDuplicateLinks('just text, no link', tracked.lines)).toEqual([]);
        // The prefilter is the first line of `findDuplicateLinks`; both halves of the claim
        // are observable — no tokenizer call, and no indexed read of the array.
        expect(vi.mocked(tokenizeLinks)).not.toHaveBeenCalled();
        expect(tracked.reads).toEqual([]);
    });

    it('never tokenizes a stored line that has no ://', () => {
        const lines = [
            line('plain line one'),
            line('plain line two'),
            line('plain line three'),
            line('plain line four'),
            line('link here https://x.dev/a'),
        ];
        expect(matchedUrls('see https://x.dev/a', lines)).toEqual(['https://x.dev/a']);
        // One call for the composer's own text, one for the single line that survived the
        // `://` prefilter. The match also stops the walk before the older lines.
        expect(vi.mocked(tokenizeLinks).mock.calls.map((call) => call[0]))
            .toEqual(['see https://x.dev/a', 'link here https://x.dev/a']);
    });

    it('tokenizes a line whose :// belongs to no scheme, because the prefilter asks only for ://', () => {
        // Recorded so the prefilter is not mistaken for a scheme check: `x://y` costs one
        // tokenizeLinks call and can never produce a token.
        const matches = findDuplicateLinks('see https://x.dev/a', [line('weird x://y text'), line('real https://x.dev/a')]);
        expect(matches).toHaveLength(1);
        expect(vi.mocked(tokenizeLinks).mock.calls.map((call) => call[0]))
            .toEqual(['see https://x.dev/a', 'real https://x.dev/a', 'weird x://y text']);
    });

    it('returns [] when the composer holds a :// but no tokenizable link', () => {
        expect(matchedUrls('odd :// shape only', [line('see https://x.dev/a')])).toEqual([]);
    });

    it('holds an empty line list without throwing', () => {
        expect(matchedUrls('see https://x.dev/a', [])).toEqual([]);
    });

    /**
     * The plan's worst case, kept as a shape rather than a stopwatch: 4 096 lines, every one
     * carrying links that do not match. Measured here while this file was written: the miss
     * took 6.6-8.7 ms and the same buffer with a match on the newest line took about 10 ms on
     * its first run and 1-2 ms once warm. A timing assertion would fail on a loaded CI runner
     * and prove nothing, so the numbers belong in the plan's Cost budget and this test asserts
     * only that the fixture is the fixture. `MAX_LINK_LINES_SCANNED` was not needed.
     */
    it('walks a full 4 096-line window on a miss and stops at once on a hit', () => {
        const filler = (i: number) => line(`line ${i} https://other${i}.dev/page?utm_source=x&page=${i} tail`);
        const miss: BufferLine[] = [];
        for (let i = 0; i < 4096; i++) miss.push(filler(i));
        expect(findDuplicateLinks('https://target.dev/page?utm_source=y', miss)).toEqual([]);

        const hit = miss.slice(0, 4095);
        hit.push(line('newest https://target.dev/page?utm_source=z'));
        const matches = findDuplicateLinks('https://target.dev/page?utm_source=q', hit);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.url).toBe('https://target.dev/page?utm_source=z');
    });
});

describe('what a match carries to the dialog', () => {
    it('hands over the line itself, so prefixtext, shortTime, date and text reach the row', () => {
        const stored = line('read this before you post it https://x.dev/a', {
            prefixtext: '<bob>',
            shortTime: '09:12',
            date: 1700003520000,
        });
        const matches = findDuplicateLinks('here https://x.dev/a again', [stored]);
        expect(matches).toHaveLength(1);
        const match = matches[0]!;
        expect(match.line).toBe(stored);
        expect(match.line.prefixtext).toBe('<bob>');
        expect(match.line.shortTime).toBe('09:12');
        expect(match.line.date).toBe(1700003520000);
        expect(match.line.text).toBe('read this before you post it https://x.dev/a');
    });

    it('keeps the <nick> prefix form BufferLineRow parses', () => {
        const stored = line('note https://x.dev/a', { prefixtext: '<bob>' });
        const match = findDuplicateLinks('https://x.dev/a', [stored])[0]!;
        expect(match.line.prefixtext).toMatch(/^<.+>$/);
    });

    it('reports the URL as the buffer holds it, not the normalised key', () => {
        // The reader has to be able to see why the app thinks these are the same link.
        const match = findDuplicateLinks('https://x.dev/a?utm_source=reddit#section', [
            line('earlier https://x.dev/a?ref=4'),
        ])[0];
        expect(match).toBeUndefined();
        const shown = findDuplicateLinks('https://x.dev/a?utm_source=reddit#section', [
            line('earlier https://x.dev/a#top'),
        ])[0]!;
        expect(shown.url).toBe('https://x.dev/a#top');
    });

    it('writes nothing to the stored line', () => {
        const stored = line('earlier https://x.dev/a');
        const before = JSON.stringify(stored);
        findDuplicateLinks('again https://x.dev/a', [stored]);
        expect(JSON.stringify(stored)).toBe(before);
    });
});
