// Media file extension regexes for URL embed detection.
// Used by BufferLineRow and PluginEmbed to identify image/video/audio URLs.

export const imageExts = /\.(bmp|gif|ico|jpe?g|png|svg|svgz|tif|tiff|webp|avif)(\?[^#]*)?(#.*)?$/i;
export const videoExts = /\.(3gp|avi|flv|gifv|mkv|mp4|ogv|webm|wmv)(\?[^#]*)?(#.*)?$/i;
export const audioExts = /\.(flac|m4a|mid|MID|midi|mp3|oga|ogg|opus|spx|wav|wma)(\?[^#]*)?(#.*)?$/i;

/**
 * Normalize image URLs for embed display.
 * Handles Dropbox direct links and Imgur HTTP→HTTPS conversion.
 */
export function normalizeImageUrl(url: string): string {
    if (/^https:\/\/www\.dropbox\.com\/s\/[a-z0-9]+\//i.test(url)) {
        const dbox_url = document.createElement("a");
        dbox_url.href = url;
        const base_url = dbox_url.protocol + '//' + dbox_url.host + dbox_url.pathname + '?';
        const dbox_params = (dbox_url.search || '').substring(1).split('&');
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
