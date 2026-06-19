import DOMPurify from 'dompurify';

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
 * Wraps text in backticks (simplified codify filter).
 */
export function codify(text: string | undefined): string {
    if (text === undefined) return '';
    return '`' + text + '`';
}

/**
 * Converts hex color codes (#RRGGBB) to styled spans.
 */
export function inlinecolour(text: string | undefined): string {
    if (text === undefined) return '';
    return text.replace(/(#(?:[0-9a-fA-F]{6}))/g, '<span style="color: $1">$1</span>');
}

/**
 * Truncates text from the beginning with ellipsis if it exceeds the limit.
 */
export function prefixlimit(text: string | undefined, limit: number): string {
    if (text === undefined) return '';
    if (text.length <= limit) return text;
    return text.substring(0, limit) + '...';
}


