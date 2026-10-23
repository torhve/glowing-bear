import { test, expect } from '@playwright/test';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';
import { openSettings, closeSettings } from '../helpers/settings';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
    if (modalVisible) {
        await closeSettings(page);
    }
});

// --- Font Family Tests ---

test('should have font family text input in settings modal', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Inconsolata, Consolas, Monaco, monospace');
});

test('should accept custom font family value', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'Fira Code, monospace';
    await input.fill(customFont);
    await expect(input).toHaveValue(customFont);
});

test('should persist font family to localStorage', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'Liberation Mono, monospace';
    await input.fill(customFont);
    await expect(input).toHaveValue(customFont);

    await closeSettings(page);

    const stored = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return null;
        try {
            return JSON.parse(saved).fontfamily || null;
        } catch {
            return null;
        }
    });
    expect(stored).toBe(customFont);
});

test('should load font family from localStorage on reload', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'DejaVu Sans Mono, monospace';
    await input.fill(customFont);
    await closeSettings(page);

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);
    await openSettings(page);

    await expect(input).toHaveValue(customFont);
});

// --- Font Size Tests ---

test('should have font size text input and slider in settings modal', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');
    const slider = page.getByTestId('font-size-slider');
    await expect(textInput).toBeVisible();
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute('min', '6');
    await expect(slider).toHaveAttribute('max', '36');
});

test('should update text field when slider moves', async () => {
    await openSettings(page);
    const slider = page.getByTestId('font-size-slider');
    const textInput = page.getByTestId('font-size-input');

    // Set initial value in the text field
    await textInput.fill('20px');

    // Wait for the effect to sync the slider position
    await expect(async () => {
        const val = await slider.inputValue();
        expect(val).toBe('20');
    }).toPass({ timeout: 2000, intervals: [50] });

    // Now move the slider to 28 by filling the slider value
    await slider.fill('28');

    // Wait for text field to update
    await expect(textInput).toHaveValue('28px', { timeout: 2000 });
});

test('should persist font size to localStorage', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');

    await textInput.fill('18px');
    await expect(textInput).toHaveValue('18px');

    await closeSettings(page);

    const stored = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return null;
        try {
            return JSON.parse(saved).fontsize || null;
        } catch {
            return null;
        }
    });
    expect(stored).toBe('18px');
});

test('should load font size from localStorage on reload', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');

    await textInput.fill('22px');
    await closeSettings(page);

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);
    await openSettings(page);

    await expect(textInput).toHaveValue('22px');

    // Also verify slider synced
    const slider = page.getByTestId('font-size-slider');
    await expect(async () => {
        const val = await slider.inputValue();
        expect(val).toBe('22');
    }).toPass({ timeout: 2000, intervals: [50] });
});

test('a padded font size paints at the size the slider shows', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');
    const slider = page.getByTestId('font-size-slider');

    await textInput.fill(' 15 px ');

    await expect(async () => {
        expect(await slider.inputValue(), 'the slider reads the padded value').toBe('15');
    }).toPass({ timeout: 2000, intervals: [50] });

    // The part that used to be wrong: the typed string went to CSS verbatim, and
    // `15 px` — a space between the number and the unit — is invalid at
    // computed-value time. The property then becomes `unset` rather than falling
    // back to the `var(--font-size, …)` default, so the chat painted at the
    // browser's own 16px while the slider read 15.
    await expect(async () => {
        const applied = await page.evaluate(() => ({
            customProperty: getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim(),
            body: getComputedStyle(document.body).fontSize,
        }));
        expect(applied.customProperty).toBe('15px');
        expect(applied.body).toBe('15px');
    }).toPass({ timeout: 2000, intervals: [50] });
    // This spec is UI-only, so it must not read message rows; the two writers
    // above are the ones that decide what a row inherits, and `+page.svelte`
    // now derives both from one value.

    // Restore the default. This spec is the last one in the file, so nothing
    // reads the setting after it today, but a page that ends a run holding a
    // non-default size is the kind of state a later spec would inherit by
    // surprise.
    await textInput.fill('14px');
    await expect(async () => {
        expect(await slider.inputValue()).toBe('14');
    }).toPass({ timeout: 2000, intervals: [50] });
    await closeSettings(page);
});

test('a size CSS refuses paints the app default, not the browser default', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');

    // The same `unset` path the padded pixel value reached, arrived at by a
    // different string: a font family typed into the size field, a half-typed
    // list, or nothing but spaces. `var(--x)` and `inherit` are the ones CSS
    // accepts as syntax — a var here can only name a property the app never
    // defines, and a CSS-wide keyword hands the size back to the browser.
    // Playwright's Chromium defaults to 16px, so 14px here is the app's own
    // default and not the engine's.
    for (const typed of ['   ', 'Georgia', 'Foo, ', 'var(--x)', 'inherit']) {
        await textInput.fill(typed);
        await expect(async () => {
            const applied = await page.evaluate(() => ({
                customProperty: getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim(),
                body: getComputedStyle(document.body).fontSize,
            }));
            expect(applied.customProperty, `${JSON.stringify(typed)} must not reach CSS`).toBe('14px');
            expect(applied.body, `${JSON.stringify(typed)} must not paint the browser default`).toBe('14px');
        }).toPass({ timeout: 2000, intervals: [50] });
    }

    await textInput.fill('14px');
    await closeSettings(page);
});
