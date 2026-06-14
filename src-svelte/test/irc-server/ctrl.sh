#!/usr/bin/env bash
set -euo pipefail

# CLI helper to send commands to the WeeChat test fixture control API (port 16667).
# Usage: ./test/irc-server/ctrl.sh <command> [arg1] [arg2] ...
#
# Examples:
#   ./test/irc-server/ctrl.sh send_pm testuser "Hello from CLI!"
#   ./test/irc-server/ctrl.sh send_message "#glowing-bear" "Hello channel!"
#   ./test/irc-server/ctrl.sh send_notice "#glowing-bear" "Notice text"
#   ./test/irc-server/ctrl.sh colored_message "#glowing-bear" "Red text" 04
#   ./test/irc-server/ctrl.sh join "#other-channel"
#   ./test/irc-server/ctrl.sh part "#glowing-bear"
#   ./test/irc-server/ctrl.sh nick newbotname
#   ./test/irc-server/ctrl.sh topic "#glowing-bear" "New topic"
#   ./test/irc-server/ctrl.sh raw "PRIVMSG #chan :hi"
#   ./test/irc-server/ctrl.sh quit

CMD=${1:-}
ARG1=${2:-}
ARG2=${3:-}
ARG3=${4:-}
ARG4=${5:-}

build_json() {
  case "$CMD" in
    send_pm)         echo "{\"cmd\":\"send_pm\",\"nick\":$(jq "$ARG1"),\"text\":$(jq "$ARG2")}" ;;
    send_message)    echo "{\"cmd\":\"send_message\",\"channel\":$(jq "$ARG1"),\"text\":$(jq "$ARG2")}" ;;
    send_notice)     echo "{\"cmd\":\"send_notice\",\"channel\":$(jq "$ARG1"),\"text\":$(jq "$ARG2")}" ;;
    colored_message) echo "{\"cmd\":\"colored_message\",\"channel\":$(jq "$ARG1"),\"text\":$(jq "$ARG2"),\"fg\":$(jq "$ARG3"),\"bg\":$(jq "$ARG4")}" ;;
    join)            echo "{\"cmd\":\"join\",\"channel\":$(jq "$ARG1")}" ;;
    part)            echo "{\"cmd\":\"part\",\"channel\":$(jq "$ARG1")}" ;;
    nick)            echo "{\"cmd\":\"nick\",\"nickname\":$(jq "$ARG1")}" ;;
    topic)           echo "{\"cmd\":\"topic\",\"channel\":$(jq "$ARG1"),\"text\":$(jq "$ARG2")}" ;;
    raw)             echo "{\"cmd\":\"raw\",\"raw\":$(jq "$ARG1")}" ;;
    quit)            echo "{\"cmd\":\"quit\"}" ;;
    *)               echo "{\"cmd\":\"$CMD\"}" ;;
  esac
}

# Minimal jq-like JSON string escaping (no dependency on jq binary)
jq() {
  if [ $# -eq 0 ] || [ -z "$1" ]; then
    echo null
  else
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\t'/\\t}"
    echo "\"$s\""
  fi
}

if [ -z "$CMD" ]; then
  echo "Usage: $0 <command> [args...]" >&2
  echo "Run '$0 help' for examples" >&2
  exit 1
fi

JSON=$(build_json)
node -e "
  const net = require('net');
  const c = net.connect(16667, 'localhost', () => { c.end(process.argv[1] + '\n'); });
  let buf = '';
  c.on('data', d => buf += d);
  c.on('end', () => { try { console.log(JSON.stringify(JSON.parse(buf), null, 2)); } catch { console.log(buf); } });
  c.on('error', e => { console.error('ERROR:', e.message); process.exit(1); });
" "$JSON"
