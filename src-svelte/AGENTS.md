# Glowing Bear Svelte — Agent Guide

Browser frontend for WeeChat IRC via WebSockets — **no backend**. Client-side SvelteKit 2.x + Svelte 5 + TypeScript (strict) + Tailwind CSS v4. Wrapped in Tauri 2.x for desktop. Requires WeeChat >= 2.9. Migration from AngularJS (`src/`) into `src-svelte/`; AngularJS app must remain intact.

## Project Structure

`src/` has `components/`, `lib/` (stores, utils, filters), `routes/`. Test suites in `e2e/` and `test/unit/`. IRC server fixture in `test/irc-server/`. Key modules: `weechat.ts`, `connectionManager.ts`, `handlers.ts`, `models.ts`, `settings.ts`, `theme.ts`, `filters.ts`, `notifications.ts`.

## Commands

```bash
npm run dev                    # Dev server (localhost:8001)
npm run check                  # svelte-check
npm run lint                   # eslint src
npm test                       # Vitest unit tests
npm run test:e2e -- --grep "X" # Targeted E2E tests
npm run irc:start / irc:stop   # Manual gbtest IRC server
```

## Code Style (CRITICAL)

### Svelte 5 Runes
- **Never use `$:`** — compiles to `$effect.pre`, causes `$effect_orphan` errors during event handlers
- Use `$state`, `$derived`, `$effect`, `$props()` (NOT `export let`)
- Pattern: `let s = $state($settings)` + `$effect(() => { const unsub = $settings.subscribe(...) })`
- `.svelte` templates: `$storeName` (e.g. `$settings`, `$buffers`)
- `.ts` files: `const val = get(storeName)` via `import { get } from 'svelte/store'`

### Reactivity
Immutable updates only. Spread copies: `buffers.set({ ...get(buffers) })`. Read via `get(store)`, mutate copy, then `store.set(copy)`. Never mutate in-place.

**{#if} blocks after async boundaries do NOT reliably trigger.** Workaround: push placeholder items synchronously before `await`, update in-place after. For modals: render unconditionally, control visibility via `.showPopover()/.hidePopover()`.

### Components
- `$props()` for props, `$state`/`$derived` for mutable/computed state
- Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel
- Add `data-testid` on interactive elements for E2E tests
- Use Tailwind semantic colors (`bg-bg`, `text-text`, `bg-surface`, etc.)

### Security
Always use `sanitizeHtml()` from `$lib/filters` for HTML injection. For messages/topics, prefer `tokenizeLinks()` + Svelte native escaping over `{@html}`.

### Function Comments
Every non-trivial function needs a brief comment above it explaining intent.

## Testing Framework

**Unit tests (`test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Mock stores via `vi.mock('$lib/stores/models')`, read with `get(store)`.

**E2E tests (`e2e/specs/*.test.ts`)** — UI components, user flows. gbtest auto-started by Playwright's `globalSetup` (port check). Gbtest persists across runs, no teardown needed. Dev server auto-started by Playwright's `webServer` config.

### Writing E2E Tests
Add `data-testid` attributes, include `effect_orphan` pageerror filter, use `waitForAppReady(page)` after `goto`. Serial tests need `configure({ mode: 'serial' })`.

### Test Rules
- **Test user-visible behavior, not implementation details.** DOM output, UI state, user flows.
- **Prefer user-facing locators.** `getByRole()`/`getByText()` first. `data-testid` only when no semantic role or stable text fits.
