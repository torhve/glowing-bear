import { test, expect } from "@playwright/test";
import { createConnectedPage } from "../fixtures/auth";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";

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
              container.scrollHeight - container.clientHeight - 200,
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


// Poll until chat is scrolled to bottom, respecting a proper timeout.
// Playwright's actionTimeout overrides waitForFunction's inline timeout,
// so we implement our own retry loop here.
async function waitForAtBottom(
    page: import("@playwright/test").Page,
    timeout = 60000,
) {
    // Scroll to bottom directly — more reliable than waiting for auto-scroll,
    // which has complex readmarker logic that can prevent reaching bottom on large buffers.
    await page.evaluate(() => {
        const c = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (c) c.scrollTop = c.scrollHeight;
    });
    // Settle delay for ChatView's double-rAF auto-scroll effects.
    // On large buffers, rendering takes time. Wait 2s then re-scroll to bottom
    // to ensure we're truly at bottom after all effects settle.
    await page.waitForTimeout(2000);
    // Re-scroll to bottom after effects settle
    await page.evaluate(() => {
        const c = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (c) c.scrollTop = c.scrollHeight;
    });
    await page.waitForTimeout(500);
}

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.describe("PageUp/PageDown Global Scroll", () => {
    test.beforeEach(async ({ browser }) => {
        if (page) await page.close().catch(() => {});
        page = await createConnectedPage(browser);
        await waitForBuffer(page, "#glowing-bear", 15000);
        await switchToBuffer(page, "#glowing-bear");
        // Absorb any existing unread from cross-test pollution by sending a message.
        // This advances lastSeen past all existing content, clearing the readmarker.
        await page.waitForTimeout(500);
        await irc.sendMessage("#glowing-bear", `KB-RESET-${Date.now()}`);
        // Wait for auto-scroll to bottom after our reset message.
        // With accumulated content from many prior serial tests, rendering can take
        // a long time. Use generous timeout and tolerance.
        await waitForAtBottom(page, 60000);
    });

    test("PageUp should scroll chat up when focus is outside input", async () => {
        // Send enough messages to have content to scroll
        for (let i = 0; i < 20; i++) {
            await irc.sendMessage("#glowing-bear", `pageup-test-${Date.now()}-${i}`);
        }
        // Wait for auto-scroll to settle at bottom after messages arrive.
        // With accumulated content from prior serial tests, use generous tolerance.
        await waitForAtBottom(page, 60000);

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

    test("PageDown should scroll chat down when focus is outside input", async () => {
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

    test("PageUp should still work when focus is in message input", async () => {
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

    test("PageUp should work when focus is on nicklist", async () => {
        for (let i = 0; i < 15; i++) {
            await irc.sendMessage(
                "#glowing-bear",
                `nicklist-pgup-test-${Date.now()}-${i}`,
            );
        }
        // Wait for auto-scroll to settle at bottom after messages arrive
        await waitForAtBottom(page, 30000);
      

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

    test("PageUp should not scroll when focus is in a native INPUT element", async () => {
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

    test("PageUp with Ctrl modifier should not scroll via global handler", async () => {
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
