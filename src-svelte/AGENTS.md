# Glowing Bear Svelte — Agent Guide

## What This Is

Glowing Bear is a browser-based frontend for WeeChat IRC via WebSockets — **no backend**. All code is client-side Svelte 5 + TypeScript. Optionally wrapped in Tauri for desktop apps. Requires WeeChat >= 2.9.

This is a migration of the AngularJS 1.x frontend (`src/`) into SvelteKit (`src-svelte/`). The AngularJS app must remain intact.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | SvelteKit 2.x (Svelte 5) |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS v4 (via `@tailwindcss/vite`) |
| Build | Vite 6 |
| Testing | Vitest 2.x (unit) + Playwright 1.60.x (E2E) |
| Protocol | `weechat.js` + `websockets.js` (framework-agnostic, from AngularJS) |
| Desktop | Tauri 2.x (Rust) in `../../src-tauri/` |
| Libraries | fflate, DOMPurify, linkifyjs, favico.js, linkify-string, zlibjs |

## Project Structure

```
src-svelte/
├── src/
│   ├── components/          # Svelte components
│   ├── lib/                 # Shared code: types, utils, stores, notifications, filters
│   │   └── stores/          # connectionManager, models, handlers, settings, theme, etc.
│   └── routes/              # SvelteKit routes (+page.svelte, +layout.svelte, 404.html)
├── public/css/themes/       # 12 theme CSS files
├── test/unit/               # Vitest unit tests
├── e2e/                     # Playwright E2E tests (specs/, helpers/, fixtures/)
├── playwright.config.ts
├── vite.config.ts / svelte.config.js / vitest.config.ts
└── package.json
```

## Key Files & Concepts

| File | Purpose |
|------|---------|
| `weechat.js` | WeeChat binary relay protocol parser/encoder. Static methods on `Protocol`, instance methods on `new Protocol()` |
| `websockets.js` | Thin WebSocket transport |
| `connectionManager.ts` | WebSocket lifecycle, handshake (plain/PBKDF2), post-handshake sync |
| `handlers.ts` | Dispatches parsed protocol messages → mutates `models` stores |
| `models.ts` | Writable stores: buffers, currentBuffer, connected, hotlist, servers, wconfig |
| `settings.ts` | Settings with localStorage persistence |
| `theme.ts` | Dynamic CSS variable injection for 12 themes |
| `notifications.ts` | Desktop notifications, sound, favicon badge |
| `ChatView.svelte` | Virtual scrolling (~50-100 DOM nodes) |
| `PluginEmbed.svelte` | 17+ embed types, DOMPurify sanitization |
| `+page.svelte` | App shell: ConnectionForm if disconnected, full chat if connected |

## Commands

```bash
npm install              # install deps
npm run dev              # Vite dev server on http://localhost:8001
npm run build            # Production build into build/
npm run check            # svelte-check
npm run lint             # eslint src
npm test                 # Vitest unit tests
npm run test:e2e         # Playwright E2E tests (headless)
npm run test:e2e:all     # Full pipeline: start WeeChat → run Playwright → stop WeeChat
```

### Dev Server

No need to restart `npm run dev` after file changes — Vite's HMR (Hot Module Replacement)
automatically updates the browser. Changes to `.svelte`, `.ts`, and `.css` files reflect
instantly. Only changes to `vite.config.ts` or `svelte.config.js` require a restart.

## Common Patterns

### Adding a new component
1. Create `src/components/ComponentName.svelte` with `<script lang="ts">`
2. Use `$props()` for props (NOT `export let`), `$state` for mutable state, `$derived` for computed values
3. Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel imports
4. Add `data-testid` attributes on interactive elements for E2E tests
5. Use Tailwind semantic color variables: `bg-bg`, `text-text`, `border-border`, `bg-surface`, `bg-surface-raised`, `bg-input-bg`, `text-text-secondary`, `text-danger`, `text-text-muted`, `accent`
6. Wrap modals/dialogs in `<BaseDialog>` with `id`, `labelledby`, and `popovertarget`/`popovertargetaction="hide"` on close buttons

### Adding a new setting
1. Add field to `Settings` interface in `src/lib/types.ts`
2. Set default value in the writable store init in `src/lib/stores/settings.ts`
3. Wire up in `SettingsModal.svelte` — use `updateSettings({ settingName })` on change
4. Read via `$settings.settingName` in Svelte templates, `get(settings)` in TS functions

### Handling a new protocol message type
1. Add handler function in `src/lib/stores/handlers.ts`
2. Register in the `eventHandlers` map at the bottom of the same file
3. Read state with `get(buffers)`, update with `buffers.set({...})` — always create new object references to trigger Svelte reactivity
4. Never mutate store objects in-place; spread copies: `buffers.set({ ...get(buffers) })`

### Store access patterns
- In `.svelte` templates: `$storeName` (Svelte auto-subscription, e.g. `$settings`, `$buffers`, `$themeStore`)
- In `.ts` files: `const val = get(storeName)` via `import { get } from 'svelte/store'`
- There is no `useStore()` utility — the codebase uses direct `$storeName` and `get()` exclusively

### Sending input to WeeChat
- `InputBar.svelte` handles user input with readline keybindings, history, tab completion
- Tab completion delegates to `completeNick()` in `src/lib/utils.ts`
- Input is sent through `connectionManager` which formats and sends over WebSocket

## Business Context

Glowing Bear is a free/open-source IRC web frontend for WeeChat. Users run their own WeeChat instance (VPS, home server, Raspberry Pi) and connect their browser directly to it — no intermediary server. Key users: sysadmins, gamers, privacy-conscious IRC users. Performance matters: chat buffers can have thousands of lines, hence virtual scrolling (~50-100 DOM nodes). The app must work as a PWA (offline-capable) and on mobile. Security model: user controls their own server entirely, no data passes through third parties.

## Testing Framework

### When to Write Unit vs E2E Tests

**Unit tests (`test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Fast, no browser needed.

- Filters, utils, protocol parser/encoder, store logic, notification functions, buffer filtering/sorting
- Mock stores via `vi.mock('$lib/stores/models')` and `vi.mock('$lib/notifications')`
- Use `get(store)` from svelte/store to read mocked values

**E2E tests (`e2e/specs/*.spec.ts`)** — UI components, user flows, anything that touches the DOM or store interplay.

- Every new component or component change → add/update E2E test with `data-testid` attributes
- Connection flow, chat messaging, buffer switching, nicklist, settings, theme changes
- Use `page.getByTestId('...')` selectors, include `$effect.pre` error filter in `beforeEach`

**Rule of thumb:** If it doesn't touch the DOM or component state, write a unit test. If it renders UI or involves multiple stores/components interacting, write an E2E test.

### Writing E2E Tests
1. Add `data-testid` attributes to components being tested
2. Create test file in `e2e/specs/` with `.spec.ts` extension
3. Include `$effect.pre` error handler in `beforeEach`:
   ```ts
   beforeEach(() => {
       page.on('pageerror', (e) => { if (e.message?.includes('effect_orphan')) return; });
       await page.goto('http://localhost:8001/');
   });
   ```
4. Use `page.getByTestId('...')` selectors + `.first()`/`.last()` for Playwright strict mode
5. For shared state across tests: `test.describe.configure({ mode: 'serial' })`

### Control API CLI
Use `test/irc-server/ctrl.sh` to send IRC commands during testing (gbtest must be running).

## Known Issues

- **Svelte 5 `$effect.pre` orphan error** in dev-mode Playwright tests — filtered via `page.on('pageerror')` in `beforeEach`. Does NOT affect production builds.
- **WeeChat relay timeouts** — restart with `npm run irc:stop && npm run irc:start` if tests fail to connect.
- **Vitest browser mode is NOT used** — incompatible with Svelte 5. Playwright is the active E2E framework.

## Prerequisites

1. **gbtest environment** running: IRC localhost:6667, relay ws://localhost:9001 (password: `testpassword123`)
   - Start: `npm run irc:start` / Stop: `npm run irc:stop`
   - Modifying `test/irc-server/` code requires restart
2. **Dev server** on http://localhost:8001: `npm run dev`

## Code Style (CRITICAL)

### Protocol Methods
- Static methods: `Protocol.formatHandshake()`, `Protocol.formatInit()`, etc.
- Instance methods: `protocolInstance.setId()`, `protocolInstance.parse()`
- `connectionManager.ts` uses `new Protocol()` for instance methods. **Never call `Protocol.setId()`**

### Svelte 5 Runes — MUST USE, DO NOT USE `$:`
- **Never use `$:`** — compiles to `$effect.pre`, causes `$effect_orphan` errors during event handlers
- Use `$state` for mutable state, `$derived` for computed values, `$effect` for side effects
- Use `$props()` for component props (NOT `export let`)
- Pattern: `let s = $state($settings)` + `$effect(() => { const unsub = $settings.subscribe(...) })`

### Reactivity — Immutable Updates Only
- Never mutate store objects in-place; always create new references to trigger Svelte reactivity
- `buffers.set({ ...get(buffers) })` — spread copies
- For partial updates: read via `get(store)`, mutate the copy, then `store.set(copy)`

### Function Comments
- Every new function needs a brief comment above it explaining *why* — what problem it solves. Code shows how; the comment explains why. One line, placed directly above the declaration.
- Skip trivial getters/setters and pass-throughs where the name makes intent self-evident. Applies to exported, internal, and component-level helpers alike.

### Lucide Icons — Always Use Per-Icon Imports
- **DO**: `import Pin from '@lucide/svelte/icons/pin'` — only bundles that icon
- **DON'T**: `import { Pin } from '@lucide/svelte'` — barrel import includes all ~1600 icons

### Security — DOMPurify & XSS
- Always use `sanitizeHtml()` from `$lib/filters` for any HTML injection
- Default mode forbids dangerous tags: script, iframe, object, embed, form, input, img
- Use `allowEmbeds: true` only for trusted plugin embed content (YouTube, Spotify, etc.)
- For message content and topics, prefer `tokenizeLinks()` + Svelte's native text escaping over `{@html}` + sanitize

### Tailwind CSS v4 — Semantic Colors
- Use semantic color variables, not arbitrary hex/RGB values: `bg-bg`, `text-text`, `border-border`, `bg-surface`, `bg-surface-raised`, `bg-input-bg`, `text-text-secondary`, `text-danger`, `text-text-muted`, `accent`

### TypeScript
- `@typescript-eslint/no-explicit-any` eslint-disable comments are used liberally for protocol types — keep them but add justification comment above each one
- `var` prohibited — use `let` or `const` exclusively

### Other
- `fflate` injected as global in `vite.config.ts` (required by `weechat.js`)
- SPA routing: `adapter-static` with `fallback: '404.html'`
- DRY: use `sortBuffers()`, `parseRelayUrl()`, `<LinkifiedText />` instead of duplicating logic
- `recordBuffer` is from `bufferResume.ts`, NOT `models.ts`
