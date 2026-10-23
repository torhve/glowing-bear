/**
 * The font-size control: one value rule, read by the slider and written by the field.
 *
 * `SettingsModal` used to parse the setting twice — the sync `$effect` with
 * `/^\s*(\d+)\s*(?:px)?\s*$/` and the field's `oninput` with `/^(\d+)(?:px)?$/` —
 * and both clamped with their own numbers. Those two regexes disagreed about
 * whitespace, but the disagreement had no observable outcome: the effect is a
 * superset of the field and re-parses everything the field writes, which is what
 * kept the split invisible. The observable defect was downstream, in the value
 * the page handed to CSS, and `font-size-rule.test.ts` pins the rule that fixed
 * it. What is guarded here is the control itself: both readings of the stored
 * value now go through that one rule, and the bounds are one pair.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { flushSync } from 'svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import { settings, updateSettings } from '#lib/stores/settings.ts';
import { FONT_SIZE_DEFAULT_PX } from '#lib/fontSize.ts';
import { mountHarness } from './helpers/mountComponent.ts';

const { render, teardown } = mountHarness();

// This file only ever mounts one component.
const renderModal = () => render(SettingsModal, {});

function input(target: HTMLElement, testid: string) {
    const el = target.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`no [data-testid="${testid}"] in the settings dialog`);
    return el;
}

function sliderLabel(target: HTMLElement) {
    const el = target.querySelector<HTMLElement>('.font-size-label');
    if (!el) throw new Error('no font-size label');
    return el.textContent?.trim();
}

/** Type into the font-size text field the way a user does. */
function typeIntoFontSize(target: HTMLElement, value: string) {
    const field = input(target, 'font-size-input');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return field;
}

beforeEach(() => {
    updateSettings({ fontsize: '14px' });
});

afterEach(teardown);

describe('the font-size control reads the stored value by one rule', () => {
    it('a padded value is written to settings and moves the slider', () => {
        const target = renderModal();
        expect(sliderLabel(target)).toBe('14px');

        typeIntoFontSize(target, ' 15 px ');

        // The field stores what was typed; normalising happens where the value is
        // read, so the text in the box never fights the user.
        expect(get(settings).fontsize, 'the store took the padded string').toBe(' 15 px ');
        expect(sliderLabel(target)).toBe('15px');
        expect(input(target, 'font-size-slider').value).toBe('15');
    });

    it('the same value arriving through the store moves the slider identically', () => {
        const target = renderModal();
        expect(sliderLabel(target)).toBe('14px');

        updateSettings({ fontsize: ' 16 px ' });
        flushSync();

        // The two paths used to be two parsers. Whatever reaches the store, the
        // slider answers the same way — which is the property the split broke.
        expect(sliderLabel(target)).toBe('16px');
        expect(input(target, 'font-size-slider').value).toBe('16');
    });

    it('an unpadded value reads the same as its padded form', () => {
        const target = renderModal();

        typeIntoFontSize(target, '18');

        expect(get(settings).fontsize).toBe('18');
        expect(sliderLabel(target)).toBe('18px');
        expect(input(target, 'font-size-slider').value).toBe('18');
    });

    it('clamps to the slider bounds, from the pair the markup also reads', () => {
        const target = renderModal();
        const slider = input(target, 'font-size-slider');
        expect(slider.min, 'the markup and the clamp read one pair').toBe('6');
        expect(slider.max).toBe('36');

        typeIntoFontSize(target, '99');
        expect(sliderLabel(target)).toBe('36px');

        typeIntoFontSize(target, '1');
        expect(sliderLabel(target)).toBe('6px');
    });

    it('falls back to the default size for a value that is not a pixel count', () => {
        const target = renderModal();

        typeIntoFontSize(target, 'large');

        expect(get(settings).fontsize, 'the field writes whatever is typed').toBe('large');
        expect(sliderLabel(target), 'and the slider shows the shared default').toBe(
            `${FONT_SIZE_DEFAULT_PX}px`,
        );
    });
});
