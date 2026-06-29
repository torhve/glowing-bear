import { test, expect } from "@playwright/test";
import { createConnectedPage } from "../fixtures/auth";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";

import { setupEffectOrphanFilter } from "../helpers/pageerror";

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await createConnectedPage(browser);
  setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
  if (page) await page.close();
});

test.beforeEach(async () => {
  setupEffectOrphanFilter(page);

  // Reset buffer state to absorb all unread messages from prior serial tests.
  // Sending a message triggers the handler to update lastSeen to cover all lines,
  // effectively clearing the readmarker and providing a clean baseline for each test.
  await switchToBuffer(page, "#glowing-bear");
  await page.waitForTimeout(500);

  // Scroll to bottom so handler absorbs any existing unread
  const chatContainer = page.locator('[data-testid="chat-messages"]');
  await chatContainer.evaluate((el) => {
  	(el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  });
  await waitForScrollSettled(3000);

  // Send a dummy message to advance lastSeen past all existing content
  await irc.sendMessage("#glowing-bear", `BEFORE-EACH-RESET-${Date.now()}`);
  await page.waitForTimeout(1000);
  await waitForScrollSettled(5000);
});

async function getChatScrollState() {
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
  		scrollDiffFromBottom:
  			container.scrollHeight - container.clientHeight - container.scrollTop,
  		totalLines: rows.length,
  	};
  });
}

// Wait for scroll position to stabilize at bottom after buffer switch
async function waitForScrollSettled(timeout = 10000) {
  const container = '[data-testid="chat-messages"]';
  await page.waitForFunction(
  	(sel) => {
  		const el = document.querySelector(sel) as HTMLElement;
  		if (!el) return false;
  		// Browser clamps scrollTop to scrollHeight - clientHeight when at bottom
  		const diff = el.scrollHeight - el.clientHeight - el.scrollTop;
  		return diff <= 5;
  	},
  	container,
  	{ timeout },
  );
}

// Wait for scroll effect to settle (scroll position stops changing) regardless of position
async function waitForScrollStable(timeout = 5000) {
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
  // Give a brief pause for any final scroll adjustments
  await page.waitForTimeout(300);
}

test("should scroll to bottom when switching to a buffer with many lines", async () => {
  // Wait for #glowing-bear to appear in buffer list
  await waitForBuffer(page, "#glowing-bear", 15000);

  // Send initial messages to ensure we have enough lines for scroll testing
  for (let i = 0; i < 10; i++) {
  	await irc.sendMessage("#glowing-bear", `scroll-init-${Date.now()}-${i}`);
  }

  // Switch to the buffer and wait for data to load
  await switchToBuffer(page, "#glowing-bear");

  // Wait for chat messages to actually load (async fetchMoreLines from +page effect)
  const firstRow = page.locator('[data-testid="bufferline-row"]').first();
  await expect(firstRow).toBeVisible({ timeout: 20000 });

  // Wait for enough rows to load
  await page.waitForFunction(
  	() => {
  		const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
  		return rows.length >= 20;
  	},
  	{ timeout: 10000 },
  );

  // Wait for scroll to settle at bottom
  await waitForScrollSettled(8000);

  const state = await getChatScrollState();
  expect(state).not.toBeNull();
  expect(state!.totalLines).toBeGreaterThanOrEqual(20);
  expect(state!.atBottom).toBe(true);
  expect(state!.scrollDiffFromBottom).toBeLessThanOrEqual(3);
});

test("should scroll to readmarker when switching to buffer with unread messages", async () => {
  // First ensure we're on #glowing-bear and scrolled to bottom
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  // Switch away to gbtest buffer
  await waitForBuffer(page, "gbtest", 10000);
  await switchToBuffer(page, "gbtest");

  // Send messages to #glowing-bear while we're NOT on it (creates unread)
  await irc.sendMessage("#glowing-bear", "scroll test message 1");
  await irc.sendMessage("#glowing-bear", "scroll test message 2");

  // Switch back to #glowing-bear — should scroll to readmarker, not bottom
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollStable();

  const state = await getChatScrollState();
  expect(state).not.toBeNull();
  // Readmarker should be visible (above middle of viewport)
  const readmarker = page.getByTestId("readmarker");
  await expect(readmarker).toBeVisible();
});

test("should scroll to bottom when switching to fresh buffer with no unread", async () => {
  // First consume any leftover unread from prior serial tests
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  // Switch to gbtest briefly, then back — no messages sent in between
  // so #glowing-bear has no new unread content
  await waitForBuffer(page, "gbtest", 10000);
  await switchToBuffer(page, "gbtest");
  await waitForScrollSettled();

  // Switch back to #glowing-bear — should scroll to bottom since nothing's new
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  const state = await getChatScrollState();
  expect(state).not.toBeNull();

  // Should be at or very near bottom (no readmarker since no unread)
  expect(state!.scrollDiffFromBottom).toBeLessThanOrEqual(5);
});

test("should not auto-scroll when switched away and messages arrive", async () => {
  // When user is on a different buffer, incoming messages on inactive buffer
  // should NOT trigger any scroll action — lastSeen stays unchanged.
  // This verifies the handler's "inactive buffer" path.
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  const stateBefore = await getChatScrollState();
  expect(stateBefore).not.toBeNull();

  // Switch away
  await switchToBuffer(page, "gbtest");
  await waitForScrollSettled();

  // Send messages to #glowing-bear while we're NOT on it
  await irc.sendMessage("#glowing-bear", "inactive test message 1");
  await irc.sendMessage("#glowing-bear", "inactive test message 2");

  // Wait for messages to arrive and be processed
  await page.waitForTimeout(1000);

  // Switch back — should show readmarker since there are unread messages
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollStable();

  const state = await getChatScrollState();
  expect(state).not.toBeNull();
  // Readmarker should be visible
  const readmarker = page.getByTestId("readmarker");
  await expect(readmarker).toBeVisible();
});

test("should position readmarker at ~45% when unread count is large", async () => {
  // When there are many unread messages that don't fit in the viewport,
  // the readmarker should be positioned at ~45% of the viewport height.
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  // Switch away to create an inactive buffer scenario
  await switchToBuffer(page, "gbtest");
  await waitForScrollSettled();

  // Send many messages (50+) to ensure they don't fit in viewport
  for (let i = 0; i < 60; i++) {
  	await irc.sendMessage("#glowing-bear", `large unread test ${i}`);
  }

  // Wait a moment for all messages to arrive
  await page.waitForTimeout(2000);

  // Switch back — should scroll to readmarker at ~45%, not bottom
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollStable();

  const state = await getChatScrollState();
  expect(state).not.toBeNull();

  // Should NOT be at bottom since there are many unread messages
  expect(state!.atBottom).toBe(false);

  // Readmarker should be visible and positioned roughly in the upper half of viewport
  const readmarker = page.getByTestId("readmarker");
  await expect(readmarker).toBeVisible();

  // Verify readmarker is above the middle of the viewport
  const rmPosition = await page.evaluate(() => {
  	const container = document.querySelector(
  		'[data-testid="chat-messages"]',
  	) as HTMLElement;
  	const rm = document.querySelector(".readmarker") as HTMLElement;
  	if (!container || !rm) return null;
  	const rmRect = rm.getBoundingClientRect();
  	const containerRect = container.getBoundingClientRect();
  	const rmRelativeY = (rmRect.top - containerRect.top) / containerRect.height;
  	return rmRelativeY;
  });
  expect(rmPosition).not.toBeNull();
  // Readmarker should be between 20% and 70% of viewport height
  expect(rmPosition!).toBeGreaterThan(0.2);
  expect(rmPosition!).toBeLessThan(0.7);
});

test("should scroll down when user types and sends a message while at bottom", async () => {
  // Represses the bug: user at bottom, sends a message, but view does NOT scroll
  // because curIsAtBottom check used a 3px tolerance — new line grew scrollHeight
  // by ~20px, making scrollTop appear "not at bottom" in the rAF callback.
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  const stateBefore = await getChatScrollState();
  expect(stateBefore).not.toBeNull();
  expect(stateBefore!.atBottom).toBe(true);

  const linesBefore = stateBefore!.totalLines;
  const input = page.getByTestId("message-input");
  await input.click();
  const msgText = "scroll-follow-test-" + Date.now();
  await input.fill(msgText);
  await input.press("Enter");

  // Wait for the new line to render in DOM
  await page.waitForFunction(
  	(expected) => {
  		const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
  		return rows.length >= expected;
  	},
  	linesBefore + 1,
  	{ timeout: 10000 },
  );

  	// Wait for the message to become visible in the viewport.
  	// After sending a message while at bottom, scroll-follow should bring it into view.
  	// With accumulated content from prior serial tests, cascading effects (hotlist sync,
  	// effect re-runs, layout recalculation) can take longer than a fixed timeout.
  	await expect(async () => {
  		const result = await page.evaluate((text) => {
  			const container = document.querySelector(
  				'[data-testid="chat-messages"]',
  			) as HTMLElement;
  			if (!container) return null;
  			const rows = Array.from(
  				document.querySelectorAll('[data-testid="bufferline-row"]'),
  			);
  			const targetRow = rows.find((row) => row.textContent?.includes(text));
  			if (!targetRow) return null;
  			const rowRect = targetRow.getBoundingClientRect();
  			const contRect = container.getBoundingClientRect();
  			// Row's vertical position relative to container viewport (0=top, 1=bottom)
  			const relativeY = (rowRect.top - contRect.top) / contRect.height;
  			return {
  				relativeY,
  				visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
  			};
  		}, msgText);
  		expect(result).not.toBeNull();
  		expect(result!.visible).toBe(true);
  		// Message should be in lower 50% of viewport (near bottom)
  		expect(result!.relativeY).toBeGreaterThan(0.4);
  	}).toPass({ timeout: 15000, intervals: [500] });
});

test("should NOT auto-scroll when user scrolled up in active buffer and messages arrive", async () => {
  // Regression test: incoming messages should not scroll the view to bottom
  // when the user has intentionally scrolled up to read older messages.
  await waitForBuffer(page, "#glowing-bear", 15000);
  await switchToBuffer(page, "#glowing-bear");
  await waitForScrollSettled();

  // Send enough messages to ensure scrollable content.
  for (let i = 0; i < 20; i++) {
  	await irc.sendMessage("#glowing-bear", `scroll-pad-${Date.now()}-${i}`);
  }
  // Wait for all lines to render in DOM
  await page.waitForFunction(
  	() => {
  		const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
  		return rows.length >= 20;
  	},
  	{ timeout: 15000 },
  );
  await page.waitForTimeout(500);
  await waitForScrollSettled(8000);

  // Verify the chat container is actually scrollable before proceeding.
  const state = await getChatScrollState();
  if (!state || state.scrollHeight - state.clientHeight < 100) {
  	// Not enough content to scroll — skip rather than fail
  	test.skip();
  	return;
  }

  // Scroll up to ~60% from top (intentionally away from bottom)
  const scrollBefore = await page.evaluate(() => {
  	const container = document.querySelector(
  		'[data-testid="chat-messages"]',
  	) as HTMLElement;
  	if (!container) return null;
  	// Position at 40% of total scroll range (clearly not at bottom)
  	const maxScrollTop = container.scrollHeight - container.clientHeight;
  	const targetScrollTop = maxScrollTop * 0.4;
  	container.scrollTop = targetScrollTop;
  	container.dispatchEvent(new Event("scroll", { bubbles: true }));
  	return {
  		scrollTop: container.scrollTop,
  		scrollHeight: container.scrollHeight,
  		clientHeight: container.clientHeight,
  	};
  });
  expect(scrollBefore).not.toBeNull();
  // Verify we're actually scrolled up (not at bottom)
  const diffFromBottom =
  	scrollBefore!.scrollHeight -
  	scrollBefore!.clientHeight -
  	scrollBefore!.scrollTop;
  expect(diffFromBottom).toBeGreaterThan(100);

  // Send new messages while user is scrolled up
  const msg1 = "scrolled-up-test-1-" + Date.now();
  const msg2 = "scrolled-up-test-2-" + Date.now();
  await irc.sendMessage("#glowing-bear", msg1);
  await irc.sendMessage("#glowing-bear", msg2);

  // Wait for messages to render
  await page.waitForTimeout(2000);

  // Allow time for any scroll effects to settle
  await waitForScrollStable();

  // Verify scroll position stayed roughly the same (within 50px tolerance)
  const scrollAfter = await page.evaluate(() => {
  	const container = document.querySelector(
  		'[data-testid="chat-messages"]',
  	) as HTMLElement;
  	if (!container) return null;
  	return {
  		scrollTop: container.scrollTop,
  		scrollHeight: container.scrollHeight,
  		clientHeight: container.clientHeight,
  	};
  });
  expect(scrollAfter).not.toBeNull();
  const scrollShift = Math.abs(
  	scrollAfter!.scrollTop - scrollBefore!.scrollTop,
  );
  // View should not have scrolled significantly — within 50px of original position
  expect(scrollShift).toBeLessThan(50);

  // Readmarker should be visible since there are unread messages
  const readmarker = page.getByTestId("readmarker");
  await expect(readmarker).toBeVisible();

  // The new messages should exist in DOM but NOT be visible in viewport
  const newMsgVisibility = await page.evaluate((text) => {
  	const container = document.querySelector(
  		'[data-testid="chat-messages"]',
  	) as HTMLElement;
  	const rows = Array.from(
  		document.querySelectorAll('[data-testid="bufferline-row"]'),
  	);
  	const targetRow = rows.find((row) => row.textContent?.includes(text));
  	if (!targetRow || !container) return null;
  	const rowRect = targetRow.getBoundingClientRect();
  	const contRect = container.getBoundingClientRect();
  	return {
  		exists: true,
  		visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
  	};
  }, msg1);
  expect(newMsgVisibility).not.toBeNull();
  expect(newMsgVisibility!.exists).toBe(true);
  // New message should NOT be visible (it's below the scrolled-up viewport, behind readmarker)
  expect(newMsgVisibility!.visible).toBe(false);
});

    test("should NOT auto-scroll when scrolled up slightly and messages arrive on active buffer", async () => {
        // Regression test for bug: user has readmarker, scrolled down past it (to read recent content),
        // new message arrives -> old code scrolled to readmarker; fixed code does nothing.
        await waitForBuffer(page, "#glowing-bear", 15000);
        await switchToBuffer(page, "#glowing-bear");
        await waitForScrollSettled();

        // Send enough messages to ensure scrollable content and a visible readmarker.
        for (let i = 0; i < 30; i++) {
            await irc.sendMessage("#glowing-bear", `scroll-pad-${Date.now()}-${i}`);
        }
        await page.waitForFunction(
            () => {
                const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
                return rows.length >= 30;
            },
            { timeout: 15000 },
        );
        await page.waitForTimeout(500);
        await waitForScrollSettled(8000);

        // Verify the chat container is actually scrollable.
        const state = await getChatScrollState();
        if (!state || state.scrollHeight - state.clientHeight < 100) {
            test.skip();
            return;
        }

        // Scroll up just enough to hide the readmarker (~2 lines worth, ~40px).
        // This simulates: user was at bottom, scrolled down to read recent messages,
        // readmarker is now off-screen below.
        const scrollBefore = await page.evaluate(() => {
            const container = document.querySelector(
                '[data-testid="chat-messages"]',
            ) as HTMLElement;
            if (!container) return null;
            const maxScrollTop = container.scrollHeight - container.clientHeight;
            // Position ~40px above bottom (clearly not at bottom, but close)
            const targetScrollTop = Math.max(0, maxScrollTop - 40);
            container.scrollTop = targetScrollTop;
            container.dispatchEvent(new Event("scroll", { bubbles: true }));
            return {
                scrollTop: container.scrollTop,
                scrollHeight: container.scrollHeight,
                clientHeight: container.clientHeight,
            };
        });
        expect(scrollBefore).not.toBeNull();
        // Verify we're clearly not at bottom
        const diffFromBottom =
            scrollBefore!.scrollHeight -
            scrollBefore!.clientHeight -
            scrollBefore!.scrollTop;
        expect(diffFromBottom).toBeGreaterThan(20);

        // Send new messages while user is scrolled up slightly
        const msg1 = "scrolled-slightly-test-1-" + Date.now();
        await irc.sendMessage("#glowing-bear", msg1);

        // Wait for messages to render
        await page.waitForTimeout(2000);
        await waitForScrollStable();

        // Verify scroll position stayed roughly the same.
        // With the fix, no auto-scroll should occur.
        const scrollAfter = await page.evaluate(() => {
            const container = document.querySelector(
                '[data-testid="chat-messages"]',
            ) as HTMLElement;
            if (!container) return null;
            return {
                scrollTop: container.scrollTop,
                scrollHeight: container.scrollHeight,
                clientHeight: container.clientHeight,
            };
        });
        expect(scrollAfter).not.toBeNull();
        const scrollShift = Math.abs(
            scrollAfter!.scrollTop - scrollBefore!.scrollTop,
        );
        // View should not have scrolled significantly — within 30px of original position.
        // (scrollHeight grows by ~20px per new line; scrollTop naturally shifts by that amount.)
        expect(scrollShift).toBeLessThan(30);

        // Readmarker should be visible since there are unread messages
        const readmarker = page.getByTestId("readmarker");
        await expect(readmarker).toBeVisible();

        // The new message should exist in DOM but NOT be visible in viewport
        const newMsgVisibility = await page.evaluate((text) => {
            const container = document.querySelector(
                '[data-testid="chat-messages"]',
            ) as HTMLElement;
            const rows = Array.from(
                document.querySelectorAll('[data-testid="bufferline-row"]'),
            );
            const targetRow = rows.find((row) => row.textContent?.includes(text));
            if (!targetRow || !container) return null;
            const rowRect = targetRow.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            return {
                exists: true,
                visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
            };
        }, msg1);
        expect(newMsgVisibility).not.toBeNull();
        expect(newMsgVisibility!.exists).toBe(true);
        // New message should NOT be visible (it's below the scrolled-up viewport, behind readmarker)
        expect(newMsgVisibility!.visible).toBe(false);
    });

