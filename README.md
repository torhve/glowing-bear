# Glowing Bear

A web frontend for the [WeeChat](https://weechat.org) IRC client. Connects directly to WeeChat via WebSocket relay — no backend service required.

Requires WeeChat >= 2.9 with the relay plugin configured.

## How to Run It

Glowing Bear can be used in several ways:

### In Your Browser

Point any modern browser at a hosted instance and connect to your WeeChat relay. Your browser talks directly to WeeChat; it doesn't matter where Glowing Bear itself is hosted.

### Self-Hosted Static Site

Build the static site and serve it with any web server (nginx, Caddy, Apache):

```bash
npm install
npm run build
```

This produces a `build/` directory containing all the files you need. Point your web server at it. For HTTPS hosting, see the [Getting Started](#getting-started-for-users) section below.

### Progressive Web App

Glowing Bear includes PWA support with auto-update strategy. On supported browsers and devices, you can install it as an app:

- **Desktop Chrome/Firefox/Edge** — "Install" option in the address bar or app menu
- **Android Chrome** — "Add to homescreen" for a full-screen experience
- **iOS Safari** — "Add to Home Screen" from the share sheet

Once installed, it runs standalone without browser chrome and caches assets for offline use.

### Tauri Desktop App

Glowing Bear can be packaged as a native desktop application via [Tauri 2](https://tauri.app), giving you a custom window, autostart support, system notifications, and persistent window state across sessions. Requires Rust installed.

```bash
npm install
npm run tauri:build
```

Produces installers for Linux (deb), macOS (dmg), and Windows (msi/nsis).

## Getting Started for Users

To connect Glowing Bear to your WeeChat instance, you need a relay. In WeeChat:

```
/relay add weechat 9001
/set relay.network.password YOURPASSWORD
```

Then enter your WeeChat host, port, and password in Glowing Bear's connection form.

**Please note that the above sets up an unencrypted relay.** All data will be transmitted in clear text. Set up TLS encryption (via Let's Encrypt or similar) before using over the internet. See our [wiki](https://github.com/glowing-bear/glowing-bear/wiki/Proxying-WeeChat-relay-with-a-web-server) for proxying and encryption guides.

## Development

### Tech Stack

- [SvelteKit 2.x](https://svelte.dev/docs/kit) + [Svelte 5](https://svelte.dev) (runes)
- [TypeScript](https://www.typescriptlang.org/) (strict mode)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Tauri 2.x](https://tauri.app) (desktop apps)
- [@vite-pwa/sveltekit](https://github.com/vike/vite-plugin-pwa) (PWA)
- [Vitest](https://vitest.dev) (unit tests) + [Playwright](https://playwright.dev) (E2E tests)

### Prerequisites

- **Node.js** (v20+)
- **Rust/Cargo** — only needed if building Tauri desktop apps

### Daily Development

```bash
npm install
npm run dev          # Development server at localhost:8001
npm run check        # TypeScript type checking
npm run lint         # ESLint
npm run knip         # Detect unused dependencies and exports
```

### Building

```bash
npm run build        # Production static build → build/
npm run preview      # Preview production build locally
npm run tauri:build  # Tauri desktop production build (requires Rust)
```

### Testing

```bash
npm test                         # Run unit tests (Vitest)
npm run test:watch               # Unit tests in watch mode
npm run test:e2e                 # Run E2E tests (Playwright)
npm run test:e2e -- --grep "X"   # Run specific E2E tests
npm run test:e2e:watch           # E2E tests in Playwright UI mode
npm run test:e2e:debug           # E2E tests in debug mode
npm run irc:start                # Start gbtest IRC server fixture
npm run irc:stop                 # Stop gbtest IRC server
```

Unit tests live in `src-svelte/test/unit/`. E2E tests in `src-svelte/e2e/specs/`. The gbtest IRC server (`test/fixtures/gbtest/`) provides a local WeeChat instance for automated testing.

### Tauri Desktop

```bash
npm run tauri      # Tauri CLI
npm run tauri:dev  # Tauri desktop dev mode (requires Rust)
```

Uses the project-bundled `@tauri-apps/cli` (v2) rather than a globally installed `cargo tauri`, ensuring version consistency with Rust dependencies.

### Utilities

```bash
npm run generate-icons  # Generate PWA icons from source SVG
npm run generate-icns   # Generate macOS .icns icon file
npm run irc:server      # Run the IRC server fixture directly via tsx
```


### Themes

Glowing Bear ships with built-in themes (Dark, Light, Black, Catppuccin variants, Base16 variants, and more).
Custom CSS injection is also available in settings for unlimited personalization.

### Key Features

- **Buffer list** — sortable by number or server, filter unread/pinned, search modal (Alt+G)
- **Content search** — Ctrl+F to search buffer content (requires WeeChat `/grep` script)
- **Chat view** — scrollable message history with lazy loading, time grouping, nick prefixes
- **Nicklist** — searchable nickname list with prefix icons; inline on desktop, swipe overlay on mobile
- **Hotlist bar** — horizontal strip of buffers with unread activity in the top bar; prominent on mobile when buffer list is hidden
- **Pin/unpin buffers** — pinned buffers always stay visible and sort to the top
- **Keyboard shortcuts** — Alt+1-9 quick keys, Alt+J two-digit jump-to-buffer, type-to-focus, PageUp/PageDown scroll, Alt+< previous buffer, Alt+L focus input, Alt+n toggle nicklist, Alt+A jump to most urgent buffer, Alt+↑/↓ adjacent buffer, Alt+h clear all unread, double-Escape disconnect
- **Mobile touch gestures** — swipe right → buffer list, swipe left → nicklist, vertical swipe → switch buffer
- **Image upload** — drag-and-drop or click to upload images via Imgur
- **URL embeds** — rich previews for links
- **Emoji shortcodes** — optional `:beer:` → 🍺 replacement while typing
- **Desktop notifications** — system notifications and favicon badge for mentions and highlights
- **KaTeX math rendering** — optional LaTeX math support
- **Connection stats** — hover the status indicator to see bytes sent/received, message count, uptime, and time since last message
- **Auto-reconnect** — automatic reconnection with backoff on connection loss
- **Buffer resume** — restores last active buffer on reconnect

## Contributing

Join us at **#glowing-bear** on [Libera](https://libera.chat) to discuss ideas, ask questions, or just chat about the project.

We welcome all contributions — code, design, documentation, testing. Make sure your changes pass the test suite before submitting a pull request.

## Legacy AngularJS Code

The original AngularJS application is preserved in [`src-angular/`](src-angular/) for reference.
