# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Glowing Bear is a browser-based frontend for the WeeChat IRC client. It speaks the WeeChat relay protocol directly over WebSockets — there is **no backend service**. All code is client-side JavaScript (AngularJS 1.x) plus an optional Tauri wrapper (Rust) for native desktop apps. The user's browser connects straight to their WeeChat instance.

Requires WeeChat ≥ 0.4.2 on the server side. There is a compatibility shim for WeeChat 2.8 vs ≥ 2.9 around the handshake / password hashing (`settings.compatibilityWeechat28`).

## Common commands

```bash
npm install              # install deps (runs automatically before `start`)
npm start                # webpack dev server on http://localhost:8000 with live reload
npm run build            # production build into build/
npm run lint             # jshint over src/js/*.js and test/unit/*.js
npm test                 # karma + jasmine unit tests (single run; uses webpack preprocessor)
npm run protractor       # e2e tests — REQUIRES Glowing Bear on :8000 AND WeeChat relay on :9001
./run_tests.sh           # what CI runs: lint + unit tests
npm run tauri -- dev     # run the Tauri desktop wrapper in dev mode
npm run tauri -- build   # build native desktop bundles
```

Single-test runs: there is no built-in filter flag; edit `test/unit/main.test.js` to import only the spec you want, or use Jasmine's `fdescribe` / `fit` to focus.

The Karma config (`test/karma.conf.js`) auto-switches to `ChromeHeadlessNoSandbox` under `TRAVIS=1`. For headless local runs without a display, set that env var or add a custom launcher.

## Architecture

Entry point is `src/main.js`, which imports every AngularJS module under `src/js/`. Webpack bundles everything; `src/index.html` is the shell that Angular boots into. There is **no router-driven view layout** — the whole UI lives in `src/index.html` with directives in `src/directives/` (`input.html`, `plugin.html`).

The codebase splits cleanly into protocol vs. UI:

### Protocol layer (network-agnostic)
- **`src/js/weechat.js`** (~1400 lines) — pure parser/encoder for the WeeChat binary relay protocol. Knows nothing about WebSockets. Decodes types (`chr`, `int`, `str`, `hda`, `ptr`, `tim`, `arr`, `htb`, `inl`, …), handles zlib-compressed frames (via `zlibjs`), and produces JS objects. Also contains the rich-text/color parser (`rawText2Rich`) used by the UI to render WeeChat color codes.
- **`src/js/websockets.js`** (`ngWebsockets` factory) — thin WebSocket transport. Sends commands, matches responses to callbacks by id, exposes promise-based send.
- **`src/js/connection.js`** (`connection` factory) — orchestration: open/close/reconnect, handshake (`compatibilityWeechat28` switch between plaintext password and PBKDF2/SHA-512), TOTP, hotlist polling interval, ping/pong keepalive. **Do not call `ngWebsockets` directly from controllers — go through `connection`.**

### Domain / state
- **`src/js/models.js`** (`models` service) — the single source of truth for buffers, lines, nicklists, the WeeChat version, and `wconfig`. UI watches scopes on these models.
- **`src/js/handlers.js`** — dispatch table that takes parsed protocol messages and mutates `models` accordingly (`_buffer_line_added`, `_nicklist`, `_buffer_opened`, etc.).
- **`src/js/bufferResume.js`** — tracks which buffer was last viewed so reconnect lands the user in the right place.

### UI
- **`src/js/glowingbear.js`** (~1000 lines) — the main `WeechatCtrl` controller. Handles settings defaults, theme switching, mobile swipe state, the buffer list, notifications wiring, focus/scroll. Imports `connectionFactory` from `connection.js` and registers it as the `connection` service.
- **`src/js/inputbar.js`** (~800 lines) — chat input directive with readline-style keybindings, history, tab completion (delegates to `irc-utils.js` for nick completion).
- **`src/js/plugin-directive.js`** + **`src/directives/plugin.html`** — renders embedded plugin output (image previews, video embeds, etc.).
- **`src/js/imgur*.js`** — Imgur upload integration (drag-and-drop in `imgur-drop-directive.js`).
- **`src/js/filters.js`** — Angular filters used in templates (highlighting, IRC color → HTML, etc.).
- **`src/js/notifications.js`** — desktop notifications, sound, favicon badge (`favico.js`).
- **`src/js/settings.js`** + **`src/js/localstorage.js`** — settings with localStorage persistence. Every setting must be declared in `settings.setDefaults({...})` in `glowingbear.js` or it won't persist.

### Plugins (content embedding)
- **`src/js/plugins.js`** defines `Plugin` (matches against message text) and `UrlPlugin` (matches URLs via a regex). The plugin registry lives in the `plugins` Angular module. To add an embed type, append a new `Plugin`/`UrlPlugin` to the array in this file. **Anything injected into the DOM via `innerHTML` must be sanitized** — the codebase has had XSS regressions here; see recent commits about sanitizing gist/tweet/tiktok HTML before insertion.

### Tauri wrapper
`src-tauri/` is a thin Rust shell that loads the built web app. `tauri.conf.json` points `distDir` at `../build` and `devPath` at the webpack dev server. It uses `tauri-plugin-window-state` for window persistence.

## Conventions

- AngularJS 1.x dependency-injection arrays are used everywhere (`['$scope', ..., function($scope, ...){}]`). Adding a new dependency requires updating both the array and the function signature.
- `jshint` is configured for `esversion: 6` (`.jshintrc`); ES module syntax in source is handled by Babel via webpack.
- Globals whitelisted by jshint: `angular`, `weeChat`, `Notification`, `linkifyStr`, `renderMathInElement`, `emojione`, `escape`.
- Themes are CSS files directly under `src/css/` (e.g. `dark.css`, `light.css`, `base16-*.css`) — register new themes in the `$scope.themes` array in `glowingbear.js`.
