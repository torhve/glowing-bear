/**
 * What each embeddable URL becomes, end to end.
 *
 * Two places decide what an embed is. `lib/utils/urlEmbeds.ts` holds a matcher
 * table that `BufferLineRow` uses to decide a URL is embeddable and to name it —
 * that name is the label on the "Show …" button. `PluginEmbed` then re-matches
 * the same URL with its own copy of every pattern to build the thing that gets
 * injected. The label and the embed come from two lists of the same 16 regular
 * expressions, and nothing asserted they agreed.
 *
 * This pins both halves for one corpus: what the table calls the URL, and what
 * the frame that reaches the page points at, how big it is, and what it is
 * allowed to do — the parts a merge can silently change. `sandbox` and `allow`
 * are not among them: jsdom implements neither on `HTMLIFrameElement`, so the
 * difference between the gist and asciinema frames, which run `document.write()`
 * scripts and are isolated without `allow-same-origin` while every other frame
 * keeps it, is only visible in a browser.
 *
 * Two rows record behaviour that is wrong on purpose, so a later change is
 * measured against something:
 *
 *   - `https://www.yr.no/place/Norway/Oslo/Oslo/#` is named "Meteogram" and
 *     builds an image whose `lat`/`lon` are the place names from the URL path.
 *     yr.no `place/` URLs carry place names, never coordinates, and the
 *     `weathericon/2.0/legacymeteogram` product answers HTTP 404 today.
 *   - A TikTok URL is named by the table but builds nothing here, because
 *     `BufferLineRow` hands TikTok a callback rather than a URL string and this
 *     path only ever receives strings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import PluginEmbed from '#components/PluginEmbed.svelte';
import { detectEmbedUrl } from '#lib/utils/urlEmbeds.ts';
import type { PluginMetadata } from '#lib/types.ts';

const owners: unknown[] = [];

function render(props: Record<string, unknown>) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    owners.push(mount(PluginEmbed as Component<Record<string, unknown>>, { target, props }));
    flushSync();
    return target;
}

afterEach(async () => {
    for (const owner of owners.splice(0)) await unmount(owner as never);
    document.body.replaceChildren();
});

/** The frame's whole contract: where it points, what it may do, how big it is. */
function injected(target: HTMLElement): string {
    const frame = target.querySelector('iframe');
    if (frame) {
        return `iframe src=${JSON.stringify(frame.getAttribute('src'))}`
            + ` srcdoc=${JSON.stringify(frame.getAttribute('srcdoc'))}`
            + ` size=${frame.getAttribute('width')}x${frame.getAttribute('height')}`
            + ` border=${JSON.stringify(frame.getAttribute('frameborder'))}`
            + ` fullscreen=${JSON.stringify(frame.getAttribute('allowfullscreen'))}`;
    }
    const img = target.querySelector('img');
    if (img) return `img src=${JSON.stringify(img.getAttribute('src'))}`;
    const video = target.querySelector('video source');
    if (video) return `video src=${JSON.stringify(video.getAttribute('src'))}`;
    const audio = target.querySelector('audio source');
    if (audio) return `audio src=${JSON.stringify(audio.getAttribute('src'))}`;
    return 'nothing';
}

interface Row {
    url: string;
    /** What the table calls it, which is what the button says. */
    name: string | null;
    /** What reaches the page. */
    built: string;
}

const ROWS: Row[] = [
    // YouTube: every shape the pattern claims has to reach the same player.
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://youtu.be/dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://www.youtube.com/live/dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://m.youtube.com/watch?list=PL&v=dQw4w9WgXcQ', name: 'YouTube video', built: `iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" srcdoc=null size=100%x315px border="0" fullscreen=""` },

    // The three Twitch shapes are distinguished by the URL, in order.
    { url: 'https://clips.twitch.tv/FaintPeopleGlorifyPepe', name: 'Twitch clip', built: `iframe src="https://clips.twitch.tv/embed?clip=FaintPeopleGlorifyPepe&parent=localhost" srcdoc=null size=640pxx277px border="0" fullscreen=""` },
    { url: 'https://www.twitch.tv/videos/123456789', name: 'Twitch video', built: `iframe src="https://player.twitch.tv/?video=123456789&parent=localhost" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://www.twitch.tv/somechannel', name: 'Twitch channel', built: `iframe src="https://player.twitch.tv/?channel=somechannel&parent=localhost" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://clips.twitch.tv/', name: null, built: 'nothing' },

    { url: 'https://www.dailymotion.com/video/x8abcde', name: 'Dailymotion video', built: `iframe src="https://www.dailymotion.com/embed/video/x8abcde" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://dai.ly/x8abcde', name: 'Dailymotion video', built: `iframe src="https://www.dailymotion.com/embed/video/x8abcde" srcdoc=null size=100%x315px border="0" fullscreen=""` },
    { url: 'https://streamable.com/ab12z', name: 'Streamable video', built: `iframe src="https://streamable.com/o/ab12z" srcdoc=null size=100%x100% border="0" fullscreen=""` },
    { url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', name: 'Spotify music', built: `iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT" srcdoc=null size=100%x380px border="0" fullscreen=""` },
    { url: 'https://open.spotify.com/album/1f57w4WXkPdYHc1T51IGuH', name: 'Spotify music', built: `iframe src="https://open.spotify.com/embed/album/1f57w4WXkPdYHc1T51IGuH" srcdoc=null size=100%x380px border="0" fullscreen=""` },
    { url: 'https://soundcloud.com/artist/track-name', name: 'SoundCloud', built: `iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack-name&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false" srcdoc=null size=100%x166px border="0" fullscreen=""` },
    { url: 'https://www.mixcloud.com/artist/mix-name/', name: 'MixCloud', built: `iframe src="https://www.mixcloud.com/widgets/player/?url=https%3A%2F%2Fwww.mixcloud.com%2Fartist%2Fmix-name%2F&light=1" srcdoc=null size=100%x100% border="0" fullscreen=""` },
    { url: 'https://maps.google.com/?q=Oslo', name: 'Google Maps', built: `iframe src="https://www.google.com/maps?q=https%3A%2F%2Fmaps.google.com%2F%3Fq%3DOslo&output=embed" srcdoc=null size=100%x250px border="0" fullscreen=""` },
    { url: 'https://www.google.com/maps/place/Oslo/@59.91,10.75', name: 'Google Maps', built: `iframe src="https://www.google.com/maps?q=https%3A%2F%2Fwww.google.com%2Fmaps%2Fplace%2FOslo%2F%4059.91%2C10.75&output=embed" srcdoc=null size=100%x250px border="0" fullscreen=""` },
    { url: 'https://giphy.com/gifs/something-funny-3o6Zt6l9F1lXlXlXl', name: 'Giphy', built: `iframe src="https://giphy.com/embed/3o6Zt6l9F1lXlXlXl" srcdoc=null size=100%x100% border="0" fullscreen=""` },
    // The Giphy pattern needs a hyphen before the id, so a bare /gifs/ is not embeddable at all.
    { url: 'https://giphy.com/gifs/', name: null, built: 'nothing' },

    { url: 'https://gist.github.com/torvid/1a2b3c4d5e6f', name: 'GitHub Gist', built: `iframe src=null srcdoc="<script src=\\"https://gist.github.com/torvid/1a2b3c4d5e6f.js\\"></script>" size=100%x300px border="0" fullscreen=null` },
    { url: 'https://pastebin.com/AbCdEfGh', name: 'Pastebin', built: `iframe src="https://pastebin.com/embed/AbCdEfGh" srcdoc=null size=100%x350 border="0" fullscreen=""` },
    { url: 'https://www.allocine.fr/videokast/video-28123456', name: 'AlloCine video', built: `iframe src="https://www.allocine.fr/_iframe/videokast/?video=28123456&result=media" srcdoc=null size=100%x100% border="0" fullscreen=""` },
    { url: 'https://asciinema.org/a/357111', name: 'Asciinema', built: `iframe src=null srcdoc="<script src=\\"https://asciinema.org/a/357111.js\\"></script>" size=100%x300px border="0" fullscreen=null` },

    // Named "Meteogram", built from place names as coordinates, against a product
    // that answers 404. Pinned as wrong, not as correct.
    { url: 'https://www.yr.no/place/Norway/Oslo/Oslo/#', name: 'Meteogram', built: 'img src="https://api.met.no/weatherapi/weathericon/2.0/legacymeteogram?lat=Oslo&lon=Oslo"' },
    { url: 'https://www.yr.no/place/Norway/Oslo/Oslo/', name: null, built: 'nothing' },

    // The table names TikTok; this path builds nothing, because the real caller
    // sends a callback for it rather than a URL string.
    { url: 'https://www.tiktok.com/@user/video/7123456789012345678', name: 'TikTok', built: 'nothing' },
    { url: 'https://vm.tiktok.com/ZM8abcdef/', name: 'TikTok', built: 'nothing' },

    // Media extensions are decided before the embed table, by both halves.
    { url: 'https://example.com/photo.png', name: null, built: 'img src="https://example.com/photo.png"' },
    { url: 'https://example.com/clip.mp4', name: null, built: 'video src="https://example.com/clip.mp4"' },
    { url: 'https://example.com/song.mp3', name: null, built: 'audio src="https://example.com/song.mp3"' },
    { url: 'https://example.com/some/page', name: null, built: 'nothing' },
];

describe('what each embeddable URL becomes', () => {
    for (const row of ROWS) {
        it(row.url, () => {
            expect(detectEmbedUrl(row.url)?.name ?? null, `table name for ${row.url}`).toBe(row.name);

            const target = render({
                plugin: {
                    name: row.name ?? 'Link',
                    className: '',
                    visible: true,
                    nsfw: false,
                    content: row.url,
                } satisfies PluginMetadata,
            });
            expect(injected(target), `built for ${row.url}`).toBe(row.built);
        });
    }
});
