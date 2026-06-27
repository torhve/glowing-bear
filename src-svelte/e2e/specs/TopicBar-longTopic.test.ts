import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
    // Reset channel topic to prevent cross-test contamination
    await irc.setTopic('#glowing-bear', '');
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});

test('channel name does not wrap with very long topic', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Set an extremely long topic that would cause wrapping if channel name isn't protected
    const longTopic = 'This is a very long channel topic that contains a lot of text which should cause the topic text area to truncate rather than pushing the channel name into wrapping onto two lines. It goes on and on and on describing things in great detail just to test the layout behavior when topics exceed the available horizontal space in the topic bar.';
    await irc.setTopic('#glowing-bear', longTopic);

    // Wait for topic to propagate
    await page.waitForTimeout(1000);

    // The topic bar opener button has fixed height h-8 (32px) via parent container.
    // If channel name wraps to two lines, it would still fit within the button
    // but the content would be clipped or overflow.
    // Check that the channel name element stays on a single line by verifying its height
    // is less than the full button height (it should be ~1 line, not 2).
    const channelNameEl = page.locator('.topic-channel-name').first();
    const box = await channelNameEl.boundingBox();
    expect(box, 'channel name element should exist').not.toBeNull();

    // Single-line text at 13px font-size with default line-height is ~16-18px tall.
    // Two wrapped lines would be ~32-36px, exceeding the button height of 32px.
    // Allow some tolerance: channel name height must be < 28px (clearly single-line).
    expect(box!.height, 'channel name must stay on a single line (height < 28px)').toBeLessThan(28);

    // Also verify the channel name text is present and visible
    await expect(channelNameEl).toContainText('glowing-bear');
});

test('topic text truncates with ellipsis for very long topic', async () => {
    await switchToBuffer(page, '#glowing-bear');

    const longTopic = 'A'.repeat(500);
    await irc.setTopic('#glowing-bear', longTopic);
    await page.waitForTimeout(1000);

    const topicTextEl = page.locator('.topic-text').first();

    // The topic text span has `truncate` class — verify it's not overflowing the button
    const topicBox = await topicTextEl.boundingBox();
    const barBox = await page.getByTestId('topic-bar').first().boundingBox();

    expect(topicBox, 'topic text element should exist').not.toBeNull();
    expect(barBox, 'topic opener button should exist').not.toBeNull();

    // Topic text width should be less than available space within the opener button.
    // The opener button is narrower than the full topic bar (controls zone takes space on right).
    // Subtract icon + channel name + separator space from the opener button width.
    const availableWidth = (barBox!.width - 80); // subtract icon + channel name + separator + padding
    expect(topicBox!.width, 'topic text should be truncated to fit').toBeLessThan(availableWidth + 25);
});
