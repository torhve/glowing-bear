/**
 * The dialog header contract, pinned before any shared component replaces it.
 *
 * Two things here are public surface rather than implementation detail.
 *
 * Class names. Settings has a custom CSS field whose contents are injected into
 * the page, and this repo's own `SettingsModal-customCSS` spec styles `.nick`.
 * A header class that no stylesheet in this repository mentions can still be
 * load-bearing for a stylesheet this repository cannot see, so a shared
 * `DialogHeader` has to carry the existing names rather than invent one.
 * Class *tokens* are pinned, not their order in the attribute: order is not
 * visible to CSS and a refactor that reshuffles it changes nothing a user can
 * observe.
 *
 * The close buttons. They were audited as six copies of one button, and the duplicate-link
 * dialog is the seventh; it added no new shape. They are still not one button: three class
 * variants, four labels, two icon sizes, and three of them run a callback in addition to
 * hiding the popover. A component parameterised on all of that is not a deduplication, so the
 * differences are recorded here as assertions a refactor has to keep.
 *
 * Mounted rather than driven through the UI: two of the seven (the image upload preview and
 * the topic modal) need upload state or a channel topic to reach, and all seven render
 * unconditionally — popover visibility is toggled, not mounted — so the DOM is present as soon
 * as the component is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import BufferSearchModal from '#components/BufferSearchModal.svelte';
import ContentSearchModal from '#components/ContentSearchModal.svelte';
import DuplicateLinkDialog from '#components/DuplicateLinkDialog.svelte';
import ImageUploadPreview from '#components/ImageUploadPreview.svelte';
import MultiLinePasteDialog from '#components/MultiLinePasteDialog.svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import TopicModal from '#components/TopicModal.svelte';
import { activeBufferId, buffers } from '#lib/stores/models.ts';
import type { DuplicateMatch } from '#lib/duplicateLinks.ts';
import type { BufferLine } from '#lib/types.ts';
const components: Record<string, unknown>[] = [];

function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}


/** Class tokens as a sorted list: the names are the contract, their order is not. */
function tokens(el: Element): string[] {
    return [...el.classList].sort();
}
/**
 * The header row, found through the title rather than through a position: the
 * heading is what the dialog's `aria-labelledby` points at, so the element that
 * contains it is by definition the row the dialog is titled by.
 *
 * Not `dialog > div:first-child`: the paste dialog wraps its content in a
 * `flex flex-col` box, so its first child is that box and not its header.
 */
function headerOf(target: HTMLElement, headingId: string): HTMLElement {
    const heading = target.querySelector(`#${headingId}`);
    if (!heading?.parentElement) throw new Error(`no heading #${headingId} to find a header from`);
    return heading.parentElement;
}

/**
 * The dialog's own close button. `popovertargetaction="hide"` alone is not
 * enough to identify it: Settings, Topic and the upload preview each have a
 * second button that also hides the popover (Save, Done, Cancel), so the close
 * button is the one that hides the popover *from inside the header row*.
 */
function closeOf(header: Element) {
    const button = header.querySelector('button[popovertargetaction="hide"]');
    if (!button) throw new Error('no popover-hiding button in the header row');
    return button;
}

/** Every header is the same shape: title on the left, close on the right, ruled off. */
const SHARED_HEADER_TOKENS = ['border-b', 'border-border', 'flex', 'items-center', 'justify-between'];

beforeEach(() => {
    activeBufferId.set('');
    buffers.set({});
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

/** Every dialog: component, the props it needs to render, its heading id, and its header class. */
/** A stored line the dialog can read nick, time and text out of. */
function storedLine(text: string, over: Partial<BufferLine> = {}): BufferLine {
    return {
        prefix: [],
        content: [],
        date: 1700003520000,
        shortTime: '09:12',
        buffer: 'irc.gbtest.#chan',
        tags: [],
        highlight: false,
        displayed: true,
        prefixtext: '<bob>',
        text,
        showHiddenBrackets: false,
        ...over,
    };
}

/** Two previous posts of the same link, newest first, as the composer hands them over. */
function duplicateRows(): DuplicateMatch[] {
    return [
        { url: 'https://x.dev/a', line: storedLine('newest post https://x.dev/a', { prefixtext: '<bob>', shortTime: '09:12' }) },
        { url: 'https://x.dev/a', line: storedLine('older post https://x.dev/a too', { prefixtext: '<carol>', shortTime: '07:40', date: 1699917120000 }) },
    ];
}

/** Every dialog: component, the props it needs to render, its heading id, and its header class. */
const DIALOGS = [
    [SettingsModal, {}, 'settings-title', 'settings-header'],
    [TopicModal, { bufferName: '#chan' }, 'topic-title', 'topic-modal-header'],
    [ImageUploadPreview, {}, 'preview-title', 'image-upload-header'],
    // The paste dialog is the one header with no class of its own; its title id is
    // still what the dialog is labelled by, and that is recorded too so a refactor
    // cannot treat the missing name as an oversight to fix silently.
    [MultiLinePasteDialog, { text: 'a\nb\nc' }, 'multiline-paste-title', ''],
    // The duplicate-link dialog takes the same unnamed header.
    [DuplicateLinkDialog, { matches: duplicateRows(), bufferName: '#chan', windowSize: 120 }, 'duplicate-link-title', ''],
    [BufferSearchModal, {}, 'buffer-search-title', 'buffer-search-header'],
    [ContentSearchModal, { onSearch: () => {} }, 'content-search-title', 'content-search-header'],
] as const;

describe('dialog headers keep the class names a user can style', () => {
    it('names each header with the class custom CSS can already target', () => {
        for (const [component, props, headingId, headerClass] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            if (!headerClass) continue; // the paste dialog has none, by design
            expect([...headerOf(target, headingId).classList], headerClass)
                .toContain(headerClass);
        }
    });

    it('gives every header the same row shape', () => {
        const wide = ['px-6', 'py-4'];
        for (const [component, props, headingId, headerClass] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            const found = [...headerOf(target, headingId).classList];
            const label = headerClass || 'the paste dialog (unnamed header)';
            const padding = headerClass === 'buffer-search-header' || headerClass === 'content-search-header'
                ? ['px-4', 'py-3']
                : wide;
            for (const token of [...SHARED_HEADER_TOKENS, ...padding]) {
                expect(found, label).toContain(token);
            }
        }
    });

    it('keeps the heading level and title styling each dialog renders today', () => {
        const levels: Record<string, [string, string[]]> = {
            'settings-title': ['h2', ['text-lg', 'text-white']],
            'topic-title': ['h3', ['text-lg', 'text-text']],
            'preview-title': ['h3', ['text-lg', 'text-text']],
            'multiline-paste-title': ['h3', ['text-lg', 'text-text']],
            'duplicate-link-title': ['h3', ['text-lg', 'text-text']],
            'buffer-search-title': ['h2', ['text-sm', 'text-text']],
            'content-search-title': ['h2', ['text-sm', 'text-text']],
        };

        for (const [component, props, headingId] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            const [tag, titleTokens] = levels[headingId]!;
            const heading = headerOf(target, headingId).querySelector('h1,h2,h3,h4,h5,h6');
            expect(heading, headingId).not.toBeNull();
            expect(heading!.tagName.toLowerCase(), headingId).toBe(tag);
            // The heading's id is what the dialog's `aria-labelledby` points at, so the
            // dialog's accessible name depends on it surviving a header refactor.
            expect(heading!.getAttribute('id'), headingId).toBe(headingId);
            for (const token of titleTokens) {
                expect([...heading!.classList], headingId).toContain(token);
            }
        }
    });
});

describe('the seven close buttons are three buttons, not one', () => {
    it('labels each close button with the dialog it closes', () => {
        const labels: Record<string, string> = {
            'settings-title': 'Close settings',
            'topic-title': 'Close topic',
            'buffer-search-title': 'Close search',
            'content-search-title': 'Close search',
            'preview-title': 'Close',
            'multiline-paste-title': 'Close',
            'duplicate-link-title': 'Close',
        };

        for (const [component, props, headingId] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            const label = labels[headingId]!;
            expect(closeOf(headerOf(target, headingId)).getAttribute('aria-label'), label)
                .toBe(label);
        }
    });

    it('keeps the three distinct close styles separate', () => {
        const close = (headingId: string) => {
            const entry = DIALOGS.find(([_, __, id]) => id === headingId)!;
            return closeOf(headerOf(render(entry[0] as Component<Record<string, unknown>>, entry[1]), headingId));
        };

        const settings = close('settings-title');
        const searches = [close('buffer-search-title'), close('content-search-title')];
        const panels = [close('topic-title'), close('preview-title'), close('multiline-paste-title'), close('duplicate-link-title')];

        // Settings hovers to white; the two search dialogs sit on a muted base with no
        // transition; the four panel dialogs share a tertiary style. Three buttons,
        // not one, and the refactor has to keep them three.
        expect(tokens(settings)).toEqual(
            ['hover:text-white', 'p-1', 'rounded', 'text-text-secondary', 'transition-colors'].sort(),
        );
        for (const button of searches) {
            expect(tokens(button)).toEqual(
                ['hover:text-text', 'p-1', 'rounded', 'text-text-muted'].sort(),
            );
        }
        for (const button of panels) {
            expect(tokens(button)).toEqual(
                ['hover:text-text', 'p-1', 'rounded', 'text-text-secondary', 'transition-colors'].sort(),
            );
        }
    });

    it('keeps the two icon sizes, which follow the density of the dialog', () => {
        const iconHeight = (headingId: string) => {
            const entry = DIALOGS.find(([_, __, id]) => id === headingId)!;
            const svg = closeOf(headerOf(render(entry[0] as Component<Record<string, unknown>>, entry[1]), headingId))
                .querySelector('svg');
            return svg?.getAttribute('height');
        };

        expect(iconHeight('settings-title')).toBe('18');
        expect(iconHeight('topic-title')).toBe('18');
        expect(iconHeight('preview-title')).toBe('18');
        expect(iconHeight('multiline-paste-title')).toBe('18');
        expect(iconHeight('duplicate-link-title')).toBe('18');
        expect(iconHeight('buffer-search-title')).toBe('16');
        expect(iconHeight('content-search-title')).toBe('16');
    });

    it('hides through the popover API on all seven, and runs a callback on three', () => {
        for (const [component, props, headingId] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            const button = closeOf(headerOf(target, headingId));
            const dialog = button.closest('dialog');
            // All seven hide via the popover attribute; none of them implements its own
            // Escape or backdrop handling. A shared header must not add either: the
            // native popover already owns both, and a second handler would fire twice.
            expect(button.getAttribute('popovertarget'), headingId).toBe(dialog?.getAttribute('id'));
            expect(button.getAttribute('popovertargetaction'), headingId).toBe('hide');
        }

        // Three of them also run a callback on close, which is why they cannot fold into
        // a close button that only hides.
        const pasteCancel = vi.fn();
        const pasteTarget = render(MultiLinePasteDialog, { text: 'a\nb\nc', onCancel: pasteCancel });
        closeOf(headerOf(pasteTarget, 'multiline-paste-title'))
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        flushSync();
        expect(pasteCancel, 'the paste dialog must cancel the paste when its X is used').toHaveBeenCalledTimes(1);

        const uploadClose = vi.fn();
        const uploadTarget = render(ImageUploadPreview, { onClose: uploadClose });
        closeOf(headerOf(uploadTarget, 'preview-title'))
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        flushSync();
        expect(uploadClose, 'the upload preview must run its close handler when its X is used').toHaveBeenCalledTimes(1);

        // The duplicate dialog's X means Edit, the same answer as its Edit button and the
        // same answer as Escape. A close that only hid the popover would leave the reader
        // with an unanswered question on screen.
        const editAnswer = vi.fn();
        const duplicateTarget = render(DuplicateLinkDialog, {
            matches: duplicateRows(), bufferName: '#chan', windowSize: 120, onEdit: editAnswer,
        });
        closeOf(headerOf(duplicateTarget, 'duplicate-link-title'))
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        flushSync();
        expect(editAnswer, 'the duplicate-link dialog must run its Edit answer when its X is used').toHaveBeenCalledTimes(1);
    });
});

/**
 * What the duplicate-link dialog puts on screen. It is mounted here rather than in a file of
 * its own because the cost budget for this feature allows two new test files, and this one
 * already mounts every dialog in the app.
 */
describe('the duplicate-link dialog shows who posted the link, when, and with what', () => {
    it('renders one row per match, each naming the nick, the time and the earlier text', () => {
        const target = render(DuplicateLinkDialog, {
            matches: duplicateRows(), bufferName: '#chan', windowSize: 120,
        });
        const rows = [...target.querySelectorAll('[data-testid="duplicate-link-row"]')];
        expect(rows).toHaveLength(2);

        const first = rows[0]!.textContent ?? '';
        expect(first).toContain('<bob>');
        expect(first).toContain('09:12');
        expect(first).toContain('https://x.dev/a');
        expect(first).toContain('newest post https://x.dev/a');

        const second = rows[1]!.textContent ?? '';
        expect(second).toContain('<carol>');
        expect(second).toContain('07:40');
        expect(second).toContain('older post https://x.dev/a too');
    });

    it('renders the earlier text through LinkifiedText, not raw HTML', () => {
        const target = render(DuplicateLinkDialog, {
            matches: [{ url: 'https://x.dev/a', line: storedLine('see https://x.dev/a now') }],
            bufferName: '#chan', windowSize: 60,
        });
        const row = target.querySelector('[data-testid="duplicate-link-row"]')!;
        // The link inside the quoted message became an anchor, which is what
        // `LinkifiedText` does and `{@html}` would not have to.
        expect(row.querySelector('a')?.getAttribute('href')).toBe('https://x.dev/a');
    });

    it('bounds its own claim to the window it actually read', () => {
        const target = render(DuplicateLinkDialog, {
            matches: duplicateRows(), bufferName: '#chan', windowSize: 120,
        });
        expect(target.textContent).toContain('the last 120 messages of #chan');
    });

    it('names the match count in the title when there is more than one row', () => {
        const two = render(DuplicateLinkDialog, {
            matches: duplicateRows(), bufferName: '#chan', windowSize: 120,
        });
        expect(two.querySelector('#duplicate-link-title')?.textContent).toContain('Post this link again? (2 previous posts)');

        const one = render(DuplicateLinkDialog, {
            matches: [{ url: 'https://x.dev/a', line: storedLine('see https://x.dev/a') }],
            bufferName: '#chan', windowSize: 50,
        });
        expect(one.querySelector('#duplicate-link-title')?.textContent).toBe('Post this link again?');
    });

    it('gives a long message a scrolling box instead of clipping it', () => {
        const long = `https://x.dev/a ${'a very long reply that has to stay readable '.repeat(12)}`;
        const target = render(DuplicateLinkDialog, {
            matches: [{ url: 'https://x.dev/a', line: storedLine(long) }],
            bufferName: '#chan', windowSize: 200,
        });
        const paragraph = target.querySelector('[data-testid="duplicate-link-row"] p')!;
        // jsdom lays nothing out, so what is pinned is the rule the stylesheet acts on: a
        // bounded height with `overflow-y-auto`, and the whole text still in the DOM.
        for (const token of ['max-h-40', 'overflow-y-auto', 'break-words']) {
            expect([...paragraph.classList], token).toContain(token);
        }
        expect((paragraph.textContent ?? '').length).toBeGreaterThan(long.length - 1);
    });

    it('offers Edit as the button Enter answers', () => {
        const target = render(DuplicateLinkDialog, {
            matches: duplicateRows(), bufferName: '#chan', windowSize: 120,
        });
        const edit = target.querySelector('[data-testid="duplicate-link-edit"]')!;
        expect(edit.getAttribute('aria-keyshortcuts')).toBe('Enter');
        expect(target.querySelector('[data-testid="duplicate-link-send-anyway"]')).not.toBeNull();
    });
});
