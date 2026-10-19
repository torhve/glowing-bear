/**
 * The settings option rows and section headers, pinned before they are collapsed.
 *
 * `SettingsModal` hand-writes 15 option rows and 6 section headers. Unlike the six
 * dialog headers (see `dialog-header-contract.test.ts`), these really are copies —
 * which is exactly why they are worth a component. But "they are copies" is only
 * safe to act on once the differences between them are listed, and there are five:
 *
 *   - `id` is not derived from the setting key (`showNicklist` → `show-nicklist`,
 *     but `noembed` → `noembed`), so it has to stay an explicit value;
 *   - four rows carry a `data-testid` the E2E specs click through, the rest do not;
 *   - `savepassword` does not toggle like the others — turning it off also clears
 *     the stored password, so its change handler is a different function;
 *   - `protocol` is one of the 15 rows but is a `<select>`, not a checkbox.
 *   - `autoconnect` is only rendered while `savepassword` is on, so one row's very
 *     existence is conditional on another setting;
 *
 * A `ToggleOption` that cannot express all five would silently change behaviour.
 * These tests are the list it has to satisfy.
 *
 * `data-settings-option`, `data-settings-checkbox` and `data-settings-section` are
 * pinned even though no test in this repo reads them: Settings ships a custom CSS
 * field, and an attribute selector is as reachable there as a class selector.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import { get } from 'svelte/store';
import { settings, updateSettings } from '#lib/stores/settings.ts';
import type { Settings } from '#lib/types.ts';

const components: Record<string, unknown>[] = [];

function render() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(SettingsModal, { target, props: {} }));
    flushSync();
    return target;
}

/** Class *tokens*, sorted: order in the attribute is not visible to CSS. */
function tokens(el: Element | null) {
    return el ? [...el.classList].sort() : [];
}

const LABEL_CLASS = ['flex', 'items-center', 'justify-between', 'py-2', 'settings-option'];
const SPAN_CLASS = ['flex', 'gap-2', 'items-center', 'settings-option-label', 'text-sm', 'text-text'];
const CHECKBOX_CLASS = ['h-4', 'w-4'];

/**
 * The checkboxes that carry a `data-testid`. Five do; only four of those are read by
 * an E2E spec today. The fifth is pinned anyway — a test id that no test uses is
 * still a name something outside this repo can depend on, and "no spec reads it" is
 * not the same as "nothing reads it".
 */
const TESTID_BY_KEY: Record<string, string> = {
    stylizePrivateChats: 'stylizePrivateChats-checkbox',
    enableFormatting: 'enableFormatting-checkbox',
    enableEmojify: 'enableEmojify-checkbox',
    useFavico: 'favico-checkbox',
    soundnotification: 'sound-checkbox',
};

/** The 13 checkbox rows that are always present: setting key and the `id` the label points at. */
const CHECKBOX_ROWS: Array<[keyof Settings, string]> = [
    ['showNicklist', 'show-nicklist'],
    ['noembed', 'noembed'],
    ['orderbyserver', 'orderbyserver'],
    ['stylizePrivateChats', 'stylize-private-chats'],
    ['onlyUnread', 'only-unread'],
    ['readlineBindings', 'readline-bindings'],
    ['enableFormatting', 'enable-formatting'],
    ['enableQuickKeys', 'enable-quick-keys'],
    ['enableEmojify', 'enable-emojify'],
    ['useFavico', 'use-favico'],
    ['soundnotification', 'sound-notification'],
    ['enableMathjax', 'enable-mathjax'],
    ['savepassword', 'save-password'],
];

let initial: Settings;

beforeEach(() => {
    initial = { ...get(settings) };
});

afterEach(async () => {
    updateSettings(initial);
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

describe('the checkbox rows', () => {
    it('each row carries its key, its id, and the same wrapper classes', () => {
        const target = render();

        for (const [key, id] of CHECKBOX_ROWS) {
            const label = target.querySelector(`[data-settings-option="${String(key)}"]`);
            expect(label, String(key)).not.toBeNull();
            expect(label!.tagName, String(key)).toBe('LABEL');
            expect(tokens(label), String(key)).toEqual(LABEL_CLASS);

            const span = label!.querySelector('span');
            expect(span, `${String(key)} label span`).not.toBeNull();
            expect(tokens(span), String(key)).toEqual(SPAN_CLASS);
            // Every row shows an icon; the label text is what a user reads.
            expect(span!.textContent!.trim().length, String(key)).toBeGreaterThan(0);

            const input = label!.querySelector('input');
            expect(input, `${String(key)} input`).not.toBeNull();
            expect(input!.getAttribute('id'), String(key)).toBe(id);
            expect(input!.getAttribute('name'), String(key)).toBe(String(key));
            expect(input!.getAttribute('type'), String(key)).toBe('checkbox');
            expect(tokens(input), String(key)).toEqual(CHECKBOX_CLASS);
            expect(input!.getAttribute('data-settings-checkbox'), String(key)).toBe(String(key));

            // The test ids are the E2E surface, and only four rows have one.
            expect(input!.getAttribute('data-testid'), String(key)).toBe(TESTID_BY_KEY[String(key)] ?? null);
        }
    });

    it('the checkbox reflects the setting and a click flips it', () => {
        const target = render();
        const input = target.querySelector('[data-settings-checkbox="onlyUnread"]') as HTMLInputElement;

        updateSettings({ onlyUnread: false });
        flushSync();
        expect(input.checked).toBe(false);

        input.click();
        flushSync();
        expect(get(settings).onlyUnread).toBe(true);
        expect(input.checked).toBe(true);
    });

    it('savepassword is not a plain toggle — turning it off clears the stored password', () => {
        // The one row whose change handler is a named function rather than
        // `updateSettings({ k: !s.k })`. A shared row component that assumes the
        // plain form would drop the clear silently.
        updateSettings({ savepassword: true, password: 'hunter2' });
        flushSync();
        const target = render();
        const input = target.querySelector('[data-settings-checkbox="savepassword"]') as HTMLInputElement;

        input.click();
        flushSync();

        expect(get(settings).savepassword).toBe(false);
        expect(get(settings).password, 'a saved password is dropped when saving is turned off').toBe('');
    });

    it('leaving a row off does not store the password it just cleared', () => {
        updateSettings({ savepassword: false, password: '' });
        flushSync();
        const target = render();
        const input = target.querySelector('[data-settings-checkbox="savepassword"]') as HTMLInputElement;

        input.click();
        flushSync();
        expect(get(settings).savepassword).toBe(true);
        expect(get(settings).password).toBe('');
    });
    it('autoconnect exists only while savepassword is on', () => {
        // The one row whose presence depends on another setting: autoconnect is
        // pointless without a stored password, so the modal does not offer it.
        // A shared row component is easy to write in a way that loses this.
        updateSettings({ savepassword: false });
        flushSync();
        const target = render();
        expect(target.querySelector('[data-settings-option="autoconnect"]')).toBeNull();

        updateSettings({ savepassword: true });
        flushSync();
        const row = target.querySelector('[data-settings-option="autoconnect"]');
        expect(row, 'the row appears with its own id and checkbox').not.toBeNull();
        expect(tokens(row)).toEqual(LABEL_CLASS);
        const input = row!.querySelector('input')!;
        expect(input.getAttribute('id')).toBe('auto-connect');
        expect(input.getAttribute('name')).toBe('autoconnect');
        expect(input.getAttribute('data-settings-checkbox')).toBe('autoconnect');
    });

});

describe('the row that is not a checkbox', () => {
    it('protocol renders a select with the three transport choices', () => {
        const target = render();
        const label = target.querySelector('[data-settings-option="protocol"]');
        expect(label).not.toBeNull();
        // Same wrapper as the checkbox rows: the row shape is shared even though
        // the control is not.
        expect(tokens(label)).toEqual(LABEL_CLASS);

        const select = label!.querySelector('select');
        expect(select).not.toBeNull();
        expect(select!.getAttribute('id')).toBe('protocol-selector');
        expect(select!.getAttribute('data-testid')).toBe('protocol-selector');
        expect([...select!.querySelectorAll('option')].map((o) => o.getAttribute('value')))
            .toEqual(['auto', 'api', 'legacy']);
    });

    it('choosing a protocol writes the preference', () => {
        const target = render();
        const select = target.querySelector('[data-testid="protocol-selector"]') as HTMLSelectElement;

        select.value = 'legacy';
        // Svelte 5 compiles `onchange` on this select to `$.delegated('change', …)`
        // with `$.delegate(['change'])`: the real listener sits on `document`, so a
        // non-bubbling event dispatched on the element never reaches it. The handler
        // is then simply never called and the store keeps its old value — which a
        // test can easily mistake for "already correct" and pass vacuously.
        select.dispatchEvent(new Event('change', { bubbles: true }));
        flushSync();

        expect(get(settings).protocol).toBe('legacy');
    });
});

describe('the six section headers', () => {
    const SECTIONS = ['appearance', 'display', 'behaviour', 'notifications', 'advanced', 'connection'];

    it('each section is a <section> with its name and an h3 heading', () => {
        const target = render();

        for (const name of SECTIONS) {
            const section = target.querySelector(`[data-settings-section="${name}"]`);
            expect(section, name).not.toBeNull();
            expect(section!.tagName, name).toBe('SECTION');
            expect(tokens(section), name).toEqual(['settings-section']);

            const heading = section!.querySelector('h3');
            expect(heading, `${name} heading`).not.toBeNull();
            expect(tokens(heading), name).toEqual(
                ['mb-3', 'flex', 'items-center', 'gap-2', 'text-base', 'font-bold', 'text-accent', 'uppercase', 'tracking-wide', 'settings-section-header'].sort(),
            );
            expect(heading!.textContent!.trim(), name).not.toBe('');
        }
    });

    it('the sections appear in this order, because that is the order a user reads them', () => {
        const target = render();
        const order = [...target.querySelectorAll('[data-settings-section]')]
            .map((el) => el.getAttribute('data-settings-section'));
        expect(order).toEqual(SECTIONS);
    });
});

describe('the four wide field controls', () => {
    /** Three share one class string exactly; the custom CSS textarea adds `font-mono`. */
    const FIELD_CLASS = 'w-full px-3 py-2 bg-input-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent';

    it('share one class string, with the textarea the only variant', () => {
        const target = render();
        const themeDark = target.querySelector('[data-testid="theme-dark-selector"]')!;
        const themeLight = target.querySelector('[data-testid="theme-light-selector"]')!;
        const fontFamily = target.querySelector('[data-testid="font-family-input"]')!;
        const customCss = target.querySelector('[data-testid="custom-css-textarea"]')!;

        // The three identical ones are byte-identical, which is what makes them a
        // deduplication candidate rather than a family lookalike.
        expect(themeDark.className).toBe(FIELD_CLASS);
        expect(themeLight.className).toBe(FIELD_CLASS);
        expect(fontFamily.className).toBe(FIELD_CLASS);

        // The textarea is the variant: same tokens plus `font-mono`. Its tokens are
        // not in the same order as the others — `font-mono` sits mid-string — and
        // order is not something CSS can see, so this one is pinned as a token set.
        expect([...customCss.classList].sort()).toEqual([...FIELD_CLASS.split(' '), 'font-mono'].sort());
    });

    it('the field controls are not the FormInput class — a shared component would restyle them', () => {
        // Recorded so a later "just use FormInput for these too" is recognised as a
        // visual change and not a rename: FormInput adds hover/placeholder/transition
        // classes and derives its padding from a size prop.
        const target = render();
        const fontFamily = target.querySelector('[data-testid="font-family-input"]')!;
        expect(fontFamily.classList.contains('form-input')).toBe(false);
        expect(fontFamily.classList.contains('transition-colors')).toBe(false);
    });
});
