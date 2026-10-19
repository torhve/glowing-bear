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
         * Broken, and kept broken until someone decides what it should be.
         *
         * The pattern matches yr.no's place URLs, which are place-name paths
         * (`/place/Norway/Oslo/Oslo/`) and carry no coordinates, so the two path
         * segments read here as `lat` and `lon` are the words "Oslo" and "Oslo".
         * The `weathericon/2.0/legacymeteogram` product answers HTTP 404 with
         * "The specified product does not exist" today, and yr.no's own
         * `meteogram.png` is gone too. The result is a broken image behind a
         * button that says "Show Meteogram".
         */
        name: 'Meteogram',
        test: (url) => /yr\.no\/place\/[^/]+\/[^/]+\/[^/]+\/#/.test(url),
        render: (url) => {
            const parts = url.split('/');
            if (parts.length < 7) return null;
            return {
                kind: 'img',
                src: `https://api.met.no/weatherapi/weathericon/2.0/legacymeteogram?lat=${parts[5]}&lon=${parts[6]}`,
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
