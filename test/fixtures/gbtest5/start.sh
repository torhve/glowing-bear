#!/bin/bash
set -e

# Start a second, version-pinned WeeChat relay alongside gbtest so the app can be
# tested against a newer relay API contract than 4.10.1 / API 0.6.0.
#
# gbtest itself is untouched: same IRC server (6667) and control port (16667), a
# different WeeChat home, a different relay port, and a different IRC nick, so the
# two instances never share state beyond the channel itself.
#
# Nothing here is required for the rest of the suite. When no 5.0 binary is
# available the script exits 2 and the E2E spec that needs it skips.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEECHAT_HOME="/tmp/gbtest5-weechat"
API_RELAY_PORT=9011
IRC_PORT=6667
CONTROL_PORT=16667
NICK="testuser5"
CHANNEL="#glowing-bear"
PASSWORD="testpassword123"

# --- locate a WeeChat 5 relay binary -------------------------------------
# Deliberately explicit: silently falling back to whatever `weechat-headless` is
# on PATH would run 4.10.1 and the spec would then "verify" 5.0 behaviour
# against a 4.10.1 relay.
find_binary() {
	local candidate
	if [ -n "$GB_WEECHAT5_BIN" ]; then
		printf '%s' "$GB_WEECHAT5_BIN"
		return 0
	fi
	for candidate in weechat5-headless /tmp/weechat-src/build/src/gui/curses/headless/weechat-headless; do
		if command -v "$candidate" &>/dev/null || [ -x "$candidate" ]; then
			printf '%s' "$candidate"
			return 0
		fi
	done
	return 1
}

is_version_5() {
	local bin="$1"
	local version
	# `--version` prints bare "5.0.0-dev" on some builds and a full
	# "WeeChat 5.0.0-dev (...)" banner on others — accept either shape.
	version="$("$bin" --version 2>/dev/null | head -1)"
	case "$version" in
		5.* | *" 5."*) return 0 ;;
		*) echo "  refusing $bin: reports '$version' (need WeeChat 5.x)" >&2; return 1 ;;
	esac
}

probe_api_relay() {
	node -e '
		const crypto = require("crypto");
		const ts = Math.floor(Date.now() / 1000);
		const iterations = 100000;
		const hash = crypto.pbkdf2Sync("'"$PASSWORD"'", String(ts), iterations, 32, "sha256").toString("hex");
		const cred = Buffer.from("hash:pbkdf2+sha256:" + ts + ":" + iterations + ":" + hash).toString("base64");
		fetch("http://127.0.0.1:'"$API_RELAY_PORT"'/api/version", { headers: { Authorization: "Basic " + cred } })
			.then(r => r.ok ? r.json() : null)
			.then(b => {
				if (!b || typeof b.relay_api_version !== "string") process.exit(1);
				if (!/^5\./.test(b.weechat_version)) process.exit(1);
				process.exit(0);
			})
			.catch(() => process.exit(1));
	' >/dev/null 2>&1
}

if probe_api_relay; then
	echo "WeeChat 5 relay on $API_RELAY_PORT already live — skipping start"
	exit 0
fi

BIN="$(find_binary)" || {
	echo "No WeeChat 5 relay binary found."
	echo "  Set GB_WEECHAT5_BIN=/path/to/weechat-headless (5.x) to enable this fixture."
	exit 2
}
is_version_5 "$BIN" || exit 2

if ! nc -z localhost "$IRC_PORT" 2>/dev/null; then
	echo "ERROR: gbtest IRC server ($IRC_PORT) is not running — start gbtest first"
	exit 1
fi

echo "=== WeeChat 5 relay fixture ==="
echo "  binary: $BIN"

# A custom -d home does NOT find the plugins a packaged WeeChat would: the plugin
# path is ${weechat_data_dir}/plugins, so without this the relay plugin never
# loads, no port opens, and the failure looks like a network problem.
mkdir -p "$WEECHAT_HOME/plugins"
PLUGIN_SRC="$GB_WEECHAT5_PLUGIN_DIR"
if [ -z "$PLUGIN_SRC" ]; then
	# A locally built WeeChat keeps its plugins scattered through its build tree
	# (upstream currently puts relay.so under build/src/plugins/relay/, irc.so under
	# build/src/plugins/irc/, and so on). Search that tree instead of guessing a
	# path: a wrong guess looks exactly like a relay that refuses to open a port.
	scan="$BIN"
	build_root=""
	for _ in 1 2 3 4 5 6 7 8; do
		scan="$(dirname "$scan")"
		if [ "$(basename "$scan")" = "build" ]; then build_root="$scan"; break; fi
		done
	[ -n "$build_root" ] && PLUGIN_SRC="$build_root"
fi

if [ -n "$PLUGIN_SRC" ] && [ -d "$PLUGIN_SRC" ]; then
	echo "  plugins from: $PLUGIN_SRC"
	# Every plugin module, not just relay.so: this fixture also has to reach the
	# gbtest IRC server (irc.so) and answer FIFO control (fifo.so).
	find "$PLUGIN_SRC" -type f -name '*.so' -exec cp {} "$WEECHAT_HOME/plugins/" \;
	count=$(ls "$WEECHAT_HOME/plugins" | wc -l | tr -d ' ')
	echo "  copied $count plugin module(s)"
	[ "$count" -gt 0 ] || { echo "ERROR: plugin search found nothing"; exit 1; }
else
	echo "ERROR: no plugin source found — set GB_WEECHAT5_PLUGIN_DIR or build_root"; exit 1
fi

"$BIN" -d "$WEECHAT_HOME" --daemon \
	-r "/set relay.network.password_hash_algo pbkdf2+sha256" \
	-r "/set relay.network.password $PASSWORD" \
	-r "/set relay.network.max_clients 16" \
	-r "/relay add api $API_RELAY_PORT" \
	-r "/server add gbtest5 localhost/$IRC_PORT -nicks=$NICK -autoconnect -notls" \
	-r "/set irc.server.gbtest5.autojoin $CHANNEL" \
	-r "/connect gbtest5"

for _ in $(seq 1 20); do
	if probe_api_relay; then
		echo "  API relay ready (authenticated probe, WeeChat 5 + relay API)"
		break
	fi
	sleep 1
done
probe_api_relay || { echo "ERROR: relay did not become ready on $API_RELAY_PORT"; exit 1; }

# The app's spec waits for a real channel message, so the join has to land.
for _ in $(seq 1 40); do
	if printf '{"cmd":"status","channel":"%s"}\n' "$CHANNEL" | nc -w 3 localhost "$CONTROL_PORT" | grep -q "\"$NICK\""; then
		echo "  $NICK joined $CHANNEL"
		exit 0
	fi
	sleep 0.5
done
echo "ERROR: $NICK never joined $CHANNEL"
exit 1
