/**
 * Characterization tests for B9: image-URL normalization exists on one embed path
 * and not the other.
 *
 *   BufferLineRow.svelte:116   content = normalizeImageUrl(url)
 *   PluginEmbed.svelte:142     processUrlContent(url) -> injectImage(url)
 *
 * `normalizeImageUrl` (mediaExtensions.ts:12) rewrites two things a chat line
 * needs rewritten to display at all: a Dropbox shared link gains `dl=1` so it
 * returns the file instead of Dropbox's own page, and an `http://` Imgur link
 * becomes `https://` because Imgur will not serve an image over plain HTTP.
 *
 * PluginEmbed imports the same extension tables that decide an URL is an image,
 * but never calls the normalizer. So the same Dropbox or Imgur URL arriving
 * through the plugin-metadata path is handed to the browser unchanged.
 *
 * These pin which path normalizes today. The fix (stage S6) is to normalize once
 * in the shared classifier; until then this is the difference a reviewer has to
 * be able to see.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PluginEmbed from '#components/PluginEmbed.svelte';
import { normalizeImageUrl } from '#lib/utils/mediaExtensions.ts';
import type { PluginMetadata } from '#lib/types.ts';

const components: Record<string, unknown>[] = [];

function render(plugin: PluginMetadata) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(PluginEmbed, { target, props: { plugin } }));
    flushSync();
    return target;
}

function embedImageSrc(target: HTMLElement): string | null {
    const img = target.querySelector<HTMLImageElement>('[data-testid="plugin-embed"] img');
    return img ? img.getAttribute('src') : null;
}

/** A plugin metadata block carrying a plain image URL, already revealed. */
function imagePlugin(url: string): PluginMetadata {
    return { content: url, nsfw: false, name: 'image', className: '', visible: true };
}

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

describe('B9 characterization: normalizeImageUrl runs on one embed path only', () => {
    it('what the normalizer does, on its own', () => {
        // A Dropbox link with no query string gets `?&dl=1`: the function builds
        // the URL as `pathname + '?'` and then joins a parameter list that started
        // as ['']. Browsers accept it, so nothing user-visible depends on it — but
        // it is what the function returns, and the shared classifier in stage S6
        // will inherit it unless someone decides to clean it up.
        expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.png'))
            .toBe('https://www.dropbox.com/s/abc123/photo.png?&dl=1');
        expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.png?raw=1'))
            .toBe('https://www.dropbox.com/s/abc123/photo.png?raw=1&dl=1');
        expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.png?dl=0'))
            .toBe('https://www.dropbox.com/s/abc123/photo.png?dl=1');
        expect(normalizeImageUrl('http://i.imgur.com/photo.png'))
            .toBe('https://i.imgur.com/photo.png');
        expect(normalizeImageUrl('https://example.com/photo.png'))
            .toBe('https://example.com/photo.png');
    });

    it('the plugin path renders an Imgur image over plain http', () => {
        const url = 'http://i.imgur.com/photo.png';
        const target = render(imagePlugin(url));

        expect(embedImageSrc(target), 'PluginEmbed injects the URL exactly as it arrived')
            .toBe(url);
        // The other path would not have rendered this at all in a browser that
        // blocks mixed content.
        expect(normalizeImageUrl(url)).toBe('https://i.imgur.com/photo.png');
    });

    it('the plugin path renders a Dropbox shared link without dl=1', () => {
        const url = 'https://www.dropbox.com/s/abc123/photo.png';
        const target = render(imagePlugin(url));

        expect(embedImageSrc(target)).toBe(url);
        expect(normalizeImageUrl(url)).toBe('https://www.dropbox.com/s/abc123/photo.png?&dl=1');
    });

    it('the plugin path does classify the URL as an image, so the omission is not a missed branch', () => {
        // Same extension table BufferLineRow uses (mediaExtensions.ts:4) decided
        // this was an image and an <img> was injected. The normalizer was simply
        // never called on the way there.
        const target = render(imagePlugin('https://www.dropbox.com/s/abc123/photo.png'));
        expect(embedImageSrc(target), 'an image was injected').not.toBeNull();
    });
});
