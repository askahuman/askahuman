#!/usr/bin/env bash
# Localhost MCP stdio launcher used by the autonomous E2E (scripts/agent-e2e.sh).
# Identical role to scripts/mcp-serve.sh but pinned to localhost (no phone/LAN/TLS) and
# it tees the pairing QR + deep link to a log file so the test harness can read the link
# and drive the real PWA. stdout/stdin stay pristine for MCP JSON-RPC; only stderr is teed.
set -euo pipefail
umask 077  # pair-log carries the SPAKE2 secret (room id + code) — owner-only.
cd "$(dirname "$0")/.."
# Per-user log dir (0700), never shared world-readable /tmp; honor AAH_PAIR_LOG override.
LOGDIR="${TMPDIR:-${HOME}/.cache}"
mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR" 2>/dev/null || true
LOG="${AAH_PAIR_LOG:-${LOGDIR%/}/aah-test-pair.log}"
install -m600 /dev/null "$LOG"  # 0600 + no symlink-follow.
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
( cd backend && go build -o ../bin/agent ./cmd/agent ) 1>&2
exec ./bin/agent serve \
  --relay "${AAH_RELAY_URL:-ws://127.0.0.1:8080/ws}" \
  --web   "${AAH_WEB_ORIGIN:-http://localhost:8081}" 2>>"$LOG"
