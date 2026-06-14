#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SVELTE_DIR="$SCRIPT_DIR/../../../src-svelte"
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
if ! command -v /opt/homebrew/bin/weechat-headless &>/dev/null; then
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

if ! $IRC_ALREADY_RUNNING; then
	# 1. Start IRC server as daemon
	cd "$SRC_SVELTE_DIR" && npx tsx "test/irc-server/index.ts" \
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
	/opt/homebrew/bin/weechat-headless -d "$WEECHAT_HOME" \
		--daemon \
		-r "/set relay.network.password testpassword123" \
	-r "/set relay.network.max_connections 32" \
		-r "/relay add weechat $RELAY_PORT" \
		-r "/server add gbtest localhost/$IRC_PORT -nicks=testuser -autoconnect -notls" \
		-r "/set irc.server.gbtest.autojoin #glowing-bear" \
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
else
	echo "  WeeChat relay already running — skipping start"
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
echo "Run 'npm run dev' (from src-svelte/) to start the UI."
echo "Run 'npm run test:e2e' to run Cypress tests."
echo "Run '$SCRIPT_DIR/stop.sh' to shut down."
