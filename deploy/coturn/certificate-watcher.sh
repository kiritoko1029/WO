#!/bin/sh
set -eu

certificates=${WO_TURN_MANAGED_CERTS:-/certs}
runtime=/run/wo-turn

copy_generation() {
  generation=$(readlink -f "$certificates/current" 2>/dev/null) || return 1
  case "$generation" in "$certificates"/generations/*) ;; *) return 1 ;; esac
  [ -r "$generation/fullchain.pem" ] && [ -r "$generation/key.pem" ] || return 1
  # Resolve once and stage both files before replacing either active file.
  # The source generation is immutable for this entire operation.
  umask 077
  cp "$generation/fullchain.pem" "$runtime/.certificate.tmp" || return 1
  cp "$generation/key.pem" "$runtime/.key.tmp" || return 1
  chmod 600 "$runtime/.certificate.tmp" "$runtime/.key.tmp" || return 1
  mv -f "$runtime/.certificate.tmp" "$runtime/turn_tls_cert.pem" || return 1
  mv -f "$runtime/.key.tmp" "$runtime/turn_tls_key.pem" || return 1
  printf '%s\n' "$generation" > "$runtime/certificate-generation" || return 1
}

if [ "$(id -u)" -ne 65534 ] || [ "$(id -g)" -ne 65533 ]; then
  printf '%s\n' 'TURN certificate reader must run with the TURN service identity' >&2
  exit 1
fi

if [ "${1:-}" = --initialize ]; then
  copy_generation
  exit $?
fi

# The parent is about to exec turnserver as PID 1. Never signal its setup shell.
while [ "$(cat /proc/1/comm)" != turnserver ]; do sleep 1; done
while :; do
  sleep 5
  current=$(readlink -f "$certificates/current" 2>/dev/null || true)
  previous=$(cat "$runtime/certificate-generation")
  if [ -n "$current" ] && [ "$current" != "$previous" ]; then
    if copy_generation; then
      # coturn handles SIGUSR2 by rebuilding its TLS contexts without dropping allocations.
      kill -USR2 1
      printf '%s\n' 'TURN certificate refreshed'
    else
      printf '%s\n' 'TURN certificate refresh failed; retaining the last available certificate' >&2
    fi
  fi
done
