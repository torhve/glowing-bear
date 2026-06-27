import { test, expect } from "@playwright/test";
import {
	connectToWeechat,
	clearSettings,
	setSettings,
	waitForAppReady,
	reconnect,
} from "../helpers/connection";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";

import { setupEffectOrphanFilter } from "../helpers/pageerror";

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await page.route("**/cdnjs.cloudflare.com/**", (route) => route.abort());
	await page.goto("http://localhost:8001/");
	await waitForAppReady(page);
	await clearSettings(page);
	await setSettings(page, {
		savepassword: false,
		autoconnect: false,
		useFavico: true,
	});
	setupEffectOrphanFilter(page);
	await connectToWeechat(page);
	await waitForBuffer(page, "#glowing-bear", 15000);
	await switchToBuffer(page, "#glowing-bear");
});

test.afterAll(async () => {
	await page.close();
});

test.beforeEach(async () => {
	setupEffectOrphanFilter(page);
	// No state reset needed — each test does its own reconnect + setup.
	// FaviconBadge tests use unique identifiers to be resilient to cross-test pollution.
});

async function getFaviconHref(
	p: import("@playwright/test").Page,
): Promise<string> {
	return await p.evaluate(() => {
		const link = document.querySelector("link[rel='icon'][sizes='32x32']");
		return link?.getAttribute("href") || "";
	});
}

test("favicon badge updates when unread messages arrive on inactive buffer", async () => {
	await reconnect(page, { extraSettings: { useFavico: true } });
	await waitForBuffer(page, "#glowing-bear", 10000);
	// First absorb any existing unread by switching to the target buffer
	await switchToBuffer(page, "#glowing-bear");
	await page.waitForTimeout(500);
	// Then switch away so new messages create unread
	await switchToBuffer(page, "gbtest");

	// Send unique message to #glowing-bear to create unread
	const msgId = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await irc.sendMessage("#glowing-bear", msgId);

	// Wait for favicon to have a badge (data URL with count)
	await expect(async () => {
		const href = await getFaviconHref(page);
		// Badge favicon is a data URL, not the static /favicon.png
		expect(href.startsWith("data:")).toBe(true);
	}).toPass({ timeout: 10000, intervals: [200] });
});

test("favicon badge resets when switching to buffer with unread", async () => {
	await reconnect(page, { extraSettings: { useFavico: true } });
	await waitForBuffer(page, "#glowing-bear", 10000);
	// First absorb any existing unread by switching to the target buffer
	await switchToBuffer(page, "#glowing-bear");
	await page.waitForTimeout(500);
	// Then switch away so new messages create unread
	await switchToBuffer(page, "gbtest");

	// Send unique message to #glowing-bear to create unread
	const msgId = `fb-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await irc.sendMessage("#glowing-bear", msgId);

	// Wait for badge to appear (data URL)
	await expect(async () => {
		const href = await getFaviconHref(page);
		expect(href.startsWith("data:")).toBe(true);
	}).toPass({ timeout: 10000, intervals: [200] });

	// Switch back to #glowing-bear — this should clear unread and reset favicon
	await switchToBuffer(page, "#glowing-bear");
	await page.waitForTimeout(1000);

	// Favicon should be the default (no badge)
	const faviconHref = await getFaviconHref(page);
	expect(faviconHref).toBe("/favicon.png");
});

test("no badge drawn when favico setting is disabled", async () => {
	await reconnect(page, { extraSettings: { useFavico: false } });
	await waitForBuffer(page, "#glowing-bear", 10000);
	await switchToBuffer(page, "gbtest");

	await irc.sendMessage("#glowing-bear", "favico-disabled-test-" + Date.now());

	// Wait for message to be processed (don't check DOM since we're on gbtest buffer)
	await page.waitForTimeout(2000);

	const faviconHref = await getFaviconHref(page);
	expect(faviconHref).toBe("/favicon.png");
});

test("favico setting toggle persists", async () => {
	// Re-enable favico (was disabled by previous test)
	await setSettings(page, { useFavico: true });
	await reconnect(page);
	await waitForBuffer(page, "#glowing-bear", 10000);
	await switchToBuffer(page, "#glowing-bear");

	await page.getByTestId("settings-button").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible({
		timeout: 5000,
	});

	const checkbox = page.getByTestId("favico-checkbox");
	await expect(checkbox).toBeChecked();

	await checkbox.uncheck();
	await expect(checkbox).not.toBeChecked();

	await page.getByTestId("settings-modal-close").click();
	await expect(page.getByTestId("settings-modal")).not.toBeVisible({
		timeout: 5000,
	});

	// Reopen and verify
	await page.getByTestId("settings-button").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible({
		timeout: 5000,
	});
	await expect(checkbox).not.toBeChecked();
	await page.getByTestId("settings-modal-close").click();
});
