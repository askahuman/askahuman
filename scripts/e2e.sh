#!/usr/bin/env bash
# Live end-to-end check against the system running in kind (bring it up first:
# `make ci-up`). Proves the full path with nothing mocked:
#   1. the integration suite pointed at the deployed relay (round trip for
#      yesno/choice/text, the MCP request_approval tool, and relay blindness);
#   2. the REAL PWA in headless Chromium pairing to the relay and approving.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

RELAY_WS="${RELAY_WS:-ws://127.0.0.1:8080/ws}"
WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:8081}"
HEALTH="${WEB_ORIGIN%/}"; HEALTH="http://localhost:8080/healthz"

echo "==> checking the deployed system is reachable"
curl -fsS -m 5 "$HEALTH" >/dev/null || {
  echo "relay $HEALTH unreachable — run 'make ci-up' first" >&2; exit 1; }
curl -fsS -m 5 -o /dev/null "$WEB_ORIGIN/" || {
  echo "web $WEB_ORIGIN unreachable — run 'make ci-up' first" >&2; exit 1; }
echo "    relay + web are up"

echo "==> building the agent binary"
( cd backend && go build -o "$ROOT/bin/agent" ./cmd/agent )

echo "==> live integration suite vs the deployed relay"
( cd backend && AAH_RELAY_URL="$RELAY_WS" go test -tags integration -count=1 ./internal/agent/ )

echo "==> real PWA (headless Chromium) vs the deployed relay+web"
export AGENT_BIN="$ROOT/bin/agent" RELAY_WS WEB_ORIGIN
for k in yesno choice text; do
  KIND="$k" node "$ROOT/frontend/e2e/pwa-live.mjs" | grep -E 'agent decision|PWA LIVE E2E'
done

echo
echo "E2E PASSED — MCP/agent + relay-in-kind + real PWA, all live."
