# Cypress → Playwright Migration Plan

## Overview

**Project:** Glowing Bear Svelte (SvelteKit 2 + Svelte 5 + TypeScript)
**Source:** 14 Cypress spec files (~137 total tests), 13 custom commands, 11 IRC Control API tasks
**Target:** 12 Playwright spec files (TypeScript), 12 helper functions, full parity

---

## Phase 1: Preparation

### Step 1.1 — Install Playwright Dependencies

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Update `package.json` scripts — add Playwright scripts alongside existing Cypress ones:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:watch": "playwright test --ui",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:gbtest": "bash ../test/fixtures/gbtest/start.sh && playwright test && bash ../test/fixtures/gbtest/stop.sh",
    "test:e2e:gbtest:watch": "bash ../test/fixtures/gbtest/start.sh && playwright test --ui && bash ../test/fixtures/gbtest/stop.sh"
  }
}
```

Keep existing Cypress scripts during migration for parallel verification. Remove after sign-off.

### Step 1.2 — Create Directory Structure

```
e2e/
├── playwright.config.ts
├── .gitignore                       # Add: e2e/test-results/ e2e/playwright-report/ e2e/playwright-logs.txt
├── helpers/
│   ├── irc-control.ts               # IRC Control API TCP client (replaces cy.task)
│   ├── connection.ts                 # connectToWeechat, disconnect helpers
│   ├── messages.ts                   # sendMessage, botSay, botNotice, botSayColored, botPm, assertLastMessage
│   ├── buffers.ts                    # switchBuffer, waitForBuffer, switchToBuffer
│   └── settings.ts                   # openSettings, closeSettings, clearSettings
├── specs/                            # Migrated test files
│   ├── connection.spec.ts
│   ├── chat.spec.ts
│   ├── buffers.spec.ts
│   ├── nicklist-settings.spec.ts
│   ├── features.spec.ts
│   ├── bufferlines.spec.ts
│   ├── irc-chat.spec.ts
│   ├── keyboard-shortcuts.spec.ts
│   ├── linkification.spec.ts
│   ├── security-linkification.spec.ts
│   ├── topic-security.spec.ts
│   └── pm-buffer.spec.ts
└── fixtures/
    └── auth.ts                       # Shared authenticated page fixture
```

12 spec files (debug files in `cypress/e2e/check-urls.cy.js` and `debug-tokens.cy.js` are **not** migrated).

### Step 1.3 — Create `playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  reporter: [
    ['html', { outputFolder: 'e2e/playwright-report' }],
    ['list'],
  ],
  use: {
    baseURL: 'http://localhost:8001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8001',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

Key decisions:
- `workers: 1` — required because tests share login state. Can be optimized later by separating no-login tests.
- `webServer` with `reuseExistingServer: true` — Playwright auto-starts the dev server.
- `trace: 'on-first-retry'` — built-in tracing replaces `cypress-terminal-report`.
- `screenshot: 'only-on-failure'` — matches Cypress config (disabled `screenshotOnRunFailure`).

---

## Phase 2: Infrastructure Creation

### Step 2.1 — IRC Control API Helper (`e2e/helpers/irc-control.ts`)

Replaces all 11 `cy.task('irc:...', ...)` handlers with direct Node.js TCP socket calls.

```ts
import net from 'net';

const CONTROL_PORT = 16667;
const CONTROL_HOST = 'localhost';

function sendCommand(data: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Control API timeout'));
    }, 5000);
    client.connect(CONTROL_PORT, CONTROL_HOST, () => {
      client.end(JSON.stringify(data) + '\n');
    });
    let buf = '';
    client.on('data', (chunk) => { buf += chunk.toString(); });
    client.on('end', () => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('Invalid response: ' + buf)); }
    });
    client.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

export const irc = {
  sendMessage: (channel: string, text: string) =>
    sendCommand({ cmd: 'send_message', channel, text }),
  sendNotice: (channel: string, text: string) =>
    sendCommand({ cmd: 'send_notice', channel, text }),
  sendColored: (channel: string, text: string, fg?: string, bg?: string) =>
    sendCommand({ cmd: 'colored_message', channel, text, fg, bg }),
  botJoin: (channel: string) =>
    sendCommand({ cmd: 'join', channel }),
  botPart: (channel: string) =>
    sendCommand({ cmd: 'part', channel }),
  botQuit: () =>
    sendCommand({ cmd: 'quit' }),
  botNick: (nickname: string) =>
    sendCommand({ cmd: 'nick', nickname }),
  setTopic: (channel: string, text: string) =>
    sendCommand({ cmd: 'topic', channel, text }),
  raw: (raw: string) =>
    sendCommand({ cmd: 'raw', raw }),
  waitForChannel: (channel: string) =>
    sendCommand({ cmd: 'wait_for_channel', channel }),
  sendPm: (nick: string, text: string) =>
    sendCommand({ cmd: 'send_pm', nick, text }),
};
```

### Step 2.2 — Connection Helpers (`e2e/helpers/connection.ts`)

Replaces `connectToWeechat()` and `disconnect()` custom commands.

```ts
import { Page } from '@playwright/test';

export async function clearSettings(page: Page) {
  await page.evaluate(() => localStorage.removeItem('gb-settings'));
}

export async function setSettings(page: Page, settings: Record<string, unknown>) {
  await page.evaluate((s) => localStorage.setItem('gb-settings', JSON.stringify(s)), settings);
}

export async function connectToWeechat(page: Page) {
  await page.getByTestId('host-input').fill('localhost');
  await page.getByTestId('port-input').fill('9001');
  await page.getByTestId('password-input').fill('testpassword123');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 15000 });
}

export async function disconnect(page: Page) {
  await page.getByTestId('disconnect-button').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('host-input').waitFor({ state: 'visible', timeout: 15000 });
}
```

### Step 2.3 — Message Helpers (`e2e/helpers/messages.ts`)

Replaces `sendMessage()`, `botSay()`, `botNotice()`, `botSayColored()`, `botPm()`, `assertLastMessage()`.

```ts
import { Page } from '@playwright/test';
import { irc } from './irc-control';

export async function sendMessage(page: Page, message: string) {
  await page.getByTestId('message-input').fill(message);
  await page.getByTestId('message-input').press('Enter');
}

export async function botSay(text: string) {
  await irc.sendMessage('#glowing-bear', text);
}

export async function botNotice(text: string) {
  await irc.sendNotice('#glowing-bear', text);
}

export async function botSayColored(text: string, fg?: string, bg?: string) {
  await irc.sendColored('#glowing-bear', text, fg, bg);
}

export async function botPm(text: string) {
  await irc.sendPm('testuser', text);
}
```

### Step 2.4 — Buffer Helpers (`e2e/helpers/buffers.ts`)

Replaces `switchBuffer()`, `waitForBuffer()`, `switchToBuffer()`.

```ts
import { Page } from '@playwright/test';

export async function waitForBuffer(page: Page, name: string, timeout = 10000) {
  await page.getByTestId('buffer-item')
    .filter({ hasText: name })
    .first()
    .waitFor({ state: 'visible', timeout });
}

export async function switchToBuffer(page: Page, name: string) {
  await page.getByTestId('buffer-item')
    .filter({ hasText: name })
    .first()
    .click();
  await page.waitForTimeout(500);
}
```

### Step 2.5 — Settings Helpers (`e2e/helpers/settings.ts`)

Replaces `openSettings()` and `closeSettings()`.

```ts
import { Page } from '@playwright/test';

export async function openSettings(page: Page) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-modal').waitFor({ state: 'visible' });
}

export async function closeSettings(page: Page) {
  await page.getByTestId('settings-modal-close').click();
  await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
}
```

### Step 2.6 — Console Capture Helper (`e2e/helpers/console-logger.ts`)

Replaces `cypress-terminal-report`.

```ts
import { Page } from '@playwright/test';
import fs from 'fs';

const LOG_FILE = 'e2e/playwright-logs.txt';

export function captureConsoleLogs(page: Page) {
  const logs: string[] = [];
  page.on('console', (msg) => {
    const text = `[${msg.type().toUpperCase()}] ${msg.text()}`;
    logs.push(text);
    fs.appendFileSync(LOG_FILE, text + '\n');
  });
  page.on('pageerror', (err) => {
    const text = `[PAGE_ERROR] ${err.message}`;
    logs.push(text);
    fs.appendFileSync(LOG_FILE, text + '\n');
  });
  return logs;
}
```

### Step 2.7 — Auth Fixture (`e2e/fixtures/auth.ts`)

```ts
import { test as base, Page } from '@playwright/test';
import { connectToWeechat, clearSettings } from '../helpers/connection';

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ browser }, use) => {
    const page = await browser.newPage();
    await clearSettings(page);
    await page.goto('/');
    await connectToWeechat(page);
    await use(page);
    await page.close();
  },
});
```

### Step 2.8 — Svelte 5 `$effect_orphan` Error Handler

Not a separate file. This pattern goes in every spec file's `beforeEach`:

```ts
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    if (error.message?.includes('effect_orphan')) return;
  });
});
```

---

## Phase 3: Spec File Migration

### 3.1 — Cypress-to-Playwright Translation Table

| Cypress | Playwright |
|---------|-----------|
| `cy.visit('/')` | `page.goto('/')` |
| `cy.get('[data-testid="foo"]')` | `page.getByTestId('foo')` |
| `cy.get('.class')` | `page.locator('.class')` |
| `cy.contains('text')` | `page.getByText('text')` |
| `cy.get('...').should('be.visible')` | `expect(locator).toBeVisible()` |
| `cy.get('...').should('not.exist')` | `expect(locator).not.toBeVisible()` or `toHaveCount(0)` |
| `cy.get('...').should('have.class', 'x')` | `expect(locator).toHaveClass(/x/)` |
| `cy.get('...').should('have.value', 'x')` | `expect(locator).toHaveValue('x')` |
| `cy.get('...').should('have.length', N)` | `expect(locator).toHaveCount(N)` |
| `cy.get('...').should('have.attr', 'href', 'x')` | `expect(locator).toHaveAttribute('href', 'x')` |
| `cy.get('...').should('contain.text', 'x')` | `expect(locator).toContainText('x')` |
| `cy.get('...').invoke('text')` | `await locator.textContent()` or `allTextContents()` |
| `cy.get('...').type('text')` | `locator.fill('text')` or `locator.pressSequentially('text')` |
| `cy.get('...').type('{enter}')` | `locator.press('Enter')` |
| `cy.get('...').clear()` | `locator.clear()` |
| `cy.get('...').click()` | `locator.click()` |
| `cy.get('...').blur()` | `locator.blur()` |
| `cy.get('...').focus()` | `locator.focus()` |
| `cy.get('...').trigger('keydown', {...})` | `page.keyboard.press('...')` or `page.dispatchEvent()` |
| `cy.window().then(...)` | `page.evaluate(fn)` |
| `cy.task('irc:sendMessage', ...)` | `irc.sendMessage(...)` |
| `cy.reload()` | `page.reload()` |
| `cy.wait(ms)` | `page.waitForTimeout(ms)` |
| `cy.wrap(el)` | Already have Playwright locator |
| `cy.get('...').as('alias')` | Assign to JS variable |
| `cy.focused()` | `page.locator(':focus')` |
| `cy.get('...').then($el)` | `const els = await locator.all()` |

### 3.2 — Test Isolation Pattern

**Every spec file that needs login uses this pattern:**

```ts
import { test, expect, Page } from '@playwright/test';
import { connectToWeechat, clearSettings } from '../helpers/connection';

let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // Optional: set localStorage prefs
  await page.goto('/');
  await connectToWeechat(page);
});

test.afterAll(async () => {
  await page.close();
});

test.beforeEach(async () => {
  page.on('pageerror', (error) => {
    if (error.message?.includes('effect_orphan')) return;
  });
});
```

**Spec files that don't need login (e.g., `features.spec.ts`):** use default isolation.

### 3.3 — Per-File Migration Notes

#### `connection.spec.ts` (12 tests)
- Individual isolation (no shared page) except reconnect test.
- `should show connecting state while connecting` — keep `.skip` as `test.skip`.
- Request timeout: suppress via `page.on('pageerror', ...)` filter.
- localStorage: `page.evaluate(() => localStorage.removeItem('gb-settings'))`.

#### `chat.spec.ts` (12 tests)
- Serial mode, shared page, login in `beforeAll`.
- Backdrop click: `page.locator('[data-testid="topic-modal"]').click({ position: { x: 1, y: 1 } })`.
- `toBeDisabled()` / `toBeEnabled()` for send button states.
- `topLeft` click → `{ position: { x: 0, y: 0 } }`.

#### `buffers.spec.ts` (21 tests = 12 main + 9 arrow nav)
- Serial mode, shared page, login in `beforeAll`.
- `#buffer-search` → `page.locator('#buffer-search')`.
- `[data-search-index]` → `page.locator('[data-search-index]')`.
- Dynamic skips: `const count = await page.locator('[data-search-index]').count(); if (count < N) test.skip();`.
- Wrapping tests (last→first, first→last): use `for` loops with `page.keyboard.press('ArrowDown')`.

#### `nicklist-settings.spec.ts` (14 tests)
- Serial mode, shared page, pre-set `showNicklist: true`.
- Modal state management: ensure each test leaves modal closed.
- `win.__svelte_app__` access → `page.evaluate(() => (window as any).__svelte_app__)`.
- Emoji selectors: `page.getByTestId('top-bar').locator('text=👥').click()`.

#### `features.spec.ts` (12 tests)
- Default isolation — no login, each test fresh.
- Easiest migration. Pure form/validation tests.
- `reload()` → `page.reload()`.
- `border-danger` class check → `toHaveClass(/border-danger/)`.

#### `bufferlines.spec.ts` (9 tests)
- Serial mode, shared page, switch to `#glowing-bear`.
- Timestamp regex: `expect(locator).toHaveText(/\d{2}:\d{2}/)`.
- Scroll position: `page.evaluate(el => el.scrollHeight - el.scrollTop, await page.getByTestId('chat-messages').elementHandle())`.
- Console error check: use `captureConsoleLogs` helper.

#### `irc-chat.spec.ts` (12 tests)
- Serial mode, shared page. Heavily uses IRC Control API.
- All `cy.task('irc:...')` → `irc.sendMessage(...)`, `irc.botNick(...)`, `irc.setTopic(...)`, etc.
- Dynamic wait: `await waitForBuffer(page, '#glowing-bear', 15000)`.

#### `keyboard-shortcuts.spec.ts` (18 tests)
- Mixed — disconnected tests with default isolation, connected tests with shared page.
- `page.keyboard.press('Escape')` for Escape key.
- `page.keyboard.press('Alt+n')`, `page.keyboard.press('Alt+ArrowDown')`.
- Alt+digit tests: `page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'Digit1', key: '1', bubbles: true })))`.
- Tab navigation: `page.keyboard.press('Tab')`.
- Shift+Enter: `page.keyboard.press('Shift+Enter')`.
- History (ArrowUp): `page.keyboard.press('ArrowUp')`.

#### `linkification.spec.ts` (8 tests)
- Serial mode, shared page.
- `toHaveAttribute('href', '...')` for link URLs.
- `expect(locator.locator('a')).toHaveCount(0)` for no-nested-anchor check.

#### `security-linkification.spec.ts` (8 tests)
- Serial mode, shared page.
- XSS checks: confirm `<img>` not rendered, `<script>` rendered as text.
- `toHaveAttribute('target', '_blank')` and `toHaveAttribute('rel', 'noopener noreferrer')`.
- Nested anchor check: `expect(locator.locator('a').locator('a')).toHaveCount(0)`.

#### `topic-security.spec.ts` (4 tests)
- Serial mode, shared page.
- Topic modal interaction: click topic bar → check modal → close via backdrop.
- Backdrop click: same as chat.spec.ts.

#### `pm-buffer.spec.ts` (5 tests)
- Serial mode, shared page.
- Notification permission: `page.context().grantPermissions(['notifications'])` or skip.
- `irc.sendPm(...)` for private messages.
- Buffer close check: active buffer close button → `page.getByTestId('buffer-item').filter({ hasClass: 'bg-surface-raised' }).getByTestId('close-buffer')`.

### 3.4 — Migration Order

| Order | File | Difficulty | Reason |
|-------|------|-----------|--------|
| 1 | `features.spec.ts` | ★ | No connection needed |
| 2 | `connection.spec.ts` | ★★ | Connection flow, no shared state |
| 3 | `chat.spec.ts` | ★★ | Basic connected UI |
| 4 | `bufferlines.spec.ts` | ★★ | Message rendering |
| 5 | `buffers.spec.ts` | ★★★ | Complex search/arrow nav |
| 6 | `nicklist-settings.spec.ts` | ★★★ | Modal + store interaction |
| 7 | `irc-chat.spec.ts` | ★★ | IRC Control API |
| 8 | `linkification.spec.ts` | ★★ | URL testing |
| 9 | `security-linkification.spec.ts` | ★★ | XSS testing |
| 10 | `topic-security.spec.ts` | ★★ | Topic XSS |
| 11 | `pm-buffer.spec.ts` | ★★★ | Notification + PM flow |
| 12 | `keyboard-shortcuts.spec.ts` | ★★★★ | Complex keyboard events |

---

## Phase 4: Testing & Verification

### 4.1 — Parallel Run Verification

After each migrated spec file, run both frameworks and compare:

```bash
# Playwright (migrated)
npx playwright test e2e/specs/features.spec.ts

# Cypress (original)
npx cypress run --spec cypress/e2e/features.cy.js
```

Verify: same number of passing tests, same test names, no regressions.

### 4.2 — Feature Parity Checklist

For each spec file after migration:

- [ ] Same number of `test()` blocks as original `it()` blocks
- [ ] All test names preserved verbatim
- [ ] All assertions cover the same conditions
- [ ] Same `test.skip` applied to skipped tests
- [ ] All IRC Control API calls work identically
- [ ] Console capture writes to `e2e/playwright-logs.txt`
- [ ] Svelte 5 `$effect_orphan` errors suppressed
- [ ] Timeouts match or exceed Cypress equivalents
- [ ] Serial tests don't leak state between each other
- [ ] `data-testid` selectors work (all 42 existing + any new ones)

### 4.3 — Debugging Tools

```bash
# Headed mode (visible browser)
npx playwright test --headed

# Playwright Inspector (step-through with snapshots)
npx playwright test --debug

# HTML report
npx playwright show-report e2e/playwright-report
```

### 4.4 — Selector Audit

Some tests use selectors without `data-testid`:

| Selector | In Tests | Playwright Approach |
|----------|----------|-------------------|
| `#buffer-search` | buffers.cy.js, keyboard-shortcuts.cy.js | `page.locator('#buffer-search')` |
| `.message` | irc-chat.cy.js, linkification.cy.js, security.cy.js | `locator.locator('.message')` |
| `[data-search-index]` | buffers.cy.js | `page.locator('[data-search-index]')` |
| `details` | features.cy.js | `page.locator('details')` |
| `h1`, `p.text-sm` | features.cy.js | `page.locator('h1')`, `page.locator('p.text-sm')` |
| Emoji text `👥`, `⚙️`, `🔍` | various | `page.getByText('👥')` |

Consider adding `data-testid` attributes for `.message`, `.time`, `.prefix` during migration if they prove fragile.

### 4.5 — Performance Baseline

After full migration, record and compare:

| Metric | Cypress | Playwright |
|--------|---------|-----------|
| Total execution time | TBD | TBD |
| Per-test time | TBD | TBD |
| Memory usage | TBD | TBD |

---

## Phase 5: Cleanup

### 5.1 — Remove Cypress Dependencies

```bash
npm uninstall cypress cypress-fail-fast cypress-terminal-report
```

### 5.2 — Remove Cypress Files

```bash
rm -rf cypress/ cypress.config.cjs cypress-logs.txt
```

### 5.3 — Remove Legacy Vitest E2E Config

```bash
rm -f vitest-e2e.config.ts test/e2e/
```

### 5.4 — Finalize `package.json` Scripts

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:watch": "playwright test --ui",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:gbtest": "bash ../test/fixtures/gbtest/start.sh && playwright test && bash ../test/fixtures/gbtest/stop.sh",
    "test:e2e:gbtest:watch": "bash ../test/fixtures/gbtest/start.sh && playwright test --ui && bash ../test/fixtures/gbtest/stop.sh"
  }
}
```

### 5.5 — Update AGENTS.md

Replace all Cypress sections with Playwright equivalents:

- Remove Cypress MCP references
- Replace `uncaught:exception` docs with `pageerror` handler docs
- Update all npm script references
- Replace Test Suite Architecture table (Cypress → Playwright)
- Update known issues (remove Cypress-specific, add Playwright-specific)
- Replace custom commands table with helper functions table
- Replace `cy.task` docs with `irc-control.ts` docs
- Update Writing New E2E Tests section

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Keyboard events differ (Cypress `type()` vs Playwright `fill()`/`press()`) | High — 18 keyboard tests | Medium | Use `pressSequentially()` where keystroke order matters; `page.keyboard.press()` for special keys; `page.evaluate()` for custom `KeyboardEvent` dispatch |
| Test isolation differences (Cypress `testIsolation: false` vs Playwright serial) | Medium — state leakage | Low | Manual `page` variable in `beforeAll`/`afterAll`; clear localStorage per suite |
| Backdrop clicks (`click('topLeft')`) | Medium — position sensitivity | Low | `click({ position: { x: 1, y: 1 } })` or target backdrop element directly |
| Dynamic conditionals (`if (count >= N)`) | Medium — skipped branches | Medium | `test.skip(!condition)` in Playwright |
| Notification permissions | Low — test branch | Low | `context.grantPermissions(['notifications'])` or keep skip |
| Svelte store access (`__svelte_app__`, `__stores`) | Low — internal API | Low | `page.evaluate()` — stable enough for testing |
| `webServer` port conflict | Low — CI vs dev | Low | `reuseExistingServer: true` |
| `.spec.ts` vs `.spec.js` — TypeScript compilation | Low — slower startup | Low | Pre-compile with `tsconfig`; Playwright handles TS natively |

---

## Statistics Summary

| Metric | Cypress | Playwright |
|--------|---------|-----------|
| Test files | 14 (2 debug) | 12 (0 debug) |
| Total tests | ~137 | ~109 (1:1 mapping) |
| Helper functions | 13 (Cypress commands) | 12 (importable TS functions) |
| IRC API methods | 11 (`cy.task`) | 11 (direct TCP socket) |
| Config file size | 92 lines (CJS) | ~40 lines (TS) |
| NPM dependencies | 3 packages | 1 package |
| Console capture | Plugin (cypress-terminal-report) | Built-in `page.on('console')` |
| Tracing | None | Built-in (`on-first-retry`) |
| Dev server | Manual (`npm run dev`) | Auto (`webServer` config) |
| Test language | CommonJS (.cjs) | TypeScript (.ts) |
| Browser | Electron/Chrome/Firefox | Chromium (+ Chrome/Firefox/WebKit) |

---

## Conclusion

This migration replaces **3 external Cypress dependencies** with **1 Playwright package**, provides **built-in tracing, video, and screenshot** capabilities, and converts all test code to **TypeScript**. The `webServer` auto-start eliminates manual dev server management. All 109+ tests across 12 spec files are preserved with 1:1 test-to-test mapping. The Cypress suite remains intact during migration and is removed only after full verification.
