# Glowing Bear Svelte — Agent Guide

Browser frontend for WeeChat IRC via WebSockets — **no backend**. Client-side SvelteKit 2.x + Svelte 5 + TypeScript (strict) + Tailwind CSS v4. Wrapped in Tauri 2.x for desktop. Requires WeeChat >= 2.9. Migration from AngularJS (`src/`) into `src-svelte/`; AngularJS app must remain intact.

## Project Structure

```
src-svelte/src/
├── components/   # 18 Svelte components
├── lib/          # types, utils, stores, notifications, filters
│   └── stores/   # connectionManager, models, handlers, settings, theme, bufferResume, connectionStore, inputHistory, nickColors, themeColors
└── routes/       # SvelteKit routes (+page.svelte, +layout.svelte, etc.)
e2e/              # Playwright tests: specs/, helpers/, fixtures/, playwright.config.ts, global-setup.ts, global-teardown.ts
test/unit/        # Vitest unit tests
test/irc-server/  # Local IRC server for testing
static/css/themes/ # 13 theme CSS files
```

Key files: `weechat.ts` (binary relay protocol), `connectionManager.ts` (WS lifecycle), `handlers.ts` (dispatches → models), `models.ts` (writable stores), `settings.ts` (localStorage), `theme.ts` (CSS vars), `notifications.ts`, `faviconBadge.ts`, `linkTokens.ts`, `filters.ts`, `toast.ts`.

## Commands

```bash
npm run dev                    # Vite dev server on localhost:8001
npm run build                  # Production build to build/
npm run check                  # svelte-check
npm run lint                   # eslint src
npm test                       # Vitest unit tests
npm run test:e2e               # Playwright E2E (auto-starts gbtest if needed)
npm run test:e2e -- --grep "X" # Targeted E2E tests
npm run test:e2e e2e/specs/Component.test.ts  # Single file
npm run test:e2e:watch         # Playwright UI mode
npm run irc:start / irc:stop   # Manual gbtest start/stop
```

## Code Style (CRITICAL)

### Svelte 5 Runes
- **Never use `$:`** — compiles to `$effect.pre`, causes `$effect_orphan` errors during event handlers
- Use `$state`, `$derived`, `$effect`, `$props()` (NOT `export let`)
- Pattern: `let s = $state($settings)` + `$effect(() => { const unsub = $settings.subscribe(...) })`

### Reactivity
Immutable updates only. Spread copies: `buffers.set({ ...get(buffers) })`. Read via `get(store)`, mutate copy, then `store.set(copy)`. Never mutate in-place.

**{#if} blocks after async boundaries do NOT reliably trigger.** Workaround: push placeholder items synchronously before `await`, update in-place after. For modals: render unconditionally, control visibility via `.showPopover()/.hidePopover()`.

### Store Access
- `.svelte` templates: `$storeName` (e.g. `$settings`, `$buffers`)
- `.ts` files: `const val = get(storeName)` via `import { get } from 'svelte/store'`

### Components
- `$props()` for props, `$state`/`$derived` for mutable/computed state
- Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel
- Add `data-testid` on interactive elements for E2E tests
- Use Tailwind semantic colors: `bg-bg`, `text-text`, `border-border`, `bg-surface`, `bg-surface-raised`, `bg-input-bg`, `text-text-secondary`, `text-danger`, `text-text-muted`, `accent`
- Modals: `<BaseDialog>` with `id`, `labelledby`, close buttons with `popovertarget`/`popovertargetaction="hide"`
- `mount(Component, { target, props })` returns component **exports**, not DOM element

### Security
Always use `sanitizeHtml()` from `$lib/filters` for HTML injection. For messages/topics, prefer `tokenizeLinks()` + Svelte native escaping over `{@html}`.

### Function Comments
Every non-trivial function needs a brief comment above it explaining intent.

## Testing Framework

**Unit tests (`test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Mock stores via `vi.mock('$lib/stores/models')`, read with `get(store)`.

**E2E tests (`e2e/specs/*.test.ts`)** — UI components, user flows. gbtest auto-started by Playwright's `globalSetup` (port check). Gbtest persists across runs, no teardown needed. Dev server auto-started by Playwright's `webServer` config.

### Writing E2E Tests
1. Add `data-testid` attributes to tested components
2. Create `e2e/specs/Component.test.ts`
3. Include error filter in `beforeEach`: `page.on('pageerror', (e) => { if (e.message?.includes('effect_orphan')) return; });`
4. `page.goto('http://localhost:8001/')` then `await waitForAppReady(page)`
5. Shared state: `test.describe.configure({ mode: 'serial' })`

### Test Rules
- **Test user-visible behavior, not implementation details.** DOM output, UI state, user flows. Implementation details (`new Audio(src)`, `new Notification(title)`) belong in unit tests.
- **Prefer user-facing locators.** `getByRole()`/`getByText()` first. `data-testid` only when no semantic role or stable text fits.
- **Mock browser APIs with `addInitScript`** in `beforeAll`, reset in `beforeEach`. Not per-test `page.evaluate()`.

### Deploying and pushing

- NEVER git push to upstream
- NEVER git push to origin

## Known Issues

- **Svelte 5 `$effect.pre` orphan error** in dev-mode Playwright — filtered via `page.on('pageerror')`. Does NOT affect production.
- **Vitest browser mode is NOT used** — incompatible with Svelte 5.
- **Tauri on Windows uses MSWebView2**

## Prerequisites

1. **gbtest environment**: IRC localhost:6667, relay ws://localhost:9001 (password: `testpassword123`). Auto-started by Playwright's `globalSetup`. Manual: `npm run irc:start` / `irc:stop`. Persists across runs. Modifying `test/irc-server/` requires restart.
2. **Dev server**: localhost:8001. Auto-started by Playwright's `webServer`. Manual: `npm run dev`
