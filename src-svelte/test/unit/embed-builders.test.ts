/**
 * What each embeddable URL becomes, end to end.
 *
 * One table decides what a URL is called and what it becomes. `lib/utils/urlEmbeds.ts`
 * holds the matchers: `BufferLineRow` takes the name for the "Show …" label from the
 * matching entry and `PluginEmbed` builds the element out of that same entry. They used
 * to be two copies of sixteen regular expressions that could drift apart, which is what
 * `70663db6` removed. Standing in front of the table is `classifyMediaUrl`, which claims
 * any URL whose path ends in a media extension, so a link that is already a file — a
 * pasted `meteogram.svg`, say — reaches the page unchanged and never consults the table.
 *
 * This pins both halves for one corpus: what the table calls the URL, and what
 * the frame that reaches the page points at, how big it is, and what it is
 * allowed to do — the parts a merge can silently change. `sandbox` and `allow`
 * are not among them: jsdom implements neither on `HTMLIFrameElement`, so the
 * difference between the gist and asciinema frames, which run `document.write()`
 * scripts and are isolated without `allow-same-origin` while every other frame
 * keeps it, is only visible in a browser.
 *
 * One row records behaviour that is wrong on purpose, so a later change is
 * measured against something:
 *
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
    // AlloCine has no entry, and these three rows keep the reason alive: the page this table used
    // to match is gone (410), the frame URL it used to build answers a 404 page *inside the
    // frame*, the live /video/video-<id>/ section is the whole ad-supported site rather than a
    // player, and its real player page needs two ids no pasted link carries while a cross-origin
    // fetch of an AlloCine page is refused. The third row is the URL the legacy AngularJS plugin
    // still builds (`_video/iblogvision.aspx?cmedia=<id>`): status 200, and nothing in it that
    // plays — a 200 is not proof of an embed. The byte-level probe behind all of this lives in
    // the campaign's working notes (N24); these rows assert our table's behaviour, not
    // allocine.fr's current answer.
    { url: 'https://www.allocine.fr/videokast/video-28123456', name: null, built: 'nothing' },
    { url: 'https://www.allocine.fr/video/video-19557975/', name: null, built: 'nothing' },
    { url: 'https://www.allocine.fr/_video/iblogvision.aspx?cmedia=20615027', name: null, built: 'nothing' },
    { url: 'https://asciinema.org/a/357111', name: 'Asciinema', built: `iframe src=null srcdoc="<script src=\\"https://asciinema.org/a/357111.js\\"></script>" size=100%x300px border="0" fullscreen=null` },

    // Yr.no: the location id from the URL plus the localized content segment,
    // which is what yr.no documents and serves. Measured against yr.no itself —
    // 200 `image/svg+xml` for `/nb/innhold/1-72837/`, `/en/content/1-72837/`,
    // `/nn/innhald/1-72837/` and `/sme/sisdoallu/1-72837/` on `meteogram.svg`,
    // 404 for `/nn/innhold/`, `/en/innhold/` and a language-less `/content/`,
    // and 404 for the `place/Norway/Oslo/Oslo/` path this entry used to match and
    // used to read place names out of as `lat` and `lon`.
    { url: 'https://www.yr.no/nb/varsel/daglig-tabell/1-72837/Norge/Oslo/Oslo', name: 'Meteogram', built: 'img src="https://www.yr.no/nb/innhold/1-72837/meteogram.svg?mode=light"' },
    { url: 'https://www.yr.no/en/forecast/daily-table/1-2144/Norway/Trondheim', name: 'Meteogram', built: 'img src="https://www.yr.no/en/content/1-2144/meteogram.svg?mode=light"' },
    // A URL that is already a widget SVG never reaches this entry: `classifyMediaUrl`
    // claims any URL whose path ends in an image extension before the table is
    // consulted, so it arrives as the image it already is, palette included. The
    // table still names it, and that name is the label on the button above it.
    { url: 'https://www.yr.no/nn/innhald/11-3154/meteogram.svg', name: 'Meteogram', built: 'img src="https://www.yr.no/nn/innhald/11-3154/meteogram.svg"' },
    { url: 'https://www.yr.no/nb/innhold/1-72837/meteogram.svg?mode=dark', name: 'Meteogram', built: 'img src="https://www.yr.no/nb/innhold/1-72837/meteogram.svg?mode=dark"' },
    // The retired form: named nothing, built nothing, because it names no location.
    { url: 'https://www.yr.no/place/Norway/Oslo/Oslo/#', name: null, built: 'nothing' },

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
