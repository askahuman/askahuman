#!/usr/bin/env bash
# Pair from a phone on the same Wi-Fi. The kind cluster publishes the relay (:8080)
# and PWA (:8081) on all interfaces, so they're reachable at this Mac's LAN IP. The
# agent advertises the LAN-IP pairing link; scan its QR with the iPhone Camera app.
#
# Usage: scripts/pair-lan.sh [ask|pair|serve]      (default: ask — sends one demo request)
#   HTTPS=1 scripts/pair-lan.sh   →  use the TLS proxy (run `scripts/https-lan.sh` first) so the
#                                    in-app camera / service worker / Web Push work on iOS.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-ask}"
LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
[ -n "$LAN" ] || { echo "could not detect a LAN IP — set LAN=<ip> and retry" >&2; exit 1; }

if [ "${HTTPS:-0}" = "1" ]; then
  PORT="${TLS_PORT:-8443}"
  DIAL="ws://127.0.0.1:8080/ws"          # agent dials the plain local relay
  PUB=(--public-relay "wss://$LAN:$PORT/ws")
  WEB="https://$LAN:$PORT"
  HEALTH="https://$LAN:$PORT/healthz"; CK="-k"
  HINT="run 'scripts/https-lan.sh' first (the TLS proxy)"
else
  DIAL="ws://$LAN:8080/ws"               # agent + phone share the LAN-IP relay
  PUB=()
  WEB="http://$LAN:8081"
  HEALTH="http://$LAN:8080/healthz"; CK=""
  HINT="run 'make ci-up' first"
fi

curl -fsS $CK -m5 "$HEALTH" >/dev/null || { echo "relay not reachable at $HEALTH — $HINT" >&2; exit 1; }
curl -fsS $CK -m5 -o /dev/null "$WEB/" || { echo "PWA not reachable at $WEB — $HINT" >&2; exit 1; }
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
echo "building agent…" >&2; ( cd backend && go build -o ../bin/agent ./cmd/agent )

echo "LAN IP: $LAN   PWA: $WEB"
echo "On the iPhone (same Wi-Fi): scan the QR below with the Camera app, or open the printed link."
if [ "${HTTPS:-0}" != "1" ]; then
  echo "Note: over plain http the in-app camera / service worker / Web Push won't run on iOS; pairing +"
  echo "      approve/decline/choice/text all work. For those, use HTTPS=1 (see scripts/https-lan.sh)."
fi
echo

case "$MODE" in
  ask)
    exec ./bin/agent ask --relay "$DIAL" "${PUB[@]}" --web "$WEB" --kind yesno --category deploy \
      --title "Test from your phone" --summary "Approve this to confirm the round trip from your iPhone." ;;
  pair)  exec ./bin/agent pair  --relay "$DIAL" "${PUB[@]}" --web "$WEB" ;;
  serve) exec ./bin/agent serve --relay "$DIAL" "${PUB[@]}" --web "$WEB" ;;
  *) echo "usage: scripts/pair-lan.sh [ask|pair|serve]" >&2; exit 2 ;;
esac
