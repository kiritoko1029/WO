#!/bin/sh
set -eu

mode=${WO_TLS_MODE:-acme}
domain=${APP_DOMAIN:-}
state=/acme.sh
certificates=/certs
status=/status
webroot=/var/www/acme
export AUTO_UPGRADE=0
umask 077

case "$mode" in acme|local|external) ;; *) printf '%s\n' 'Invalid certificate mode' >&2; exit 64 ;; esac
if ! printf '%s\n' "$domain" | LC_ALL=C grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || [ "${#domain}" -gt 253 ]; then
  printf '%s\n' 'Invalid certificate hostname' >&2
  exit 64
fi
if [ "$mode" = local ] && [ "$domain" != wo.localhost ]; then
  printf '%s\n' 'Local certificates require wo.localhost' >&2
  exit 64
fi

validate_certificate() {
  candidate=$1
  [ -s "$candidate/fullchain.pem" ] && [ -s "$candidate/key.pem" ] || return 1
  # A combined certificate/key export must never enter the public status volume.
  if grep -q 'PRIVATE KEY' "$candidate/fullchain.pem"; then return 1; fi
  openssl x509 -in "$candidate/fullchain.pem" -noout -checkend 0 >/dev/null 2>&1 || return 1
  openssl verify -CAfile "$candidate/fullchain.pem" -partial_chain -purpose sslserver \
    -verify_hostname "$domain" "$candidate/fullchain.pem" >/dev/null 2>&1 || return 1
  # Avoid a pipeline hiding an OpenSSL parse failure.
  certificate_public=$(openssl x509 -in "$candidate/fullchain.pem" -pubkey -noout 2>/dev/null) || return 1
  private_public=$(openssl pkey -in "$candidate/key.pem" -pubout 2>/dev/null) || return 1
  [ "$certificate_public" = "$private_public" ]
}

current_generation() {
  resolved=$(readlink -f "$certificates/current" 2>/dev/null) || return 1
  case "$resolved" in "$certificates"/generations/*) ;; *) return 1 ;; esac
  [ -d "$resolved" ] || return 1
  printf '%s\n' "$resolved"
}

write_status() {
  status_state=$1
  status_error=$2
  success=null
  if [ -s "$state/wo-last-success" ] && { [ "$mode" != external ] || [ -s "$state/wo-external-imported" ]; }; then
    success=$(jq -Rn --arg value "$(cat "$state/wo-last-success")" '$value')
  fi
  jq -n --arg mode "$mode" --arg state "$status_state" \
    --arg attempt "$(cat "$state/wo-last-attempt")" --argjson success "$success" \
    --argjson error "$status_error" \
    '{version: 1, mode: $mode, state: $state, lastAttemptAt: $attempt, lastSuccessAt: $success, errorCode: $error}' \
    > "$status/.status.json.tmp"
  chmod 644 "$status/.status.json.tmp"
  mv -f "$status/.status.json.tmp" "$status/status.json"
}

publish_certificate() {
  candidate=$1
  validate_certificate "$candidate" || return 1
  fingerprint=$(openssl x509 -in "$candidate/fullchain.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')
  case "$fingerprint" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#fingerprint}" -eq 64 ] || return 1
  destination="$certificates/generations/$fingerprint"
  if [ ! -d "$destination" ]; then
    staging=$(mktemp -d "$certificates/generations/.pending.XXXXXXXX") || return 1
    cp "$candidate/fullchain.pem" "$staging/fullchain.pem" || return 1
    cp "$candidate/key.pem" "$staging/key.pem" || return 1
    chown 65534:65533 "$staging/key.pem" || return 1
    chmod 400 "$staging/key.pem" || return 1
    chmod 444 "$staging/fullchain.pem" || return 1
    chmod 755 "$staging" || return 1
    mv "$staging" "$destination" || return 1
  fi
  validate_certificate "$destination" || return 1
  previous=$(current_generation || true)
  # Rename a symlink rather than replacing files that TLS readers may have open.
  ln -s "generations/$fingerprint" "$certificates/.current.tmp" || return 1
  mv -Tf "$certificates/.current.tmp" "$certificates/current" || return 1
  cp "$destination/fullchain.pem" "$status/.certificate.pem.tmp" || return 1
  chmod 644 "$status/.certificate.pem.tmp" || return 1
  mv -f "$status/.certificate.pem.tmp" "$status/certificate.pem" || return 1
  if [ "$previous" != "$destination" ] || [ ! -s "$state/wo-last-success" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$state/wo-last-success" || return 1
  fi
}

acme_certificate() {
  case "${ACME_EMAIL:-}" in ''|*[!A-Za-z0-9@._+-]*|*@*@*) return 1 ;; esac
  case "$ACME_EMAIL" in ?*@?*.?*) ;; *) return 1 ;; esac
  acme_server=${WO_ACME_SERVER:-letsencrypt}
  case "$acme_server" in letsencrypt|letsencrypt_test|https://*) ;; *) return 1 ;; esac
  set -- --home /acmebin --config-home "$state" --cert-home "$state/domains" \
    --server "$acme_server" --no-color
  if [ -n "${WO_ACME_CA_BUNDLE:-}" ]; then
    [ -r "$WO_ACME_CA_BUNDLE" ] || return 1
    set -- "$@" --ca-bundle "$WO_ACME_CA_BUNDLE"
  fi
  if [ "$force" = 1 ]; then
    set -- "$@" --force
  fi
  issue_result=0
  if [ -s "$state/domains/${domain}_ecc/${domain}.conf" ]; then
    # The native renewal path honors ACME Renewal Information (ARI), including
    # a CA moving the renewal window forward after initial issuance.
    timeout 900 acme.sh --renew "$@" --ecc -d "$domain" \
      > "$state/wo-last-acme.log" 2>&1 || issue_result=$?
  else
    timeout 900 acme.sh --issue "$@" --accountemail "$ACME_EMAIL" -d "$domain" \
      --webroot "$webroot" --keylength ec-256 \
      > "$state/wo-last-acme.log" 2>&1 || issue_result=$?
  fi
  # acme.sh returns 2 when the existing certificate is not due for renewal.
  [ "$issue_result" -eq 0 ] || [ "$issue_result" -eq 2 ] || return 1
  timeout 60 acme.sh --install-cert "$@" --ecc -d "$domain" \
    --fullchain-file "$state/export/fullchain.pem" --key-file "$state/export/key.pem" \
    >> "$state/wo-last-acme.log" 2>&1 || return 1
  publish_certificate "$state/export"
}

local_certificate() {
  current=$(current_generation || true)
  if [ "$force" = 0 ] && [ -n "$current" ] && validate_certificate "$current" \
    && openssl x509 -in "$current/fullchain.pem" -noout -checkend 604800 >/dev/null 2>&1; then
    publish_certificate "$current"
    return
  fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -subj "/CN=$domain" -addext "subjectAltName=DNS:$domain,DNS:localhost,IP:127.0.0.1" \
    -addext 'basicConstraints=critical,CA:FALSE' -addext 'extendedKeyUsage=serverAuth' \
    -keyout "$state/export/key.pem" -out "$state/export/fullchain.pem" \
    > "$state/wo-last-local.log" 2>&1 || return 1
  publish_certificate "$state/export"
}

external_certificate() {
  certificate_name=${WO_EXTERNAL_CERT_FILE:-fullchain.pem}
  private_name=${WO_EXTERNAL_KEY_FILE:-privkey.pem}
  for filename in "$certificate_name" "$private_name"; do
    case "$filename" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) return 1 ;; esac
    source_file="/external-certs/$filename"
    [ -f "$source_file" ] && [ -r "$source_file" ] || return 1
    [ "$(wc -c < "$source_file")" -le 65536 ] || return 1
  done
  rm -f "$state/export/fullchain.pem" "$state/export/key.pem"
  cp "/external-certs/$certificate_name" "$state/export/fullchain.pem" || return 1
  cp "/external-certs/$private_name" "$state/export/key.pem" || return 1
  # One complete, validated generation is published even if 1Panel replaces
  # the source pair non-atomically. A mismatched pair never reaches consumers.
  publish_certificate "$state/export" || return 1
  imported=$(current_generation) || return 1
  if [ ! -s "$state/wo-external-imported" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$state/wo-last-success"
  fi
  printf '%s\n' "${imported##*/}" > "$state/wo-external-imported"
}

attempt_certificate() (
  # Kernel locks disappear on crashes, so restarting cannot inherit a stale lock.
  flock -n 9 || { printf '%s\n' 'Certificate operation already in progress; retry shortly' >&2; exit 75; }
  date -u +%Y-%m-%dT%H:%M:%SZ > "$state/wo-last-attempt"
  rm -f "$certificates/.current.tmp"
  write_status starting null
  if [ "$mode" = local ]; then
    result=0
    local_certificate || result=$?
  elif [ "$mode" = external ]; then
    result=0
    external_certificate || result=$?
  else
    result=0
    acme_certificate || result=$?
  fi
  if [ "$result" -eq 0 ]; then
    write_status ready null
    printf '%s\n' 'Certificate ready'
  else
    error='"ISSUANCE_FAILED"'
    if [ -s "$state/wo-last-success" ]; then error='"RENEWAL_FAILED"'; fi
    if [ "$mode" = external ]; then error='"IMPORT_FAILED"'; fi
    write_status error "$error"
    if [ "$mode" = external ]; then
      printf '%s\n' 'Certificate import failed; check the 1Panel website certificate, key and host directory' >&2
    else
      printf '%s\n' 'Certificate operation failed; check DNS, ports and ACME connectivity' >&2
    fi
    exit 1
  fi
) 9>"$state/wo-certificate.lock"

case "${1:-daemon}" in
  --check)
    current=$(current_generation) || exit 1
    validate_certificate "$current" || exit 1
    if [ "$mode" = external ]; then
      [ -s "$state/wo-external-imported" ] && [ "$(cat "$state/wo-external-imported")" = "${current##*/}" ] || exit 1
    fi
    exit 0
    ;;
  --sync-now) [ "$mode" = external ] || exit 64 ;;
  --renew-now) [ "$mode" != external ] || { echo 'Renew in 1Panel, then use --sync-now' >&2; exit 64; } ;;
  daemon) ;;
  *) printf '%s\n' 'Usage: certificates.sh [daemon|--renew-now|--sync-now|--check]' >&2; exit 64 ;;
esac

mkdir -p "$state/export" "$certificates/generations" "$status" "$webroot/.well-known/acme-challenge"
chmod 700 "$state" "$state/export"
chmod 755 "$certificates" "$certificates/generations" "$status" "$webroot" "$webroot/.well-known" "$webroot/.well-known/acme-challenge"
force=0
if [ "${1:-daemon}" = --renew-now ] || [ "${1:-daemon}" = --sync-now ]; then
  force=1
  attempt_certificate
  exit $?
fi

child=
stop() {
  trap - TERM INT
  if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  exit 0
}
trap stop TERM INT
while :; do
  attempt_certificate &
  child=$!
  interval=43200
  wait "$child" || interval=300
  if [ "$mode" = external ]; then interval=30; fi
  sleep "$interval" &
  child=$!
  wait "$child" || true
done
