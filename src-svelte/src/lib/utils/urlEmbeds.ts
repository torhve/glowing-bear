/**
 * What a URL is embeddable as, and what it becomes.
 *
 * Two callers ask about the same URL. `BufferLineRow` asks for the name, which is
 * the label on the "Show …" button and the reason the line offers an embed at all.
 * `PluginEmbed` asks for the element. Both answers come from this table, in this
 * order, so the label a user reads and the embed they get cannot disagree — they
 * used to be two lists of the same patterns, kept in step by hand.
 */

export interface EmbedMatch {
    name: string;
}

/**
 * The element the embed area should hold.
 *
 * Only the embed's identity is described here. How the element is assembled —
 * its class, its border, which permissions it is given — stays with the component
 * that builds it, because that is presentation, not what the embed is.
 */
export interface EmbedRender {
    kind: 'iframe' | 'img';
    /**
     * Which frame shape this is:
     *   - `player`: a cross-origin video or audio player. Sandboxed, but allowed
     *     to keep its own origin because players such as YouTube and Twitch read
     *     their own cookies and never initialize without it.
     *   - `script`: an embed whose script calls `document.write()`, so it gets a
     *     document of its own and no same-origin.
     *   - `plain`: a frame the provider expects to own outright.
     */
    frame?: 'player' | 'script' | 'plain';
    src?: string;
    /** Set instead of `src` for the `script` frames. */
    srcdoc?: string;
    width?: string;
    height?: string;
    alt?: string;
}

type UrlMatcher = {
    name: string;
    test: (url: string) => boolean;
    /** null when the URL is named but this path has nothing to show for it. */
    render: (url: string) => EmbedRender | null;
};

// YouTube video id: watch?v= (with any parameters before v=), embed/, v/, shorts/, live/,
// youtube-nocookie.com and youtu.be. The same pattern names the URL and picks the
// id out of it, so every shape the name claims reaches the player.
const youtubeVideoPattern = /(?<![\w-])(?:youtube(?:-nocookie)?\.com\/(?:(?:embed|v|shorts|live)\/|watch\b[^/#\s]*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/i;

/** A cross-origin player at its default size. */
function player(src: string, width = '100%', height = '315px'): EmbedRender {
    return { kind: 'iframe', frame: 'player', src, width, height };
}

/**
 * Gist and Asciinema ship embed scripts that call `document.write()`, which does
 * nothing when the script is loaded into this document. A `srcdoc` frame gives the
 * script a document of its own where the call works.
 */
function scriptFrame(scriptSrc: string): EmbedRender {
    return {
        kind: 'iframe',
        frame: 'script',
        srcdoc: `<script src="${scriptSrc}"></script>`,
        width: '100%',
        height: '300px',
    };
}

/** Twitch's player wants to know which page is embedding it. */
function parentHost(): string {
    return window.location.hostname;
}

/**
 * A yr.no link in one of the four languages the site serves, carrying a location id.
 *
 * The id shape is deliberately narrow — one or two digits, a hyphen, four to
 * eight — because the loose form `\d+-\d+` also matches the `2024-05` inside a
 * dated path, and this entry would then invent a widget URL for a page that
 * names no location. The shapes it has to accept are real ones taken from yr.no
 * URLs: `1-72837` (Oslo), `2-3196359` (United States), `11-3154`, `1-96814`.
 * A link with no id is not a location and is left as a plain link: yr.no
 * answers an id that does not exist with HTTP 503 and its outage page, not 404,
 * so there is nothing downstream that could tell a bad id from an outage.
 */
const yrLocationUrl = /^https?:\/\/(?:www\.)?yr\.no\/(en|nb|nn|sme)\/[^\s"']*\b(\d{1,2}-\d{4,8})\b/i;

/**
 * The segment yr.no puts between the language and the location id in its own
 * widget URLs. It is localized, not fixed: `/nn/innhold/` and `/en/innhold/`
 * answer 404 while `/nn/innhald/` and `/en/content/` answer 200, so a single
 * spelling would work in exactly one language.
 */
const yrContentSegments: Record<string, string> = {
    en: 'content',
    nb: 'innhold',
    nn: 'innhald',
    sme: 'sisdoallu',
};

const embedMatchers: UrlMatcher[] = [
    {
        name: 'YouTube video',
        test: (url) => youtubeVideoPattern.test(url),
        render: (url) => {
            const id = url.match(youtubeVideoPattern)?.[1];
            return id ? player(`https://www.youtube.com/embed/${id}`) : null;
        },
    },
    {
        name: 'Twitch clip',
        test: (url) => /clips\.twitch\.tv\/(\w+)/.test(url),
        render: (url) => {
            const m = url.match(/clips\.twitch\.tv\/(\w+)/);
            return m ? player(`https://clips.twitch.tv/embed?clip=${m[1]}&parent=${parentHost()}`, '640px', '277px') : null;
        },
    },
    {
        name: 'Twitch video',
        test: (url) => /twitch\.tv\/videos\/(\d+)/.test(url),
        render: (url) => {
            const m = url.match(/twitch\.tv\/videos\/(\d+)/);
            return m ? player(`https://player.twitch.tv/?video=${m[1]}&parent=${parentHost()}`) : null;
        },
    },
    {
        name: 'Twitch channel',
        test: (url) => /twitch\.tv\/([a-zA-Z0-9_]+)/.test(url) && !/clips\.twitch\.tv/.test(url),
        render: (url) => {
            const m = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
            return m ? player(`https://player.twitch.tv/?channel=${m[1]}&parent=${parentHost()}`) : null;
        },
    },
    {
        name: 'Dailymotion video',
        test: (url) => /dailymotion\.com\/video\/([a-zA-Z0-9]+)|dai\.ly\/([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)|dai\.ly\/([a-zA-Z0-9]+)/);
            const id = m?.[1] ?? m?.[2];
            return id ? player(`https://www.dailymotion.com/embed/video/${id}`) : null;
        },
    },
    {
        name: 'Streamable video',
        test: (url) => /streamable\.com\/([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/streamable\.com\/([a-zA-Z0-9]+)/);
            return m ? player(`https://streamable.com/o/${m[1]}`, '100%', '100%') : null;
        },
    },
    {
        name: 'Spotify music',
        test: (url) => /open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
            return m ? player(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, '100%', '380px') : null;
        },
    },
    {
        name: 'SoundCloud',
        test: (url) => /soundcloud\.com\/([^?]+)/.test(url),
        // The player takes the track URL itself rather than an id.
        render: (url) => player(
            `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`,
            '100%',
            '166px',
        ),
    },
    {
        name: 'MixCloud',
        test: (url) => /mixcloud\.com\/([^?]+)/.test(url),
        render: (url) => player(`https://www.mixcloud.com/widgets/player/?url=${encodeURIComponent(url)}&light=1`, '100%', '100%'),
    },
    {
        name: 'Google Maps',
        test: (url) => /(?:maps\.google\.)|(?:google\..*\/maps)/.test(url),
        render: (url) => player(`https://www.google.com/maps?q=${encodeURIComponent(url)}&output=embed`, '100%', '250px'),
    },
    {
        // The id only matches behind a hyphen, so a bare /gifs/ is not embeddable.
        name: 'Giphy',
        test: (url) => /giphy\.com\/gifs\/[^/]*-([a-zA-Z0-9]+)?/.test(url),
        render: (url) => {
            const m = url.match(/giphy\.com\/gifs\/[^/]*-([a-zA-Z0-9]+)?/);
            return m ? player(`https://giphy.com/embed/${m[1]}`, '100%', '100%') : null;
        },
    },
    {
        /**
         * yr.no's own forecast chart, built from the location id in the URL.
         *
         * This entry used to match `yr.no/place/<country>/<region>/<city>/#` and
         * build `api.met.no/weathericon/2.0/legacymeteogram?lat=…&lon=…` out of
         * path segments that carry place names, never coordinates: the two values
         * read as `lat` and `lon` were the words "Oslo" and "Oslo". Measured
         * today, every piece of it is gone. `yr.no/place/Norway/Oslo/Oslo/`
         * answers 404, `weathericon/2.0/legacymeteogram` answers 404 with "The
         * specified product does not exist", and yr.no's retired embed API is
         * gone as well — `api/v0/locations/1-72837/forecast.svg` 404, and its
         * geocoding query `api/v0/locations/query?q=Trondheim` 410 Gone. The
         * button said "Show Meteogram" and always produced a broken image.
         *
         * What yr.no sanctions and serves now is a location id taken from a
         * location URL, plus a localized content segment
         * (https://developer.yr.no/doc/guides/available-widgets/). Measured:
         *
         *   /nb/innhold/1-72837/meteogram.svg               200 image/svg+xml
         *   /en/content/1-72837/meteogram.svg               200
         *   /nn/innhald/1-72837/meteogram.svg               200
         *   /sme/sisdoallu/1-72837/meteogram.svg            200
         *   /nn/innhold/…, /en/innhold/…, /content/…        404
         *   /en/forecast/daily-table/1-72837/Norway/Oslo    200 — where the id is copied from
         *   /nb/innhold/9-9999999/meteogram.svg             503 "Tekniske problemer"
         *   /place/Norway/Oslo/Oslo/                        404
         *
         * Rendered as an image rather than the iframe yr.no's own docs show. The
         * SVG declares `width="782" height="391"` and carries the chart's fonts
         * and sizes in its own `<style>` block; the external
         * `static.nrk.no/nrk-sans` stylesheet contributes one `@font-face`, and
         * the inline `text { font-family: … }` rule already lists system
         * fallbacks. Measured in Chromium: as an `<img>` it loads complete at
         * 782x391 with 5470 distinct colours painted — header, day labels, hour
         * labels, legend and both axes present, clouds and curves drawn. In an
         * iframe the same document paints at 786x395, chart plus frame chrome and
         * a scrollbar, for a font nobody would notice. An image asks the browser
         * for no permissions at all; a frame of someone else's document does.
         *
         * `?mode=dark` is measured (mean luminance 26 against 239, 94% of pixels
         * dark) and is not used here: this table maps a URL to an element and has
         * no theme input, and the seam for that would be a palette argument on
         * `buildEmbed` that the fifteen other entries would carry unused. A URL
         * that is already a `meteogram.svg` never reaches this entry anyway —
         * `classifyMediaUrl` claims any URL ending in an image extension before
         * the table is consulted, so a chart pasted with `?mode=dark` on it
         * reaches the page as the image it asked for.
         */
        name: 'Meteogram',
        test: (url) => yrLocationUrl.test(url),
        render: (url) => {
            const match = yrLocationUrl.exec(url);
            const lang = match?.[1]?.toLowerCase();
            const locationId = match?.[2];
            const segment = lang ? yrContentSegments[lang] : undefined;
            if (!lang || !locationId || !segment) return null;
            return {
                kind: 'img',
                src: `https://www.yr.no/${lang}/${segment}/${locationId}/meteogram.svg?mode=light`,
                alt: 'Weather meteogram',
            };
        },
    },
    {
        name: 'GitHub Gist',
        test: (url) => /gist\.github\.com\/([^/]+)\/([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/gist\.github\.com\/([^/]+)\/([a-zA-Z0-9]+)/);
            return m ? scriptFrame(`https://gist.github.com/${m[1]}/${m[2]}.js`) : null;
        },
    },
    {
        /**
         * The one frame with no sandbox at all. Pastebin's own embed page is
         * written to be framed directly, and this is what upstream Glowing Bear
         * has always asked for; every other frame here is sandboxed.
         */
        name: 'Pastebin',
        test: (url) => /pastebin\.com\/([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/pastebin\.com\/([a-zA-Z0-9]+)/);
            return m ? { kind: 'iframe', frame: 'plain', src: `https://pastebin.com/embed/${m[1]}`, width: '100%', height: '350' } : null;
        },
    },
    {
        name: 'AlloCine video',
        test: (url) => /allocine\.fr\/videokast\/video-([a-zA-Z0-9]+)/.test(url),
        render: (url) => {
            const m = url.match(/allocine\.fr\/videokast\/video-([a-zA-Z0-9]+)/);
            return m ? player(`https://www.allocine.fr/_iframe/videokast/?video=${m[1]}&result=media`, '100%', '100%') : null;
        },
    },
    {
        name: 'Asciinema',
        test: (url) => /asciinema\.org\/a\/([0-9a-z]+)/.test(url),
        render: (url) => {
            const m = url.match(/asciinema\.org\/a\/([0-9a-z]+)/);
            return m ? scriptFrame(`https://asciinema.org/a/${m[1]}.js`) : null;
        },
    },
    {
        // TikTok: match both long form (tiktok.com/@user/video/...) and short URLs (vm.tiktok.com/...)
        // Named here so the button says "TikTok", but built by a callback the row
        // hands to the embed area instead of a URL, so there is nothing to build here.
        name: 'TikTok',
        test: (url) => /(?:tiktok\.com\/@[^/]+\/video\/[^/]+|vm\.tiktok\.com\/\w+)/.test(url),
        render: () => null,
    },
];

/** The first table entry that claims this URL. */
function matchEmbed(url: string): UrlMatcher | null {
    for (const matcher of embedMatchers) {
        if (matcher.test(url)) return matcher;
    }
    return null;
}

export function detectEmbedUrl(url: string): EmbedMatch | null {
    const matcher = matchEmbed(url);
    return matcher ? { name: matcher.name } : null;
}

/**
 * The element for a URL, or null when no entry can show it. A URL can be named
 * and still have no element here — TikTok is injected by callback — and an entry
 * can match and still decline, which is how a Giphy link without an id is left
 * as a plain link.
 */
export function buildEmbed(url: string): EmbedRender | null {
    return matchEmbed(url)?.render(url) ?? null;
}
