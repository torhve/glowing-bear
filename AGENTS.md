# Glowing Bear Svelte — Agent Guide

Browser frontend for WeeChat IRC via WebSockets — **no backend**. Client-side SvelteKit 2.x + Svelte 5 + TypeScript (strict) + Tailwind CSS v4. Wrapped in Tauri 2.x for desktop. Includes PWA support via `@vite-pwa/sveltekit` (auto-update strategy). Requires WeeChat >= 2.9.

## Project Structure

Source code in `src-svelte/src/` has `components/`, `lib/`, `routes/`. Config files (`package.json`, `svelte.config.js`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `tsconfig.json`) live at repo root. Static assets in `static/`. Test suites in `src-svelte/test/unit/` and `src-svelte/e2e/specs/`. Gbtest environment in `test/fixtures/gbtest/`.

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
npm run lint                   # eslint src-svelte/src
npm test                       # Vitest unit tests
npm run test:e2e -- --grep "X" # Targeted E2E tests
npm run irc:start / irc:stop   # Manual gbtest IRC server
npm run tauri                 # Tauri CLI (uses @tauri-apps/cli)
npm run tauri:dev             # Tauri desktop dev mode
npm run tauri:build           # Tauri desktop production build
```

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

## Tauri Desktop

Wrapped in Tauri 2.x for desktop distribution. Custom titlebar via `TauriTitlebar.svelte`. Window API access via `$lib/tauriWindow`. Tauri config in `src-tauri/tauri.conf.json`.

## Testing Framework

**Unit tests (`src-svelte/test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Mock stores via `vi.mock('$lib/stores/models')`, read with `get(store)`.

**E2E tests (`src-svelte/e2e/specs/*.test.ts`)** — UI components, user flows. gbtest auto-started by Playwright's `globalSetup` (port check on relay 9001, IRC 6667, control 16667). Gbtest persists across runs, no teardown needed. Dev server auto-started by Playwright's `webServer` config.

### Writing E2E Tests

- Import and call `setupEffectOrphanFilter(page)` from `../helpers/pageerror` in every test file to suppress harmless Svelte `$effect_orphan` warnings
- Add `data-testid` attributes on interactive elements
- Use `waitForAppReady(page)` after `page.goto()`
- Serial tests need `test.describe.configure({ mode: 'serial' })`
- Helpers available in `src-svelte/e2e/helpers/`: `connection.ts` (connect, disconnect, reconnect, settings), `buffers.ts` (switch, wait), `irc-control.ts` (IRC server control), `settings.ts`, `pageerror.ts`

### Test Rules

- **Test user-visible behavior, not implementation details.** DOM output, UI state, user flows.
- **Prefer user-facing locators.** `getByRole()`/`getByText()` first. `data-testid` only when no semantic role or stable text fits.

### Git

After code changing is completed -> a choice to the user to git commit.
Do NOT push.

## Legacy AngularJS Code

The original AngularJS application is preserved in `src-angular/`. Do not modify it unless explicitly requested. The active development target is the Svelte version.
