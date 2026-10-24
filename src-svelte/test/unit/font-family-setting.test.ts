/**
 * The font-family control, and what it promises the user.
 *
 * The rule itself is `font-family-rule.test.ts`. What is guarded here is the
 * dialog's half: the field keeps the text the user typed (normalising happens
 * where the value is read, not where it is written), the placeholder names the
 * family an empty field actually gets, and Reset returns the setting to that
 * empty state.
 *
 * Reset used to write `'Inconsolata, Consolas, Monaco, Ubuntu Mono, monospace'`
 * — a stack this modal invented, different from what the placeholder claimed
 * and from what a fresh install renders. Reset now clears the choice instead of
 * substituting one, which is also what makes "the app default wins" true for a
 * blank or refused value: the app default is one thing, and it is in the
 * stylesheet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { flushSync } from 'svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import { settings, updateSettings } from '#lib/stores/settings.ts';
import { FONT_FAMILY_DEFAULT_CSS, fontFamilyCss } from '#lib/fontFamily.ts';
import { mountHarness } from './helpers/mountComponent.ts';

const { render, teardown } = mountHarness();

// This file only ever mounts one component.
const renderModal = () => render(SettingsModal, {});

/** The font-family text field, or a clear failure. */
function familyField(target: HTMLElement) {
    const el = target.querySelector<HTMLInputElement>('[data-testid="font-family-input"]');
    if (!el) throw new Error('no [data-testid="font-family-input"] in the settings dialog');
    return el;
}

/** Type into the family field the way a user does. */
function typeIntoFamily(target: HTMLElement, value: string) {
    const field = familyField(target);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return field;
}

beforeEach(() => {
    updateSettings({ fontfamily: '' });
});

afterEach(teardown);

describe('the family field', () => {
    it('says what an empty field paints', () => {
        const target = renderModal();
        // A placeholder naming a stack the app never renders is how a user ends
        // up believing a default exists that does not.
        expect(familyField(target).getAttribute('placeholder')).toBe(FONT_FAMILY_DEFAULT_CSS);
    });

    it('keeps the typed text while the reader refuses it', () => {
        const target = renderModal();
        typeIntoFamily(target, '   ');

        // The box never fights the user: the store holds the string, and the
        // refusal happens where the value is applied to CSS.
        expect(get(settings).fontfamily, 'the store took what was typed').toBe('   ');
        expect(fontFamilyCss(get(settings).fontfamily), 'a whitespace-only family must not reach CSS')
            .toBeNull();
    });

    it('keeps a family CSS can paint, exactly as typed', () => {
        const target = renderModal();
        typeIntoFamily(target, 'Fira Code, monospace');

        expect(get(settings).fontfamily).toBe('Fira Code, monospace');
        expect(fontFamilyCss(get(settings).fontfamily)).toBe('Fira Code, monospace');
    });

    it('Reset clears the choice rather than substituting a stack', () => {
        const target = renderModal();
        typeIntoFamily(target, 'Menlo, monospace');

        const button = target.querySelector<HTMLButtonElement>('[data-testid="reset-settings-button"]');
        if (!button) throw new Error('no [data-testid="reset-settings-button"] in the settings dialog');
        button.click();
        flushSync();

        expect(get(settings).fontfamily, 'reset left a family behind').toBe('');
        expect(familyField(target).value).toBe('');
        // Empty means "nothing is written over the stylesheet's own default",
        // which is the same state a fresh install is in.
        expect(fontFamilyCss(get(settings).fontfamily)).toBeNull();
    });
});
