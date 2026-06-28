import { test, expect } from "@playwright/test";
import {
	connectToWeechat,
	clearSettings,
	waitForAppReady,
} from "../helpers/connection";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";

import { setupEffectOrphanFilter } from "../helpers/pageerror";

async function connect(page: import("@playwright/test").Page) {
	await clearSettings(page);
	await connectToWeechat(page);
}

async function getChatScrollState(page: import("@playwright/test").Page) {
	return await page.evaluate(() => {
		const container = document.querySelector(
			'[data-testid="chat-messages"]',
		) as HTMLElement;
		if (!container) return null;
		const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
		return {
			scrollTop: container.scrollTop,
			scrollHeight: container.scrollHeight,
			clientHeight: container.clientHeight,
			atBottom:
				container.scrollTop >=
				container.scrollHeight - container.clientHeight - 3,
			totalLines: rows.length,
		};
	});
}

async function waitForScrollStable(
	page: import("@playwright/test").Page,
	timeout = 5000,
) {
	await page.waitForFunction(
		() => {
			const el = document.querySelector(
				'[data-testid="chat-messages"]',
			) as HTMLElement;
			if (!el) return false;
			const currentScrollTop = el.scrollTop;
			return currentScrollTop !== undefined && currentScrollTop >= 0;
		},
		{ timeout },
	);
	await page.waitForTimeout(300);
}

test.describe("PageUp/PageDown Global Scroll", () => {
	test.beforeEach(async ({ page }) => {
		setupEffectOrphanFilter(page);
		await page.goto("http://localhost:8001/");
		await waitForAppReady(page);
		await connect(page);
		await waitForBuffer(page, "#glowing-bear", 15000);
		await switchToBuffer(page, "#glowing-bear");
		// Absorb any existing unread from cross-test pollution by sending a message.
		// This advances lastSeen past all existing content, clearing the readmarker.
		await page.waitForTimeout(500);
		await irc.sendMessage("#glowing-bear", `KB-RESET-${Date.now()}`);
		// Wait for auto-scroll to bottom after our reset message.
		// With accumulated content from many prior serial tests, rendering can take
		// a long time. Use generous timeout and tolerance.
		await page.waitForFunction(
			() => {
				const container = document.querySelector(
					'[data-testid="chat-messages"]',
				) as HTMLElement;
				if (!container) return false;
				const diff =
					container.scrollHeight - container.clientHeight - container.scrollTop;
				return diff <= 100;
			},
			{ timeout: 30000 },
		);
	});

	test("PageUp should scroll chat up when focus is outside input", async ({
		page,
	}) => {
		// Send enough messages to have content to scroll
		for (let i = 0; i < 20; i++) {
			await irc.sendMessage("#glowing-bear", `pageup-test-${Date.now()}-${i}`);
		}
		// Wait for auto-scroll to settle at bottom after messages arrive.
		// With accumulated content from prior serial tests, use generous tolerance.
		await page.waitForFunction(
			() => {
				const container = document.querySelector(
					'[data-testid="chat-messages"]',
				) as HTMLElement;
				if (!container) return false;
				const diff =
					container.scrollHeight - container.clientHeight - container.scrollTop;
				return diff <= 100;
			},
			{ timeout: 30000 },
		);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();
		expect(stateBefore!.atBottom).toBe(true);

		// Ensure focus is NOT in the input (click on chat view area)
		await page.getByTestId("chat-view").click();

		// Press PageUp — should scroll up
		await page.keyboard.press("PageUp");
		await waitForScrollStable(page);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBeLessThan(stateBefore!.scrollTop);
	});

	test("PageDown should scroll chat down when focus is outside input", async ({
		page,
	}) => {
		// Send enough messages to have content
		for (let i = 0; i < 30; i++) {
			await irc.sendMessage(
				"#glowing-bear",
				`pagedown-test-${Date.now()}-${i}`,
			);
		}
		await page.waitForTimeout(2000);

		// First scroll all the way to top
		const chatContainer = page.locator('[data-testid="chat-messages"]');
		await chatContainer.evaluate((el) => {
			el.scrollTop = 0;
		});
		await waitForScrollStable(page);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();
		expect(stateBefore!.atBottom).toBe(false);

		// Press PageDown — should scroll down
		await page.getByTestId("chat-view").click();
		await page.keyboard.press("PageDown");
		await waitForScrollStable(page);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBeGreaterThan(stateBefore!.scrollTop);
	});

	test("PageUp should still work when focus is in message input", async ({
		page,
	}) => {
		for (let i = 0; i < 20; i++) {
			await irc.sendMessage(
				"#glowing-bear",
				`input-pgup-test-${Date.now()}-${i}`,
			);
		}
		await page.waitForTimeout(2000);

		// Scroll to top first
		const chatContainer = page.locator('[data-testid="chat-messages"]');
		await chatContainer.evaluate((el) => {
			el.scrollTop = 0;
		});
		await waitForScrollStable(page);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();

		// Focus the input and press PageUp
		const input = page.getByTestId("message-input");
		await input.click();
		await input.press("PageUp");
		await waitForScrollStable(page);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBeLessThan(stateBefore!.scrollTop);
	});

	test("PageUp should work when focus is on nicklist", async ({ page }) => {
		for (let i = 0; i < 15; i++) {
			await irc.sendMessage(
				"#glowing-bear",
				`nicklist-pgup-test-${Date.now()}-${i}`,
			);
		}
		// Wait for auto-scroll to settle at bottom after messages arrive
		await page.waitForFunction(
			() => {
				const container = document.querySelector(
					'[data-testid="chat-messages"]',
				) as HTMLElement;
				if (!container) return false;
				const diff =
					container.scrollHeight - container.clientHeight - container.scrollTop;
				return diff <= 50;
			},
			{ timeout: 15000 },
		);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();
		expect(stateBefore!.atBottom).toBe(true);

		// Click on nicklist to put focus there
		await page.getByTestId("nicklist").click();
		await page.keyboard.press("PageUp");
		await waitForScrollStable(page);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBeLessThan(stateBefore!.scrollTop);
	});

	test("PageUp should not scroll when focus is in a native INPUT element", async ({
		page,
	}) => {
		for (let i = 0; i < 15; i++) {
			await irc.sendMessage(
				"#glowing-bear",
				`input-skip-test-${Date.now()}-${i}`,
			);
		}
		await page.waitForTimeout(2000);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();

		// Create a temporary INPUT element and focus it
		await page.evaluate(() => {
			const input = document.createElement("input");
			input.type = "text";
			input.id = "temp-input";
			input.style.position = "absolute";
			input.style.left = "-9999px";
			document.body.appendChild(input);
			input.focus();
		});

		await page.keyboard.press("PageUp");
		await page.waitForTimeout(300);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBe(stateBefore!.scrollTop);

		// Cleanup
		await page.evaluate(() => {
			const el = document.getElementById("temp-input");
			el?.remove();
		});
	});

	test("PageUp with Ctrl modifier should not scroll via global handler", async ({
		page,
	}) => {
		for (let i = 0; i < 15; i++) {
			await irc.sendMessage(
				"#glowing-bear",
				`modifier-test-${Date.now()}-${i}`,
			);
		}
		await page.waitForTimeout(2000);

		const stateBefore = await getChatScrollState(page);
		expect(stateBefore).not.toBeNull();

		// Press Ctrl+PageUp — should NOT scroll due to modifier guard
		await page.getByTestId("chat-view").click();
		await page.keyboard.press("Control+PageUp");
		await page.waitForTimeout(300);

		const stateAfter = await getChatScrollState(page);
		expect(stateAfter).not.toBeNull();
		expect(stateAfter!.scrollTop).toBe(stateBefore!.scrollTop);
	});
});
