# WeeChat Relay API contract dossier

Live-verified contract facts for the JSON relay API migration (baseline **WeeChat
4.10.1 / relay API 0.6.0**). These complement — and where they disagree, override —
the OpenAPI schema and online manual. `TODO.md` §5 carries the same facts in plan
form; this directory keeps the reproducible evidence.

## Reproducing the probes

1. Start a probe WeeChat (isolated profile, never the legacy gbtest profile):

   ```bash
   weechat-headless -d /tmp/gb-api-probe --stdout \
     -r "/set relay.network.password testpassword123" \
     -r "/relay add api 9010" &
   ```

   - A password is **mandatory**: `relay.network.allow_empty_password` defaults off
     and the relay then rejects *every* connection before any HTTP handling — even
     the unauthenticated `POST /api/handshake`.
   - The FIFO (`/tmp/gb-api-probe/weechat_fifo_*`) is used for server-side setup
     (`/buffer set notify …`, `/exec -nf …`, `/close`); line format is
     `<plugin.buffer> */<command>`.
   - Channel traffic is injected through the gbtest IRC control server
     (`127.0.0.1:16667`, JSON-per-line: `send_message`, `send_pm`, `join`, …).

2. Run the probes (Node ≥ 22 for global `WebSocket`):

   ```bash
   node probes/probe-session.mjs        # bootstrap, completion, input, lines, G1 notify experiment
   node probes/probe-nicklist-sync.mjs  # sync nicks semantics: no initial nick state, deltas only
   node probes/probe-lifecycle.mjs      # free buffers, errors, close events, event inventory
   node probes/probe-scripts-grep.mjs   # /api/scripts shape + /grep buffer freshness (needs the
                                        # gbtest grep shim autoloaded; isolated profile, port 9012)
   node probes/probe-auth-algorithms.mjs # all five auth algorithms, HTTP + WS (needs a
                                          # dedicated instance on 9011 with
                                          # password_hash_algo=* — stop the gbtest5
                                          # fixture first, it owns that port)
   node probes/probe-endpoint-matrix.mjs 9010   # every endpoint the transport uses,
                                          # diff 4.10.1 vs 5.0 (also 9011)
   node probes/probe-weechat5-schema.mjs 9011  # buffer/line key sets, id type +
                                          # safety, live event shape
   node probes/probe-weechat5-line-fields.mjs 9011  # the same stamped line on both paths;
                                          # exits 1 when the 5.0 contract drifts
   ```

3. Raw frames land in `frames/probe-session.jsonl` and `frames/probe-lifecycle.jsonl`
   (one JSON record per line; `step:"frame"` records are exact server frames).

## Relay configuration on the WeeChat side

Relay names follow `[ipv4.][ipv6.][tls.]<protocol.name>` or `unix.[tls.]<protocol.name>`
(manual §11.9, `/help relay`). This client uses the `api` and `weechat` protocols:

```weechat
/relay add tls.api 9010        # JSON API over TLS (preferred transport)
/relay add tls.weechat 9013    # legacy WebSocket protocol over TLS
/relay add api 9010            # unencrypted — local testing only
/set relay.network.password YOURPASSWORD
/set relay.network.tls_cert_key ~/.config/weechat/tls/relay.pem
```

The gbtest fixture in `test/fixtures/gbtest/start.sh` adds the unencrypted pair instead: `api` on 9010 and `weechat` on 9001, which is what the E2E helpers connect to.

- `tls.*` needs ONE file holding the certificate AND the private key; the default path
  is `relay.network.tls_cert_key`. `/relay tlscertkey` reloads it in a running WeeChat,
  which is what an operator runs when certbot renews a certificate mid-upgrade.
- `relay.network.websocket_allowed_origins` (default empty) is a POSIX regex matched
  against the browser `Origin` header. `relay-websocket.c:relay_websocket_client_handshake_valid`
  skips the check entirely when the option is empty; when it is set, a missing or
  non-matching `Origin` returns `-2` and the upgrade is rejected. A relay that restricts
  origins must list the origin the app is served from, or every browser connection
  fails at the handshake rather than at the payload.
- `relay.network.password_hash_algo` picks the handshake algorithms (`plain`, `sha256`,
  `sha512`, `pbkdf2+sha256`, `pbkdf2+sha512`; a leading `!` excludes a name).
  `probe-auth-algorithms.mjs` exercises all five over both HTTP and WS.
- Hashed credentials embed a Unix timestamp that must fall inside `relay.network.time_window`
  (default 5 s) of server time — the reason credentials are regenerated per retry.
- `relay.network.websocket_permessage_deflate` (on by default) is where the API transport
  sees compression; the legacy transport negotiates zlib per message instead. Keep it
  on unless a client is known to mishandle the extension.
- `unix.[tls.]<protocol>` listens on a socket path instead of a port, which is the
  migration path for hosts where no port can be exposed: add a `unix.api` relay under
  the WeeChat runtime dir and reach it with `ssh -L 9010:.weechat/relay_socket`, so the
  browser still connects to a local port.
- TOTP (`relay.network.totp_secret`) is NOT supported by this client: the app refuses a
  TOTP-protected relay with an explicit error instead of half-connecting, so gate G3
  in `TODO.md` §5 stays open.

## Fixture hygiene: clearing the hotlist (measured 2026-10-07)

The favicon badge counts *global* notifications, so a hotlist entry left behind by an
earlier run or probe keeps a badge painted no matter what the next test does. The same
command behaves differently depending on how it reaches the 4.10.1 fixture:

- `POST /api/input` → `hotlist clear` on `irc.gbtest.#glowing-bear`: 204, and it removed
  a `relay.relay.list` entry but left the channel's own entry (same date, count 5)
  through four attempts.
- `POST /api/input` → `hotlist -clear` on the same buffer: 204, nothing removed.
- FIFO `core.weechat */hotlist clear`: hotlist empty, and it stayed empty.

`/api/input` runs the command in that buffer's context, and a core buffer refuses it
outright — 204, then "You cannot write text in this buffer" written into core.weechat,
which is itself unread state that then lands in the hotlist (count 4 measured). Global
commands therefore go through the FIFO, which is what gbtest's own warm-instance hygiene
already does and what `src-svelte/e2e/helpers/relay-admin.ts` now uses.

Not explained: why the channel's own entry survives an API-context clear while a
`relay.list` entry does not. The reliable operation is recorded above; the mechanism is
not.

## Verified facts (with evidence pointers)

### Transport and envelope

- WS endpoint: `ws://host:port/api`, subprotocols `api.weechat` +
  `base64url.bearer.authorization.weechat.<b64url("plain:<pw>"|"hash:...")>`.
  Unauthenticated upgrade → abrupt close, no JSON error frame.
- Client request frame: `{"request":"GET /api/buffers?lines=0","request_id":"id","body":{…}}`.
  The payload field is **`body`** (not `request_body`); responses echo it as `request_body`.
  Evidence: `probe-session.jsonl` frames; source `relay-api-protocol.c:relay_api_protocol_recv_json_request`.
- **Batching = top-level JSON array** of request objects; sequential execution,
  per-item responses correlated by `request_id`. A `request:"BATCH"` string is a 400.
  Evidence: `probe-session.jsonl` `STEP batch-bootstrap` (200/204/200) vs the failed
  `BATCH` attempt in the first probe run.
- Event frames are flat: `code:0`, `message:"Event"`, `event_name`, top-level
  `buffer_id`, `body_type`, `body`. Sample captured for `buffer_line_added`,
  `buffer_opened`, `buffer_closing`, `buffer_closed`.

### Resources (exact table from `relay-api-protocol.c`)

| Method | Resource | Auth | Notes |
|---|---|---|---|
| OPTIONS | `*` | none | must target `/api/*`; 204 + `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`, `Access-Control-Allow-Headers: origin, content-type, accept, authorization`, `Access-Control-Allow-Origin: *` |
| POST | `/api/handshake` | none | negotiates `plain|sha256|sha512|pbkdf2+sha256|pbkdf2+sha512`; live response `{"password_hash_algo":"pbkdf2+sha512","password_hash_iterations":100000,"totp":false}` |
| GET | `/api/version` | required | `{weechat_version, weechat_version_git, weechat_version_number, relay_api_version, relay_api_version_number}` |
| GET | `/api/buffers[/{idOrName}[/lines[/{lineId}] | /nicks]]` | required | list → array; single → object; `lines` → array oldest-first; `nicks` → `nick_group` object |
| GET | `/api/hotlist` | required | array of `{priority, date, buffer_id, count:[low,message,private,highlight]}` |
| GET | `/api/scripts` | required | array |
| POST | `/api/input` | required | body `{buffer_id?|buffer_name?, command}` → 204 no body; unknown buffer → 404; omitted buffer fields → **main buffer** |
| POST | `/api/completion` | required | body `{buffer_id?|buffer_name?, command, position?}` → `{context, base_word, position_replace, add_space, list[]}` |
| POST | `/api/ping` | required | 204 no body |
| POST | `/api/sync` | required | WS-only (HTTP → 403); body `{sync,nicks,input,colors}`, all default to enabled |

No PUT/DELETE resources exist despite the CORS Allow header.

### Errors

- `{"error":"..."}` bodies, same shape over HTTP and WS: 400 (bad request/params),
  401 (invalid password), 403 (sync over HTTP), 404 (`Buffer "…" not found`,
  `Resource not found`, `Line "…" not found in buffer "…"`), 405.
- Evidence: `probe-lifecycle.jsonl` `STEP err-*`.

### IDs

- Buffer / nick / nick-group IDs are creation timestamps in microseconds
  (live: `1791126593804960` ≈ 2026-10-04); line IDs are small per-buffer counters.
  All safe integers in practice; still validated at the JS boundary.

### History semantics (live-confirmed)

- `GET /api/buffers/{id}/lines`: no param → **all** lines (schema lies: says 0);
  `lines=0` → `[]`; `lines=-3` → last 3 oldest-first; `lines=3` → first 3.
- Buffer object requests: `lines` default 0 → **key omitted**; `lines=5` → included;
  for `type:"free"` buffers `lines_free` overrides `lines`
  (`?lines=5&lines_free=1` → 1 line). Free buffer recipe: `/exec -nf -name <n> <cmd>`.

### G1 notify experiment (live)

- Buffer JSON keys (complete, live): `id, name, short_name, number, type, hidden,
  title, modes, input_prompt, input, input_position, input_multiline, nicklist,
  nicklist_case_sensitive, nicklist_display_groups, time_displayed,
  local_variables, keys, last_read_line_id` — **no `notify`**.
- Hotlist visibility mirrors notify policy exactly:
  notify 0 + message → no count change; notify 1 + PM → private count on the PM
  buffer; notify 2 + message → message count +1; notify 3 + message → +1.
  Server-side rule (`gui_hotlist_check_buffer_notify`): LOW needs notify ≥ 3,
  MESSAGE ≥ 2, PRIVATE/HIGHLIGHT ≥ 1.
- `notify_level` on lines: `-1` = `notify_none` tag, `0/1/2/3` = low/message/private/highlight.

### Completion (live)

- `gbb` → `{"context":"auto","base_word":"gbb","position_replace":0,"add_space":false,"list":["gbbot2: "]}`
  (nick candidates embed the configured completer suffix).
- `/msg prob` → context `command_arg`, `position_replace:5`, `list:["probebot"]`.
- `/ver` (core) → context `command`, `position_replace:1`, `list:["version"]`.

### Scripts list + content-search freshness (live, `probes/probe-scripts-grep.mjs`)

- `GET /api/scripts` → `body_type:"scripts"`, `body:[{name,version,description,
  author,license}]`. **`name` is the script filename** (`grep.py`, not `grep`),
  so a script check must strip the extension before comparing.
- The `*grep` results buffer is **shared and reused** (`name:"python.grep",
  short_name:"grep"`), so it can already exist before a search is sent.
- Every `/grep` run — hit **or** miss — emits `buffer_cleared`, then
  `buffer_title_changed`, then `buffer_line_added` lines. A miss still writes
  two lines (`Searching text '…' in buffer …` + `No results found for '…'`).
  Consequence for the app: buffer *existence* cannot prove results; freshness
  must come from the clear (the app's `clearEpoch`) or new lines, and the
  "script missing" case is the only one where nothing ever changes.
- `GET /api/buffers/{id}/infolist` → 404 `Sub-resource of buffers not found:
  "infolist"` — there is no infolist sub-resource; buffer state comes from
  `GET /api/buffers/{id}` plus events.
- Raw evidence: `raw/scripts-grep-freshness.json`, `frames/probe-scripts-grep.jsonl`.

### Lifecycle events (live)

- `/close` → `buffer_closing` (body = buffer) then `buffer_closed` (body null);
  subsequent `GET /api/buffers/{id}` → 404.
- `/exec -nf` → `buffer_opened` with full buffer body (`type:"free"`).
- Live inventory also captured `buffer_localvar_removed`, `buffer_modes_changed`,
  `nicklist_nick_removing`, `nicklist_group_removing`.

### Nicklist churn events (live, `probes/capture-nicklist-events.mjs`)

- A part/join churn emits `nicklist_nick_removing` (body = the full nick
  object, old id) followed by `nicklist_nick_added` (body = full nick object
  with a NEW id); groups churn the same way with `nicklist_group_added`.
- Removal event bodies are full entity objects, not bare ids: id extraction
  must read `body.id` (a bare numeric body is tolerated defensively).
  `nicklist_nick_added`/`nicklist_group_added` are real events and must be
  routed, not left unrouted (raw capture: `raw/nicklist-events.json`).

### Buffer metadata + input events (live, `probes/probe-metadata-events.mjs`)

- `buffer_localvar_added`, `buffer_localvar_changed` and `buffer_localvar_removed`
  each carry a FULL buffer snapshot in `body` — removal does NOT name the
  removed variable; the snapshot's `local_variables` map (what REMAINS) is
  authoritative, so the client must replace its map from the snapshot rather
  than delete a named key (raw capture: `raw/metadata-events.json`).
- Trigger commands: `/buffer set localvar_set_<name> <value>` and
  `localvar_del_<name>` (the bare `localvar_<name>` form is only the hdata
  accessor, not a settable property).
- `input_text_changed` / `input_text_cursor_moved` / `input_prompt_changed`
  carry full buffer snapshots including `input` and `input_position`.
- `buffer_cleared` carries the full buffer snapshot; only the id matters.
- Event names `buffer_input_changed`, `buffer_localvar_set` and `input_changed`
  do NOT exist in WeeChat source — they were fake names in the client's type
  union/mapper and have been removed.

### Read markers / hotlist control (live, `probes/probe-read-marker-commands.mjs`)

- `/buffer set unread` (no argument: mark everything read; `-N`/`+N` move the marker;
  `N` mark the N latest lines unread), `/buffer set hotlist -1` (removes hotlist entry).
- `/input set_unread_current_buffer` is a deprecated alias, not a separate command:
  `core-command.c` implements it by running `/buffer set unread` in that buffer's
  context, and `config_weechat_update_cb` rewrites saved old forms to the new one. The
  app sent the alias until `1104e187`; both transports now send the real command.
- The argument decides whether a marker survives, and the two `-1` states are not
  interchangeable. Measured on both fixtures (4.10.1/API 0.6.0, 5.0.0-dev/API 0.7.0):

  | command | 4.10.1 `last_read_line_id` | 5.0 `last_read_line_id` | 5.0 `first_line_not_read` |
  |---|---|---|---|
  | `/buffer set unread -100000` | `-1` | `-1` | `true` |
  | `/buffer set unread` | a real id | a real id | `false` |
  | `/buffer set unread 0` | `-1` | `-1` | `false` |

  4.10.1 buffers do not report `first_line_not_read` at all, so `-1` there is
  permanently ambiguous.
- Switching sends `/buffer set unread` with no argument deliberately: it leaves a real
  line id that other clients and `reanchorReadBoundaryFromServer` can anchor to.
  `unread 0` erases that anchor and lands in the `-1` ambiguity above.
- Guarded by `src-svelte/e2e/specs/ReadMarkerServerState.test.ts`, which reads the marker
  and the hotlist back over the API after an app-driven switch; mutating the command to
  `unread 0` makes it fail.
- GUI window switching auto-removes hotlist entries; headless/API sessions never do.

### Operational traps

- `relay.network.commands` default `*,!quit` — server-side command allow/deny for
  `/api/input`.
- `relay.network.allow_empty_password` off + empty password → all connections
  rejected (fixture must set a password).
- `relay.network.password_hash_algo` restricted (gbtest: `pbkdf2+sha256`) → `plain:`
  credentials are rejected with `{"error":"Invalid hash algorithm (not found or not
  supported)"}`. API hash credential is colon-separated
  `hash:pbkdf2+sha256:<timestamp>:<iterations>:<hex>`: PBKDF2 salt = decimal
  timestamp string (±`relay.network.time_window`, default 5 s), iterations must
  equal the server's `password_hash_iterations`, key length = digest length
  (32 for sha256), hex compared case-insensitively. `gbtest/start.sh`'s
  authenticated probe implements exactly this.
### Auth algorithms (live, `probes/probe-auth-algorithms.mjs` → `frames/probe-auth.jsonl`)

Run against a dedicated probe instance (port 9011, `password_hash_algo=*`, never the
shared gbtest fixture):

- All five algorithms authenticate over HTTP and WebSocket subprotocol auth:
  `plain`, `sha256`, `sha512`, `pbkdf2+sha256`, `pbkdf2+sha512` → 200.
- Handshake negotiation with `password_hash_algo=*` picks `pbkdf2+sha512` even when
  the client lists `plain` first — the server's preference order wins; clients must
  use whatever the handshake returns, not their own first choice.
- Wrong password for every algorithm → 401 `{"error":"Invalid password"}`.
- Timestamp 60 s outside `relay.network.time_window` → 401 `{"error":"Invalid
  timestamp"}`.
- Harness trap: Node undici keep-alive HTTP sockets interleaved with rapid
  WebSocket connects caused spurious server-side WS auth failures; sending
  `Connection: close` on probe HTTP requests removes the artifact. Warns against
  hammering WS reconnects immediately after HTTP calls.
- Operational trap: an orphaned WeeChat from an earlier session silently held port
  9011 and made a fresh instance appear to hang (TCP accepted by the kernel
  backlog, never served). Check `lsof -iTCP:<port> -sTCP:LISTEN` before blaming
  the protocol stack.

- `/api/input` with omitted buffer fields executes on the **main buffer** (204, no
  hint) — always send `buffer_id`.

### Relay lifecycle events (live, `probes/probe-quit-event.mjs` → `raw/quit-event.json`)

- The API command whitelist blocks `/quit` over `/api/input` (default
  `relay.network.commands = *,!quit` — the request returns 204 but nothing
  happens), so quit is triggered out-of-band:
  `echo "core.weechat */quit" > /tmp/gbtest-weechat/weechat_fifo_<pid>`.
- API clients DO receive `{"event_name":"quit","buffer_id":-1,"body_type":null,"body":null}`
  before the cascade; source hooks it (`relay-api-protocol.c` signal hook list
  includes `upgrade;upgrade_ended;quit`). The manual table's "plain text
  connections only" note applies to `upgrade`/`upgrade_ended`; `quit` is
  live-confirmed for API clients.
- Quit then cascades `nicklist_*_removing`, `buffer_closing` → `buffer_closed`
  (null body), `buffer_localvar_removed` with `local_variables:{}`,
  `buffer_unmerged`, and socket close 1006. `buffer_merged`/`buffer_unmerged`
  are real wire events and are routed through `bufferUpdated`.
- Client behavior: `upgrade`/`upgrade_ended` schedule a reconnect in ~2 s
  (legacy `_upgrade` parity, overriding the slower backoff timer); `quit`
  relies on the socket-close failure path. Destructive probe — restart the
  fixture with `npm run irc:start` afterwards.

### Manual event table audit (WeeChat 4.10.1)

Every event in the manual's "events sent according to synchronization
options" table is now handled: buffer lifecycle/metadata events route through
`bufferOpened`/`bufferClosing`/`bufferClosed`/`bufferUpdated` (full-snapshot
merge), `buffer_cleared` drops lines, notify events map string→numeric levels,
nicklist add/remove events upsert/remove, `buffer_line_added`/
`buffer_line_data_changed` update lines, `hotlist_changed`/`hotlist_removed`
rebuild the hotlist map, input events are consumed as no-ops (input is
client-owned), and `upgrade`/`upgrade_ended`/`quit` route through
`relayLifecycle`. Events beyond the manual table but present in source
(`buffer_merged`, `buffer_unmerged`, `buffer_types_changed`,
`buffer_time_for_each_line_changed`, `buffer_notify_default_changed`) are
routed or tolerated via the open `ApiEventName` union.

### Nicklist sync semantics (live, `probes/probe-nicklist-sync.mjs`)

- `POST /api/sync` with `nicks:true` streams **deltas only**: after enabling
  sync and sitting idle, zero `nicklist_*` events arrive for the channel's
  existing nicks (2 known via `GET /nicks`, 0 events for them) while
  `buffer_line_added` events keep flowing — sync is active, nick STATE is not
  included. No initial nicklist snapshot is sent on connect.
  Evidence: `probe-nicklist-sync.mjs` run against gbtest on 4.10.1 (2026-07-20).
- Consequence: a buffer's nicklist is EMPTY until an authoritative snapshot is
  applied — `GET /api/buffers/{id}/nicks` on first open, or a `buffer_opened`
  event carrying `nicklist_root`. Delta events for an unopened buffer create a
  PARTIAL group and must not be treated as a complete list (the app tracks this
  with `BufferData.nicklistFetched` and gates the switch-time fetch on it, not
  on the presence of a 'root' group).
- `GET /api/buffers/{id}/nicks` is the authoritative full state; the client
  applies it as a replace (clear then upsert), matching the legacy
  `_nicklist` fresh-fetch semantics.
## WeeChat 5.0.0-dev / relay API 0.7.0 (probed 2026-10-07)

Everything above was captured against 4.10.1 / API 0.6.0. A second live relay —
built from WeeChat `main` (5.0.0-dev, reports `relay_api_version` **0.7.0**) — was
probed with `probes/probe-weechat5-line-fields.mjs` to find where the two contract
versions disagree. The supported way to reproduce it is the pinned build script plus
the optional fixture, which starts that build against the same mock IRC server and
opens the API relay on 9011:

```bash
bash test/fixtures/gbtest5/build.sh          # -> /tmp/weechat5-build/.../weechat-headless
GB_WEECHAT5_BIN=/tmp/weechat5-build/src/gui/curses/headless/weechat-headless \
GB_WEECHAT5_PLUGIN_DIR=/tmp/weechat5-build bash test/fixtures/gbtest5/start.sh
node probes/probe-weechat5-line-fields.mjs 9011
```

The pin is a commit (`44e149b12830…`): upstream has no v5.0.0 tag — the newest tag is
v4.10.1 and the 5.0 line lives on `main` as 5.0.0-dev — so a pin can only be a commit,
and it is moved deliberately rather than tracking `main`.

The probe is self-contained: it opens the sync window, prints a line stamped with a
unique token, and accepts only samples carrying that token from either path, so a stale
line already sitting in the buffer cannot stand in for the one it was asked to produce.
It cannot use `core.weechat` — `POST /api/input` there answers `204` and WeeChat then
writes "You cannot write text in this buffer" into the buffer (measured) — so the
command goes to a channel buffer. Starting a relay by hand still works, but a custom
`-d` home finds no plugins unless they are copied in, so the relay plugin never loads
and no port opens.

Negative control, measured 2026-10-07: the same probe against the 4.10.1 fixture relay
exits 1 and names `date_printed` on both paths, so a pass means it really reached a
5.0-shaped line object rather than an old one.

`.github/workflows/weechat5-contract.yml` runs both probes against the pinned build
(weekly, and on push/PR). It measures the wire only — the app-side E2E against a 5.0
relay needs both fixture relays at once and is run locally — and because the ref is
pinned, a green run says this repository's path to that commit still holds, not that
upstream has not moved.

- **The line object lost `date_printed` (and `date_usec_printed`).** A live
  `buffer_line_added` body from 5.0 carries exactly
  `id, y, date, displayed, highlight, notify_level, prefix, message, tags` —
  `date_printed` is absent. 4.10.1 sent both. The app's `validateLine` required
  `date_printed`, so **every** line a 5.0 relay delivered — fetched history and
  live events alike — failed validation and was dropped: the app connected,
  buffers appeared, and the chat stayed empty, with only
  `[api] invalid history payload: lines[0] date_printed: expected string, got
  undefined` in the console.
  Evidence: `probe-weechat5-line-fields.mjs` (`line-keys` step), and an app-level
  A/B against the same live 5.0 relay — before the fix 0 rendered rows and 4
  `invalid history payload` warnings, after it 29 rendered rows and 0 warnings.
  Regression: `test/unit/api-validation.test.ts` fixtures `liveLine` (4.10.1) and
  `liveLine50` (5.0).
- **`notify` is a buffer field now, and it is a string.** 5.0 buffers carry
  `notify: "all" | "message" | "highlight" | "none"` plus `buffer_notify_changed`.
  The validator already accepted it as optional; 4.10.1 buffers omit it.
- **New 5.0 buffer fields: each one measured, and each one deliberately left
  unread.** On a freshly started 5.0 fixture all three buffers report
  `notify=all`, `prefix_displayed=true`, `day_change=true`,
  `first_line_not_read=false`, `last_read_line_id=-1`.
  - `notify` — **adopted**: mapped, `buffer_notify_changed` routed, and read by
    the line tally. 4.10.1 omits it and cannot be made to report it: asking for
    it explicitly (`columns=…notify`) returns no such field, and infolist is
    unsupported. The app defaults it to 3, which is WeeChat's own default —
    live-verified on 5.0 with
    `GET /api/options/weechat.look.buffer_notify_default` →
    `{"value":"all","default_value":"all"}`. A user who lowers a buffer's notify
    is mis-modelled on 4.10.1 API and correctly modelled on 5.0; the hotlist
    baseline is what actually corrects the counts on 4.10.1.
  - `first_line_not_read` — **do not act on it.** Upstream defines it only as the
    disambiguation of `last_read_line_id = -1` (`relay-api-msg.c`): true means the
    marker sits before the first line (nothing read), false means the marker was
    removed because every line has been read. The app derives the boundary from
    the hotlist instead, and that is an unread-policy choice, not a claim that
    the two signals mean the same thing — a zero hotlist count can also be a
    filtered notification rather than proof that every line was read. Honouring `true`
    would put the boundary before the first line and make every retained line unread: the
    phantom unread the read-boundary code exists to prevent, since replayed backlog lines
    arrive with `notify_level = -1` and create no unread.
    Provenance, from upstream history (full clone, `git log -Sfirst_line_not_read`):
    - The flag is old. It entered in `323290c83` (2009-02-02, Fix crash when read marker
      is moved before first line displayed) as `int first_line_not_read` in the gui
      buffer struct, so the code freeing the marker's own line had a state to move it
      into instead of leaving `last_read_line = NULL`. `gui_buffer_set_unread`
      (`gui-buffer.c`) still writes it out of that same overload: `unread 0` →
      `last_read_line = NULL`, flag 0; marker moved past the first line →
      `last_read_line = NULL`, flag 1.
    - Only its exposure over the API is new: `f15a1a675` (2026-08-17, API 0.7.0), and its
      stated reason is the relay **remote**, not web clients — a remote displaying a
      buffer has no marker, so the receiving WeeChat read `-1` as nothing-read and, in
      flashcode's words, the whole backlog of buffers entirely read on the remote was
      added in the local hotlist, and the highlights were triggered again locally. Same
      class of bug as ours; the direction that fix serves is the `false` one, which the
      app already gets from the hotlist baseline.
    - `false` is not a reliable signal that the user has read everything: upstream issue
      #2029, open since 2023-10-08 and reported against 4.0.5, is titled
      `first_line_not_read` is 0 for new buffer with a message — a buffer created,
      printed to and never viewed reports 0. The field's friendly direction has a known
      rough edge of its own.
    Recorded so it is not adopted later as an obvious win.
  - `prefix_displayed` — **do not act on it.** It is the API name for the
    gui-buffer flag `prefix_for_each_line` (`relay-api-msg.c` maps it from that
    hdata field), and WeeChat sets it from buffer type: formatted → 1, free → 0
    (`gui-buffer.c`). On the two fixtures' free buffers (`relay.relay.list`,
    `python.grep`) every line prefix is empty, and every formatted buffer
    reports `prefix_displayed=true` — so on every buffer these relays expose the
    prefixes it would hide are already empty. That is a claim about these
    fixtures, not about every free buffer in every plugin. The only case it
    would change is a user who explicitly runs `/buffer set
    prefix_for_each_line 0` on a formatted buffer, and the wire keeps sending
    the prefix regardless.
  - `day_change` — **not adopted, and it is not what makes separators work.**
    WeeChat's day-change separator is drawn by the curses GUI at render time
    (`gui_chat_display_day_changed`, gated by `weechat.look.day_change &&
    buffer->day_change`); it is never a buffer line, and the logger's
    `day_changed` handler only rotates log filenames. No relay version has ever
    sent a separator, which is why the app injects its own. The flag would only
    let the app honor "this buffer has separators off".
  - `day_changed` / `buffer_day_change_changed` — **routed as known-and-ignored
    in `api-mapping.ts`, still uncaptured by any probe here, and the gap they
    would close is intended behavior.** `day_changed` is a timer
    signal (`config_day_change_timer_cb`) meaning "the local day rolled over,
    re-render": the app injects separators only in its three line-append paths,
    so a buffer idle across midnight shows nothing until its next message. That
    is the product decision — a separator marks where a new day's messages
    begin, so a day with no messages needs no separator. Do not "fix" it. If it
    is ever revisited, prove it with a fake-clock component test rather than a
    system clock or the shared dev server. `buffer_day_change_changed` fires when
    `/buffer set day_change` flips the flag. Neither event was ever seen live by
    these probes — `/buffer set day_change on|off` returned 204 with no event,
    and `day_changed` needs a real local midnight.

- **Input is `POST /api/input` with `buffer_id`.** `POST /api/buffers/<id>/input`
  returns 405 Method Not Allowed on 5.0. The app already used the correct form.
- **WebSocket auth follows `relay.network.password_hash_algo`.** When it is pinned
  to `pbkdf2+sha256`, a `plain:` credential is rejected and the socket just closes
  (1006, no reason) — the WS subprotocol must carry the same PBKDF2 hash the REST
  probe uses. A probe that only works with `plain:` is a fixture bug waiting to
  happen.
- **A probed fixture is not a clean fixture.** After a probing session the 5.0
  channel buffer read `notify=highlight` and `title="probe-title"`, and
  `core.weechat` had logged `Notify changed for "irc.gbtest5.#glowing-bear":
  "all" to "message" … to "highlight"` — all residue from earlier probes. Reading
  those values as WeeChat defaults is exactly how a probe artifact gets written
  into a document as a fact. Restart before recording field values:
  `test/fixtures/gbtest5/stop.sh && test/fixtures/gbtest5/start.sh`.

- **Line identifiers are timestamps now, and they are no longer dense.** 4.10.1
  numbered a buffer's lines 0, 1, 2, …; 5.0 assigns
  `epoch_seconds × 1_000_000 + microseconds`, e.g. line id `1791365101063294` with
  `date: "2026-10-07T09:25:01.063294Z"`. Consequences measured, not inferred:
  - ids stay safe JS integers (`Number.isSafeInteger` true for every id sampled;
    the encoding overflows `Number.MAX_SAFE_INTEGER` around the year 2254), so
    `asLineId` and the `lineIdsSeen` index keep working;
  - ids are **sparse and globally unique**, so anything that assumed dense
    per-buffer numbering (id arithmetic, using an id as an offset, or assuming two
    buffers could share an id) is wrong on 5.0. The app normalizes ids to
    `weechat:<digits>` strings and never does id arithmetic, which is why this did
    not bite;
  - `last_read_line_id` is a timestamp id on 5.0 (`1791365636514441`) where 4.10.1
    gave a small counter (`302281`), and `-1` when nothing is read — the validator
    already accepts `>= -1`.
  Evidence: `probes/probe-weechat5-schema.mjs` (buffer keys, line keys, id typeof
  and safety) against both relays.
- **Buffer key sets, live diff.** 4.10.1:
  `id, name, short_name, number, type, hidden, title, modes, input*, nicklist*,
  time_displayed, local_variables, keys, last_read_line_id`.
  5.0 adds `notify`, `prefix_displayed`, `day_change`, `first_line_not_read`.
  The validator allows unknown additive fields on purpose, so the extra fields
  pass; none of them are consumed.
- **Freshness events require `POST /api/sync`; fetching buffers does not subscribe.**
  A probe that authenticated and called `GET /api/buffers` (even
  `GET /api/buffers/<id>`) received **zero** events on both relays. After the
  app's own `POST /api/sync {sync,nicks,input,colors}` the same probe received
  `buffer_line_added`. A probe that reports "the relay sends no events" has almost
  certainly skipped this step.
- **Event envelope is `body`, not `event_body`.** Live 5.0 frame:
  `{code:0, message:"Event", event_name, buffer_id, body_type, body}`. A probe that
  reads `event_body` silently sees nothing.
- **Buffer-mutation commands all answer 204 on 5.0 and which events they produce**
  (`probes/` mutation sweep on the channel buffer): `/me` → `buffer_line_added`;
  `/buffer notify highlight` → `buffer_notify_changed` whose body is a **full
  buffer object** (not a bare level); `/buffer set title` → `buffer_title_changed`
  (also a full buffer object). `/buffer set day_change on|off` was accepted but
  produced no `buffer_day_change_changed`, and no `day_changed` was observed
  outside a real local midnight — so those two new events remain **unprobed**.
  The app routes `buffer_notify_changed`, `buffer_title_changed` and
  `buffer_day_change_changed` — the last is an ordinary buffer_* change signal
  (full buffer snapshot), so it lands in the same `bufferUpdated` group as the
  others. `day_changed` is routed to `ignoredEvent()`: core-level, `buffer_id`
  -1, body null, and the relay discards the signal's date string, so the frame
  carries nothing to apply. Neither reaches an `unrouted event:` warning.
  `unrouted event:` now means only "an event name this client has not looked
  at" — which is what surfaced a newer relay in the first place.
- **Endpoint matrix.** `probes/probe-endpoint-matrix.mjs` hits each endpoint the
  transport uses and prints the sampled response's top-level key set; run it
  against both relays and diff. Sampled 2026-10-07, version, hotlist, scripts,
  completion, nicks and ping answered the same on both, and the only divergence
  in those samples was `date_printed` on lines — the bug above, not a remaining
  gap. Key-set equality is a smoke signal, not proof: it checks neither field
  types nor nested structure, and the 5.0.0-dev build has the script plugin
  disabled, so its empty `scripts` array says nothing about script item shape.

> The relay probed here is a **5.0.0-dev build from upstream main**, which reports
> `relay_api_version` 0.7.0. A released 5.0.0 was not probed; the version pair is
> the same one a user reported, which is why the drift was worth chasing.

## Coverage limitations (2026-10-06 audit pass)

Recorded here so the gaps survive in tracked history, not only in local notes:

- **Free-buffer history gate.** `hasNoHistoryToFetch`/`markHistoryComplete` stop
  `fetchMoreLines` for `bufferType === 1` buffers. The gate is proven by
  `test/unit/free-buffer-history-gate.test.ts` (transport spies: disabling it
  fails 2 tests). `e2e/specs/FreeBuffer-history.test.ts` only proves row
  stability and the absent "Fetch more lines" affordance — that affordance is
  absent with or without the guard, so it is **not** regression coverage for the
  gate.
- **`/grep` freshness.** `waitForFreshBuffer` resolves on the first change
  (newly opened buffer, `clearEpoch` bump, or changed line count). A clear
  precedes the result lines, so the switch can land on an empty buffer whose
  rows then render reactively; overlapping searches resolve on the first fresh
  change. Pinned by `test/unit/content-search-wait.test.ts` (6 fake-timer
  tests); no E2E exercises two concurrent searches.
- **Pending query navigation.** Same-nick/different-server matching and stale-
  timeout protection are unit-only (`test/unit/pending-query-navigation.test.ts`,
  7 tests) because the gbtest fixture has exactly one IRC server.
- **Root-level nicks.** No gbtest IRC nick has a null `parent_group_id`, so
  `test/unit/nicklist-root-rows.test.ts` (3 tests) is the only coverage; nick
  visibility and group-display/case-sensitivity semantics remain unfiltered on
  both the root and the grouped path.
