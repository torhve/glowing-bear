import { test, expect } from "@playwright/test";
import { createConnectedPage } from "../fixtures/auth";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";
import { waitForChatSettled } from "../helpers/waits";

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
    await waitForChatSettled(page);
}

// Bring the chat to the true bottom and leave it there.
//
// The follow pin loop and its settle window must be over first: an in-flight pin
// re-anchors the view and would undo a later deliberate scroll-up. Then re-scroll on
// each poll until the view reports the bottom, because auto-scroll has readmarker
// logic that can hold a large buffer short of it — the corrective scroll is part of the
// wait instead of a fallback sleep.
async function waitForAtBottom(
    page: import("@playwright/test").Page,
    timeout = 60000,
) {
    await waitForChatSettled(page, 300, timeout);
    await expect
        .poll(
            async () => {
                await page.evaluate(() => {
                    const c = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
                    if (c) c.scrollTop = c.scrollHeight;
                });
                return page.evaluate(() => {
                    const c = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
                    if (!c) return false;
                    return c.scrollTop >= c.scrollHeight - c.clientHeight - 200;
                });
            },
            { timeout },
        )
        .toBe(true);
}

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.describe("PageUp/PageDown Global Scroll", () => {
    // One shared connection for the whole file — all tests assert relative
    // scroll positions, so there is no need to pay for a fresh page + WeeChat
    // connect per test.
    test.beforeAll(async ({ browser }) => {
        page = await createConnectedPage(browser);
        await waitForBuffer(page, "#glowing-bear", 15000);
        await switchToBuffer(page, "#glowing-bear");
        // Absorb any existing unread by sending a message: this advances
        // lastSeen past all existing content, clearing the readmarker for the
        // whole file.
        await irc.sendMessage("#glowing-bear", `KB-RESET-${Date.now()}`);
        await waitForAtBottom(page, 60000);
    });

    test.afterAll(async () => {
        if (page) await page.close().catch(() => {});
    });

    // Wait for the last of a flood of messages to render in the DOM.
    async function waitForLastMessage(text: string) {
        await expect(
            page.locator('[data-testid="bufferline-row"]').filter({ hasText: text }).first(),
        ).toBeVisible({ timeout: 15000 });
    }

    test("PageUp should scroll chat up when focus is outside input", async () => {
        // Send enough messages to have content to scroll
        let last = "";
        for (let i = 0; i < 20; i++) {
            last = `pageup-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render, then for auto-scroll to settle at bottom
        await waitForLastMessage(last);
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
        let last = "";
        for (let i = 0; i < 60; i++) {
            last = `pagedown-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render
        await waitForLastMessage(last);

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
        let last = "";
        for (let i = 0; i < 20; i++) {
            last = `input-pgup-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render
        await waitForLastMessage(last);

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
        let last = "";
        for (let i = 0; i < 15; i++) {
            last = `nicklist-pgup-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render, then for auto-scroll to settle at bottom
        await waitForLastMessage(last);
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
        let last = "";
        for (let i = 0; i < 15; i++) {
            last = `input-skip-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render
        await waitForLastMessage(last);

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
        // The settle window is the interval in which a scroll would have happened; the
        // position is asserted after it closes.
        await waitForChatSettled(page);

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
        let last = "";
        for (let i = 0; i < 15; i++) {
            last = `modifier-test-${Date.now()}-${i}`;
            await irc.sendMessage("#glowing-bear", last);
        }
        // Wait for the last message to render
        await waitForLastMessage(last);

        const stateBefore = await getChatScrollState(page);
        expect(stateBefore).not.toBeNull();

        // Press Ctrl+PageUp — should NOT scroll due to modifier guard
        await page.getByTestId("chat-view").click();
        await page.keyboard.press("Control+PageUp");
        await waitForChatSettled(page);

        const stateAfter = await getChatScrollState(page);
        expect(stateAfter).not.toBeNull();
        expect(stateAfter!.scrollTop).toBe(stateBefore!.scrollTop);
    });
});
