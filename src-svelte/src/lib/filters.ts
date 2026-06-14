// Filter functions for Glowing Bear
// Ported from AngularJS filters.js

/**
 * Sanitize HTML content to prevent XSS using DOMPurify.
 *
 * Default mode forbids dangerous tags: script, iframe, object, embed, form, input, img.
 * This prevents execution of malicious scripts and loading of external resources.
 * The `img` tag is explicitly forbidden to block image-based XSS vectors.
 *
 * Use `allowEmbeds: true` only for trusted plugin embed content (YouTube, Spotify, etc.)
 * which legitimately requires iframes and scripts.
 *
 * Note: For message content and topics, prefer tokenizeLinks() + Svelte's native
 * text escaping instead of {@html} + sanitizeHtml(). Tokenization eliminates
 * the XSS surface area entirely by never using {@html}.
 */
export function sanitizeHtml(html: string, opts: { allowEmbeds?: boolean } = {}): string {
    if (!html) return '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOMPurify injected as global by Vite
    const DOMPurify = (globalThis as any).DOMPurify;
    if (!DOMPurify) return html;
    if (opts.allowEmbeds) {
        return DOMPurify.sanitize(html, {
            ADD_ATTR: ['target', 'allow', 'frameborder', 'allowfullscreen', 'scrolling'],
            ADD_TAGS: ['script', 'iframe'],
            FORBID_TAGS: ['style', 'form', 'textarea'],
            FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
        });
    }
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['span', 'a', 'code', 'b', 'i', 'u', 's', 'strike', 'br', 'div'],
        ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'style', 'dir'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'img'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'onkeypress'],
    });
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string | undefined): string {
    if (!text) return '';
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m] ?? m);
}

/**
 * Wrap text in backticks for inline code formatting.
 */
export function codify(text: string | undefined): string {
    if (text === undefined || text === null) return '';
    return `\`${text}\``;
}

/**
 * Convert hex color codes (#RRGGBB) to span with style attribute.
 */
export function inlinecolour(text: string | undefined): string {
    if (!text) return '';
    return text.replace(/#([0-9A-Fa-f]{6})/g, '<span style="color: #$1">#$1</span>');
}

/**
 * Truncate long strings with ellipsis, preserving the first N characters.
 */
export function prefixlimit(text: string | undefined, limit: number = 50): string {
    if (!text) return '';
    if (text.length <= limit) return text;
    return text.substring(0, limit) + '...';
}


