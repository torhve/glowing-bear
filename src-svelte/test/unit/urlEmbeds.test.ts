import { describe, it, expect } from 'vitest';
import { buildEmbed, detectEmbedUrl } from '#lib/utils/urlEmbeds.ts';

describe('detectEmbedUrl', () => {
    it('detects YouTube watch URLs', () => {
        const result = detectEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(result).toEqual({ name: 'YouTube video' });
    });

    it('detects YouTube short URLs', () => {
        const result = detectEmbedUrl('https://youtu.be/dQw4w9WgXcQ');
        expect(result).toEqual({ name: 'YouTube video' });
    });

    it('detects YouTube embed URLs', () => {
        const result = detectEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
        expect(result).toEqual({ name: 'YouTube video' });
    });

    it('detects YouTube alternate paths', () => {
        for (const url of [
            'https://www.youtube.com/shorts/dQw4w9WgXcQ',
            'https://www.youtube.com/live/dQw4w9WgXcQ',
            'https://www.youtube.com/v/dQw4w9WgXcQ',
            'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            'https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ',
            'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        ]) {
            expect(detectEmbedUrl(url)).toEqual({ name: 'YouTube video' });
        }
    });

    // The id has to survive intact into the player URL, so it is checked where it
    // is used rather than by reaching into the pattern: a truncated or overlong
    // run must not be accepted, and every accepted form must reach the same player.
    it('builds the same player from every accepted form', () => {
        for (const url of [
            'https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ',
            'https://www.youtube.com/shorts/dQw4w9WgXcQ',
            'https://youtu.be/dQw4w9WgXcQ?si=abc',
        ]) {
            expect(buildEmbed(url)?.src, url).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
        }
    });

    it('does not treat other hosts or non-video paths as YouTube', () => {
        for (const url of [
            'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
            'https://www.youtube.com/playlist?list=PLdQw4w9WgXcQ',
            'https://www.youtube.com/watching',
            'https://www.youtube.com/watch#?v=dQw4w9WgXcQ',
            'https://youtu.be/dQw4w9WgXcQxyz',
        ]) {
            expect(detectEmbedUrl(url)).toBeNull();
        }
    });

    it('detects Twitch clips', () => {
        const result = detectEmbedUrl('https://clips.twitch.tv/CleverFuriousTrayPJSalt');
        expect(result).toEqual({ name: 'Twitch clip' });
    });

    it('detects Twitch videos', () => {
        const result = detectEmbedUrl('https://www.twitch.tv/videos/123456789');
        expect(result).toEqual({ name: 'Twitch video' });
    });

    it('detects Twitch channels', () => {
        const result = detectEmbedUrl('https://www.twitch.tv/monstercat');
        expect(result).toEqual({ name: 'Twitch channel' });
    });

    it('detects Dailymotion URLs', () => {
        const result = detectEmbedUrl('https://www.dailymotion.com/video/x8d9e1');
        expect(result).toEqual({ name: 'Dailymotion video' });
    });

    it('detects Streamable URLs', () => {
        const result = detectEmbedUrl('https://streamable.com/abc123');
        expect(result).toEqual({ name: 'Streamable video' });
    });

    it('detects Spotify track URLs', () => {
        const result = detectEmbedUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
        expect(result).toEqual({ name: 'Spotify music' });
    });

    it('detects Spotify album URLs', () => {
        const result = detectEmbedUrl('https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo');
        expect(result).toEqual({ name: 'Spotify music' });
    });

    it('detects SoundCloud URLs', () => {
        const result = detectEmbedUrl('https://soundcloud.com/user/track-name');
        expect(result).toEqual({ name: 'SoundCloud' });
    });

    it('detects MixCloud URLs', () => {
        const result = detectEmbedUrl('https://www.mixcloud.com/user/mix-name/');
        expect(result).toEqual({ name: 'MixCloud' });
    });

    it('detects Google Maps URLs', () => {
        const result = detectEmbedUrl('https://maps.google.com/?q=London');
        expect(result).toEqual({ name: 'Google Maps' });
    });

    it('detects Giphy URLs', () => {
        const result = detectEmbedUrl('https://giphy.com/gifs/eyes-shocked-bird-feqkVgjJpYtjy');
        expect(result).toEqual({ name: 'Giphy' });
    });

    it('detects Asciinema URLs', () => {
        const result = detectEmbedUrl('https://asciinema.org/a/123abc');
        expect(result).toEqual({ name: 'Asciinema' });
    });

    it('detects Yr.no location links carrying a location id', () => {
        // Shapes copied from yr.no itself: a Norwegian forecast page, an English
        // one, a US location, Nynorsk and Sami spellings, yr.no's own widget URL,
        // and the same link without `www.`.
        for (const url of [
            'https://www.yr.no/nb/varsel/daglig-tabell/1-72837/Norge/Oslo/Oslo',
            'https://www.yr.no/en/forecast/daily-table/1-2144/Norway/Trondheim',
            'https://www.yr.no/nn/innhald/1-72837/meteogram.svg',
            'https://www.yr.no/sme/sisdoallu/1-72837/meteogram.svg',
            'https://www.yr.no/nb/innhold/1-72837/meteogram.svg?mode=light',
            'https://yr.no/nb/varsel/1-72837/Norge/Oslo',
        ]) {
            expect(detectEmbedUrl(url), `${url} names no embed`).toEqual({ name: 'Meteogram' });
        }
    });

    it('leaves a Yr.no link that names no location as a plain link', () => {
        // yr.no answers a location id that does not exist with HTTP 503 and its
        // outage page rather than 404, so a button offered for a URL with no id
        // is a broken image offered in advance. The retired `place/` form — the
        // one this entry used to match, and the one the app still builds a
        // weathericon URL from — is here because it must now name nothing.
        for (const url of [
            'https://www.yr.no/nb/',
            'https://www.yr.no/sok/oslo',
            'https://www.yr.no/place/Norway/Oslo/Oslo/',
            'https://www.yr.no/nb/nyheter/2024-05-17/saken',
            'https://www.yr.no/nb/innhold/9-99999999999/meteogram.svg',
        ]) {
            expect(detectEmbedUrl(url), `${url} should not name an embed`).toBeNull();
        }
    });

    it('detects GitHub Gist URLs', () => {
        const result = detectEmbedUrl('https://gist.github.com/user/abc123def456');
        expect(result).toEqual({ name: 'GitHub Gist' });
    });

    it('detects Pastebin URLs', () => {
        const result = detectEmbedUrl('https://pastebin.com/abc123');
        expect(result).toEqual({ name: 'Pastebin' });
    });

    it('detects TikTok URLs', () => {
        const result = detectEmbedUrl('https://www.tiktok.com/@user/video/1234567890123456789');
        expect(result).toEqual({ name: 'TikTok' });
    });

    it('detects TikTok short URLs', () => {
        const result = detectEmbedUrl('https://vm.tiktok.com/abcdefg/');
        expect(result).toEqual({ name: 'TikTok' });
    });

    it('detects AlloCine URLs', () => {
        const result = detectEmbedUrl('https://www.allocine.fr/videokast/video-12345');
        expect(result).toEqual({ name: 'AlloCine video' });
    });

    it('returns null for plain URLs', () => {
        const result = detectEmbedUrl('https://example.com/page');
        expect(result).toBeNull();
    });

    it('returns null for image URLs (handled by extension check)', () => {
        const result = detectEmbedUrl('https://example.com/image.jpg');
        expect(result).toBeNull();
    });

    it('returns null for non-URL text', () => {
        const result = detectEmbedUrl('just some text');
        expect(result).toBeNull();
    });
});
