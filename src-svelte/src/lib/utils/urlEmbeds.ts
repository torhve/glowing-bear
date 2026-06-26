export interface EmbedMatch {
    name: string;
}

type UrlMatcher = {
    name: string;
    test: (url: string) => boolean;
};

const embedMatchers: UrlMatcher[] = [
    { name: 'YouTube video', test: (url) => /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(url) },
    { name: 'Twitch clip', test: (url) => /clips\.twitch\.tv\/(\w+)/.test(url) },
    { name: 'Twitch video', test: (url) => /twitch\.tv\/videos\/(\d+)/.test(url) },
    { name: 'Twitch channel', test: (url) => /twitch\.tv\/([a-zA-Z0-9_]+)/.test(url) && !/clips\.twitch\.tv/.test(url) },
    { name: 'Dailymotion video', test: (url) => /dailymotion\.com\/video\/([a-zA-Z0-9]+)|dai\.ly\/([a-zA-Z0-9]+)/.test(url) },
    { name: 'Streamable video', test: (url) => /streamable\.com\/([a-zA-Z0-9]+)/.test(url) },
    { name: 'Spotify music', test: (url) => /open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/.test(url) },
    { name: 'SoundCloud', test: (url) => /soundcloud\.com\/([^?]+)/.test(url) },
    { name: 'MixCloud', test: (url) => /mixcloud\.com\/([^?]+)/.test(url) },
    { name: 'Google Maps', test: (url) => /(?:maps\.google\.)|(?:google\..*\/maps)/.test(url) },
    { name: 'Giphy', test: (url) => /giphy\.com\/gifs\/[^/]*-([a-zA-Z0-9]+)?/.test(url) },
    { name: 'Meteogram', test: (url) => /yr\.no\/place\/[^/]+\/[^/]+\/[^/]+\/#/.test(url) },
    { name: 'GitHub Gist', test: (url) => /gist\.github\.com\/([^/]+)\/([a-zA-Z0-9]+)/.test(url) },
    { name: 'Pastebin', test: (url) => /pastebin\.com\/([a-zA-Z0-9]+)/.test(url) },
    { name: 'AlloCine video', test: (url) => /allocine\.fr\/videokast\/video-([a-zA-Z0-9]+)/.test(url) },
    { name: 'Asciinema', test: (url) => /asciinema\.org\/a\/([0-9a-z]+)/.test(url) },
    // TikTok: match both long form (tiktok.com/@user/video/...) and short URLs (vm.tiktok.com/...)
    { name: 'TikTok', test: (url) => /(?:tiktok\.com\/@[^/]+\/video\/[^/]+|vm\.tiktok\.com\/\w+)/.test(url) },
];

export function detectEmbedUrl(url: string): EmbedMatch | null {
    for (const matcher of embedMatchers) {
        if (matcher.test(url)) {
            return { name: matcher.name };
        }
    }
    return null;
}
