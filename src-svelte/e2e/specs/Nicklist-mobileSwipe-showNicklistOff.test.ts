import { test, expect } from "@playwright/test";
import {
	connectToWeechat,
	clearSettings,
	disconnect,
	setSettings,
	waitForAppReady,
} from "../helpers/connection";
import {
	waitForBuffer,
	switchToBuffer,
	waitForBufferMobile,
	switchToBufferMobile,
	closeMobileOverlay,
} from "../helpers/buffers";

import { setupEffectOrphanFilter } from "../helpers/pageerror";

// Inject touch event dispatcher into the page for swipe simulation.
async function injectSwipeDispatcher(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		(window as any).__swipeOnTarget = (
			target: Element,
			sx: number,
			sy: number,
			ex: number,
			ey: number,
			steps = 10,
		) => {
			const makeTouch = (x: number, y: number, id: number) =>
				new Touch({
					identifier: id,
					clientX: x,
					clientY: y,
					radiusX: 1,
					radiusY: 1,
					force: 0.5,
					target,
				});
			target.dispatchEvent(
				new TouchEvent("touchstart", {
					bubbles: true,
					cancelable: false,
					composed: true,
					touches: [makeTouch(sx, sy, 1)],
				}),
			);
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const mx = sx + (ex - sx) * t;
				const my = sy + (ey - sy) * t;
				target.dispatchEvent(
					new TouchEvent("touchmove", {
						bubbles: true,
						cancelable: false,
						composed: true,
						touches: [makeTouch(mx, my, 2)],
					}),
				);
			}
			target.dispatchEvent(
				new TouchEvent("touchend", {
					bubbles: true,
					cancelable: false,
					composed: true,
					changedTouches: [makeTouch(ex, ey, 3)],
					touches: [],
				}),
			);
		};
	});
}

// Helper to simulate a swipe gesture via touch events on document
async function swipeGesture(
	page: import("@playwright/test").Page,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
) {
	await page.evaluate(
		({ sx, sy, ex, ey }) => {
			(window as any).__swipeOnTarget(document, sx, sy, ex, ey);
		},
		{ sx: startX, sy: startY, ex: endX, ey: endY },
	);
}

let browserPage: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
	browserPage = await browser.newPage();
	await browserPage.route("**/cdnjs.cloudflare.com/**", (route) =>
		route.abort(),
	);
	await browserPage.goto("http://localhost:8001/");
	await waitForAppReady(browserPage);
	await clearSettings(browserPage);
	await setSettings(browserPage, {
		savepassword: false,
		autoconnect: false,
		showNicklist: false,
	});
	await injectSwipeDispatcher(browserPage);
	setupEffectOrphanFilter(browserPage);
});

test.afterAll(async () => {
	await browserPage.close();
});

// Reset page state between serial tests: close overlays, restore desktop viewport,
// so each test starts from a known baseline.
test.beforeEach(async () => {
	setupEffectOrphanFilter(browserPage);
	await closeMobileOverlay(browserPage);

	// Restore desktop viewport — tests set their own viewport size as needed
	await browserPage.setViewportSize({ width: 1280, height: 720 });
	await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
});

// When "show nicklist" is off in settings, swiping from right edge on mobile should still open the nicklist overlay with actual nick data visible.
test("swipe from right opens nicklist with content even when showNicklist is off", async () => {
	await setSettings(browserPage, {
		showNicklist: false,
		alwaysnicklist: false,
	});
	await browserPage.setViewportSize({ width: 375, height: 667 });
	await connectToWeechat(browserPage);
	// Switch to #glowing-bear which has nick data
	await waitForBuffer(browserPage, "#glowing-bear", 10000);
	await switchToBuffer(browserPage, "#glowing-bear");

	// Set back to mobile viewport after desktop-based buffer switch
	await browserPage.setViewportSize({ width: 375, height: 667 });
	await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));

	// On mobile, the nicklist overlay should be present in DOM (because buffer has nick data)
	await browserPage
		.locator(".mobile-nicklist-overlay")
		.waitFor({ state: "attached", timeout: 10000 });

	// Nicklist overlay should be hidden initially
	await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
		/translate-x-full/,
	);

	const width = 375;
	const height = 667;
	const startX = width - 10; // near right edge
	const startY = height / 2;
	const endX = 50;
	const endY = height / 2;

	// Perform swipe left from right edge to open nicklist
	await swipeGesture(browserPage, startX, startY, endX, endY);

	// Nicklist overlay should now be visible
	await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
		/translate-x-0/,
	);

	// The nicklist content should be rendered inside the overlay even though showNicklist is off
	// Check that the nicklist-items container is present and contains nick items
	await expect(browserPage.getByTestId("nicklist-items")).toBeVisible({
		timeout: 5000,
	});
	const nickCount = await browserPage.getByTestId("nick-item").count();
	expect(nickCount).toBeGreaterThan(0);
});

// When "show nicklist" is off, tapping the nicklist button on mobile should also open the nicklist with content.
test("tapping nicklist button opens nicklist with content when showNicklist is off", async () => {
	await closeMobileOverlay(browserPage);
	await disconnect(browserPage);
	await setSettings(browserPage, {
		showNicklist: false,
		alwaysnicklist: false,
	});
	await browserPage.setViewportSize({ width: 375, height: 667 });
	await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
	await connectToWeechat(browserPage);
	await waitForBufferMobile(browserPage, "#glowing-bear", 10000);
	await switchToBufferMobile(browserPage, "#glowing-bear");

	// Ensure nicklist overlay is in DOM
	await browserPage
		.locator(".mobile-nicklist-overlay")
		.waitFor({ state: "attached", timeout: 5000 });

	// Nicklist overlay should be hidden initially
	await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
		/translate-x-full/,
	);

	// Tap nicklist button in topbar to open
	await browserPage.getByTestId("nicklist-button").click();
	await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
		/translate-x-0/,
	);

	// The nicklist content should be rendered inside the overlay even though showNicklist is off
	await expect(browserPage.getByTestId("nicklist-items")).toBeVisible({
		timeout: 5000,
	});
	const nickCount2 = await browserPage.getByTestId("nick-item").count();
	expect(nickCount2).toBeGreaterThan(0);

	// Tap again to close
	await browserPage.getByTestId("nicklist-button").click();
	await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
		/translate-x-full/,
	);
});

// On desktop, when "show nicklist" is off, the nicklist should NOT be visible (desktop behavior unchanged).
test("desktop nicklist remains hidden when showNicklist is off", async () => {
	await disconnect(browserPage);
	await setSettings(browserPage, {
		showNicklist: false,
		alwaysnicklist: false,
	});
	await browserPage.setViewportSize({ width: 1280, height: 720 });
	await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
	await connectToWeechat(browserPage);
	await waitForBuffer(browserPage, "#glowing-bear", 10000);
	// Let layout settle after connection before clicking buffer items
	await browserPage.waitForTimeout(500);
	await switchToBuffer(browserPage, "#glowing-bear");

	// Desktop nicklist should NOT be visible when showNicklist is off
	await expect(browserPage.getByTestId("nicklist")).not.toBeVisible({
		timeout: 5000,
	});
});
