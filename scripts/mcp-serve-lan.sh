#!/usr/bin/env bash
# Cursor / Claude-Desktop MCP stdio launcher for phone pairing over the LAN, with an
# auto-popping QR: every time an agent calls request_approval, this renders the pairing
# deep-link as a PNG and opens it (Preview) so you SCAN IT WITH THE IPHONE CAMERA — never
# click the link on the Mac (that would pair the Mac and take the room's only phone slot).
#
# Register THIS script as the MCP server "command". stdin/stdout stay pristine for MCP
# JSON-RPC; the QR watcher only reads the pair-log file and is detached from stdio.
set -euo pipefail
umask 077  # pair-log + QR page carry the SPAKE2 secret (room id + code) — owner-only.
cd "$(dirname "$0")/.."

# Cursor / Claude-Desktop spawn MCP servers with a minimal PATH; make node/ipconfig/open/tail
# resolvable so the QR popup works (node lives in Homebrew here).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
# Per-user log dir (0700), never shared world-readable /tmp; honor AAH_PAIR_LOG override.
LOGDIR="${TMPDIR:-${HOME}/.cache}"
mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR" 2>/dev/null || true
LOG="${AAH_PAIR_LOG:-${LOGDIR%/}/ask-a-human-pair.log}"
PAGE="${AAH_PAIR_PAGE:-${LOGDIR%/}/ask-a-human-pair.html}"
install -m600 /dev/null "$LOG"  # 0600 + no symlink-follow.
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
( cd backend && go build -o ../bin/agent ./cmd/agent ) 1>&2

# Watcher: the agent prints "link: <url>" then "code: <code>" per pairing. On the code line
# (so we have both), render a full-screen scannable QR page and open it in the browser.
# stdin is /dev/null so it can never steal MCP JSON-RPC bytes from the server's stdin.
(
  url=""
  tail -n0 -F "$LOG" 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      link:*) url="${line#link: }" ;;
      code:*)
        code="${line#code: }"
        [ -n "$url" ] || continue
        node scripts/render-pair-page.mjs "$url" "$code" "$PAGE" 2>/dev/null || true
        [ "${AAH_QR_OPEN:-1}" = "0" ] || open "$PAGE" 2>/dev/null || true
        url="" ;;
    esac
  done
) </dev/null &
WATCHER=$!
trap 'kill "$WATCHER" 2>/dev/null || true' EXIT TERM INT

# The server MUST run in the FOREGROUND (no `&`, no `exec`) so it inherits this script's
# stdin/stdout (the MCP JSON-RPC pipe) — a backgrounded job gets stdin from /dev/null and
# never handshakes; `exec` would skip the trap that reaps the watcher. stderr → pair-log,
# which the watcher reads to pop the QR. The agent dials localhost, advertises the LAN.
./bin/agent serve \
  --relay "ws://127.0.0.1:8080/ws" \
  --public-relay "ws://${LAN}:8080/ws" \
  --web "http://${LAN}:8081" 2>>"$LOG"
