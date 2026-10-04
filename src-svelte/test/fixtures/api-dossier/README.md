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
   node probes/probe-auth-algorithms.mjs # all five auth algorithms, HTTP + WS (needs a
                                          # dedicated instance on 9011 with
                                          # password_hash_algo=*; see that file's header)
   ```

3. Raw frames land in `frames/probe-session.jsonl` and `frames/probe-lifecycle.jsonl`
   (one JSON record per line; `step:"frame"` records are exact server frames).

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

### Lifecycle events (live)

- `/close` → `buffer_closing` (body = buffer) then `buffer_closed` (body null);
  subsequent `GET /api/buffers/{id}` → 404.
- `/exec -nf` → `buffer_opened` with full buffer body (`type:"free"`).
- Live inventory also captured `buffer_localvar_removed`, `buffer_modes_changed`,
  `nicklist_nick_removing`, `nicklist_group_removing`.

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
