#!/usr/bin/env bash
# MCP stdio launcher for ask-a-human, bound to this Mac's LAN IP so a phone can pair.
# Register THIS script as the MCP server "command" in your agent client (Cursor / Claude
# Desktop / Codex). stdout/stdin carry MCP JSON-RPC (kept pristine — a clean exec, no shell
# wrappers around it); the human-facing pairing QR + deep link are written to a log file on
# the FIRST request_approval call:
#   tail -f "$TMPDIR/ask-a-human-pair.log"     # then scan the QR with the iPhone Camera
# Pairing is held in RAM for the life of this process (no DB); restart ⇒ re-pair.
set -euo pipefail
umask 077  # pair-log carries the SPAKE2 secret (room id + code) — owner-only.
cd "$(dirname "$0")/.."
LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
# Per-user log dir (0700), never shared world-readable /tmp; honor AAH_PAIR_LOG override.
LOGDIR="${TMPDIR:-${HOME}/.cache}"
mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR" 2>/dev/null || true
LOG="${AAH_PAIR_LOG:-${LOGDIR%/}/ask-a-human-pair.log}"
install -m600 /dev/null "$LOG"  # 0600 + no symlink-follow.
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
( cd backend && go build -o ../bin/agent ./cmd/agent ) 1>&2

# HTTPS=1 advertises the TLS proxy to the phone (run scripts/https-lan.sh first) so the
# in-app camera / service worker / Web Push work on iOS; the agent still dials plain local.
if [ "${HTTPS:-0}" = "1" ]; then
  PORT="${TLS_PORT:-8443}"
  exec ./bin/agent serve --relay "ws://127.0.0.1:8080/ws" --public-relay "wss://${LAN}:${PORT}/ws" \
    --web "https://${LAN}:${PORT}" 2>>"$LOG"
fi
exec ./bin/agent serve --relay "ws://${LAN}:8080/ws" --web "http://${LAN}:8081" 2>>"$LOG"
