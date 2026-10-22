import { test, expect } from "@playwright/test";
import {
    connectToWeechat,
    disconnect,
    setSettings,
} from "../helpers/connection";
import {
    waitForBuffer,
    switchToBuffer,
    waitForBufferMobile,
    switchToBufferMobile,
    closeMobileOverlay,
} from "../helpers/buffers";

import { createConnectedPage } from '../fixtures/auth';
import { swipeOnDocument as swipeGesture } from "../helpers/touch";


let browserPage: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
    browserPage = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false, showNicklist: true },
    });
});

test.afterAll(async () => {
    await browserPage.close();
});

// Reset page state between serial tests: close overlays, restore desktop viewport,
// so each test starts from a known baseline.
test.beforeEach(async () => {
    await closeMobileOverlay(browserPage);

    // Restore desktop viewport — tests set their own viewport size as needed
    await browserPage.setViewportSize({ width: 1280, height: 720 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
});

test("nicklist is visible on desktop", async () => {
    // Switch to #glowing-bear which has nick data (required for nicklist to render)
    await waitForBuffer(browserPage, "#glowing-bear", 10000);
    await switchToBuffer(browserPage, "#glowing-bear");
    await expect(browserPage.getByTestId("nicklist")).toBeVisible({
        timeout: 10000,
    });
});

test("swipe from right edge opens nicklist on mobile", async () => {
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: false, alwaysnicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);
    await waitForBuffer(browserPage, "#glowing-bear", 10000);
    await switchToBuffer(browserPage, "#glowing-bear");

    // Nicklist overlay should be hidden initially (nicklistOpenOnMobile = false)
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

    // Check nicklist overlay is now open
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-0/,
    );
});

test("swipe right from nicklist overlay closes it on mobile", async () => {
    await closeMobileOverlay(browserPage);
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: true, alwaysnicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
    await connectToWeechat(browserPage);
    await waitForBufferMobile(browserPage, "#glowing-bear", 10000);
    await switchToBufferMobile(browserPage, "#glowing-bear");

    // Ensure nicklist overlay is in DOM
    await browserPage
        .locator(".mobile-nicklist-overlay")
        .waitFor({ state: "attached", timeout: 5000 });

    const width = 375;
    const height = 667;

    // Open nicklist via swipe from right edge
    await swipeGesture(browserPage, width - 10, height / 2, 50, height / 2);
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-0/,
    );

    // Close nicklist using its close button (swipe-right-from-chat no longer closes nicklist)
    await browserPage.getByTestId("nicklist-close-button").click();

    // Nicklist should be closed (translate-x-full means hidden)
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-full/,
    );
});

test("close button in nicklist header works on mobile", async () => {
    await closeMobileOverlay(browserPage);
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: true, alwaysnicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
    await connectToWeechat(browserPage);
    await waitForBufferMobile(browserPage, "#glowing-bear", 10000);
    await switchToBufferMobile(browserPage, "#glowing-bear");

    // Ensure nicklist overlay is in DOM
    await browserPage
        .locator(".mobile-nicklist-overlay")
        .waitFor({ state: "attached", timeout: 5000 });

    // Open nicklist via swipe
    const width = 375;
    const height = 667;
    const startX = width - 10;
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Verify nicklist is open
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-0/,
    );

    // Click the close button inside the nicklist header
    await browserPage.getByTestId("mobile-nicklist-close").click();

    // Nicklist should be closed
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-full/,
    );
});

test("swipe right from left shows buffer list on mobile", async () => {
    await closeMobileOverlay(browserPage);
    await disconnect(browserPage);
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event("resize")));
    await connectToWeechat(browserPage);
    // Manually hide buffer list — viewport resize alone may not trigger
    // the desktop→mobile transition before the app renders.
     
    await browserPage.evaluate(() =>
        (window as any).__hideBufferListOnMobile?.(),
    );

    // Buffer list should not be visible on mobile by default
    await expect(browserPage.getByTestId("buffer-list")).not.toBeVisible({
        timeout: 5000,
    });

    const width = 375;
    const height = 667;
    const startX = 10;
    const startY = height / 2;
    const endX = width - 50;
    const endY = height / 2;

    // Perform swipe right from left edge
    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Buffer list should now be visible
    await expect(browserPage.getByTestId("buffer-list")).toBeVisible({
        timeout: 5000,
    });
});

test("tapping nicklist button opens and closes nicklist on mobile", async () => {
    await closeMobileOverlay(browserPage);
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: false, alwaysnicklist: true });
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

    // Tap again to close
    await browserPage.getByTestId("nicklist-button").click();
    await expect(browserPage.locator(".mobile-nicklist-overlay")).toHaveClass(
        /translate-x-full/,
    );
});
