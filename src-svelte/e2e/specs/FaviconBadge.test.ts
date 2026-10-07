import { test, expect } from "@playwright/test";
import { setSettings, reconnect } from "../helpers/connection";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";
import { createConnectedPage } from "../fixtures/auth";
import { absorbAllUnread, waitForUnreadAtLeast } from "../helpers/waits";
import { clearServerHotlist } from "../helpers/relay-admin";

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false, useFavico: true },
    });
    await waitForBuffer(page, "#glowing-bear", 15000);
    await switchToBuffer(page, "#glowing-bear");
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
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
    // Server-side first: the badge counts global notifications, and a hotlist entry this
    // spec cannot absorb (a buffer no longer in its list) would keep a badge painted
    // through the whole run. reconnect() then re-reads a hotlist we know is empty.
    await clearServerHotlist();
    await reconnect(page, { extraSettings: { useFavico: true } });
    await waitForBuffer(page, "#glowing-bear", 10000);
    // The badge is global and notifications outrank unread in it, so the empty baseline has
    // to be created rather than assumed: gbtest persists across runs, and a leftover PM
    // notification keeps a badge painted no matter what this test does next.
    await absorbAllUnread(page);
    await switchToBuffer(page, "gbtest");
    // Without this the assertion below is vacuous: a badge left over from another spec would
    // satisfy "it is a data URL" on its own.
    await expect
        .poll(() => getFaviconHref(page), { timeout: 10000, intervals: [200] })
        .toBe("/favicon.png");

    // Send unique message to #glowing-bear to create unread
    const msgId = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await irc.sendMessage("#glowing-bear", msgId);
    await waitForUnreadAtLeast(page, "#glowing-bear", 1);

    // Wait for favicon to have a badge (data URL with count)
    await expect(async () => {
        const href = await getFaviconHref(page);
        // Badge favicon is a data URL, not the static /favicon.png
        expect(href.startsWith("data:")).toBe(true);
    }).toPass({ timeout: 10000, intervals: [200] });
});

test("favicon badge resets when switching to buffer with unread", async () => {
    await clearServerHotlist();
    await reconnect(page, { extraSettings: { useFavico: true } });
    await waitForBuffer(page, "#glowing-bear", 10000);
    await absorbAllUnread(page);
    await switchToBuffer(page, "gbtest");
    await expect
        .poll(() => getFaviconHref(page), { timeout: 10000, intervals: [200] })
        .toBe("/favicon.png");

    // Send unique message to #glowing-bear to create unread
    const msgId = `fb-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await irc.sendMessage("#glowing-bear", msgId);

    // Wait for badge to appear (data URL), with the unread itself confirmed first
    await waitForUnreadAtLeast(page, "#glowing-bear", 1);
    await expect(async () => {
        const href = await getFaviconHref(page);
        expect(href.startsWith("data:")).toBe(true);
    }).toPass({ timeout: 10000, intervals: [200] });

    // Switch back to #glowing-bear — this should clear unread and reset favicon
    await switchToBuffer(page, "#glowing-bear");
    // Favicon should return to the default (no badge) once the unread clears.
    await expect(async () => {
        const href = await getFaviconHref(page);
        expect(href).toBe("/favicon.png");
    }).toPass({ timeout: 10000, intervals: [200] });
});

test("no badge drawn when favico setting is disabled", async () => {
    await reconnect(page, { extraSettings: { useFavico: false } });
    await waitForBuffer(page, "#glowing-bear", 10000);
    await absorbAllUnread(page);
    await switchToBuffer(page, "gbtest");

    await irc.sendMessage("#glowing-bear", "favico-disabled-test-" + Date.now());

    // The unread badge is the app's own record that the line arrived. Once it is there,
    // the favicon check below is a real negative instead of a guess at timing.
    await waitForUnreadAtLeast(page, "#glowing-bear", 1);

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
