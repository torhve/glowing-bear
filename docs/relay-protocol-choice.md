# Choosing a relay transport

Glowing Bear speaks two WeeChat relay protocols and runs **one** of them per
connection: the JSON Relay API (`/api`, WeeChat 4.10.1+, API 0.6.0) or the legacy
WebSocket relay (`/weechat`). This file records how the choice is made, what a
failed attempt is allowed to leave behind, and what the app is allowed to say about
a failure. The dual-protocol rule in `AGENTS.md` — never fall back mid-connection —
is the constraint everything here obeys.

## The setting

`Settings → Relay protocol` (`settings.protocol`, type `ProtocolPreference`) is one
of:

| Value | Meaning |
| --- | --- |
| `auto` (default) | Probe the address and use the protocol that answers. |
| `api` | Connect as the Relay API. **Does not probe.** |
| `legacy` | Connect as the legacy WebSocket relay. **Does not probe.** |

`api` and `legacy` are preferences, not guarantees. They skip the probe, which is
also why they are fast: a pinned attempt against a relay that will never answer
HTTP does not sit through the 3 s probe timeout.

The same setting can be set from the URL — `#protocol=auto|api|legacy` — which is
the only way to set it without the settings UI, and the reason a bad pin no longer
needs a localStorage edit (see *Getting out* below).

## The probe

`probeApiRelay()` in `connectionManager.ts` POSTs `/api/handshake` with the hash
algorithms the app can speak and reads the answer:

- `200` with a `password_hash_algo` string → API relay.
- A JSON error body (any status) → API relay: something on this port speaks the API
  and refused something.
- Timeout, TLS failure, or a non-JSON body → legacy. A legacy listener waits for
  the binary WebSocket handshake and never answers HTTP.

Probe timeout is `HANDSHAKE_PROBE_TIMEOUT_MS` (3000 ms). Both outcomes are recorded
live in `src-svelte/test/fixtures/api-dossier/`.

## What the cache may hold

`transportByProfile` maps `host:port:tls` → the transport that **connected**.

- An entry is written when an attempt reaches `connected`, and not before.
- An attempt that never reached a session writes nothing and clears any entry for
  that address.
- An explicit `disconnect()` clears the whole map, so a relay configuration change
- Only the **newest** attempt for an address may write, erase or comment on it
  (`attemptSeqByProfile`). A superseded attempt still settles — aborted by the
  connect that replaced it — and what it saw describes an attempt the app already
  discarded. Without this, a discarded attempt could clear the proof a live session
  holds, or name a protocol problem beside a session that just disproved it.
  is visible on the next connect.

The reason is the trap issue #12 reported. Writing the choice before the attempt
had connected meant a pinned `api` attempt against a legacy port left `api` cached
for that address. Putting Settings → Relay protocol back on `auto` then *reused the
transport that had just failed* instead of probing, and the only way out was
editing `gb-settings` in localStorage.

"Reached a session" is read from `connectionState`, not from the settled promise:
both transports resolve on `connected`, but they also resolve on a teardown and
reject after a session was already established. The facade subscribes for the
duration of the attempt and records the *transition* into `connected`, so an
attempt that started over a live session is not credited with a session it never
produced.

Consequence, and it is deliberate: **a session that later dropped keeps its
transport cached.** A dropped session is a transport loss, not a protocol fact —
the session already proved which protocol this port speaks.

## What a failure may say

`pinIsUnverified(preference, errors)` in `lib/utils/connectionFailure.ts` decides
whether a failed attempt may name the pin (`ConnectionError.protocolUnansweredError`).

It says **no** when:

- the user did not pin anything (`auto`) — the app's own probe chose;
- the relay answered in a way only the pinned protocol can answer: a refused
  credential (`passwordError`), a refused login timestamp (`clockSkewError`), a
  refused hash algorithm (`hashAlgorithmDisagree`), a version gate
  (`oldWeechatError`), refused initialization data (`uploadError`), or a TOTP
  requirement (`errorMessage`);
- the failure happened before either protocol was spoken (`tlsError`,
  `securityError`), which are already their own explanation.

It says **yes** when nothing answered at all. That is a fact about what the app
saw, not a verdict: the port may speak the other protocol, or nothing may be
listening, and from a browser those two look identical. The flag is worth having
because the first is fixable from the connection form and the pin is the only part
of the attempt the user chose.

`protocolUnansweredError` replaces `serverUnreachable` in the connection form for
this case, so one failure is explained once rather than twice.

Three rules the naming depends on, all easy to lose:

- **A connect the user asked for ends the departure a Leave recorded.**
  `userDisconnect` is set by `disconnect()` and was previously cleared only when a
  session was reached. Left set, the shared classifier reads the *next* attempt's
  failure as the user having left and names nothing at all — no refused credential
  after a Leave and a typo, no unreachable relay after a Leave and a wrong port, and
  no protocol claim either. `connect()` clears it at the start of the attempt.
- **Quiescing a transport cancels the retry ladder.** The ladder's timer is the
  shared one in `connectionLifecycle`, not a handle the transport owns, so the API
  transport's `quiesce()` has to cancel it explicitly — otherwise a replaced
  transport fires a reconnect for a relay the user has already moved on from.
- **One attempt generation is wiped once.** The legacy loss path tears the transport
  down and wipes, and a declined retry then declares the terminal outcome and wipes
  again — the same wipe twice, with a second `onDisconnect()` and a second
  capture-intent drain. `wipeOnce()` scopes the wipe to the attempt generation, so
  the loss the failure naming describes is one event, not two.

## Getting out

A pinned protocol is set in the settings modal, and the settings modal belongs to
the chat shell. A connection that never produced a session has no shell — no TopBar,
no Settings, no banner, no Leave. Before this existed, the only way back to `auto`
was editing localStorage.

So the recovery lives on the screen the user is actually on: the connection form's
`protocol-unanswered` block offers **Switch to Auto** and **Switch to the other
protocol**. Both rewrite `settings.protocol` and start a new attempt, which is what
the labels say. `handleConnect()` quiesces both transports first, so this also ends
a retry loop that is spending its attempts on a transport that cannot work on this
port.

Deliberately **not** offered: a "reset connection settings" button. It would clear
the host, port, password and TLS along with the pin, which is a larger action than
the failure justifies.

## Where each rule is pinned

| Rule | Test |
| --- | --- |
| Cache written only by a session; failed attempt clears it; Auto probes again | `test/unit/transport-choice-recovery.test.ts` |
| A dropped session keeps its transport and is not named as a protocol problem | `test/unit/transport-choice-recovery.test.ts` |
| Only the newest attempt may describe an address | `test/unit/transport-choice-recovery.test.ts` |
| Which failures may and may not name the pin | `test/unit/connection-failure-classification.test.ts` (`pinIsUnverified`) |
| Auto-detection against both live relays (API 9010, legacy 9001) | `e2e/specs/Dual-protocol.test.ts` |
| The recovery buttons, against the real relay the pin got wrong, ending in a working connection | `e2e/specs/Dual-protocol.test.ts` |
| A hung handshake is named as unreachable, not as a generic fault | `e2e/specs/HandshakeDeadline.test.ts` |
| No mid-connection fallback, in either direction | `e2e/specs/Dual-protocol.test.ts` |
