#!/usr/bin/env bash
# Local HTTPS for phone testing. Generates a mkcert cert for this Mac's LAN IP and
# runs a TLS reverse proxy that fronts the kind relay (wss /ws + /healthz) and the
# PWA (https /) on one origin (:8443). A secure context is required for the in-app
# QR camera (getUserMedia), the service worker, and Web Push. NOT for production.
#
# Run this in one terminal (it stays up); pair from another with:
#   HTTPS=1 scripts/pair-lan.sh
#
# One-time on the iPhone — install + trust the mkcert root CA so Safari trusts the
# proxy (AirDrop the printed rootCA.pem to the phone):
#   1. Settings > General > VPN & Device Management > install the profile.
#   2. Settings > General > About > Certificate Trust Settings > enable full trust.
set -euo pipefail
cd "$(dirname "$0")/.."

LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
PORT="${TLS_PORT:-8443}"
CERT="infra/local/certs/lan.pem"
KEY="infra/local/certs/lan-key.pem"
export PATH="$(go env GOPATH)/bin:$PATH"

curl -fsS -m5 http://127.0.0.1:8080/healthz >/dev/null \
  || { echo "kind relay not up — run 'make ci-up' first" >&2; exit 1; }

command -v mkcert >/dev/null || { echo "installing mkcert (go install)…"; go install filippo.io/mkcert@latest; }
if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
  mkdir -p infra/local/certs
  echo "generating cert for $LAN…"
  mkcert -cert-file "$CERT" -key-file "$KEY" "$LAN" localhost 127.0.0.1
fi
( cd backend && go build -o ../bin/devproxy ./cmd/devproxy )

CA="$(mkcert -CAROOT)/rootCA.pem"
cat <<EOF

iPhone setup (one time): install + trust this root CA, then the in-app camera works:
  $CA
(AirDrop it to the phone → install the profile → enable full trust under Certificate Trust Settings.)

PWA over HTTPS:  https://$LAN:$PORT
Pair from the phone (another terminal):  HTTPS=1 scripts/pair-lan.sh
Starting TLS proxy (Ctrl-C to stop)…
EOF

exec ./bin/devproxy --addr ":$PORT" --cert "$CERT" --key "$KEY" \
  --relay http://127.0.0.1:8080 --web http://127.0.0.1:8081
