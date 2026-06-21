# Glowing Bear Svelte — Agent Guide

Glowing Bear is a browser-based frontend for WeeChat IRC via WebSockets — **no backend**. All code is client-side Svelte 5 + TypeScript. Optionally wrapped in Tauri for desktop apps. Requires WeeChat >= 2.9. This is a migration of the AngularJS 1.x frontend (`src/`) into SvelteKit (`src-svelte/`). The AngularJS app must remain intact.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | SvelteKit 2.x (Svelte 5) |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS v4 (via `@tailwindcss/vite`) |
| Build | Vite 6 |
| Testing | Vitest 2.x (unit) + Playwright 1.60.x (E2E) |
| Protocol | `weechat.ts` (migrated from AngularJS `weechat.js`), `weechat-rest.ts` (unused, planned for future) |
| Desktop | Tauri 2.x (Rust) in `../../src-tauri/` |
| Libraries | fflate, DOMPurify, @lucide/svelte, @vite-pwa/sveltekit, zlibjs |

## Project Structure

```
src-svelte/
├── src/
│   ├── components/          # Svelte components (18 total — ChatView, PluginEmbed, InputBar, BufferList, BufferHotlist, TopBar, Nicklist, SettingsModal, BaseDialog, ConnectionForm, LinkifiedText, FormInput, Toast, BufferSearchModal, TopicModal, BufferLineRow, ImageUploadPreview, Tooltip)
│   ├── lib/                 # Shared code: types, utils, stores, notifications, filters
│   │   └── stores/          # connectionManager, models, handlers, settings, theme, bufferResume, connectionStore, inputHistory, nickColors, themeColors
│   └── routes/              # SvelteKit routes (+page.svelte, +layout.svelte, +layout.server.ts, 404.html, index.html)
├── static/css/themes/       # 13 theme CSS files
├── test/unit/               # Vitest unit tests
├── test/irc-server/         # Local IRC server for testing
├── e2e/                     # Playwright E2E tests + config (specs/, helpers/, fixtures/, playwright.config.ts)
├── vite.config.ts / svelte.config.js / vitest.config.ts
├── tsconfig.json / tsconfig.app.json
├── eslint.config.js
└── package.json
```

Key files: `weechat.ts` (binary relay protocol parser/encoder, migrated from AngularJS), `connectionManager.ts` (WS lifecycle, handshake, sync), `handlers.ts` (dispatches → models stores), `models.ts` (writable stores: buffers, currentBuffer, connected, hotlist, servers, wconfig), `settings.ts` (localStorage persistence), `theme.ts` (CSS variable injection), `notifications.ts` (desktop notifications, sound, favicon badge), `faviconBadge.ts` (canvas-based favicon badge renderer), `linkTokens.ts` (link tokenization), `emojify.ts`, `imgur.ts`, `filters.ts`, `toast.ts`).

## Commands

```bash
npm install              # install deps
npm run dev              # Vite dev server on http://localhost:8001 (HMR auto-reloads .svelte/.ts/.css; only vite.config.ts/svelte.config.js need restart)
npm run build            # Production build into build/
npm run check            # svelte-check
npm run lint             # eslint src
npm test                 # Vitest unit tests
npm run test:watch       # Vitest watch mode
npm run test:e2e         # Playwright E2E tests (headless; auto-starts gbtest if needed)
npm run test:e2e:watch   # Playwright E2E UI mode
npm run test:e2e:debug   # Playwright E2E debug mode
npm run irc:server       # Start local IRC server (npx tsx)
npm run irc:start        # Start gbtest environment
npm run irc:stop         # Stop gbtest environment
npm run generate-icons   # Generate app icons
npm run preview          # Preview production build
npm run tauri:dev        # Tauri dev mode
npm run tauri:build      # Tauri production build
```

## Common Patterns

### Adding a new component
1. Create `src/components/ComponentName.svelte` with `<script lang="ts">`
2. Use `$props()` for props, `$state` for mutable state, `$derived` for computed values
3. Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel imports
4. Add `data-testid` attributes on interactive elements for E2E tests
5. Use Tailwind semantic color variables: `bg-bg`, `text-text`, `border-border`, `bg-surface`, `bg-surface-raised`, `bg-input-bg`, `text-text-secondary`, `text-danger`, `text-text-muted`, `accent`
6. Wrap modals in `<BaseDialog>` with `id`, `labelledby`, and `popovertarget`/`popovertargetaction="hide"` on close buttons

### Adding a new setting
1. Add field to `Settings` interface in `src/lib/types.ts`
2. Set default value in the writable store init in `src/lib/stores/settings.ts`
3. Wire up in `SettingsModal.svelte` — use `updateSettings({ settingName })` on change
4. Read via `$settings.settingName` in templates, `get(settings)` in TS functions

### Handling a new protocol message type
1. Add handler function in `src/lib/stores/handlers.ts`
2. Register in the `eventHandlers` map at the bottom of the same file
3. Always create new object references to trigger Svelte reactivity: `buffers.set({ ...get(buffers) })` — never mutate in-place

### Store access patterns
- `.svelte` templates: `$storeName` (e.g. `$settings`, `$buffers`)
- `.ts` files: `const val = get(storeName)` via `import { get } from 'svelte/store'`
- No `useStore()` utility — direct `$storeName` and `get()` only

### Sending input to WeeChat
`InputBar.svelte` handles user input with readline keybindings, history, tab completion (delegates to `completeNick()` in `src/lib/utils.ts`). Input is sent through `connectionManager`.

### Programmatic mount
`mount(Component, { target, props })` returns the component's **exports**, not the DOM element. For components with no exports (no `export` declarations), it returns `{}`. If you need to pass data to a mounted component, use `props` — don't try to access the element via the return value.

## Business Context

Free/open-source IRC web frontend for WeeChat. Users run their own WeeChat instance (VPS, home server, Pi) and connect directly — no intermediary server. Key users: sysadmins, gamers, privacy-conscious IRC users. Performance matters: virtual scrolling (~50-100 DOM nodes). Must work as a PWA (offline-capable) on mobile. Security model: user controls their own server entirely.

## Testing Framework

**Unit tests (`test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Fast, no browser. Mock stores via `vi.mock('$lib/stores/models')` and `vi.mock('$lib/notifications')`, read with `get(store)`.

**E2E tests (`e2e/specs/*.spec.ts`)** — UI components, user flows, DOM/store interplay. Every new component → add/update E2E test with `data-testid`. Use `page.getByTestId('...')` + `.first()`/`.last()`. For shared state: `test.describe.configure({ mode: 'serial' })`.

### Writing E2E Tests
1. Add `data-testid` attributes to tested components
2. Create `e2e/specs/Component.test.ts`
3. Include `$effect.pre` error handler in `beforeEach`:
   ```ts
   beforeEach(() => {
       page.on('pageerror', (e) => { if (e.message?.includes('effect_orphan')) return; });
       await page.goto('http://localhost:8001/');
   });
   ```
4. Use `page.getByTestId('...')` selectors + `.first()`/`.last()` for strict mode
5. Shared state across tests: `test.describe.configure({ mode: 'serial' })`

### Running Targeted E2E Tests

Full E2E suite takes ~5 minutes. Run only the relevant tests instead of the full suite:

```bash
# Run tests matching a pattern (e.g., ReadMarker, BufferList, ChatView)
npm run test:e2e -- --grep "ReadMarker"

# Run multiple patterns
npm run test:e2e -- --grep "ReadMarker|unreadBadge"

# Run a single file
npm run test:e2e e2e/specs/ComponentName.test.ts

```

**Test user-visible behavior, not implementation details.** E2E tests should verify what the user sees/interacts with. Things like whether `new Audio(src)` or `new Notification(title)` were called are implementation details — those belong in unit tests (`test/unit/`). Keep E2E focused on DOM output, UI state, and user flows. Example: instead of intercepting `Audio` to check `sonar.mp3` was loaded, verify the sound plays via user interaction (or leave that to unit tests).

**Prefer user-facing locators.** Use `getByRole()` and `getByText()` first — they're resilient to DOM changes. Fall back to `data-testid` only when no semantic role or stable text content fits (e.g. icons, generic buttons, list items without distinguishing text). Always pick the most specific locator that still survives minor markup changes:
  ```ts
  // 👍 — semantic role
  await page.getByRole('button', { name: 'Send' }).click();
  // 👍 — text content when no role works
  await page.getByText('Connection lost').isVisible();
  // 👍 — testid as last resort
  await page.getByTestId('buffer-item').click();
  ```

**Mock browser APIs with `addInitScript`, not per-test `page.evaluate`.** When you need to spy on a browser API (`Notification`, `Audio`), inject the mock once in `beforeAll` via `addInitScript()` — it runs before any app code and survives navigations/reloads. Reset captured calls in `beforeEach`:
  ```ts
  await page.addInitScript(() => {
      (window as any).__notificationCalls = [];
      (window as any).Notification = class MockNotification {
          static permission = 'granted';
          static requestPermission = async () => 'granted';
          constructor(title: string, options?: Record<string, unknown>) {
              (window as any).__notificationCalls.push({ title, options });
          }
      } as any;
  });
  ```
  Avoid repeated `page.evaluate()` mock setups in each individual test.

Control API CLI: `test/irc-server/ctrl.sh` to send IRC commands (gbtest must be running).

## Known Issues

- **Svelte 5 `$effect.pre` orphan error** in dev-mode Playwright tests — filtered via `page.on('pageerror')` in `beforeEach`. Does NOT affect production.
- **Vitest browser mode is NOT used** — incompatible with Svelte 5.
- **Tauri on Windows uses MSWebView2** (tracks stable Edge Chromium version, auto-updates via Microsoft Update). Some modern CSS features may not be available in the bundled WebView. Always provide fallbacks: use `min-h-[100vh] min-h-dvh` instead of bare `h-dvh`, and test Tauri builds on Windows for layout issues.

## Prerequisites

1. **gbtest environment**: IRC localhost:6667, relay ws://localhost:9001 (password: `testpassword123`). Auto-started by Playwright's `globalSetup` when running `npm run test:e2e`. Manual start/stop: `npm run irc:start` / `irc:stop`. Gbtest persists across test runs and does not need to be stopped between runs. Modifying `test/irc-server/` requires restart.
2. **Dev server** on http://localhost:8001: auto-started by Playwright's `webServer` config. Manual: `npm run dev`

## Code Style (CRITICAL)

### Svelte 5 Runes
- **Never use `$:`** — compiles to `$effect.pre`, causes `$effect_orphan` errors during event handlers
- Use `$state`, `$derived`, `$effect`, and `$props()` (NOT `export let`)
- Pattern: `let s = $state($settings)` + `$effect(() => { const unsub = $settings.subscribe(...) })`

### Reactivity
Immutable updates only — never mutate store objects in-place. Spread copies: `buffers.set({ ...get(buffers) })`. Read via `get(store)`, mutate the copy, then `store.set(copy)`.

**{#if} blocks after async boundaries do NOT reliably trigger** — setting `$state` or `$derived` values inside an `async` function (after `await`) may not cause `{#if}` to re-evaluate. Workaround: push placeholder items synchronously before any `await`, then update them in-place after the async operation completes. For modals/dialogs, render unconditionally and control visibility via `.showPopover()` / `.hidePopover()` instead of `{#if}`.

### Function Comments
Every non-trivial function needs a brief comment above it explaining intent.

### Security — DOMPurify & XSS
Always use `sanitizeHtml()` from `$lib/filters` for HTML injection. Default mode forbids script, iframe, object, embed, form, input, img. Use `allowEmbeds: true` only for trusted plugin embed content. For message content/topics, prefer `tokenizeLinks()` + Svelte native escaping over `{@html}` + sanitize.

### TypeScript
- `@typescript-eslint/no-explicit-any` eslint-disable comments used for protocol types — keep them with justification comment above each

### Other
- `$lib` and `$components` aliases configured in both `vite.config.ts` and `svelte.config.js`
- PWA support via `@vite-pwa/sveltekit` — service worker registered in `+layout.svelte`
- SPA routing: `adapter-static` with `fallback: '404.html'`
