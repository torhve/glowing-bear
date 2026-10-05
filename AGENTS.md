# Glowing Bear Svelte — Agent Guide

Browser frontend for WeeChat IRC via WebSockets — **no backend**. Client-side SvelteKit 3.x + Svelte 5 + TypeScript (strict) + Tailwind CSS v4. Wrapped in Tauri 2.x for desktop. Includes basic PWA via SvelteKit's service worker at `src-svelte/src/service-worker/index.ts` (fetch-through, no caching). Requires WeeChat >= 3.x. The buffer hdata `id` (LONGLONG) exists only in WeeChat 4.3+ and is treated as optional.

## Project Structure

Source code in `src-svelte/src/` has `components/`, `lib/`, `routes/`, and `service-worker/` (own `tsconfig.json` extending `$app/tsconfig/service-worker`, excluded from the root tsconfig). SvelteKit 3 has no `svelte.config.js` — all Kit config lives in the `sveltekit({...})` plugin options in `vite.config.ts`. Other root config files: `package.json`, `vitest.config.ts`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`. Static assets in `static/`. Test suites in `src-svelte/test/unit/` and `src-svelte/e2e/specs/`. Gbtest environment in `test/fixtures/gbtest/`.

- **`lib/stores/`** — Reactive state (buffers, connection, settings, theme, handlers)
- **`lib/`** — Core utilities (types, linkTokens, weechat protocol, notifications, etc.)
- **`lib/utils/`** — Helper utilities (bufferTooltip, crypto, mediaExtensions, etc.)
- **`components/`** — UI components (chat, buffers, nicklist, modals, shared UI)
- **`routes/`** — SvelteKit routes (+layout, +page, 404)

## Commands

```bash
npm run dev                    # Dev server (localhost:8001)
npm run build                  # Production build (static output to build/)
npm run check                  # svelte-check
npm run lint                   # eslint src-svelte/src src-svelte/test src-svelte/e2e
npm test                       # Vitest unit tests (runs `svelte-kit sync` first)
npm run sync                   # Regenerate Kit 3's node_modules/$app tsconfig shims
npm run test:weechat-format    # Standalone formatter package tests (packages/weechat-format)
npm run check:weechat-format   # Formatter package typecheck
npm run bench:weechat-format   # Formatter throughput benchmark + linear-scaling guard
npm run smoke:weechat-format   # Build + consumer/packaging smoke test
npm run test:e2e               # Full E2E: serial channel specs, then parallel UI-only specs
npm run test:e2e:serial -- --grep "X" # Targeted E2E (channel-dependent specs)
npm run test:e2e:ui -- --grep "X"     # Targeted E2E (UI-only specs)
npm run irc:start / irc:stop   # Manual gbtest IRC server
npm run tauri                 # Tauri CLI (uses @tauri-apps/cli)
npm run tauri:dev             # Tauri desktop dev mode
npm run tauri:build           # Tauri desktop production build
```

Kit 3 writes generated tsconfig shims to `node_modules/$app/` (`tsconfig.json`,
`tsconfig/service-worker.json`, `types/`), and the root `tsconfig.json` plus
`src-svelte/src/service-worker/tsconfig.json` extend them. `npm install` wipes that
directory, which breaks `npm test` (rolldown: `Could not resolve 'node:module'` /
"Tsconfig not found"), `svelte-check` and the service-worker typecheck. `postinstall`,
`pretest` and `precheck` run `svelte-kit sync` so it regenerates automatically; run
`npm run sync` by hand if a tool still reports a missing tsconfig (direct tool calls and
`npm ci --ignore-scripts` bypass these hooks). The hook needs devDependencies: `npm ci
--omit=dev` would skip Kit and fail `postinstall`.

## Code Style (CRITICAL)

### Svelte 5 Runes

- **Never use `$:`** — compiles to `$effect.pre`, causes `$effect_orphan` errors during event handlers
- Use `$state`, `$derived`, `$effect`, `$props()` (NOT `export let`)
- `.svelte` templates: `$storeName` (e.g. `$settings`, `$buffers`)
- `.ts` files: `const val = get(storeName)` via `import { get } from 'svelte/store'`

### Store subscriptions in effects

To prevent effects from re-running on every store update, use `get(store)` inside `$effect`:

```ts
$effect(() => {
    const settings = get(settings);
    const unsub = someSource.subscribe((value) => {
        /* handle */
    });
    return () => unsub(); // cleanup on re-run
});
```

Do NOT initialize `$state` with a store value if you also subscribe to it in an effect — the `$state` initialization creates an unwanted reactive dependency that causes the effect to re-run on every store change.

Use `untrack()` from `svelte` to read a value inside `$effect` without creating a reactive dependency:

```ts
$effect(() => {
    const staticVal = untrack(() => get(settings)); // won't re-trigger effect
    // ...
});
```

### Reactivity

**Writable stores** (`writable()`) require immutable updates. Read via `get(store)`, mutate copy, then `store.set(copy)`. Spread pattern: `buffers.set({ ...get(buffers) })` or `buffers.update(...)`.

**`$state` proxies** support in-place mutation — `.push()`, `.splice()`, direct property assignment all trigger reactivity via Svelte 5's proxy mechanism. Use mutation for local `$state` arrays/objects; use immutable updates for writable stores.

**{#if} blocks after async boundaries do NOT reliably trigger.** Workaround: push placeholder items synchronously before `await`, update in-place after. For modals: render unconditionally, control visibility via `.showPopover()/.hidePopover()`.

### Components

- `$props()` for props, `$state`/`$derived` for mutable/computed state
- Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel
- Add `data-testid` on interactive elements for E2E tests
- Use Tailwind semantic colors (`bg-panel`, `text-text`, `bg-surface-raised`, etc.)
- Use Svelte 5 event handler syntax (`onclick`, `oninput`, `onscroll`, etc.) — never `on:click` (Svelte 4)

### Security

The codebase avoids `{@html}` entirely. For messages and topics, use the `<LinkifiedText>` component which internally calls `tokenizeAndCodify()` from `$lib/linkTokens`. This tokenizes URLs and backtick code blocks into safe tokens rendered natively by Svelte, eliminating XSS surface area.

### Function Comments

Every non-trivial function needs a brief comment above it explaining intent.

### Sync Phase (never timer-based)

`models.ts` exposes `beginSyncPhase()` / `endSyncPhase(generation?)` / `isSyncing()`.
The sync phase is the window in which WeeChat's hotlist counts are about to become
authoritative for a connection; while it is open, real-time lines are not tallied locally
as unread because the baseline already accounts for them.

- Owned by the connection init in `connectionManager.ts`: opened at the start of the
  attempt (before any request, so it covers replayed lines), closed after *that attempt's*
  hotlist baseline has been applied, in its `catch`, and unconditionally by
  `resetAllState()` on disconnect.
- `beginSyncPhase()` returns a generation token and `endSyncPhase(generation)` ignores a
  token that is no longer current, so a superseded connect attempt or a periodic hotlist
  poll cannot close a newer connection's phase. State-applying steps in init re-check
  `connectionGeneration` before mutating, so an obsolete response cannot overwrite a
  newer connection's buffers or hotlist.
- The phase must end only on a protocol event (baseline applied, init failure,
  disconnect). Never add a time-based exit: a quiet period is not evidence of a
  completed sync and would count late history as unread.
- Read-boundary resolution is a separate per-buffer lifecycle (`readBoundaryKnown`,
  `readBoundaryId`, `pendingReadBoundaryUnread`, `setReadBoundary`,
  `resolvePendingReadBoundary`). Never gate it on the global sync flag.
- Regression coverage: `src-svelte/test/unit/sync-flag-lifecycle.test.ts` and
  `src-svelte/test/unit/notification-sync-gate.test.ts`.

## Tauri Desktop

Wrapped in Tauri 2.x for desktop distribution. Custom titlebar via `TauriTitlebar.svelte`. Window API access via `$lib/tauriWindow`. Tauri config in `src-tauri/tauri.conf.json`.

## Testing Framework

**Unit tests (`src-svelte/test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Mock stores via `vi.mock('$lib/stores/models')`, read with `get(store)`.

**E2E tests (`src-svelte/e2e/specs/*.test.ts`)** — UI components, user flows. gbtest auto-started by Playwright's `globalSetup` (port check on relay 9001, IRC 6667, control 16667). Gbtest persists across runs, no teardown needed. Dev server auto-started by Playwright's `webServer` config.

E2E runs in two passes: the `chromium` project (channel-state-dependent specs, `workers: 1`, serial against the shared gbtest `#glowing-bear` state) followed by the `chromium-ui` project (UI-only specs, `workers: 4`, `fullyParallel: true`). New specs land in the serial project by default; only add a file to `UI_ONLY_SPECS` in `playwright.config.ts` if it never sends channel messages and never asserts channel-derived content (message rows, nicks, unread badges).


### Writing E2E Tests

- Import and call `setupEffectOrphanFilter(page)` from `../helpers/pageerror` in every test file to suppress harmless Svelte `$effect_orphan` warnings
- Add `data-testid` attributes on interactive elements
- Use `waitForAppReady(page)` after `page.goto()`
- Serial tests need `test.describe.configure({ mode: 'serial' })`
- Helpers available in `src-svelte/e2e/helpers/`: `connection.ts` (connect, disconnect, reconnect, settings), `buffers.ts` (switch, wait), `irc-control.ts` (IRC server control), `settings.ts`, `pageerror.ts`

### Test Rules

- **Test user-visible behavior, not implementation details.** DOM output, UI state, user flows.
- **Prefer user-facing locators.** `getByRole()`/`getByText()` first. `data-testid` only when no semantic role or stable text fits.

## Git

Do NOT push.

## Legacy AngularJS Code

The original AngularJS application is preserved in `src-angular/`. Do not modify it unless explicitly requested. The active development target is the Svelte version.
