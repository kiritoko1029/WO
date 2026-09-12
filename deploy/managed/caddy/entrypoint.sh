#!/bin/sh
set -eu

ready=/tmp/wo-caddy-ready
rm -f "$ready"
caddy run --config /opt/wo/Caddyfile.bootstrap --adapter caddyfile &
server_pid=$!
watcher_pid=

stop() {
  trap - TERM INT
  if [ -n "$watcher_pid" ]; then kill "$watcher_pid" 2>/dev/null || true; fi
  kill -TERM "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f "$ready"
  exit 0
}
trap stop TERM INT

watch_certificates() {
  previous=
  while kill -0 "$server_pid" 2>/dev/null; do
    current=$(readlink -f /certs/current 2>/dev/null || true)
    case "$current" in
      /certs/generations/*)
        if [ "$current" != "$previous" ] && [ -r "$current/fullchain.pem" ] && [ -r "$current/key.pem" ]; then
          if WO_CERTIFICATE_DIRECTORY="$current" caddy reload --config /opt/wo/Caddyfile.managed --adapter caddyfile --force; then
            previous=$current
            printf '%s\n' "$current" > "$ready"
          else
            printf '%s\n' 'HTTPS certificate activation failed; retrying with the previous configuration retained' >&2
          fi
        fi
        ;;
    esac
    sleep 5
  done
}

watch_certificates &
watcher_pid=$!
while kill -0 "$server_pid" 2>/dev/null && kill -0 "$watcher_pid" 2>/dev/null; do
  sleep 2 &
  wait $! || true
done
if kill -0 "$server_pid" 2>/dev/null; then
  printf '%s\n' 'HTTPS certificate watcher exited; restarting the service' >&2
  kill -TERM "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f "$ready"
  exit 1
fi
result=0
wait "$server_pid" || result=$?
kill "$watcher_pid" 2>/dev/null || true
wait "$watcher_pid" 2>/dev/null || true
rm -f "$ready"
exit "$result"
