# Minimal /grep shim for the gbtest WeeChat instance.
#
# Why this exists: the Homebrew WeeChat bottle ships no bundled scripts
# (no share/weechat/, empty python/autoload), so the app's content search
# (`/grep <text>` in +page.svelte) has no command to call and the
# ContentSearch E2E specs can never find the `python.grep` buffer.
#
# This reproduces the parts of the official grep script that Glowing Bear
# depends on: a `/grep` command that searches a buffer's lines
# case-insensitively and writes the matches into a `*grep` buffer
# (full name `python.grep`, short name `grep`).
#
# Loaded by test/fixtures/gbtest/start.sh: copied into python/autoload for a
# fresh WeeChat, or loaded through the FIFO when a warm gbtest is reused.

from datetime import datetime

import os
import weechat

SCRIPT_NAME = "grep"
SCRIPT_VERSION = "1.0"
SCRIPT_LICENSE = "GPL3"
SCRIPT_AUTHOR = "glowing-bear"
SCRIPT_DESCRIPTION = "grep: search buffer content (gbtest shim)"

# Marker file start.sh polls to confirm the shim really loaded: a FIFO write
# only proves the command was submitted, not that WeeChat accepted it.
READY_MARKER = "gbtest-grep.ok"

# Cap results so a search on a huge buffer cannot flood the grep buffer.
DEFAULT_MAX_LINES = 4000


def grep_buffer_name():
    """Short name of the results buffer; must stay 'grep' for the app lookup."""
    return "grep"


def get_grep_buffer():
    """Return the shared results buffer, creating it on first use."""
    buffer = weechat.buffer_search("python", grep_buffer_name())
    if not buffer:
        buffer = weechat.buffer_new(
            grep_buffer_name(), "grep_input_cb", "", "grep_close_cb", ""
        )
    if buffer:
        # The results buffer is a scratch buffer: it must never notify.
        weechat.buffer_set(buffer, "notify", "0")
    return buffer


def buffer_lines(buffer):
    """Yield (date, prefix, message) for every line of a buffer, oldest first."""
    hdata_buffer = weechat.hdata_get("buffer")
    hdata_lines = weechat.hdata_get("lines")
    hdata_line = weechat.hdata_get("line")
    hdata_data = weechat.hdata_get("line_data")
    if not (hdata_buffer and hdata_lines and hdata_line and hdata_data):
        return
    # buffer/own_lines is a "lines" object whose first_line/last_line are plain
    # pointer vars (not hdata lists), so walk the line chain manually.
    lines = weechat.hdata_pointer(hdata_buffer, buffer, "own_lines")
    if not lines:
        return
    line = weechat.hdata_pointer(hdata_lines, lines, "first_line")
    while line:
        data = weechat.hdata_pointer(hdata_line, line, "data")
        if data:
            yield (
                weechat.hdata_integer(hdata_data, data, "date"),
                weechat.hdata_string(hdata_data, data, "prefix") or "",
                weechat.hdata_string(hdata_data, data, "message") or "",
            )
        line = weechat.hdata_move(hdata_line, line, 1)


def parse_args(args):
    """Split `/grep` arguments into options and the search text."""
    options = {
        "buffer": "",
        "case": False,
        "lines": DEFAULT_MAX_LINES,
    }
    text = ""
    tokens = args.split()
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "-buffer" and index + 1 < len(tokens):
            options["buffer"] = tokens[index + 1]
            index += 2
        elif token == "-case":
            options["case"] = True
            index += 1
        elif token == "-lines" and index + 1 < len(tokens):
            try:
                options["lines"] = max(1, int(tokens[index + 1]))
            except ValueError:
                pass
            index += 2
        else:
            # Everything from the first non-option token on is the search text.
            text = " ".join(tokens[index:])
            break
    return options, text


def grep_command_cb(data, buffer, args):
    """Run the search and write matches to the *grep buffer."""
    if not buffer:
        return weechat.WEECHAT_RC_ERROR

    options, text = parse_args(args)
    if not text:
        weechat.command(buffer, "/help grep")
        return weechat.WEECHAT_RC_OK

    source = buffer
    if options["buffer"]:
        source = weechat.buffer_search("==", options["buffer"])
        if not source:
            weechat.prnt(
                buffer,
                "%sgrep: buffer \"%s\" not found"
                % (weechat.prefix("error"), options["buffer"]),
            )
            return weechat.WEECHAT_RC_ERROR

    grep_buf = get_grep_buffer()
    if not grep_buf:
        return weechat.WEECHAT_RC_ERROR

    source_name = weechat.buffer_get_string(source, "full_name")
    needle = text if options["case"] else text.lower()

    weechat.buffer_clear(grep_buf)
    weechat.buffer_set(
        grep_buf,
        "title",
        "Search results for '%s' in %s" % (text, source_name),
    )
    weechat.prnt(
        grep_buf,
        "Searching text '%s' in buffer %s" % (text, source_name),
    )

    matches = 0
    for date, prefix, message in buffer_lines(source):
        haystack = message if options["case"] else message.lower()
        if needle not in haystack:
            continue
        matches += 1
        if matches > options["lines"]:
            weechat.prnt(grep_buf, "... (max lines reached)")
            break
        weechat.prnt(
            grep_buf,
            "%s\t(%s) %s\t%s" % (source_name, format_date(date), prefix, message),
        )

    if matches == 0:
        weechat.prnt(grep_buf, "No results found for '%s'" % text)
    else:
        weechat.prnt(grep_buf, "%d line(s) found" % matches)

    weechat.command(grep_buf, "/window scroll_bottom")
    return weechat.WEECHAT_RC_OK


def format_date(date):
    """Format a line timestamp as an ISO-ish string for the result line."""
    if date <= 0:
        return ""
    return datetime.fromtimestamp(date).strftime("%Y-%m-%dT%H:%M:%S")


def grep_input_cb(data, buffer, input_data):
    """Typing in the results buffer jumps back to the searched buffer."""
    return weechat.WEECHAT_RC_OK


def grep_close_cb(data, buffer):
    """Nothing to clean up per-buffer; the script owns no persistent state."""
    return weechat.WEECHAT_RC_OK


def unregister():
    return weechat.WEECHAT_RC_OK


def register():
    weechat.register(
        SCRIPT_NAME,
        SCRIPT_AUTHOR,
        SCRIPT_VERSION,
        SCRIPT_LICENSE,
        SCRIPT_DESCRIPTION,
        "unregister",
        "",
    )
    weechat.hook_command(
        SCRIPT_NAME,
        "Search for a text in a buffer",
        "[-buffer <name>] [-case] [-lines <max>] <text>",
        "Search the current buffer (or -buffer <name>) for <text> and show the "
        "matches in the *grep buffer.",
        "-buffer %(buffers_names) -case -lines %(number) ||%(buffers_names)|-case|-lines",
        "grep_command_cb",
        "",
    )
    write_ready_marker()
    return weechat.WEECHAT_RC_OK


# Written on load so start.sh can verify the shim is registered before the test
# suite runs.
def write_ready_marker():
    """Touch a marker file in the WeeChat config dir."""
    weechat_dir = weechat.info_get("weechat_dir", "")
    if not weechat_dir:
        return
    try:
        with open(os.path.join(weechat_dir, READY_MARKER), "w") as handle:
            handle.write("%s %s\n" % (SCRIPT_NAME, SCRIPT_VERSION))
    except OSError:
        pass


register()
