#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../../.."
WEECHAT_HOME="/tmp/gbtest-weechat"

IRC_PORT=6667
CONTROL_PORT=16667
RELAY_PORT=9001

RELAY_ALREADY_RUNNING=false
IRC_ALREADY_RUNNING=false

cleanup() {
	echo ""
	echo "Cleaning up..."
	if [ -f /tmp/gbtest-irc.pid ]; then
		kill "$(cat /tmp/gbtest-irc.pid 2>/dev/null)" 2>/dev/null || true
		rm -f /tmp/gbtest-irc.pid
	fi
	if $RELAY_ALREADY_RUNNING; then
		echo "  Skipping WeeChat temp config removal (relay was pre-existing)"
	elif [ -n "$WEECHAT_HOME" ] && [ -d "$WEECHAT_HOME" ]; then
		rm -rf "$WEECHAT_HOME" 2>/dev/null || true
		echo "  Temp config removed"
	fi
	exit 1
}

# Check dependencies
if ! command -v nc &>/dev/null; then
	echo "ERROR: nc not found"
	cleanup
fi
if ! command -v weechat-headless &>/dev/null; then
	echo "ERROR: weechat-headless not found"
	cleanup
fi

# Check if already running
if nc -z localhost "$RELAY_PORT" 2>/dev/null; then
	echo "Port $RELAY_PORT already in use — assuming it's our WeeChat relay, skipping start"
	RELAY_ALREADY_RUNNING=true
fi
if nc -z localhost "$IRC_PORT" 2>/dev/null; then
	echo "Port $IRC_PORT already in use — assuming it's our IRC server, skipping start"
	IRC_ALREADY_RUNNING=true
fi

echo "=== Glowing Bear Test Environment ==="
echo ""

# 0. Create temp WeeChat config directory
mkdir -p "$WEECHAT_HOME"

# Helper: send a command to a running gbtest WeeChat through its FIFO.
# Silently does nothing when no FIFO exists (WeeChat not running yet).
weechat_cmd() {
	local fifo
	for fifo in "$WEECHAT_HOME"/weechat_fifo_*; do
		[ -p "$fifo" ] || continue
		printf 'core.weechat */%s\n' "$1" > "$fifo"
		return 0
	done
	return 0
}

# WeeChat scripts the tests rely on (the /grep shim) are autoloaded on a
# fresh start, and loaded through the FIFO when a warm instance is reused.
mkdir -p "$WEECHAT_HOME/python/autoload"
cp "$SCRIPT_DIR"/weechat/*.py "$WEECHAT_HOME/python/autoload/"

# The shim writes this marker when it registers. Polling it proves WeeChat
# accepted the command — a FIFO write alone only proves it was submitted.
GREP_READY_MARKER="$WEECHAT_HOME/gbtest-grep.ok"
rm -f "$GREP_READY_MARKER"

wait_for_grep_shim() {
	local i
	for i in $(seq 1 30); do
		if [ -f "$GREP_READY_MARKER" ]; then
			echo "  /grep shim loaded"
			return 0
		fi
		sleep 0.5
	done
	echo "ERROR: gbtest /grep shim did not load (expected $GREP_READY_MARKER)"
	cleanup
}

# Ask the gbtest IRC server which registered clients are in a channel.
irc_control() {
	printf '%s\n' "$1" | nc -w 3 localhost "$CONTROL_PORT" 2>/dev/null
}

# WeeChat autojoins #glowing-bear a moment after it connects to the IRC server.
# Until then, messages the test bot sends to the channel never reach it, so a
# spec started too early loses its own test message.
wait_for_channel_join() {
	local i
	for i in $(seq 1 40); do
		if irc_control "{\"cmd\":\"status\",\"channel\":\"#glowing-bear\"}" | grep -q '"testuser"'; then
			echo "  WeeChat joined #glowing-bear"
			return 0
		fi
		sleep 0.5
	done
	echo "ERROR: WeeChat did not join #glowing-bear (testuser never appeared)"
	cleanup
}

if ! $IRC_ALREADY_RUNNING; then
	# 1. Start IRC server as daemon
	cd "$REPO_ROOT" && npx tsx "src-svelte/test/irc-server/index.ts" \
		--daemon \
		--port="$IRC_PORT" \
		--control-port="$CONTROL_PORT" \
		--pidfile="/tmp/gbtest-irc.pid"

	# Wait for PID file (daemon writes it synchronously, then exits)
	for i in $(seq 1 5); do
		if [ -f /tmp/gbtest-irc.pid ]; then
			# Verify the process is actually running
			IRC_PID=$(cat /tmp/gbtest-irc.pid)
			if kill -0 "$IRC_PID" 2>/dev/null; then
				break
			fi
		fi
		if [ "$i" -eq 5 ]; then
			echo "ERROR: IRC server daemon did not start"
			cleanup
		fi
		sleep 1
	done

	# Wait for IRC server to listen
	for i in $(seq 1 10); do
		if nc -z localhost "$IRC_PORT" 2>/dev/null; then
			break
		fi
		if [ "$i" -eq 10 ]; then
			echo "ERROR: IRC server not listening"
			cleanup
		fi
		sleep 1
	done

	# Wait for control API
	for i in $(seq 1 5); do
		if nc -z localhost "$CONTROL_PORT" 2>/dev/null; then
			break
		fi
		sleep 1
	done
else
	echo "  IRC server already running — skipping start, waits skipped"
fi

if ! $RELAY_ALREADY_RUNNING; then
	# Start WeeChat headless with fresh config
	# Set algo BEFORE password so it gets hashed with pbkdf2+sha256
	weechat-headless -d "$WEECHAT_HOME" \
		--daemon \
		-r "/set relay.network.password_hash_algo pbkdf2+sha256" \
		-r "/set relay.network.password testpassword123" \
		-r "/set relay.network.max_clients 32" \
		-r "/set relay.network.clients_purge_delay 1" \
		-r "/relay add weechat $RELAY_PORT" \
		-r "/server add gbtest localhost/$IRC_PORT -nicks=testuser -autoconnect -notls" \
		-r "/set irc.server.gbtest.autojoin #glowing-bear" \
		-r "/hotlist clear" \
		-r "/connect gbtest"

	# Wait for WeeChat relay
	for i in $(seq 1 30); do
		if nc -z localhost "$RELAY_PORT" 2>/dev/null; then
			echo "WeeChat relay ready"
			break
		fi
		if [ "$i" -eq 30 ]; then
			echo "ERROR: WeeChat relay did not start"
			cleanup
		fi
		sleep 1
	done

	wait_for_grep_shim
	wait_for_channel_join
else
	echo "  WeeChat relay already running — skipping start"
	# Warm instance: reload the test scripts and drop notification state left
	# behind by earlier runs so every run starts from a clean slate.
	weechat_cmd "python unload grep"
	weechat_cmd "python load $SCRIPT_DIR/weechat/grep.py"
	weechat_cmd "hotlist clear"
	wait_for_grep_shim
	wait_for_channel_join
fi

echo ""
echo "=== Ready ==="
echo "  IRC server:     localhost:$IRC_PORT"
echo "  Control API:    localhost:$CONTROL_PORT"
echo "  WeeChat relay:  ws://localhost:$RELAY_PORT (password: testpassword123)"
echo "  Bot nick:       gbbot"
echo "  Auto channel:   #glowing-bear"
echo "  Config dir:     $WEECHAT_HOME"
echo ""
echo "Run 'npm run dev' (from repo root) to start the UI."
echo "Run 'npm run test:e2e' to run playwright tests."
echo "Run '$SCRIPT_DIR/stop.sh' to shut down."
