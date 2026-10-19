/**
 * Image-URL normalization, and the embed path that still bypasses it.
 *
 *   BufferLineRow.svelte:116   content = normalizeImageUrl(url)
 *   PluginEmbed.svelte:142     processUrlContent(url) -> injectImage(url)
 *
 * `normalizeImageUrl` (mediaExtensions.ts:12) rewrites two things a chat line
 * needs rewritten to display at all: a Dropbox shared link gains `dl=1` so it
 * returns the file instead of Dropbox's own page, and an `http://` Imgur link
 * becomes `https://` because Imgur will not serve an image over plain HTTP.
 *
 * PluginEmbed imports the same extension tables that decide a URL is an image,
 * but never calls the normalizer, so the same Dropbox or Imgur URL arriving
 * through the plugin-metadata path is handed to the browser unchanged. That half
 * is still open, and the last three tests keep it visible rather than approving
 * it.
 *
 * The normalizer itself is covered directly here, including the Dropbox case
 * that used to emit a stray separator.
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

describe('image URL normalization', () => {
    it('what the normalizer does, on its own', () => {
        // A Dropbox link with no query string used to come out as `?&dl=1`: the
        // function builds the URL as `pathname + '?'` and joins a parameter list,
        // and splitting an empty query gives ['']. The empty entry is dropped now.
        // Nothing user-visible depended on the stray separator — browsers accept
        // it — but it is the kind of thing a second caller would have inherited.
        expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.png'))
            .toBe('https://www.dropbox.com/s/abc123/photo.png?dl=1');
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
        expect(normalizeImageUrl(url)).toBe('https://www.dropbox.com/s/abc123/photo.png?dl=1');
    });

    it('the plugin path does classify the URL as an image, so the omission is not a missed branch', () => {
        // Same extension table BufferLineRow uses (mediaExtensions.ts:4) decided
        // this was an image and an <img> was injected. The normalizer was simply
        // never called on the way there.
        const target = render(imagePlugin('https://www.dropbox.com/s/abc123/photo.png'));
        expect(embedImageSrc(target), 'an image was injected').not.toBeNull();
    });
});
