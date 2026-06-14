import { describe, it, expect } from 'vitest';
import { tokenizeLinks } from '$lib/linkTokens';

describe('tokenizeLinks', () => {
    it('returns empty array for empty string', () => {
        expect(tokenizeLinks('')).toEqual([]);
    });

    it('returns empty array for null', () => {
        expect(tokenizeLinks(null as any)).toEqual([]);
    });

    it('returns text-only token for string without URLs', () => {
        const result = tokenizeLinks('Hello world');
        expect(result).toEqual([{ type: 'text' as const, value: 'Hello world' }]);
    });

    it('splits text and single URL correctly', () => {
        const result = tokenizeLinks('Check https://example.com for more');
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ type: 'text', value: 'Check ' });
        expect(result[1]).toEqual({ type: 'link', value: 'https://example.com' });
        expect(result[2]).toEqual({ type: 'text', value: ' for more' });
    });

    it('detects multiple URLs in one string', () => {
        const result = tokenizeLinks('See https://a.com and https://b.org');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(2);
        expect(links[0].value).toBe('https://a.com');
        expect(links[1].value).toBe('https://b.org');
    });

    it('excludes trailing period from URL', () => {
        const result = tokenizeLinks('Visit https://example.com.');
        const link = result.find(t => t.type === 'link');
        expect(link!.value).toBe('https://example.com');
    });

    it('excludes trailing comma from URL', () => {
        const result = tokenizeLinks('Go to https://example.com, please');
        const link = result.find(t => t.type === 'link');
        expect(link!.value).toBe('https://example.com');
    });

    it('handles http:// (not https://) URLs', () => {
        const result = tokenizeLinks('Old site: http://example.com/page');
        const link = result.find(t => t.type === 'link');
        expect(link!.value).toBe('http://example.com/page');
    });

    it('preserves full URL with query parameters', () => {
        const result = tokenizeLinks('https://example.com/path?query=1&foo=bar');
        const link = result.find(t => t.type === 'link');
        expect(link!.value).toBe('https://example.com/path?query=1&foo=bar');
    });

    it('blocks javascript: protocol', () => {
        const result = tokenizeLinks('javascript:void(0)');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(0);
    });

    it('blocks data: protocol', () => {
        const result = tokenizeLinks('data:text/html,<script>alert(1)</script>');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(0);
    });

    it('renders <img> tag as literal text token', () => {
        const result = tokenizeLinks('<img src=x onerror=alert(1)>');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(0);
        const textTokens = result.filter(t => t.type === 'text');
        expect(textTokens.map(t => t.value).join('')).toBe('<img src=x onerror=alert(1)>');
    });

    it('renders <script> tags as literal text tokens', () => {
        const result = tokenizeLinks('<script>alert("xss")</script>');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(0);
        expect(result[0].value).toBe('<script>alert("xss")</script>');
    });

    it('does not linkify IRC channel names', () => {
        const result = tokenizeLinks('#general #testing');
        const links = result.filter(t => t.type === 'link');
        expect(links).toHaveLength(0);
    });

    it('handles parenthetical URLs - stops before closing paren', () => {
        const result = tokenizeLinks('(see https://example.com)');
        const link = result.find(t => t.type === 'link');
        // The regex doesn't include ) in the URL, so it stops before it
        expect(link!.value).toBe('https://example.com');
    });

    it('handles angle brackets around URLs', () => {
        const result = tokenizeLinks('See <https://example.com> for info');
        // < is not a URL char so stays as text; > is consumed by \S+ then stripped as trailing punct
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ type: 'text', value: 'See <' });
        expect(result[1]).toEqual({ type: 'link', value: 'https://example.com' });
        expect(result[2]).toEqual({ type: 'text', value: ' for info' });
    });

    it('handles URL at start of string', () => {
        const result = tokenizeLinks('https://example.com is great');
        expect(result[0]).toEqual({ type: 'link', value: 'https://example.com' });
    });

    it('handles URL at end of string', () => {
        const result = tokenizeLinks('Visit https://example.com');
        const lastToken = result[result.length - 1];
        expect(lastToken).toEqual({ type: 'link', value: 'https://example.com' });
    });

    it('does not linkify HTML-escaped content', () => {
        const result = tokenizeLinks('&lt;img src=x onerror=alert(1)&gt; http://example.com');
        const links = result.filter(t => t.type === 'link');
        // &lt; and &gt; are literal text, only the real URL becomes a link
        expect(links).toHaveLength(1);
        expect(links[0].value).toBe('http://example.com');
    });

    it('strips multiple trailing punctuation characters from URLs', () => {
        const result = tokenizeLinks('See (https://example.com/path).');
        const link = result.find(t => t.type === 'link');
        expect(link!.value).toBe('https://example.com/path');
    });
});
