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
 * The close buttons. They were audited as six copies of one button. They are
 * not: three class variants, four labels, two icon sizes, and two of them run a
 * callback in addition to hiding the popover. A component parameterised on all
 * of that is not a deduplication, so the differences are recorded here as
 * assertions a refactor has to keep.
 *
 * Mounted rather than driven through the UI: two of the six (the image upload
 * preview and the topic modal) need upload state or a channel topic to reach,
 * and all six render unconditionally — popover visibility is toggled, not
 * mounted — so the DOM is present as soon as the component is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import BufferSearchModal from '#components/BufferSearchModal.svelte';
import ContentSearchModal from '#components/ContentSearchModal.svelte';
import ImageUploadPreview from '#components/ImageUploadPreview.svelte';
import MultiLinePasteDialog from '#components/MultiLinePasteDialog.svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import TopicModal from '#components/TopicModal.svelte';
import { activeBufferId, buffers } from '#lib/stores/models.ts';

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
const DIALOGS = [
    [SettingsModal, {}, 'settings-title', 'settings-header'],
    [TopicModal, { bufferName: '#chan' }, 'topic-title', 'topic-modal-header'],
    [ImageUploadPreview, {}, 'preview-title', 'image-upload-header'],
    // The paste dialog is the one header with no class of its own; its title id is
    // still what the dialog is labelled by, and that is recorded too so a refactor
    // cannot treat the missing name as an oversight to fix silently.
    [MultiLinePasteDialog, { text: 'a\nb\nc' }, 'multiline-paste-title', ''],
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

describe('the six close buttons are three buttons, not one', () => {
    it('labels each close button with the dialog it closes', () => {
        const labels: Record<string, string> = {
            'settings-title': 'Close settings',
            'topic-title': 'Close topic',
            'buffer-search-title': 'Close search',
            'content-search-title': 'Close search',
            'preview-title': 'Close',
            'multiline-paste-title': 'Close',
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
        const panels = [close('topic-title'), close('preview-title'), close('multiline-paste-title')];

        // Settings hovers to white; the two search dialogs sit on a muted base with no
        // transition; the three panel dialogs share a tertiary style. Three buttons,
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
        expect(iconHeight('buffer-search-title')).toBe('16');
        expect(iconHeight('content-search-title')).toBe('16');
    });

    it('hides through the popover API on all six, and runs a callback on only two', () => {
        for (const [component, props, headingId] of DIALOGS) {
            const target = render(component as Component<Record<string, unknown>>, props);
            const button = closeOf(headerOf(target, headingId));
            const dialog = button.closest('dialog');
            // All six hide via the popover attribute; none of them implements its own
            // Escape or backdrop handling. A shared header must not add either: the
            // native popover already owns both, and a second handler would fire twice.
            expect(button.getAttribute('popovertarget'), headingId).toBe(dialog?.getAttribute('id'));
            expect(button.getAttribute('popovertargetaction'), headingId).toBe('hide');
        }

        // Two of them also run a callback on close, which is why they cannot fold into
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
    });
});
