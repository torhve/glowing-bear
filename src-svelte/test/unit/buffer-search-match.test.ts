import { describe, expect, it } from 'vitest';
import {
    CUT_MARKER, bufferMatchesQuery, splitQueryMatches, topicCapacity, topicExcerpt,
    topicMatchesQuery, type RowMetrics,
} from '#lib/bufferSearchMatch.ts';
import type { BufferPresentation } from '#lib/types.ts';

/**
 * The rules the buffer search dialog shows its results by.
 *
 * One rule decides which rows survive the filter and which words get marked, so a row
 * cannot appear with nothing on it explaining why. These tests ask that rule directly, plus
 * the excerpt that has to keep a topic match whole inside a row that is only so wide.
 */

function buffer(values: Partial<BufferPresentation> & { shortName: string }): BufferPresentation {
    const unset: Partial<BufferPresentation> = {
        id: '1',
        number: 1,
        shortName: values.shortName,
        fullName: `irc.libera.${values.shortName}`,
        rtitle: '',
        type: 'channel',
        hidden: false,
        pinned: false,
        unread: 0,
        notification: 0,
        active: false,
    };
    return { ...unset, ...values } as BufferPresentation;
}

describe('bufferMatchesQuery', () => {
    it('keeps every buffer when there is no query', () => {
        expect(bufferMatchesQuery(buffer({ shortName: '#a' }), '')).toBe(true);
    });

    it('matches the short name, the full name, the topic and the number', () => {
        const buf = buffer({ shortName: '#gamedev', rtitle: 'Level design' , number: 96 });
        expect(bufferMatchesQuery(buf, 'game')).toBe(true);
        expect(bufferMatchesQuery(buf, 'libera')).toBe(true);
        expect(bufferMatchesQuery(buf, 'design')).toBe(true);
        expect(bufferMatchesQuery(buf, '9')).toBe(true);
    });

    it('folds case, and treats the query as text rather than a pattern', () => {
        const buf = buffer({ shortName: '#Gaming', rtitle: 'Dev + QA' });
        expect(bufferMatchesQuery(buf, 'gAMING')).toBe(true);
        expect(bufferMatchesQuery(buf, 'dev.+qa')).toBe(false);
        expect(bufferMatchesQuery(buf, '.+')).toBe(false);
    });

    it('says when it was the topic that matched', () => {
        const buf = buffer({ shortName: '#videogames', rtitle: 'Live stream on twitch.tv' });
        expect(topicMatchesQuery(buf, 'twitch')).toBe(true);
        expect(topicMatchesQuery(buf, 'video')).toBe(false);
        expect(topicMatchesQuery(buf, '')).toBe(false);
    });
});

describe('splitQueryMatches', () => {
    it('returns the whole text as one plain piece when there is nothing to mark', () => {
        expect(splitQueryMatches('#gamedev', '')).toEqual([{ text: '#gamedev', hit: false }]);
        expect(splitQueryMatches('', 'game')).toEqual([{ text: '', hit: false }]);
    });

    it('marks every occurrence, in order, and keeps the text identical', () => {
        const pieces = splitQueryMatches('twitch and TWITCH again', 'twitch');
        expect(pieces.map(p => p.text)).toEqual(['twitch', ' and ', 'TWITCH', ' again']);
        expect(pieces.map(p => p.hit)).toEqual([true, false, true, false]);
        expect(pieces.map(p => p.text).join('')).toBe('twitch and TWITCH again');
    });

    it('marks a match at the start and at the end', () => {
        expect(splitQueryMatches('twitch.tv/gamedev', 'gamedev')).toEqual([
            { text: 'twitch.tv/', hit: false },
            { text: 'gamedev', hit: true },
        ]);
        expect(splitQueryMatches('twitch.tv/gamedev', 'twitch')).toEqual([
            { text: 'twitch', hit: true },
            { text: '.tv/gamedev', hit: false },
        ]);
    });
});

describe('topicExcerpt', () => {
    const long = 'Level design, engine plumbing and shipping dates. Weekly dev stream on '
        + 'twitch.tv/gamedev; recordings are linked in the sidebar.';

    it('shows the whole topic when it fits', () => {
        const excerpt = topicExcerpt('Game night Fridays', 'game', 40);
        expect(excerpt).toEqual({ text: 'Game night Fridays', lead: false, trail: false });
    });

    it('returns nothing when the topic is not what matched, or holds no topic at all', () => {
        expect(topicExcerpt('Level design', 'twitch', 60)).toBeNull();
        expect(topicExcerpt('', 'twitch', 60)).toBeNull();
        expect(topicExcerpt('   ', 'twitch', 60)).toBeNull();
        expect(topicExcerpt('Level design', '', 60)).toBeNull();
    });

    it('returns nothing when the row is too narrow to hold the match and its markers', () => {
        expect(topicExcerpt(long, 'twitch', 11)).toBeNull();
        // 12 characters is the floor, and a 13-character query cannot fit in it either.
        expect(topicExcerpt(long, 'twitch.tv/gamedev', 12)).toBeNull();
    });

    it('keeps the whole match inside the capacity, at any width', () => {
        for (const capacity of [12, 20, 32, 48, 64, 80]) {
            const excerpt = topicExcerpt(long, 'twitch', capacity);
            if (!excerpt) continue;
            const shown = excerpt.text.toLowerCase();
            expect(shown).toContain('twitch');
            // What the dialog renders: the excerpt plus one marker per cut.
            const width = excerpt.text.length + (excerpt.lead ? 2 : 0) + (excerpt.trail ? 2 : 0);
            expect(width).toBeLessThanOrEqual(capacity);
        }
    });

    it('closes on a whole word when the room allows it', () => {
        expect(topicExcerpt('one two twitch three four', 'twitch', 18)).toEqual({
            text: 'one two twitch', lead: false, trail: true,
        });
    });

    it('stops straight after the match rather than cut through a word', () => {
        expect(topicExcerpt('one two twitch three four', 'twitch', 12)).toEqual({
            text: 'twitch', lead: true, trail: true,
        });
    });

    it('keeps a match that sits inside a longer word whole', () => {
        expect(topicExcerpt('ping @twitch:matrix.org and more', 'twitch', 14)).toEqual({
            text: 'ping @twitch', lead: false, trail: true,
        });
        expect(topicExcerpt('a long run of words before ping @twitch:matrix.org now', 'Twitch', 16)).toEqual({
            text: 'ping @twitch', lead: true, trail: true,
        });
    });

    it('keeps the start of the topic when the room can hold the match whole', () => {
        const excerpt = topicExcerpt(long, 'twitch', 80);
        expect(excerpt?.lead).toBe(false);
        expect(excerpt?.text.startsWith('Level design,')).toBe(true);
        expect(excerpt?.text.endsWith('on twitch')).toBe(true);
    });

    it('gives up the start of the topic rather than cut the matched word', () => {
        expect(topicExcerpt(long, 'twitch', 76)).toEqual({
            text: 'design, engine plumbing and shipping dates. Weekly dev stream on twitch',
            lead: true, trail: true,
        });
    });

    it('marks both cuts when both sides of the topic were dropped', () => {
        const excerpt = topicExcerpt(long, 'twitch', 40);
        expect(excerpt?.lead).toBe(true);
        expect(excerpt?.trail).toBe(true);
    });

    it('leaves the whole tail unmarked when only the head was cut', () => {
        const excerpt = topicExcerpt(long, 'sidebar', 30);
        expect(excerpt?.trail).toBe(false);
        expect(excerpt?.text.endsWith('sidebar.')).toBe(true);
    });

    it('does not end the excerpt on a separator the cut orphaned', () => {
        const excerpt = topicExcerpt('Dev chat, engine work, and a stream on twitch.tv/gamedev now', 'twitch', 34);
        expect(excerpt?.text.endsWith('/')).toBe(false);
        expect(excerpt?.text.endsWith('twitch')).toBe(true);
    });

    it('trims the whitespace its cuts orphaned', () => {
        const excerpt = topicExcerpt('  a long topic about twitch streaming  ', 'twitch', 20);
        const shown = excerpt?.text ?? '';
        expect(shown).not.toBe('');
        expect(shown).toBe(shown.trim());
    });

    it('counts non-ASCII characters as the row renders them', () => {
        const topic = 'Norsk chatter om IRC, WeeChat og Glowing Bear. Laurdagsstream på twitch.tv/norsk';
        const excerpt = topicExcerpt(topic, 'twitch', 40);
        expect(excerpt?.text).toContain('twitch');
        expect(excerpt?.text).toContain('på');
        const width = (excerpt?.text.length ?? 0) + 4;
        expect(width).toBeLessThanOrEqual(40);
    });

    it('handles a query that appears more than once', () => {
        const excerpt = topicExcerpt('twitch and twitch again and again', 'twitch', 12);
        expect(excerpt).toEqual({ text: 'twitch and', lead: false, trail: true });
    });
});

describe('topicCapacity', () => {
    // Measured against a rendered dialog at the shipped 672px width with the shipped mono
    // font: a two-digit buffer number leaves the topic line 596px, a three-digit one 588px.
    const metrics: RowMetrics = { resultsWidth: 672, charWidth: 7.8, badgeCharWidth: 7.2 };

    it('counts the characters a row can actually print', () => {
        expect(topicCapacity(2, metrics)).toBe(75);
        expect(topicCapacity(3, metrics)).toBe(74);
        expect(topicCapacity(1, metrics)).toBe(76);
    });

    it('shrinks with the row', () => {
        // A 380px phone dialog, same fonts.
        expect(topicCapacity(2, { ...metrics, resultsWidth: 380 })).toBe(38);
    });

    it('reports zero until the dialog has measured itself', () => {
        expect(topicCapacity(2, { resultsWidth: 0, charWidth: 0, badgeCharWidth: 0 })).toBe(0);
        expect(topicCapacity(2, { resultsWidth: 672, charWidth: 0, badgeCharWidth: 7.2 })).toBe(0);
    });

    it('never reports a negative budget for a row too narrow to hold anything', () => {
        expect(topicCapacity(4, { resultsWidth: 60, charWidth: 7.8, badgeCharWidth: 7.2 })).toBe(0);
    });

    it('gives the unread chip its room at the row edge', () => {
        // The chip is drawn over the row, so a topic line beside it loses the chip's width.
        expect(topicCapacity(2, metrics, 0)).toBe(75);
        expect(topicCapacity(2, metrics, 1)).toBe(72);
        expect(topicCapacity(2, metrics, 2)).toBe(71);
    });
});

describe('CUT_MARKER', () => {
    it('is the ellipsis the dialog draws for a cut', () => {
        expect(CUT_MARKER).toBe('\u2026');
    });
});
