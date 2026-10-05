# WeeChat inline chat format — verified specification

Ground truth: **WeeChat 4.10.1** source. Every rule below cites the file and line
range it was transcribed from; the installed `/opt/homebrew/bin/weechat` is the same
version, and `oracle/weechat_color_scan.c` vendors two scanner functions verbatim
(their upstream line ranges are recorded in `oracle/divergences.json`). Where two
upstream routines disagree with each other, both are recorded and the library's choice is stated.

This document describes the protocol the library implements. Divergences from the
two existing Glowing Bear parsers are in [behavior-differences.md](behavior-differences.md).

## 1. Control characters

| Byte | Name | Meaning | Source |
| --- | --- | --- | --- |
| `\x19` | `GUI_COLOR_COLOR_CHAR` | introduces a color instruction | `src/gui/gui-color.h:102-112` |
| `\x1a` | `GUI_COLOR_SET_ATTR_CHAR` | sets one attribute | `src/gui/gui-color.h:107` |
| `\x1b` | `GUI_COLOR_REMOVE_ATTR_CHAR` | removes one attribute | `src/gui/gui-color.h:108` |
| `\x1c` | `GUI_COLOR_RESET_CHAR` | resets; meaning depends on whether `\x19` precedes it | `src/gui/gui-color.h:109` |

Attribute characters directly after `\x1a` / `\x1b` are **control characters only**:

| Byte | Attribute | Source |
| --- | --- | --- |
| `\x01` | bold | `GUI_COLOR_ATTR_BOLD_CHAR`, `src/gui/gui-color.h:109-112` |
| `\x02` | reverse | |
| `\x03` | italic | |
| `\x04` | underline | |
| `\x05` | blink | |
| `\x06` | dim | |

Anything else after `\x1a` / `\x1b` is not an attribute: the control byte is
consumed and the following character stays ordinary text
(`gui_chat_string_next_char`, `src/gui/curses/gui-curses-chat.c:241-420`).

## 2. Color instructions

`\x19` is followed by a form marker:

| Form | Meaning |
| --- | --- |
| `F<payload>` | foreground only |
| `B<payload>` | background only |
| `*<fg><sep><bg>` | foreground and background together |
| `@NNNNN` | ncurses color *pair* number (curses frontend only) |
| `E` | toggle emphasis |
| `b<ref>` | bar reference / layout marker |
| `\x1c` | reset colors, keep attributes |
| two digits `NN` | theme option color by index |

### 2.1 Payload grammar

```
payload      := attr-flags? ( '@' digit{5} | digit{2} )
attr-flags   := ( '%' | '.' | '*' | '!' | '/' | '_' | '|' )+
```

| Flag | Meaning | Source |
| --- | --- | --- |
| `%` | blink | `GUI_COLOR_EXTENDED_BLINK_CHAR`, `src/gui/gui-color.h:126-132` |
| `.` | dim | |
| `*` | bold | |
| `!` | reverse | |
| `/` | italic | |
| `_` | underline | |
| `\|` | keep the current attributes (`GUI_COLOR_EXTENDED_KEEPATTR_CHAR`) | |

`gui_color_attr_get_flag()` (`src/gui/gui-color.c`) recognizes exactly these seven
characters; control characters are not valid flags inside a payload.

### 2.2 Combined foreground/background separator

`*` takes a foreground payload, a separator, then a background payload. Both
separators are accepted:

- `,` — legacy, used up to WeeChat 2.5 and still decoded for compatibility
  (`src/gui/curses/gui-curses-window.c:824-829`)
- `~` — current since WeeChat 2.6

### 2.3 Numeric fields

Numeric fields are parsed with `util_parse_int()` (`src/core/util.c`), i.e.
`strtol` semantics: optional leading whitespace, optional sign, decimal digits,
and **no trailing characters**. A field that fails to parse is not "ignored
partially": the whole field is invalid.

Ranges:

- named palette index: `0..16` (`GUI_CURSES_NUM_WEECHAT_COLORS == 17`,
  `src/gui/curses/gui-curses-color.c`)
- theme option index: `0..46` (`t_gui_color_enum`, `src/gui/gui-color.h:41-98`)
- extended color: `0..99999` (`GUI_COLOR_EXTENDED_MAX`, `src/gui/gui-color.h:156`);
  `src/gui/gui-color.c:447-465` clamps larger parsed values to it. A terminal
  renders far fewer distinct numbers, but this is the range the decoder must accept.

## 3. Consumption rules (fixed-width windows)

Both `gui_color_code_size()` (`src/gui/gui-color.c`) — used to measure how much of
a string is a color code — and the curses renderer consume **fixed-width**
payloads: they check that enough non-NUL characters *exist*, not that they are
digits. So `\x19F0x` consumes all four bytes even though `0x` is not a number, and
the style is left unchanged.

The two upstream routines are not identical, and the library follows the
**renderer** (`gui_chat_string_next_char` + `gui_window_string_apply_color_*` in
`src/gui/curses/gui-curses-window.c`), because the renderer is what a user sees:

| Input | `gui_color_code_size` | Renderer | Library follows |
| --- | --- | --- | --- |
| `\x1a*` | consumes 2 (`\x1a` + any char) | consumes 1, `*` is text | renderer |
| `\x1b*` | consumes 2 | consumes 1, `*` is text | renderer |
| `\x19B@` (fewer than five characters after `@`) | consumes the `@` | leaves `@` as text | renderer |
| `\x19*03,@12` | consumes the `@` window | leaves `@12` as text when the window is truncated | renderer |

These are not hypothetical: `gui_color_attr_get_flag()` and `gui_color_code_size()`
are vendored verbatim from WeeChat 4.10.1 into `oracle/weechat_color_scan.c`, `npm run
oracle` runs that scanner over 13,928 generated inputs, and `test/oracle.test.ts` fails
unless every difference between the library and that scanner is one of the rows above.
The scanner, its corpus and its verdicts are local artifacts — `oracle/divergences.json`
is the tracked record of these rows, and the suite checks the library against it even
without them.

A malformed control is therefore **consumed** (it never appears as text) but
applies **no** style change. The library reports it through the diagnostic
channel instead of guessing a repair.

## 4. Style semantics

### 4.1 Named palette (index 0..16)

`default, black, darkgray, red, lightred, green, lightgreen, brown, yellow, blue,
lightblue, magenta, lightmagenta, cyan, lightcyan, gray, white`
(`src/gui/curses/gui-curses-color.c:52-92`).

WeeChat has two palette tables, one with `A_BOLD` on the light colors and one
without. On any terminal with at least 16 colors — unless
`weechat.color.basic_force_bold` is set — the **no-bold** table is selected
(`gui-curses-color.c:1532-1543`). The library therefore never attaches implicit
bold to a light color; bold only comes from an explicit flag.

### 4.2 Attribute state

Each attribute is `inherited`, `enabled` or `disabled`:

- a named foreground color **replaces** the attribute set with the palette
  entry's attributes (normally empty), unless the payload carries `|`, which keeps
  the current attributes; the payload's own flags are then applied on top
- an extended color applies its flags and clears the other attributes, unless the
  payload carries `|`
- `\x1a<char>` / `\x1b<char>` set one attribute to `enabled` / `disabled`
  regardless of the previous state
- a theme color replaces attributes with that theme color's configured attributes

### 4.3 Resets

| Control | Upstream call | Effect |
| --- | --- | --- |
| `\x19\x1c` | `gui_window_reset_color()` | colors return to the chat colors, **attributes are kept** |
| `\x1c` | `gui_window_reset_style(win, GUI_COLOR_CHAT)` | colors **and** attributes become those of `weechat.color.chat` |

### 4.4 Emphasis

`\x19E` toggles a boolean. While on, the curses frontend renders text with the
configured emphasis color (`weechat.color.chat_emphasis`); `gui_color_get_custom
("emphasis")` produces `\x19E` (`src/gui/gui-color.c`). It is a **toggle**, so a
second `\x19E` turns it off. The library models it as a marker on the style rather
than baking a color into `fg`/`bg`, so a consumer can apply its own emphasis CSS.

### 4.5 Bar references

`\x19b` followed by `F`, `D`, `B`, `_`, `-`, `#`, `i`, `l`, `s` is a bar-item
styling or layout instruction (`src/gui/gui-color.h:137-145`). Inside chat text the
renderer recognizes and consumes it and applies no style
(`src/gui/curses/gui-curses-chat.c:298-314`). The library consumes it and records
the reference on the style so a consumer can decide what to do with it.

### 4.6 Theme option colors

A bare two-digit code indexes `t_gui_color_enum` (47 entries,
`src/gui/gui-color.h:41-98`), *not* the 17-color palette. Indices 17–26 are the
obsolete `chat_nick1`…`chat_nick10` colors kept for `/upgrade`; the curses
frontend resolves them to hardcoded palette colors
(`src/gui/curses/gui-curses-color.c`). The library keeps them as symbolic theme
names and leaves resolution to the consumer, because a browser has no reason to
reproduce a curses compatibility mapping.

### 4.7 Combined controls with large values

`set_custom_color_fg_bg()` (`src/gui/curses/gui-curses-window.c`) passes a parsed
foreground value ≥ 17 straight to terminal color handling, while an out-of-range
background indexes past the 17-entry palette table. The library does not reproduce
that hazard: any combined value outside the named palette is modeled as an
extended color. This is a deliberate safety difference, recorded in the ledger.

## 5. What the library deliberately does not do

- No HTML, CSS class names or `{@html}` output — it returns text runs and styles.
- No theme resolution: `theme` colors stay symbolic names; the consumer maps them.
- No IRC/mIRC conversion. IRC color/attribute conversion is an adapter concern
  (see the ledger's IRC entries).
- No repair of malformed input: unknown or truncated controls are consumed and
  reported through `onDiagnostic`, never rewritten.
- No global parser state: every call starts from `INITIAL_STYLE`.

## 6. Public surface

```ts
parseWeeChatText(input: string, options?: ParseOptions): TextRun[]
parseWeeChatStyle(input: string, options?: ParseOptions): StyleParseResult
stylesEqual(a: Style, b: Style): boolean
INITIAL_STYLE: Style            // frozen
WEECHAT_PALETTE, THEME_COLORS, BarReference
MAX_WEECHAT_COLOR = 16, MAX_THEME_COLOR = 46, MAX_EXTENDED_COLOR = 99999
```

`TextRun = { text: string; style: Style }`. Adjacent runs with equal styles are
coalesced. Styles are read-only and structurally shared; consumers must not mutate
them (see `test/immutability.test.ts`).
