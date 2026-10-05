# Behavior difference ledger

Every intentional or discovered difference between:

- **upstream** — WeeChat 4.10.1 (`/tmp/weechat-4.10.1`, verified against source)
- **current** — `src-svelte/src/lib/weechat-colors.ts` (`rawText2Rich`)
- **legacy** — `src-angular/js/weechat.js` (`WeeChatProtocol.rawText2Rich`)
- **library** — `@glowingbear/weechat-format`

The executable half of this ledger is `test/differential.test.ts`: each row is a
case with the exact dimensions expected to differ. An unlisted divergence fails the
suite, and a listed divergence that has disappeared fails it too, so this table
cannot drift.

Legend: **match** = library and current parser render the same thing;
**decide** = needs a product decision before Milestone B integration;
**approved** = decision taken and recorded below;
**adapter** = the difference is resolved in the integration adapter, not the library.

## 1. Cases where all three agree

| Case | Upstream | Current | Legacy | Library |
| --- | --- | --- | --- | --- |
| plain text | ✓ | ✓ | ✓ | ✓ |
| `\x19F03` named foreground | ✓ | ✓ | ✓ | ✓ |
| `\x19F@00012` / `\x19B@00034` extended colors | ✓ | ✓ | ✓ | ✓ |
| `\x19*01,02` legacy comma separator | ✓ | ✓ | ✓ | ✓ |
| `\x19*01~02` current tilde separator | ✓ | ✓ | ✓ | ✓ |
| `\x19F*03` bold flag in payload | ✓ | ✓ | ✓ | ✓ |
| `\x19F%03` blink, `\x19F.03` dim | ✓ | ✓ | ✗ (predates the prefixes) | ✓ |
| `\x1a\x01` set bold | ✓ | ✓ | ✓ | ✓ |
| `\x19F*03` then `\x19F\|04` keep-attributes | ✓ | ✓ | ✓ | ✓ |
| `\x19\x1c` with an attribute active | keeps it | keeps it | keeps it | keeps it |
| `\x1c` full reset | ✓ | ✓ | ✓ | ✓ |
| `\x1914` theme color (`chat_nick`) | ✓ | ✓ | ✓ | ✓ |
| `\x1943` (`chat_day_change`) | ✓ | ✓ | ✓ | ✓ |
| `\x1947` out-of-range theme index | ignored | ignored | ignored | ignored + diagnostic |
| `\x19F99` out-of-palette index | ignored | ignored | ignored | ignored + diagnostic |
| Unicode (including astral pairs) | ✓ | ✓ | ✓ | ✓ |

## 2. Deliberate differences (library follows upstream)

| # | Case | Upstream | Current | Legacy | Library | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `\x1a*`, `\x1b*` (printable attribute markers) | consumes only `\x1a`/`\x1b`; `*` is literal text, no attribute | treats `* ! / _` as attributes (IRC compatibility) | same as current | follows upstream | **approved** |
| 2 | `\x19*03` (attribute-prefixed combined control with no separator) | consumed as an incomplete combined control, applies nothing | renders red foreground | same as current | follows upstream | **approved** |
| 3 | `\x19F0x` (malformed fixed-width payload) | consumes `\x19F0x`, no style change | emits the literal text `F0xb` | same as current | consumes, reports diagnostic | **approved** |
| 4 | `\x19*03,@12 rest` (truncated extended background) | consumes the fixed-width window, applies nothing because the background failed to parse | applies red foreground, emits `,@12 rest` | same as current | follows upstream | **approved** |
| 5 | `\x19bD`, `\x19b_` (bar references) | consumed, no style effect in chat | emitted as literal text | same as current | consumed, reference recorded | **approved** |
| 6 | `\x19E` emphasis toggle | toggles on **and off** | never toggles off: emphasis stays applied for the rest of the line | never toggles off | toggles both ways | **adapter** (fix is a strict improvement) |
| 7 | `\x19E` representation | emphasis color applied by the frontend | baked into `fg` as `option:emphasis` | baked into `fg` **and** `bg` | a boolean marker on the style | **adapter** |
| 8 | combined control with a value ≥ 17 | foreground passes through to terminal color handling; an out-of-range background indexes past the 17-entry palette table | clamps/ignores | clamps/ignores | models both as an extended color | **match** in effect, safer model |
| 9 | theme indices 17–26 (`chat_nick1`…`chat_nick10`) | curses maps them to hardcoded palette colors | labels them invalid | labels them invalid | keeps the symbolic name | **adapter** |

### Decision record

2026-10-05 — rows 1–5: **adopt upstream WeeChat 4.10.1 behavior**. The application
adapter will not shim these cases; where the app currently differs from upstream,
the upstream result becomes the app result at cutover.

Consequences the adapter must handle, in priority order:

1. Row 1 is the only one with a *common* input. `convertIrcCodes()` in
   `src-svelte/src/lib/weechat-colors.ts` currently emits `\x1a*` for bold, which the
   library renders as a literal `*`. IRC conversion must emit the control-character
   form (`\x1a\x01`, `\x1b\x01`, …) — or be dropped entirely if `keep_colors` already
   delivers WeeChat controls. This is a Milestone B task, and it is the one change
   that can visibly alter messages on IRC-heavy buffers.
2. Rows 2, 3 and 4 change only malformed or truncated control sequences, which real
   WeeChat output does not contain. Text that today appears as literal `F0x` or
   `,@12` disappears instead, matching what WeeChat itself displays.
3. Row 5 removes stray `bD`/`b_` text from lines carrying bar references.
4. Rows 6–9 stay **adapter** work: emphasis becomes a boolean the adapter maps to
   CSS rather than a baked-in `option:emphasis` color, and symbolic theme indices
   17–26 resolve in the adapter against the theme, not in the library.

None of this is implemented yet: `src-svelte/src/lib/weechat-colors.ts` is untouched
and remains the production parser until Milestone B is approved and started.

## 3. Differences that only exist between the two existing parsers

| Case | Current | Legacy | Note |
| --- | --- | --- | --- |
| `\x19F%03`, `\x19F.03` | blink/dim applied | control emitted as text | the Angular parser predates blink/dim |
| `\x19E` | emphasis in `fg` only | emphasis in `fg` and `bg` | the library avoids picking a side by using a marker |
| attribute key names | `{b,r,i,u,k,d}` always present | `{bold,reverse,italic,underline}` plus ad-hoc short keys | representation only; the library uses explicit `AttributeName` keys with three states |

## 4. IRC / mIRC compatibility (adapter territory)

`convertIrcCodes()` in the app currently emits `\x1a*` and `\x1b*` for IRC bold and
its reset. Under upstream semantics those become a literal `*` (row 1). The
library does not convert IRC at all.

Decision proposed for Milestone B: the adapter converts IRC formatting into
upstream-faithful controls — `\x1a\x01` for bold, `\x1b\x01` to clear it, `\x19F*NN`
style payloads for colored bold — instead of the printable-marker shortcut. The
library then needs no IRC-specific exception, and the `*` that currently leaks into
rendered text disappears.

IRC color indices (WeeChat `src/irc/irc-color.c`): 0–15 map to named colors,
16–98 to numeric 256-color values, 99 means default. That mapping also belongs in
the adapter.

## 5. Decisions required before Milestone B

Each of these changes what users see, so they need an explicit answer rather than
a silent default:

1. **Printable attribute markers (row 1).** Keep the current IRC-compatibility
   leniency in the adapter, or follow upstream and let `\x1a*` render as `*`?
   Recommendation: follow upstream in the library, and make the adapter emit
   `\x1a\x01`. Risk: any *incoming* relay text that already contains `\x1a*` from an
   older server-side conversion would start showing `*`.
2. **Incomplete combined controls (row 2).** `\x19*03` currently colors text red.
   Upstream shows `3` as text. Recommendation: follow upstream; verify no relay
   source emits this form.
3. **Malformed payload consumption (rows 3–4).** Upstream swallows the fixed-width
   window. Recommendation: follow upstream, and surface diagnostics in a debug mode
   so malformed server output is visible instead of silently eaten.
4. **Bar references (row 5).** Recommendation: consume them (they never render in
   chat) and keep the recorded reference for any future bar rendering work.
5. **Emphasis (rows 6–7).** Recommendation: adopt the toggle fix and map the marker
   to the existing `coa-chat_emphasis`-style CSS in the adapter. This fixes a real
   bug where emphasis never turns off.
6. **Obsolete theme indices (row 9).** Recommendation: keep symbolic names and let
   the adapter map 17–26 to whatever the app currently renders for them, so no
   nick changes color during migration.

## 6. Known gaps in this ledger

- Upstream *rendering* was verified by reading C source, not by capturing terminal
  output from a live WeeChat instance. A curses fixture (isolated profile, not the
  user's) would strengthen rows 2–5.
- `gui_color_code_size()` and the renderer disagree with each other in two places
  (documented in `format.md` §3). The library follows the renderer; a C oracle
  harness comparing consumption against `gui_color_code_size` is not yet built.
- The differential corpus is 28 hand-written cases plus a 324-case combinatorial
  matrix; it is not an exhaustive grammar sweep against upstream.
