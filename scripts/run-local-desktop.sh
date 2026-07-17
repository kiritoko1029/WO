#!/usr/bin/env bash
# Local-only launcher for the unsigned macOS desktop build.
# The packaged app requires HTTPS + a trusted CA; Finder launches omit env vars.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT="$ROOT/deploy/.certs/local-dev/cert.pem"
PROXY="$ROOT/deploy/.certs/local-dev/https-proxy.mjs"
APP="$ROOT/apps/desktop/dist/unsigned-development/mac/mac-arm64/WO.app"
ORIGIN="https://127.0.0.1:8443"

if [[ ! -x "$APP/Contents/MacOS/WO" ]]; then
  echo "Missing app: $APP" >&2
  echo "Build first: pnpm --filter @wo/desktop package:mac:unsigned-development" >&2
  exit 1
fi
if [[ ! -f "$CERT" || ! -f "$PROXY" ]]; then
  echo "Missing local HTTPS cert/proxy under deploy/.certs/local-dev" >&2
  exit 1
fi

if ! curl --noproxy '*' -sS --max-time 2 "http://127.0.0.1:3000/v1/health/ready" | grep -q ready; then
  echo "Backend is not ready on http://127.0.0.1:3000" >&2
  echo "Start it with: node --env-file=deploy/.env.local apps/server/dist/index.js" >&2
  exit 1
fi

if ! curl --noproxy '*' --cacert "$CERT" -sS --max-time 2 "$ORIGIN/v1/health/ready" | grep -q ready; then
  echo "Starting local HTTPS proxy on $ORIGIN ..."
  node "$PROXY" >>/tmp/wo-https-proxy.log 2>&1 &
  sleep 1
fi

# Replace any existing package instance
while read -r pid; do
  kill "$pid" 2>/dev/null || true
done < <(ps -axo pid=,command= | awk '/mac-arm64\/WO\.app\// {print $1}')
sleep 1

export WO_API_ORIGIN="$ORIGIN"
export WO_EXTRA_CA_CERTS="$CERT"
export NODE_EXTRA_CA_CERTS="$CERT"
export SSL_CERT_FILE="$CERT"
export NO_PROXY='*'
export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true

exec "$APP/Contents/MacOS/WO" --no-proxy-server
