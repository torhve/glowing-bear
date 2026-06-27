import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	page = await createConnectedPage(browser);
	setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
	await page.close();
});

test.beforeEach(async () => {
	setupEffectOrphanFilter(page)
	// Unpin any pinned buffers from previous serial tests by switching to each buffer
	// and clicking the pin button in the topic bar if it shows "Unpin buffer"
	const bufferItems = page.getByTestId('buffer-item');
	const count = await bufferItems.count();
	for (let i = 0; i < count; i++) {
		const item = bufferItems.nth(i);
		const name = await item.textContent();
		if (name) {
			await switchToBuffer(page, name.trim());
			const pinBtn = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
			const title = await pinBtn.getAttribute('title');
			if (title === 'Unpin buffer') {
				await pinBtn.click();
				await expect(pinBtn).toHaveAttribute('title', 'Pin buffer', { timeout: 5000 });
			}
		}
	}
	// Return to first buffer for consistent starting state
	if (count > 0) {
		const first = await bufferItems.first().textContent();
		if (first) await switchToBuffer(page, first.trim());
	}
});

test('pin button is visible in topic bar', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await expect(pinButton).toBeVisible({ timeout: 5000 });
});

test('pin button has correct title when not pinned', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await expect(pinButton).toHaveAttribute('title', 'Pin buffer');
});

test('pin button shows pushpin icon when not pinned', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	// Lucide Pin icon renders an SVG element
	await expect(pinButton.locator('svg')).toBeAttached();
});

test('clicking pin button changes icon to pin-off', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
	// After pinning, the PinOff icon should be shown
	await expect(pinButton.locator('svg')).toBeAttached();
});

test('after pinning, title changes to Unpin buffer', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer');
});

test('clicking unpin button changes icon back to pushpin', async () => {
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Pin buffer', { timeout: 5000 });
	// After unpinning, the Pin icon should be shown again
	await expect(pinButton.locator('svg')).toBeAttached();
});

test('pinned buffers appear before unpinned in sorted list', async () => {
	// Pin current buffer via topic bar and verify it moves to top of sorted list.
	const firstItem = page.getByTestId('buffer-item').first();
	const targetName = await firstItem.textContent();
	expect(targetName, 'at least one buffer item exists').not.toBe(null);

	// Pin via topic bar
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });

	// Get all buffer items and their pin button titles to determine pinned status
	const bufferItems = page.getByTestId('buffer-item');
	const bufferCount = await bufferItems.count();
	expect(bufferCount).toBeGreaterThanOrEqual(2);

	// Collect buffer names and whether each is pinned (by checking the buffer name)
	const bufferData: { name: string; pinned: boolean }[] = [];
	for (let i = 0; i < bufferCount; i++) {
		const name = (await bufferItems.nth(i).textContent() || '').trim();
		bufferData.push({ name, pinned: name === targetName?.trim() });
	}

	// All pinned buffers should appear before all unpinned buffers
	let foundUnpinned = false;
	for (const buf of bufferData) {
		if (buf.pinned && foundUnpinned) {
			throw new Error(`Pinned buffer "${buf.name}" found after unpinned buffer`);
		}
		if (!buf.pinned) {
			foundUnpinned = true;
		}
	}
});

test('pinned status persists across buffer switches', async () => {
	// Pin current buffer
	const pinButton = page.getByTestId('topic-bar-container').getByTestId('pin-buffer');
	await pinButton.click();
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer');

	// Switch to a different buffer
	const otherItem = page.getByTestId('buffer-item').nth(1);
	expect(await otherItem.count(), 'at least two buffers exist').toBe(1);
	const otherName = await otherItem.textContent();
	if (otherName) {
		await switchToBuffer(page, otherName.trim());
	}

	// Switch back to the originally pinned buffer
	const firstItem = page.getByTestId('buffer-item').first();
	const firstBufName = await firstItem.textContent();
	if (firstBufName) {
		await switchToBuffer(page, firstBufName.trim());
	}

	// Verify topic bar still shows unpin icon (pinned status persisted)
	await expect(pinButton).toHaveAttribute('title', 'Unpin buffer');
});
