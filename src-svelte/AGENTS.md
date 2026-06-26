# Glowing Bear Svelte — Agent Guide

Browser frontend for WeeChat IRC via WebSockets — **no backend**. Client-side SvelteKit 2.x + Svelte 5 + TypeScript (strict) + Tailwind CSS v4. Wrapped in Tauri 2.x for desktop. Includes PWA support via `@vite-pwa/sveltekit` (auto-update strategy). Requires WeeChat >= 2.9. Migration from AngularJS (`src/`) into `src-svelte/`; AngularJS app must remain intact.

## Project Structure

`src-svelte/src/` has `components/`, `lib/`, `routes/`. Test suites in `src-svelte/test/unit/` and `src-svelte/e2e/specs/`. IRC server fixture in `src-svelte/test/irc-server/`. Gbtest environment in `test/fixtures/gbtest/`.

### Key modules by directory

**`src-svelte/src/lib/stores/`** — Reactive state management:
- `connectionManager.ts` — WebSocket connection lifecycle, reconnection logic
- `connectionStore.ts` — Current connection state
- `handlers.ts` — WeeChat protocol message handlers
- `models.ts` — Buffer, line, nick data models and mutations
- `settings.ts` — User preferences persisted to localStorage
- `theme.ts` — Theme configuration and Tailwind token mapping
- `bufferResume.ts` — Last-active-buffer tracking across sessions
- `inputHistory.ts`, `inputState.ts` — Input bar state and history

**`src-svelte/src/lib/` (root)** — Core utilities:
- `filters.ts` — Text filters (`sanitizeHtml`, `escapeHtml`, `codify`, `inlinecolour`, `truncate`)
- `linkTokens.ts` — URL/code tokenization (`tokenizeLinks`, `codifyText`, `tokenizeAndCodify`)
- `notifications.ts` — Desktop notification dispatch (Tauri + Web Notifications API)
- `toast.ts` — In-app toast notifications
- `emojify.ts` — Emoji shortcode replacement
- `faviconBadge.ts` — Favicon hotlist badge updates
- `weechat.ts` — WeeChat relay WebSocket protocol (handshake, compression, messaging)
- `weechat-rest.ts`, `weechat-rest-types.ts` — WeeChat REST API client
- `tauriWindow.ts` — Tauri window API wrapper
- `debug.ts` — Debug logging utilities
- `imgur.ts` — Imgur image upload integration

**`src-svelte/src/lib/utils/`** — Helper utilities:
- `bufferTooltip.ts` — Buffer tooltip content generation
- `crypto.ts` — Password hashing (PBKDF2, native crypto)
- `mediaExtensions.ts` — Media file type detection
- `prefixIcons.ts` — IRC prefix icon mapping
- `urlEmbeds.ts` — URL embed/rich preview generation

**`src-svelte/src/components/`** — UI components:
- `BufferList`, `BufferLineRow`, `BufferHotlist`, `BufferSearchModal` — Buffer navigation
- `ChatView`, `InputBar` — Chat display and input
- `Nicklist` — Nickname list with search
- `LinkifiedText`, `TokenGroupRenderer` — Token-based text rendering
- `TopicModal`, `TopBar`, `SettingsModal`, `ConnectionForm` — Modals and dialogs
- `TauriTitlebar` — Custom Tauri window titlebar
- `Badge`, `Toast`, `Tooltip`, `BaseDialog`, `ImageUploadPreview`, `PluginEmbed` — Shared UI

## Commands

Run from `src-svelte/`:

```bash
npm run dev                    # Dev server (localhost:8001)
npm run build                  # Production build (static output)
npm run check                  # svelte-check
npm run lint                   # eslint src
npm test                       # Vitest unit tests
npm run test:e2e -- --grep "X" # Targeted E2E tests
npm run irc:start / irc:stop   # Manual gbtest IRC server
npm run tauri                  # Tauri CLI passthrough
npm run tauri:dev              # Tauri desktop dev mode
npm run tauri:build            # Tauri desktop production build
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
  const unsub = someSource.subscribe(value => { /* handle */ });
  return () => unsub();  // cleanup on re-run
});
```

Do NOT initialize `$state` with a store value if you also subscribe to it in an effect — the `$state` initialization creates an unwanted reactive dependency that causes the effect to re-run on every store change.

### Reactivity

Immutable updates only. Spread copies: `buffers.set({ ...get(buffers) })`. Read via `get(store)`, mutate copy, then `store.set(copy)`. Never mutate in-place.

**{#if} blocks after async boundaries do NOT reliably trigger.** Workaround: push placeholder items synchronously before `await`, update in-place after. For modals: render unconditionally, control visibility via `.showPopover()/.hidePopover()`.

### Components

- `$props()` for props, `$state`/`$derived` for mutable/computed state
- Import icons per-icon: `import X from '@lucide/svelte/icons/x'` — never barrel
- Add `data-testid` on interactive elements for E2E tests
- Use Tailwind semantic colors (`bg-panel`, `text-text`, `bg-surface-raised`, etc.)

### Security

The codebase avoids `{@html}` entirely. For messages and topics, use the `<LinkifiedText>` component which internally calls `tokenizeAndCodify()` from `$lib/linkTokens`. This tokenizes URLs and backtick code blocks into safe tokens rendered natively by Svelte, eliminating XSS surface area.

`sanitizeHtml()` in `$lib/filters` exists as a last-resort fallback for content that must use `{@html}` (e.g., plugin embed HTML). Only use it when `<LinkifiedText>` cannot handle the content.

### Function Comments

Every non-trivial function needs a brief comment above it explaining intent.

## Tauri Desktop

Wrapped in Tauri 2.x for desktop distribution. Custom titlebar via `TauriTitlebar.svelte`. Plugins: autostart (`@tauri-apps/plugin-autostart`), system notifications (`plugin-notification`), window state persistence (`plugin-window-state`). Window API access via `$lib/tauriWindow`.

## Testing Framework

**Unit tests (`src-svelte/test/unit/*.test.ts`)** — pure functions, stores, protocol, utilities. Mock stores via `vi.mock('$lib/stores/models')`, read with `get(store)`.

**E2E tests (`src-svelte/e2e/specs/*.test.ts`)** — UI components, user flows. gbtest auto-started by Playwright's `globalSetup` (port check on relay 9001, IRC 6667, control 16667). Gbtest persists across runs, no teardown needed. Dev server auto-started by Playwright's `webServer` config.

### Writing E2E Tests

- Import and call `setupEffectOrphanFilter(page)` from `../helpers/pageerror` in every test file to suppress harmless Svelte `$effect_orphan` warnings
- Add `data-testid` attributes on interactive elements
- Use `waitForAppReady(page)` after `page.goto()`
- Serial tests need `test.describe.configure({ mode: 'serial' })`
- Helpers available in `e2e/helpers/`: `connection.ts` (connect, disconnect, reconnect, settings), `buffers.ts` (switch, wait), `irc-control.ts` (IRC server control), `settings.ts`, `pageerror.ts`

### Test Rules

- **Test user-visible behavior, not implementation details.** DOM output, UI state, user flows.
- **Prefer user-facing locators.** `getByRole()`/`getByText()` first. `data-testid` only when no semantic role or stable text fits.

### Git

After code changing is completed -> offer a choice to the user to git commit.
Do NOT git push.
