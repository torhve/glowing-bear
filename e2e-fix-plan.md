# E2E Test Fix Plan

Generated: 2026-06-28

Full run of 48 E2E spec files: **41 passed, 7 failed** (plus 1 intentionally skipped).

## Task 1: Fix ReadMarker-scrollOnPost — own message not visible after posting with readmarker present

**Spec:** `src-svelte/e2e/specs/ReadMarker-scrollOnPost.test.ts`
**Failed test:** "should scroll to bottom when posting own message while readmarker is present" (line 71)

**Error:** `expect(msgVisibility!.visible).toBe(true)` → Received: `false`

The user's echoed message is not visible in the viewport after sending it. The view does NOT scroll to bottom when a readmarker is present.

**Reproduction flow:**

1. Switch to `gbtest` buffer
2. Bot sends 2 messages to `#glowing-bear` (creates unread)
3. Switch back to `#glowing-bear` — readmarker appears
4. User sends a message via input bar
5. View should scroll to bottom so echoed message is visible near bottom

**Likely cause:** ChatView scroll logic (`$lib/stores/` or `ChatView.svelte`) may skip auto-scroll-to-bottom when a readmarker exists. The "scroll on post" behavior likely checks for readmarker presence and incorrectly decides not to scroll.

**Check:** ChatView scroll handlers, readmarker interaction with auto-scroll, `$effect` scroll logic.

---

## Task 2: Fix Notifications — sound does not play on highlight when enabled

**Spec:** `src-svelte/e2e/specs/Notifications.test.ts`
**Failed test:** "sound plays when soundnotification is enabled" (line 154)

**Error:** `expect(audioCalls).toContain('/assets/audio/sonar.mp3')` → Audio constructor was never called.

**Cascading impact:** 11 subsequent tests did not run.

**Reproduction flow:**

1. Enable `soundnotification` setting
2. Reload page, connect to WeeChat
3. Switch to `#glowing-bear`
4. Send PM to `testuser` (triggers `notify_private` → `playNotificationSound`)
5. Expect `Audio('/assets/audio/sonar.mp3')` to be constructed

**Likely cause:** The `playNotificationSound()` function in `$lib/notifications.ts` either isn't being called by the notification handler for PM highlights, or the `soundnotification` setting check fails. Could also be that the `notify_private` flag on the line doesn't trigger the notification path.

**Check:** `$lib/notifications.ts` (playNotificationSound), notification dispatch logic in handlers, whether PM highlights produce the correct `notification` flag on lines.

---

## Task 3: Fix Nicklist-search — search input not visible or not filtering nicks

**Spec:** `src-svelte/e2e/specs/Nicklist-search.test.ts`
**Failed test:** "nicklist search filters nicks by name" (line 40)

**Error:** `await expect(searchInput).toBeVisible()` fails — the element with `data-testid="nicklist-search"` is not found or not visible.

**Cascading impact:** 2 subsequent tests did not run.

**Likely cause:** Either:

- The nicklist search input doesn't have `data-testid="nicklist-search"` (wrong or missing attribute)
- The nicklist panel isn't open/visible when the test runs (showNicklist setting default may be off)

**Check:** `Nicklist.svelte` for the search input's `data-testid`. Verify the nicklist is shown by default in the test setup, or that the test opens it before searching.

---

## Task 4: Fix KeyboardShortcuts-pageup-pagedown — PageDown scroll and PageUp from nicklist focus broken

**Spec:** `src-svelte/e2e/specs/KeyboardShortcuts-pageup-pagedown.test.ts`

**Failed tests:**

1. "PageDown should scroll chat down when focus is outside input" (line 121) — scrollTop does NOT increase after pressing PageDown from top position
2. "PageUp should work when focus is on nicklist" (line 186) — scrollTop does NOT decrease after pressing PageUp from bottom with nicklist focused

**Passing tests in same file:** PageDown from outside input works in other contexts, PageUp from input bar works, PageUp in native INPUT correctly doesn't scroll, Ctrl+PageUp correctly doesn't scroll.

**Likely cause:** The global keyboard shortcut handler for PageUp/PageDown has asymmetrical logic — PageDown direction isn't handled correctly, or the handler doesn't capture events when focus is on the nicklist element (focus target filtering may exclude it).

**Check:** Global keyboard shortcut handler (likely `$lib/keyboardShortcuts.ts` or in App.svelte/ChatView). Verify both PageUp and PageDown directions are handled symmetrically. Check that the handler fires when focus is on non-input elements like the nicklist.

---

## Task 5: Fix Irc-integration — bot nick change infoline not rendered

**Spec:** `src-svelte/e2e/specs/Irc-integration.test.ts`
**Failed test:** "shows bot nick change" (line 130)

**Error:** No bufferline row containing "now known as" appears after `irc.botNick(newNick)`. Test waits up to 15 seconds polling but never finds the infoline.

**Cascading impact:** 4 subsequent tests (nicklist diff tests) did not run.

**Likely cause:** The WeeChat protocol handler for nick changes may not create a proper bufferline entry. The nick change event from WeeChat (info line with type "nick") may not be processed into a visible chat message.

**Check:** `$lib/stores/handlers.ts` for nick change handling. Verify the handler creates a bufferline with text containing "is now known as <newNick>". Check if the line type mapping includes nick changes.

---

## Task 6: Fix BufferList-pinning — pin button missing from topic bar

**Spec:** `src-svelte/e2e/specs/BufferList-pinning.test.ts`
**Failed test:** "pin button is visible in topic bar" (line 46)

**Error:** `page.getByTestId('topic-bar-container').getByTestId('pin-buffer')` — element not found.

**Cascading impact:** 7 subsequent tests did not run (pin icon checks, pin/unpin toggling, pinned buffer persistence, etc.).

**Likely causes:**

- The topic bar container doesn't have `data-testid="topic-bar-container"`
- The pin button doesn't have `data-testid="pin-buffer"`
- The pin button isn't rendered at all (feature not implemented or conditionally hidden based on buffer type/settings)

**Check:** `TopicBar.svelte` or equivalent component. Look for the pin button implementation and verify both `data-testid` attributes match what the test expects. Check if pinning is conditional on buffer type (channels vs queries vs core).

---

## Task 7: Fix FaviconBadge — badge not resetting to default when switching to buffer with unread

**Spec:** `src-svelte/e2e/specs/FaviconBadge.test.ts`
**Failed test:** "favicon badge resets when switching to buffer with unread" (line 75)

**Error:** After switching to a buffer that had unread messages, the favicon remains as a data: URL (badge) instead of resetting to `/favicon.png`.

**Cascading impact:** 1 subsequent test ("no badge drawn when favico setting is disabled") did not run.

**Reproduction flow:**

1. Reconnect with `useFavico: true`
2. Switch to `#glowing-bear`, then switch away to `gbtest`
3. Send message to `#glowing-bear` → creates unread → badge appears (data: URL)
4. Switch back to `#glowing-bear` → expect favicon to reset to `/favicon.png`

**Likely cause:** The favicon badge clearing logic in `$lib/faviconBadge.ts` doesn't trigger correctly on buffer switch. The function that clears the badge may not be called when switching to a buffer whose unread count drops to zero, or the condition for clearing doesn't match.

**Check:** `$lib/faviconBadge.ts` — the update/clear logic. Verify it's called during buffer switch and that the clear condition matches the case where the active buffer's unread count becomes zero.

---

## Passing Specs (41 total)

- `ChatView-scroll.test.ts` — 7/7 passed
- `BubbleChats.test.ts` — 9/9 passed
- `BufferList-pm.test.ts` — 5/5 passed
- `Nicklist-mobileSwipe-showNicklistOff.test.ts` — 3/3 passed
- `BufferList-close.test.ts` — 3/3 passed
- `Nicklist-mobileSwipe.test.ts` — 6/6 passed
- `Nicklist-mutuallyExclusive.test.ts` — 3/3 passed
- `App-layout.test.ts` — 12/12 passed
- `AutoconnectSpam.test.ts` — 1/1 passed
- `BufferHotlist-click.test.ts` — 1/1 passed
- `BufferHotlist-mobile.test.ts` — 4/4 passed
- `BufferLineRow.test.ts` — 28/28 passed
- `BufferResume.test.ts` — 3/3 passed
- `BufferSearch-arrowNav.test.ts` — 5/5 passed
- `ChatView-mobileSwipe.test.ts` — 4/4 passed
- `TopicBar-longTopic.test.ts` — 2/2 passed
- `Connection-form.test.ts` — 17/17 passed
- `ConnectionForm.test.ts` — 12/12 passed
- `DisconnectReconnect.test.ts` — 5/5 passed
- `Hash-params.test.ts` — 11/11 passed
- `HashAlgorithmMismatch.test.ts` — 3/3 passed
- `InputBar-emojify.test.ts` — 4/4 passed
- `InputBar-formatting.test.ts` — 17/17 passed
- `InputBar-nickCompletion.test.ts` — 5/5 passed
- `InputBar-typeToFocus.test.ts` — 7/7 passed
- `KeyboardShortcuts-altA.test.ts` — 3/3 passed
- `KeyboardShortcuts.test.ts` — 23/23 passed
- `LinkifiedText-security.test.ts` — 8/8 passed
- `NativeCryptoAuth.test.ts` — 1/1 passed
- `Nicklist-swipeWithBufferList.test.ts` — 3/3 passed
- `Nicklist.test.ts` — 15/15 passed
- `NotificationSound.test.ts` — 2/2 passed (1 intentionally skipped)
- `PluginEmbed.test.ts` — 6/6 passed
- `ReadMarker-unreadBadge.test.ts` — 3/3 passed
- `ReadMarker.test.ts` — 7/7 passed
- `ReconnectLoopGuard.test.ts` — 3/3 passed
- `SettingsModal-customCSS.test.ts` — 7/7 passed
- `SettingsModal-fonts.test.ts` — 8/8 passed
- `SettingsModal-themes.test.ts` — 9/9 passed
- `Toast.test.ts` — 15/15 passed
- `TopicModal-security.test.ts` — 4/4 passed
- `WeechatConfig.test.ts` — 1/1 passed
- `ChatView-scrollFetch.test.ts` — 2/2 passed
