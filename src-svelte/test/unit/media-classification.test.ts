/**
 * What a URL is by file extension — one answer, used by both consumers.
 *
 * `BufferLineRow` classifies a URL to label it ("Show Image"), and `PluginEmbed`
 * classifies the same URL to decide which element to inject. They used to be two
 * if-chains over the same three extension tables, so a label and an element could
 * disagree with nothing to notice it. Everything below is the answer both of them
 * now get; the ordering pin is the case where two tables overlap (`.gifv` is in the
 * video table, and `.gif` is a prefix of it) and the order decides the result.
 */
import { describe, expect, it } from 'vitest';
import { classifyMediaUrl, normalizeImageUrl } from '#lib/utils/mediaExtensions.ts';

describe('classifyMediaUrl', () => {
    it('names every image extension it knows', () => {
        for (const url of [
            'https://example.com/a.png',
            'https://example.com/a.jpg',
            'https://example.com/a.jpeg',
            'https://example.com/a.gif',
            'https://example.com/a.bmp',
            'https://example.com/a.ico',
            'https://example.com/a.svg',
            'https://example.com/a.svgz',
            'https://example.com/a.tiff',
            'https://example.com/a.webp',
            'https://example.com/a.avif'
        ]) {
            const media = classifyMediaUrl(url);
            expect(media, url).not.toBeNull();
            expect(media!.kind, url).toBe('image');
            expect(media!.name, url).toBe('Image');
        }
    });

    it('carries the two image fixes both consumers needed', () => {
    // A Dropbox share has to ask for the file, not Dropbox's own page.
        expect(classifyMediaUrl('https://www.dropbox.com/s/abcd1234/photo.png')!.content).toBe(
            'https://www.dropbox.com/s/abcd1234/photo.png?dl=1'
        );
        // An http Imgur link is not served over plain http at all.
        expect(classifyMediaUrl('http://i.imgur.com/abc.png')!.content).toBe('https://i.imgur.com/abc.png');
        // Everything else is passed through, so the content is the URL the reader saw.
        const plain = 'https://example.com/a.png?v=1#frag';
        expect(classifyMediaUrl(plain)!.content).toBe(plain);
    });

    it('names video and audio by extension and leaves the URL alone', () => {
        const video = 'https://example.com/clip.mp4?t=30';
        expect(classifyMediaUrl(video)).toEqual({ kind: 'video', name: 'Video', content: video });
        const audio = 'https://example.com/song.mp3';
        expect(classifyMediaUrl(audio)).toEqual({ kind: 'audio', name: 'Audio', content: audio });
        expect(classifyMediaUrl('https://example.com/song.ogg')!.kind).toBe('audio');
        expect(classifyMediaUrl('https://example.com/song.flac')!.kind).toBe('audio');
    });

    it('calls .gifv a video, which is where two tables overlap', () => {
    // `.gif` is in the image table and is a prefix of `.gifv`. The image table is
    // consulted first, so a `.gifv` link would become a still image if the regex
    // let it match — this is the one case where the order of the chain is visible.
        expect(classifyMediaUrl('https://example.com/x.gifv')!.kind).toBe('video');
        expect(classifyMediaUrl('https://example.com/x.gif')!.kind).toBe('image');
    });

    it('reads extensions case-insensitively', () => {
        expect(classifyMediaUrl('https://example.com/PHOTO.PNG')!.kind).toBe('image');
        expect(classifyMediaUrl('https://example.com/SONG.MP3')!.kind).toBe('audio');
    });

    it('declines anything that is not a media file', () => {
        expect(classifyMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
        expect(classifyMediaUrl('https://example.com/page')).toBeNull();
        expect(classifyMediaUrl('not a url')).toBeNull();
    });

    it('agrees with normalizeImageUrl rather than inventing a third rule', () => {
        for (const url of [
            'https://www.dropbox.com/s/abcd1234/photo.png?dl=0',
            'http://imgur.com/abc.png',
            'https://example.com/plain.png'
        ]) {
            expect(classifyMediaUrl(url)!.content).toBe(normalizeImageUrl(url));
        }
    });
});
