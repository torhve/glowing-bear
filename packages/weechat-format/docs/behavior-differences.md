# Behavior difference ledger

Every intentional or discovered difference between:

- **upstream** — WeeChat 4.10.1 (`/tmp/weechat-4.10.1`, verified against source)
- **adapter** — `src-svelte/src/lib/weechat-colors.ts` (`rawText2Rich`), the application parser
- **legacy** — `src-angular/js/weechat.js` (`WeeChatProtocol.rawText2Rich`), kept as a historical baseline
- **library** — `@glowingbear/weechat-format`

The executable half of this ledger is `test/differential.test.ts`: each case names the
exact dimensions expected to differ, and every diverging case id must appear in this
file. An unlisted divergence fails the suite, a listed divergence that has disappeared
fails it too, and a case id missing from the ledger fails it as well. That keeps this
table from drifting out of step with the cases the suite exercises; it is not a claim
about inputs the suite does not exercise.

Legend: **match** = library and adapter render the same thing;
**approved** = decision taken and recorded below;
**adapter** = resolved in the adapter rather than in the library.

## 1. Cases where all of them agree

| Case | Upstream | Adapter | Legacy | Library |
| --- | --- | --- | --- | --- |
| plain text | ✓ | ✓ | ✓ | ✓ |
| `\x19F03` named foreground | ✓ | ✓ | ✓ | ✓ |
| `\x19F@00012` / `\x19B@00034` extended colors | ✓ | ✓ | ✓ | ✓ |
| `\x19*01,02` legacy comma separator | ✓ | ✓ | ✓ | ✓ |
| `\x19*01~02` current tilde separator | ✓ | ✓ | ✓ | ✓ |
| `\x19F*03` bold flag in payload | ✓ | ✓ | ✓ | ✓ |
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

| # | Case | Suite cases | Upstream | Adapter | Legacy | Library | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | printable attribute markers (`\x1a*`, `\x1b*`) | `set-attr-printable`, `remove-attr-printable` | consumes only `\x1a`/`\x1b`; `*` is literal text, no attribute | follows upstream | treats `* ! / _` as attributes (IRC compatibility) | follows upstream | **approved** |
| 2 | `\x19*03` (combined control with no separator) | `combined-attr-foreground` | consumed as an incomplete combined control, applies nothing | follows upstream | renders red foreground | follows upstream | **approved** |
| 3 | `\x19F0x` (malformed fixed-width payload) | `malformed-fg-window` | consumes `\x19F0x`, no style change | follows upstream | emits the literal text `F0xb` | consumes, reports diagnostic | **approved** |
| 4 | `\x19*03,@12 rest` (truncated extended background) | `malformed-combined` | consumes the fixed-width window, applies nothing because the background failed to parse | follows upstream | applies red foreground, emits `,@12 rest` | follows upstream | **approved** |
| 5 | `\x19bD`, `\x19b_` (bar references) | `bar-controls` | consumed, no style effect in chat | consumed | emitted as literal text | consumed, reference recorded | **approved** |
| 6 | `\x19E` emphasis toggle | `emphasis-toggle-off` | toggles on **and off** | toggles both ways | never toggles off: emphasis stays applied for the rest of the line | toggles both ways | **approved** |
| 7 | `\x19E` representation | `emphasis-on` | emphasis color applied by the frontend over whatever was drawn | marker mapped to the emphasis foreground color; background untouched | baked into `fg` **and** `bg` | a boolean marker on the style | **adapter** |
| 8 | combined control with a value ≥ 17 | `combined-out-of-range-fg`, `combined-out-of-range-bg` | foreground passes through to terminal color handling; an out-of-range background indexes past the 17-entry palette table | models both as an extended color | clamps/ignores | models both as an extended color | **adapter** |
| 9 | theme indices 17–26 (`chat_nick1`…`chat_nick10`) | `theme-obsolete-slot` | curses maps them to hardcoded palette colors | renders the default text color | labels them invalid | keeps the symbolic name | **adapter** |

### Decision record

2026-10-05 — rows 1–5: **adopt upstream WeeChat 4.10.1 behavior**, with no shim in the
adapter.

2026-10-05 — row 6: **adopt the toggle fix.** Emphasis now turns off at the second
`\x19E`, which fixes a real bug where emphasis never ended.

2026-10-05 — row 7: **adapter maps the marker to the emphasis foreground only.**
Upstream overlays the emphasis color on top of whatever was drawn
(`gui-curses-chat.c:477-483`), so overriding the foreground reproduces what users see;
the background is left alone because the app has no emphasis background in its chat
palette and changing it would alter the appearance of already-emphasized text.

2026-10-05 — row 8: **model out-of-palette combined values as extended colors.**
Upstream's behavior here is a C indexing hazard, not a documented feature; the app
renders them as terminal colors, which is what WeeChat intends.

2026-10-05 — row 9: **keep the symbolic names in the library and render 17–26 as the
default text color in the adapter.** Upstream's hardcoded palette for these removed
slots has no CSS counterpart in the app, and the previous app behavior was effectively
the default color, so no nick changes color.

## 3. Differences that only exist between the adapter and the legacy Angular parser

| Case | Suite cases | Adapter | Legacy | Note |
| --- | --- | --- | --- | --- |
| `\x19F%03`, `\x19F.03` | `payload-attr-blink`, `payload-attr-dim` | blink/dim applied | control emitted as text | the Angular parser predates blink/dim |
| `\x19E` | `emphasis-on` | emphasis in `fg` only | emphasis in `fg` and `bg` | the library avoids picking a side by using a marker |
| attribute key names | — | `{b,r,i,u,k,d}` always present | `{bold,reverse,italic,underline}` plus ad-hoc short keys | representation only; the library uses explicit `AttributeName` keys with three states |

## 4. IRC / mIRC compatibility (adapter territory)

The library does not convert IRC at all. `convertIrcCodes()` in the adapter now mirrors
WeeChat's own IRC plugin, `irc_color_decode()`
(`src/plugins/irc/irc-color.c:206-488`):

| Conversion | Suite cases | Result |
| --- | --- | --- |
| `\x02`, `\x16`, `\x1d`, `\x1f` toggles | `irc-bold`, `irc-reverse`, `irc-italic`, `irc-underline` | `\x1a\x01` / `\x1b\x01`, `\x1a\x02`, `\x1a\x03`, `\x1a\x04` — the control characters WeeChat's renderer understands |
| `\x1e` strikethrough | `irc-strikethrough` | `\x1a\x06` (dim), because WeeChat has no strikethrough |
| `\x0f` reset | `irc-reset` | `\x1c` full reset, and the tracked toggles are cleared |
| `\x03NN[,NN]` colors | `irc-color`, `irc-color-fg-bg`, `irc-color-out-of-range` | mapped through `irc_color_to_weechat[]` (0–15 named colors, 16–98 terminal colors, 99 default, index wrapped at 100) and emitted as `weechat_color("\|name")` output: `\x19F\|NN`, `\x19*…~…` |
| `\x04RRGGBB[,RRGGBB]` hex colors | `irc-hex-color` | nearest terminal color by squared RGB distance over `gui_color_term256[]` (`gui_color_convert_rgb_to_term`, `gui-color.c:563-597`), emitted as an extended payload |
| WeeChat controls inside IRC text | `irc-weechat-text-untouched` | passed through unchanged; no lookahead is needed because a WeeChat color payload never contains an mIRC control byte |

The `*` that used to leak into rendered text from the old `\x1a*` conversion is gone.

## 5. Decisions taken

1. **Printable attribute markers (row 1).** Follow upstream. The adapter emits
   `\x1a\x01` instead of `\x1a*`, so the leniency is no longer needed. Incoming relay
   text that already contains `\x1a*` from an older server-side conversion now shows a
   literal `*`, which is what WeeChat itself shows.
2. **Incomplete combined controls (row 2).** Follow upstream.
3. **Malformed payload consumption (rows 3–4).** Follow upstream; diagnostics are
   available through `parseWeeChatText`'s `diagnostics` field for a future debug mode.
4. **Bar references (row 5).** Consume them; the reference is recorded in the library
   for any future bar rendering work.
5. **Emphasis (rows 6–7).** Toggle fixed; the marker maps to the emphasis foreground.
6. **Obsolete theme indices (row 9).** Symbolic in the library, default color in the
   adapter.
7. **IRC conversion.** Upstream-faithful, including the IRC color table and hex colors.
8. **Hex color mapping.** Nearest color over WeeChat's own 256-entry `gui_color_term256`
   table, not the common xterm rounding formula, which disagrees with WeeChat for
   several inputs.

## 6. Known gaps in this ledger

- Upstream *rendering* was verified by reading C source, not by capturing terminal
  output from a live WeeChat instance. A curses fixture (isolated profile, not the
  user's) would strengthen rows 2–5.
- `gui_color_code_size()` and the renderer disagree with each other, and the library
  follows the renderer. That choice is recorded in `oracle/divergences.json`: three rules,
  each with the upstream line ranges it came from and one example whose scanner and
  library extents are both written down. `test/oracle.test.ts` always checks, from the
  ledger alone, that every example still diverges in the library by the recorded
  extents. The rules:

  | rule | scanner | renderer | library follows |
  |---|---|---|---|
  | `\u001a`/`\u001b` + a character outside `\u0001`–`\u0006` | consumes both | consumes the control only | renderer |
  | `\u0019B@` with fewer than five characters after `@` | consumes the `@` | stops before it | renderer |
  | `\u0019*<fg>,@` or `\u0019*<fg>~@` with fewer than five after `@` | consumes separator and `@` | consumes the separator only | renderer |

  A corpus mismatch that fits no rule fails the suite, and a rule that stops occurring
  fails it too. The corpus is ASCII and checks consumption extents only — not style
  application, and not Unicode (see `test/unicode.test.ts`).
- The stronger check is a local tool and is not tracked: `oracle/weechat_color_scan.c` vendors
  `gui_color_code_size()` and `gui_color_attr_get_flag()` verbatim from WeeChat 4.10.1,
  and `npm run oracle` compiles it over a 13,928-input ASCII sweep, writing the scanner
  verdicts to `oracle/weechat-oracle.txt` alongside the inputs in `oracle/corpus.txt`. When
  those three artifacts are on disk the suite compares every input against the scanner
  itself; when they are absent, as in a fresh checkout, the ledger checks above still run.
  Regenerating them needs `cc` and a scanner re-vendored by hand from the upstream
  files the ledger cites — the ledger records where the scanner came from, not every
  wrapper byte, so re-vendoring is a manual step that re-verifies the ledger against
  upstream rather than against the ledger prose alone.
- The differential corpus is 30 inline-control cases plus 11 raw-IRC cases and a
  324-case combinatorial matrix; it is not an exhaustive grammar sweep against
  upstream. The oracle sweep above is a separate 13,928-input check of consumption only,
  ASCII-only so that WeeChat byte offsets and JavaScript UTF-16 offsets coincide.
- Row 7's background choice and row 9's default-color choice are app policy, not
  upstream behavior; they are the only places where the adapter deliberately departs
  from WeeChat.
