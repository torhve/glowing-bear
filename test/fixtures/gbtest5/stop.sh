#!/bin/bash

# Stop only the WeeChat 5 fixture. The IRC server and gbtest's own WeeChat are
# left alone — this fixture shares the IRC server but owns its WeeChat home, and
# the pattern below is deliberately not a prefix of gbtest's.

echo "=== Stopping WeeChat 5 relay fixture ==="

if pgrep -f "gbtest5-weechat" > /dev/null 2>&1; then
	pkill -f "gbtest5-weechat" 2>/dev/null || true
	sleep 1
	if nc -z localhost 9011 2>/dev/null; then
		pkill -9 -f "gbtest5-weechat" 2>/dev/null || true
		sleep 1
	fi
	echo "  WeeChat 5 stopped"
else
	echo "  WeeChat 5 not running"
fi

if [ -d /tmp/gbtest5-weechat ]; then
	rm -rf /tmp/gbtest5-weechat 2>/dev/null || true
	echo "  fixture config cleaned"
fi

echo "=== Done ==="
