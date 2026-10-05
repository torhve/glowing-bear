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
   node probes/probe-lifecycle.mjs      # free buffers, errors, close events, event inventory
   node probes/probe-scripts-grep.mjs   # /api/scripts shape + /grep buffer freshness (needs the
                                        # gbtest grep shim autoloaded; isolated profile, port 9012)
   node probes/probe-auth-algorithms.mjs # all five auth algorithms, HTTP + WS (needs a
                                          # dedicated instance on 9011 with
                                          # password_hash_algo=*; see that file's header)
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

### Read markers / hotlist control (source-verified)

- `/buffer set unread` (`""` mark read; `-N`/`+N` move; `N` mark N latest unread),
  `/input set_unread_current_buffer` (runs `/buffer set unread` in the command's
  buffer context), `/buffer set hotlist -1` (removes hotlist entry).
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
