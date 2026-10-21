// Media file extension tables. Nothing outside this file consults them: callers
// ask classifyMediaUrl, which is the single place a URL's kind is decided.

const imageExts = /\.(bmp|gif|ico|jpe?g|png|svg|svgz|tif|tiff|webp|avif)(\?[^#]*)?(#.*)?$/i;
const videoExts = /\.(3gp|avi|flv|gifv|mkv|mp4|ogv|webm|wmv)(\?[^#]*)?(#.*)?$/i;
const audioExts = /\.(flac|m4a|mid|MID|midi|mp3|oga|ogg|opus|spx|wav|wma)(\?[^#]*)?(#.*)?$/i;


export type MediaKind = 'image' | 'video' | 'audio';

/**
 * What a URL is by file extension, and what should be shown for it.
 *
 * BufferLineRow answered this with one if-chain and PluginEmbed with a second one
 * in the same order: the label on a "Show …" control and the element underneath it
 * were decided by two lookups that could drift apart with nothing to notice. Image
 * URLs are normalised here because both consumers needed the same two fixes — a
 * Dropbox share asking for the file rather than the page, and an Imgur link that is
 * not served over plain http. Video and audio pass through unchanged.
 */
export function classifyMediaUrl(url: string): { kind: MediaKind; name: string; content: string } | null {
    if (imageExts.test(url)) return { kind: 'image', name: 'Image', content: normalizeImageUrl(url) };
    if (videoExts.test(url)) return { kind: 'video', name: 'Video', content: url };
    if (audioExts.test(url)) return { kind: 'audio', name: 'Audio', content: url };
    return null;
}
/**
 * Normalize image URLs for embed display.
 * Handles Dropbox direct links and Imgur HTTP→HTTPS conversion.
 */
export function normalizeImageUrl(url: string): string {
    if (/^https:\/\/www\.dropbox\.com\/s\/[a-z0-9]+\//i.test(url)) {
        const dbox_url = document.createElement("a");
        dbox_url.href = url;
        const base_url = dbox_url.protocol + '//' + dbox_url.host + dbox_url.pathname + '?';
        // split('&') on an empty query yields [''], which used to join into
        // '?&dl=1'. Dropping empty entries keeps the first parameter from being
        // preceded by a stray separator.
        const dbox_params = (dbox_url.search || '').substring(1).split('&').filter(Boolean);
        let dl_added = false;
        for (let i = 0; i < dbox_params.length; i++) {
            const param = dbox_params[i];
            if (param?.split('=')[0] === "dl") {
                dbox_params[i] = "dl=1";
                dl_added = true;
            }
        }
        if (!dl_added) {
            dbox_params.push("dl=1");
        }
        return base_url + dbox_params.join('&');
    }
    if (/^http:\/\/(i\.)?imgur\.com\//i.test(url)) {
        return url.replace(/^http:/, "https:");
    }
    return url;
}
