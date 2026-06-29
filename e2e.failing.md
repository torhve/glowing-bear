# Failing E2E Tests — v0.21.0

Date: 2025-06-29
Branch: main @ 27f454e
Tests: 345 passed, 7 failed, 19 skipped, 23 did not run (from serial failures)

## Failures

### 1. BubbleChats.test.ts:78 — private buffers use bubble layout when setting enabled
- **Error:** `TimeoutError: locator.waitFor: Timeout 10000ms exceeded` waiting for buffer item `gbbot2`
- **Likely cause:** Flaky timing — buffer creation/relay propagation race condition

### 2. ChatView-scroll.test.ts:437 — should NOT auto-scroll when scrolled up slightly and messages arrive on active buffer
- **Error:** `TimeoutError: page.waitForFunction: Timeout 5000ms exceeded` in `waitForScrollSettled`
- **Likely cause:** Flaky timing — scroll position check race

### 3. Hash-params.test.ts:79 — should re-apply hash params on hash change
- **Error:** Host input still shows `initial.host` after changing hash to `#host=new.host`
- **Suspected:** Real bug — `onhashchange` handler not updating form fields

### 4. Hash-params.test.ts:89 — should handle autoconnect=false
- **Error:** Autoconnect checkbox still checked after changing hash to `#autoconnect=false`
- **Suspected:** Same root cause as #3 — `onhashchange` handler not updating settings

### 5. Irc-integration.test.ts:130 — shows bot nick change
- **Error:** "now known as" buffer line never appeared after `.toPass({ timeout: 15000 })`
- **Suspected:** Real bug — nick change infoline not being rendered, or relay timing issue

### 6. KeyboardShortcuts-altA.test.ts:65 — Alt+A prioritizes notification buffers over plain unread buffers
- **Error:** PM buffer never appeared (`waitForPmBuffer(20000)` returned null)
- **Likely cause:** Flaky timing — PM buffer creation/relay propagation race condition
- **Note:** Caused 3 downstream tests to not run (serial mode)

### 7. Notifications.test.ts:154 — sound plays when soundnotification is enabled
- **Error:** Audio calls array is empty after 15s wait; expected `/assets/audio/sonar.mp3`
- **Suspected:** Real bug — audio playback not triggered on highlight messages
- **Note:** Caused 13 downstream tests to not run (serial mode)

## Impact Assessment

- **#1, #2, #6** are likely flaky timing tests — may pass on rerun
- **#3, #4** share root cause: `onhashchange` handler in ConnectionForm not updating fields
- **#5** nick change rendering — may be a real regression or WeeChat/gbtest protocol issue
- **#7** sound notification — may be a real regression in notification dispatch
