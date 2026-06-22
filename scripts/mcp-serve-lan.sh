#!/usr/bin/env bash
# Cursor / Claude-Desktop MCP stdio launcher for phone pairing over the LAN. Every time an
# agent calls request_approval (or start_pairing), the agent prints a short pairing CODE to
# its stderr, which this script tees to a log file. TYPE that code into the app on your phone
# (open the PWA at http://<lan-ip>:8081/app) — there is no QR or deep link anymore; the code
# is the out-of-band secret and the phone derives the relay room from it.
#
# Register THIS script as the MCP server "command". stdin/stdout stay pristine for MCP
# JSON-RPC; the pairing code only ever goes to stderr → the pair-log. Watch it with:
#   tail -f "$LOG"     # then type the "Pairing code: …" value into the app on your phone
set -euo pipefail
umask 077  # pair-log carries the pairing code (the SPAKE2 secret) — owner-only.
cd "$(dirname "$0")/.."

# Cursor / Claude-Desktop spawn MCP servers with a minimal PATH; make node/ipconfig/tail
# resolvable (node lives in Homebrew here).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
# Per-user log dir (0700), never shared world-readable /tmp; honor AAH_PAIR_LOG override.
LOGDIR="${TMPDIR:-${HOME}/.cache}"
mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR" 2>/dev/null || true
LOG="${AAH_PAIR_LOG:-${LOGDIR%/}/ask-a-human-pair.log}"
install -m600 /dev/null "$LOG"  # 0600 + no symlink-follow.
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
( cd backend && go build -o ../bin/agent ./cmd/agent ) 1>&2

# The server runs in the FOREGROUND (no `&`, no `exec` before the trap) so it inherits this
# script's stdin/stdout (the MCP JSON-RPC pipe); stderr → pair-log, where the pairing code
# lands for the human to read and type. The agent dials localhost and advertises the LAN.
exec ./bin/agent serve \
  --relay "ws://127.0.0.1:8080/ws" \
  --public-relay "ws://${LAN}:8080/ws" 2>>"$LOG"
