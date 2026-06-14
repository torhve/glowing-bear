#!/bin/bash
set -e

echo "=== Shutting down Glowing Bear Test Environment ==="

# Stop WeeChat
echo "[1/2] Stopping WeeChat..."
if pgrep -f "weechat-headless.*relay add weechat" > /dev/null 2>&1; then
  pkill -f "weechat-headless.*relay add weechat" 2>/dev/null || true
  sleep 1
  if nc -z localhost 9001 2>/dev/null; then
    pkill -9 -f "weechat-headless.*relay add weechat" 2>/dev/null || true
  fi
  echo "  WeeChat stopped"
else
  echo "  WeeChat not running"
fi

# Stop IRC server
echo "[2/2] Stopping IRC server..."
if [ -f /tmp/gbtest-irc.pid ]; then
  IRC_PID=$(cat /tmp/gbtest-irc.pid 2>/dev/null)
  if [ -n "$IRC_PID" ]; then
    kill "$IRC_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f /tmp/gbtest-irc.pid
  echo "  IRC server stopped"
else
  pkill -f "test/irc-server/index.ts" 2>/dev/null || true
  echo "  IRC server stopped (fallback)"
fi

# Clean up WeeChat temp config
if [ -d /tmp/gbtest-weechat ]; then
  rm -rf /tmp/gbtest-weechat 2>/dev/null || true
  echo "  Temp config cleaned"
fi

echo "=== Done ==="
