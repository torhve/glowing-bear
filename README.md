# Glowing Bear

[![CI](https://github.com/torhve/glowing-bear/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/torhve/glowing-bear/actions/workflows/ci.yml?query=branch%3Amain)
[![Release](https://img.shields.io/github/v/release/torhve/glowing-bear?label=release)](https://github.com/torhve/glowing-bear/releases/latest)
[![License](https://img.shields.io/github/license/torhve/glowing-bear)](./COPYING)
![WeeChat](https://img.shields.io/badge/WeeChat-4.10.1%2B_API_or_3.x%2B_legacy-blue)

A web frontend for the [WeeChat](https://weechat.org) IRC client. Connects directly to WeeChat through the relay plugin — no backend service required.

Glowing Bear speaks two relay protocols and picks one automatically: the JSON **Relay API** (HTTP + WebSocket, WeeChat >= 4.10.1, API 0.6.0) when the relay supports it, and the legacy WebSocket protocol for older WeeChat versions. You can pin the choice in settings (`auto` / `api` / `legacy`). Password authentication supports plain, SHA-256/SHA-512, and PBKDF2+SHA-256/SHA-512 on both paths. Relays that require TOTP (`relay.network.totp`) work on the legacy path (the code is requested interactively); the API path cannot deliver TOTP over a browser WebSocket and will report it clearly.

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

Glowing Bear includes a basic service worker (via SvelteKit's `src-svelte/src/service-worker/`). On supported browsers and devices, you can install it as an app:

- **Desktop Chrome/Firefox/Edge** — "Install" option in the address bar or app menu
- **Android Chrome** — "Add to homescreen" for a full-screen experience
- **iOS Safari** — "Add to Home Screen" from the share sheet

Once installed, it runs standalone without browser chrome.

### Tauri Desktop App

Glowing Bear can be packaged as a native desktop application via [Tauri 2](https://tauri.app), giving you a custom window, autostart support, system notifications, and persistent window state across sessions. Requires Rust installed.

```bash
npm install
npm run tauri:build
```

Produces installers for Linux (deb), macOS (dmg), and Windows (msi/nsis).

## Getting Started for Users

To connect Glowing Bear to your WeeChat instance, you need a relay. On WeeChat 4.10.1 or newer, add the API relay:

```
/relay add api 9010
/set relay.network.password YOURPASSWORD
```

On older WeeChat versions, add the legacy relay instead (Glowing Bear detects it and falls back automatically):

```
/relay add weechat 9001
/set relay.network.password YOURPASSWORD
```

Then enter your WeeChat host, port, and password in Glowing Bear's connection form.

**Please note that the above sets up an unencrypted relay.** All data will be transmitted in clear text. Set up TLS encryption (via Let's Encrypt or similar) before using over the internet. See our [wiki](https://github.com/glowing-bear/glowing-bear/wiki/Proxying-WeeChat-relay-with-a-web-server) for proxying and encryption guides.

Add one relay, not both: Glowing Bear probes the address you enter and talks to it over
one transport — the API relay when the address answers the API probe, the legacy relay
otherwise. The choice is remembered per `host:port:tls` and holds only what a session
proved: a reconnect reuses it without re-probing, while an attempt that never connected
leaves nothing behind, so a failure cannot pin an address to a transport. Disconnecting
clears it and lets you change the relay configuration. Settings → Relay protocol can pin
the transport (`Auto`, `API` or `Legacy`) instead of probing.

A pin is a preference, not a guarantee. If nothing on the port answers as the protocol you
pinned, the connection form says so and offers the way back — switch to Auto, or switch to
the other protocol — because the settings that hold the pin belong to the chat shell a
failed connection never opens. `#protocol=auto|api|legacy` in the URL sets the same setting
without the form.

Options worth knowing (all under `relay.network.*` unless noted):

| Option | Why it matters here |
| --- | --- |
| `password` | required by both transports; the stored value is the plain password, while the app sends a timestamped hash of it rather than the password itself |
| `password_hash_algo` | the app negotiates `plain`, `sha256`, `sha512`, `pbkdf2+sha256`, `pbkdf2+sha512`; set `*,!plain` to refuse the plaintext handshake |
| `time_window` | hashed credentials carry a Unix timestamp and must fall within this window of server time (default 5 s) — a clock-skewed server makes every hashed handshake fail |
| `tls_cert_key` | combined certificate + private key file for `tls.*` relays; reload it with `/relay tlscertkey` without restarting WeeChat |
| `websocket_allowed_origins` | empty (default) accepts any `Origin`; when set it is a POSIX regex the browser's `Origin` must match, or the WebSocket handshake is rejected — set it when you serve one origin |
| `websocket_permessage_deflate` | API transport only; browsers request `permessage-deflate` and the relay answers when this is on |
| `bind_address` / `allowed_ips` | `127.0.0.1` for a local-only relay, or restrict client IPs with a POSIX regex |
| `totp_secret` | **not supported by this client** — a TOTP-protected relay is refused with an explicit error rather than half-connected, because the browser cannot carry a TOTP in the WebSocket handshake |

A reverse proxy must forward the WebSocket upgrade intact: the API transport opens
`<base>/api` with subprotocols `api.weechat` and
`base64url.bearer.authorization.weechat.<credential>` (the credential is the same
payload the HTTP `Authorization` header carries, base64url-encoded), and the legacy
transport opens `<base>/weechat`. WeeChat picks the protocol from the URL path and
authenticates from the subprotocol, so a proxy that rewrites the path or drops
`Sec-WebSocket-Protocol` breaks the handshake rather than just the framing.

Cross-origin HTTP matters too: the relay answers `OPTIONS *` with a 204 CORS preflight
(`Access-Control-Allow-Origin: *`, allowing `authorization`), so a proxy must forward OPTIONS
requests unchanged — stripping them turns every API call into a CORS failure.


### Migrating an existing relay

Back up the WeeChat configuration (`relay.conf`, `weechat.conf`) before touching the relay,
and keep a tagged previous release as rollback material

1. Confirm the WeeChat version: the API transport needs 4.10.1 or newer (Relay API 0.6.0).
   Older builds keep working, but only over the legacy relay.
2. Change the **listener**, not the browser path. A browser update never converts a
   `weechat` listener into an `api` one:

   ```weechat
   /relay del weechat
   /relay add tls.api 9010
   ```

   `addreplace` swaps a relay without restarting WeeChat.
3. Serve certificate and private key as ONE file at `relay.network.tls_cert_key`. After
   certbot renews it, run `/relay tlscertkey` — a running WeeChat keeps serving the old
   material until you do.
4. If you set `relay.network.websocket_allowed_origins`, include the origin the app is
   served from. An empty value skips the check; a set value that omits your origin makes
   every browser connection fail at the handshake.
5. Keep `relay.network.websocket_permessage_deflate` on unless a client is known to
   mishandle it.
6. Do not enable `relay.network.totp_secret`: this client refuses a TOTP-protected relay
   rather than half-connecting (see the row above).
7. If no port can be exposed, listen on a socket instead — `/relay add unix.api` under the
   WeeChat runtime dir plus `ssh -L 9010:.weechat/relay_socket` gives the browser a local
   port.
8. Update the proxy routes to match the new listener — the upgrade must reach WeeChat on
   `/api` (and `/weechat` while older clients still use it), see the paragraph above.
9. Update the saved endpoint in the app (host, port, TLS). A bookmark keeps pointing at the
   previous listener, and the app cannot tell you that the address changed.
10. Deploy the new frontend only after the listener answers the API probe: an address without
   an `api` listener still connects, over the legacy transport, which hides a half-migrated
   relay.
11. Verify the features against the new listener before retiring the old one: connect, let the
   unread baseline settle, chat, complete a nick, run a content search.
12. Retire the old `weechat` listener only when no older client needs it — that is a
   deployment choice, not dual-protocol support in the client.

The transport choice is cached per `host:port:tls`, so after changing the relay
configuration, disconnect in the app before reconnecting — otherwise the cached transport
is reused and a reconfigured listener looks unchanged.

## Development

### Tech Stack

- [SvelteKit 3.x](https://svelte.dev/docs/kit) + [Svelte 5](https://svelte.dev) (runes)
- [TypeScript](https://www.typescriptlang.org/) (strict mode)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Tauri 2.x](https://tauri.app) (desktop apps)
- [SvelteKit service worker](https://svelte.dev/docs/kit/service-workers) (PWA)
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

`GIT_COMMIT` overrides the commit hash stamped into the build and shown in Settings
(`GIT_COMMIT=abc1234 npm run build`); it defaults to `git rev-parse --short HEAD`, or `unknown`
when no repository is present — as in Docker, where `.dockerignore` excludes `.git`.

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

Glowing Bear follows the system's light/dark setting and picks a built-in palette (Dark, Light, Black, Catppuccin variants, Base16 variants, and more) to match it, and updates live when the OS preference changes. Settings lets you pin a specific palette for the light and dark modes independently. Custom CSS injection is also available in settings for personalization.

### Key Features

- **Buffer list** — sortable by number or server, filter unread/pinned, search modal (Alt+G)
- **Content search** — Ctrl+F to search buffer content (requires the WeeChat `/grep` script; a relay that does not list a grep script says so instead of reporting no results)
- **Chat view** — scrollable message history with lazy loading, time grouping, nick prefixes
- **Nicklist** — searchable nickname list with prefix icons; inline on desktop, swipe overlay on mobile
- **Hotlist bar** — horizontal strip of buffers with unread activity in the top bar; prominent on mobile when buffer list is hidden
- **Pin/unpin buffers** — pinned buffers always stay visible and sort to the top
- **Keyboard shortcuts** — Alt+1-9 quick keys, Alt+J two-digit jump-to-buffer, type-to-focus, PageUp/PageDown scroll, Alt+< previous buffer, Alt+L focus input, Alt+n toggle nicklist, Alt+A jump to most urgent buffer, Alt+↑/↓ adjacent buffer, Alt+h clear all unread, double-Escape disconnect
- **Mobile touch gestures** — tap the logo → toggle buffer list (also swipe right), swipe left → nicklist, vertical swipe → switch buffer
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
