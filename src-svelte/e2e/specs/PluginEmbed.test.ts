import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setSettings } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page)
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});

// Finds the bufferline-row containing a message with the given text
function rowForMessage(urlPattern: string) {
    return page.locator('[data-testid="bufferline-row"]').filter({
        has: page.locator(`td[data-message*="${urlPattern}"]`),
    }).first();
}

test('shows "Show Image" button when noembed is enabled', async () => {
    // noembed=true is the default after fix
    await botSay('https://picsum.photos/200/300.jpg?1');
    const row = rowForMessage('picsum.photos/200/300.jpg?1');
    await expect(row.locator('[data-testid="show-embed"]')).toBeVisible({ timeout: 10000 });

    // No preview while collapsed: nothing loads until the user clicks.
    await expect(row.locator('[data-testid="show-embed"] img')).toHaveCount(0);

    // The control names what it will show. The label and the element revealed by the
    // click have to be the same kind: an entry that says "Show Image" over an audio
    // glyph, or the other way round, is the bug this assertion exists to catch.
    await expect(row.locator('[data-testid="show-embed"]')).toHaveAccessibleName('Show Image');
    await expect(row.locator('[data-testid="show-embed"]')).toHaveAttribute('data-media-kind', 'image');
});

test('clicking Show Image reveals the embed', async () => {
    await botSay('https://picsum.photos/200/300.jpg?2');
    const row = rowForMessage('picsum.photos/200/300.jpg?2');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await showBtn.click();
    // Verify the embed area became visible within the same row
    await expect(row.locator('.embed-area')).toBeVisible({ timeout: 10000 });
    await expect(row.locator('[data-testid="plugin-embed"]')).toBeVisible();
    await expect(row.locator('[data-testid="plugin-embed"] img')).toBeVisible();
});

test('clicking Hide Image hides the embed again', async () => {
    await botSay('https://picsum.photos/200/300.jpg?3');
    const row = rowForMessage('picsum.photos/200/300.jpg?3');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await showBtn.click();
    // Wait for hide button to appear in the same row, then click it
    await expect(row.locator('[data-testid="hide-embed"]')).toBeVisible({ timeout: 10000 });
    await row.locator('[data-testid="hide-embed"]').click();
    // After hiding, the embed should be hidden and show button reappears
    await expect(row.locator('.embed-area')).not.toBeVisible({ timeout: 5000 });
    await expect(row.locator('[data-testid="show-embed"]')).toBeVisible();
});

// Issue #18: after expanding, the collapse affordance must be obvious, and
// collapsing returns the item to its collapsed state.
test('expanded media shows an obvious Collapse button and returns to the collapsed state', async () => {
    await botSay('https://picsum.photos/200/300.jpg?8');
    const row = rowForMessage('picsum.photos/200/300.jpg?8');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await expect(showBtn.locator('img')).toHaveCount(0);
    await showBtn.click();

    // The collapse control is visible while the media is expanded.
    const collapseBtn = row.locator('[data-testid="hide-embed"]');
    await expect(collapseBtn).toBeVisible({ timeout: 10000 });
    await expect(collapseBtn).toHaveAttribute('title', 'Collapse');

    // The collapse control sits below the media, not overlaid on it.
    // Measure both boxes in one task, after the image has decoded, so the
    // container height cannot change between the two reads.
    await row.locator('[data-testid="plugin-embed"] img').evaluate((el) => {
        // A locator hands its callback a generic element; decode() belongs to the HTML image, and
        // the two-box measurement below is only worth taking once that image has finished.
        if (!(el instanceof HTMLImageElement)) {
            throw new Error('the embed row holds an <img> that is not an HTMLImageElement');
        }
        return el.decode();
    });
    const boxes = await row.locator('[data-testid="plugin-embed"]').evaluate((el) => {
        const media = el.getBoundingClientRect();
        const btn = el.parentElement!.querySelector<HTMLElement>('[data-testid="hide-embed"]')!.getBoundingClientRect();
        return { mediaBottom: media.bottom, btnTop: btn.top };
    });
    expect(boxes.btnTop).toBeGreaterThanOrEqual(boxes.mediaBottom - 1);

    // Collapsing brings the Show button back.
    await collapseBtn.click();
    await expect(row.locator('.embed-area')).not.toBeVisible({ timeout: 5000 });
    await expect(showBtn).toBeVisible();
    await expect(showBtn.locator('img')).toHaveCount(0);
});

test('handles multiple images in one message', async () => {
    await irc.sendMessage('#glowing-bear', 'See https://picsum.photos/200/300.jpg?4 and https://picsum.photos/200/300.jpg?5');
    const row = rowForMessage('picsum.photos/200/300.jpg?4');
    const showButtons = row.locator('[data-testid="show-embed"]');
    await expect(showButtons).toHaveCount(2, { timeout: 10000 });
    await expect(showButtons.nth(0)).toBeVisible();
    await expect(showButtons.nth(1)).toBeVisible();
});

test('NSFW image shows yellow warning button', async () => {
    await irc.sendMessage('#glowing-bear', 'nsfw https://picsum.photos/200/300.jpg?6');
    const row = rowForMessage('picsum.photos/200/300.jpg?6');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    // NSFW button should have yellow/amber/warning background-color
    const color = await showBtn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(color).toMatch(/yellow|rgb\(240|rgb\(217|rgb\(250|rgb\(230|rgba\(234|rgba\(244|rgba\(220|oklch\(|oklab\(/i);
});

test('a Yr.no location link becomes the forecast chart yr.no serves', async () => {
    // The live half of the Meteogram entry. It spent its life matching yr.no's
    // retired `place/` URLs and building `api.met.no/weathericon/2.0/legacymeteogram`
    // out of the place names in the path read as `lat` and `lon`, against a product
    // that answers HTTP 404: a button labelled "Show Meteogram" over a broken image,
    // which no test ever loaded. This one loads it, so the URL the app builds has to
    // stay the one yr.no answers with a chart.
    await setSettings(page, { noembed: true });
    await botSay('https://www.yr.no/nb/varsel/daglig-tabell/1-72837/Norge/Oslo/Oslo');
    const row = rowForMessage('yr.no/nb/varsel/daglig-tabell/1-72837');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await expect(showBtn).toHaveAccessibleName('Show Meteogram');
    await showBtn.click();

    const chart = row.locator('[data-testid="plugin-embed"] img');
    await expect(chart).toHaveAttribute('src', 'https://www.yr.no/nb/innhold/1-72837/meteogram.svg?mode=light');
    // Decoding at the chart's own size is what "not a broken image" means here.
    await expect
        .poll(async () => chart.evaluate((el: HTMLImageElement) => el.decode()
            .then(() => `${el.naturalWidth}x${el.naturalHeight}`, () => 'undecoded')), { timeout: 20000 })
        .toBe('782x391');
});

test('an AlloCine link stays a plain link, with no embed offered', async () => {
    // The entry was deleted rather than repaired, and this is the user-visible half of that
    // decision. Measured against allocine.fr: `/videokast/video-<id>` answers 410 Gone and the
    // frame URL the entry built answers a 404 page inside the frame, while the live
    // `/video/video-<id>/` page is the whole ad-supported site rather than a player. See the
    // comment left in its place in `embedMatchers`. What a user should get now is the link —
    // clickable — and no "Show …" button promising media that cannot be shown.
    await setSettings(page, { noembed: true });
    await botSay('https://www.allocine.fr/video/video-19557975/');
    const row = rowForMessage('allocine.fr/video/video-19557975');
    await expect(row.getByRole('link', { name: /allocine\.fr/ })).toBeVisible({ timeout: 10000 });
    await expect(row.locator('[data-testid="show-embed"]')).toHaveCount(0);
    await expect(row.locator('[data-testid="plugin-embed"]')).toHaveCount(0);
});

test('noembed=false shows embeds automatically', async () => {
    await setSettings(page, { noembed: false });
    await botSay('https://picsum.photos/200/300.jpg?7');
    const row = rowForMessage('picsum.photos/200/300.jpg?7');
    await expect(row.locator('[data-testid="plugin-embed"] img')).toBeVisible({ timeout: 10000 });
    // New messages should have no "Show Image" button when noembed=false
    await expect(row.locator('[data-testid="show-embed"]')).not.toBeVisible();
});
