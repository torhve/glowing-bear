import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { describeAppState, readAppState } from "./appState";
import { relayBufferNames } from "./relay-admin";

// Buffer list displays trimmedName (stripped of #, &, etc.), so match against that.
function getBufferText(name: string): string {
    return name.replace(/^[#&!+@]+/, "");
}

// Exact-name locator: matches the .buffer-name span's full text, so a buffer called
// "glow" can no longer resolve to "glowing-bear" (or a badge's digits to a name).
export function bufferItemForName(page: Page, name: string) {
    const exact = new RegExp("^" + getBufferText(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
    return page
        .getByTestId("buffer-item")
        .filter({ has: page.locator(".buffer-name").filter({ hasText: exact }) });
}

/**
 * What the sidebar and the fixture really hold, for a row that never appeared.
 *
 * Both waits below look for the same locator, and only one of them reported anything
 * beyond a Playwright timeout. The sidebar rows separate "the buffer arrived under
 * another name" from "there is no such row". The relay's own list separates "the client
 * never heard of this buffer" from "the fixture does not have it" — a spec waiting for a
 * buffer another spec creates reads exactly like a lost sync, and did.
 */
async function missingRowReport(page: Page, name: string, timeout: number): Promise<string> {
    const present = await page
        .locator('[data-testid="buffer-item"] .buffer-name')
        .allTextContents();
    // A fixture that has gone answers late or not at all. A diagnostic must not replace
    // the failure it describes with a helper failure of its own, so this is bounded and
    // every error path returns text.
    const relayList = await Promise.race([
        relayBufferNames().then(
            (names) => names.join(", "),
            () => "unreadable",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("read timed out"), 2000)),
    ]).catch(() => "unreadable");
    return (
        `no sidebar row named "${name}" within ${timeout}ms; rows present: ` +
        `${present.join(", ") || "(none)"}; relay buffers: ${relayList} — ${await describeAppState(page)}`
    );
}

export async function waitForBuffer(page: Page, name: string, timeout = 10000) {
    const item = bufferItemForName(page, name).first();
    try {
        await item.waitFor({ state: "visible", timeout });
    } catch (error) {
        throw new Error(await missingRowReport(page, name, timeout), { cause: error });
    }
}

export async function switchToBuffer(
    page: Page,
    name: string,
    opts?: { timeout?: number },
) {
    const bufferItem = bufferItemForName(page, name).first();

    // Wait for element to be stable before clicking — prevents "element not stable" failures
    // that occur after viewport changes, reconnections, or other DOM-mutating operations.
    try {
        await bufferItem.waitFor({
            state: "visible",
            timeout: opts?.timeout ?? 10000,
        });
    } catch (error) {
        throw new Error(await missingRowReport(page, name, opts?.timeout ?? 10000), { cause: error });
    }
    try {
        await bufferItem.click({ timeout: opts?.timeout ?? 10000 });
    } catch (error) {
        // A click that never lands is usually a symptom the locator cannot see. Say what the app
        // was actually doing, because "TimeoutError: locator.click" is not the information a
        // reader needs: an app already sitting on the connect form with an empty sidebar produces
        // this exact timeout, and reads completely differently.
        const observed = await readAppState(page).catch(
            () => "app state unreadable (page navigating or closed)",
        );
        throw new Error(
            `switchToBuffer(${name}): the click on its sidebar row never landed — ${observed}`,
            { cause: error },
        );
    }
    // Check only the channel-name span — topic bar shows "{shortName} - {topicText}" format
    // so matching against the full element text can fail when topic contains similar substrings.
    await expect(page.getByTestId("topic-bar").locator(".topic-channel-name")).toContainText(
        getBufferText(name),
        { timeout: opts?.timeout ?? 10000 },
    );
}

// On mobile viewports the buffer list hides after selection. This variant
// temporarily widens the viewport so the buffer list shows, switches buffers,
// then restores the original viewport size. Since the buffer click happens
// at desktop viewport, hideBufferListOnMobile isn't triggered (it checks
// isMobileState). So we manually hide the buffer list after restoring mobile.
export async function switchToBufferMobile(page: Page, name: string) {
    const orig = (await page.viewportSize()) || { width: 375, height: 667 };
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page
        .getByTestId("buffer-item")
        .first()
        .waitFor({ state: "visible", timeout: 5000 });
    await switchToBuffer(page, name);
    // Restore mobile viewport — resize listener updates isMobileState
    // and may show buffer list on desktop→mobile transition.
    await page.setViewportSize(orig);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    // Manually hide buffer list since the click happened at desktop viewport
    // where hideBufferListOnMobile wasn't triggered.
    await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());
    await expect(page.getByTestId("buffer-list")).not.toBeAttached();
}

// Like waitForBuffer but safe for mobile: widens viewport so the buffer list
// shows, waits for the buffer to appear, then restores the original viewport.
export async function waitForBufferMobile(
    page: Page,
    name: string,
    timeout = 10000,
) {
    const orig = (await page.viewportSize()) || { width: 375, height: 667 };
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page
        .getByTestId("buffer-item")
        .first()
        .waitFor({ state: "visible", timeout: 5000 });
    await waitForBuffer(page, name, timeout);
    await page.setViewportSize(orig);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
}

// Safely close any open mobile overlay (nicklist or buffer list).
// Checks element existence before attempting interaction — no-op when overlay is absent.
export async function closeMobileOverlay(page: Page) {
    const overlayCount = await page.locator(".mobile-nicklist-overlay").count();
    if (overlayCount > 0) {
        const overlayClass = await page
            .locator(".mobile-nicklist-overlay")
            .getAttribute("class");
        if (overlayClass?.includes("translate-x-0")) {
            await page
                .getByTestId("nicklist-close-button")
                .click()
                .catch(() => {});
        }
    }
    // Also close mobile buffer list overlay if open
    const blCount = await page.locator(".mobile-buffer-list-overlay").count();
    if (blCount > 0) {
        await page
            .getByTestId("buffer-list-close")
            .click()
            .catch(() => {});
    }
}
