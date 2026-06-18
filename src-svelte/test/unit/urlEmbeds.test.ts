import { describe, it, expect } from 'vitest';
import { detectEmbedUrl } from '$lib/utils/urlEmbeds';

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

    it('detects Yr.no meteogram URLs', () => {
        const result = detectEmbedUrl('https://www.yr.no/place/Norway/Oslo/Oslo/#');
        expect(result).toEqual({ name: 'Meteogram' });
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
