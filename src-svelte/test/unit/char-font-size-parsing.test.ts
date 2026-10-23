/**
 * Characterization tests for B8: the font-size setting is parsed by two different
 * regexes inside one component.
 *
 *   SettingsModal.svelte:64   /^\s*(\d+)\s*(?:px)?\s*$/   the sync $effect that
 *                             reads settings.fontsize and positions the slider
 *   SettingsModal.svelte:213  /^(\d+)(?:px)?$/            the text field's
 *                             oninput, which decides whether the slider moves
 *
 * The first accepts surrounding whitespace, the second does not. So the same
 * string is a valid font size to the effect and an invalid one to the field:
 * typing " 15 px " writes it into settings and leaves the slider where it was.
 *
 * These pin that split. They also pin the slider's own bounds (min 6, max 36 at
 * :194-195), which are a third copy of the same numbers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { flushSync } from 'svelte';
import SettingsModal from '#components/SettingsModal.svelte';
import { settings, updateSettings } from '#lib/stores/settings.ts';
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

describe('B8 characterization: one value, two parsers', () => {
    it('a padded value is written to settings and the slider moves anyway', () => {
        const target = renderModal();
        expect(sliderLabel(target)).toBe('14px');

        typeIntoFontSize(target, ' 15 px ');

        expect(get(settings).fontsize, 'the store took the padded string').toBe(' 15 px ');
        // The field's own regex at :213 rejects this string, so its own
        // `fontSizePx = ...` line never runs. The slider still ends at 15px
        // because the sync $effect at :62 accepts the same string and writes the
        // value the field just put in the store.
        //
        // This is where the plan was wrong. B8 was written as "typing a padded
        // value updates settings.fontsize without moving the slider" — it does
        // move it. The two regexes really do disagree, but the effect's parser is
        // a superset of the field's and it re-parses everything the field writes,
        // so the disagreement is self-correcting and has no observable outcome.
        expect(sliderLabel(target), 'the effect rescued the value the field rejected').toBe('15px');
        expect(input(target, 'font-size-slider').value).toBe('15');
    });

    it('the sync effect accepts that same padded string, so the two disagree about it', () => {
        const target = renderModal();
        expect(sliderLabel(target)).toBe('14px');

        // The value the field just wrote, arriving through the store instead of
        // through the field. The effect's regex accepts it and moves the slider.
        updateSettings({ fontsize: ' 16 px ' });
        flushSync();

        expect(sliderLabel(target), 'the effect parsed what the field refused to').toBe('16px');
        expect(input(target, 'font-size-slider').value).toBe('16');
    });

    it('an unpadded value is accepted by both, which is why the split stays hidden', () => {
        const target = renderModal();

        typeIntoFontSize(target, '18');

        expect(get(settings).fontsize).toBe('18');
        expect(sliderLabel(target)).toBe('18px');
        expect(input(target, 'font-size-slider').value).toBe('18');
    });

    it('the slider clamps to 6..36 and the field clamps the same range separately', () => {
        const target = renderModal();
        const slider = input(target, 'font-size-slider');
        expect(slider.min, 'a third copy of the bounds lives in the markup').toBe('6');
        expect(slider.max).toBe('36');

        // The field's own Math.min/Math.max, written at :215 rather than shared.
        typeIntoFontSize(target, '99');
        expect(sliderLabel(target)).toBe('36px');

        typeIntoFontSize(target, '1');
        expect(sliderLabel(target)).toBe('6px');
    });

    it('a value neither regex accepts leaves the slider at its fallback', () => {
        const target = renderModal();

        typeIntoFontSize(target, 'large');

        expect(get(settings).fontsize, 'the field writes whatever is typed').toBe('large');
        expect(sliderLabel(target), 'and the effect falls back to 14').toBe('14px');
    });
});
