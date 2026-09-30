import { test, expect } from '@playwright/test';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

// Issue #6: an unmatched URL never mounts +page.svelte, and that is the only
// component that sets body[data-app-ready]. app.css hides <body> until the
// attribute exists, so the error route rendered as a blank page.
test('unmatched route renders a visible error page instead of a blank one', async ({ page }) => {
    setupEffectOrphanFilter(page);
    await page.goto('/no-such-route');

    await expect(page.getByTestId('error-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    // The regression itself: body must not stay hidden by the FOUC guard.
    await expect
        .poll(async () => page.evaluate(() => getComputedStyle(document.body).visibility))
        .toBe('visible');
});

test('error page links back to the working app from a nested path', async ({ page }) => {
    setupEffectOrphanFilter(page);
    await page.goto('/deep/nested/path');

    const link = page.getByTestId('error-home-link');
    await expect(link).toBeVisible();
    // Must stay root-relative: a bare relative href would resolve against
    // /deep/nested/ and land on another 404.
    const href = await link.getAttribute('href');
    expect(new URL(href ?? '', page.url()).pathname).toBe('/');

    await link.click();
    await expect(page.getByTestId('connect-button')).toBeVisible();
});
