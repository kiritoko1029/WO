#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Server entrypoint must start as root to read mounted secrets' >&2
  exit 1
fi

read_secret() {
  secret_file=$1
  if [ ! -r "$secret_file" ]; then
    printf '%s\n' "Required secret file is not readable: $secret_file" >&2
    exit 1
  fi
  secret_value=$(cat "$secret_file")
  if [ -z "$secret_value" ]; then
    printf '%s\n' "Required secret file is empty: $secret_file" >&2
    exit 1
  fi
  printf '%s' "$secret_value"
}

JWT_ACCESS_SECRET=$(read_secret /run/secrets/jwt_access_secret)
TURN_SHARED_SECRET=$(read_secret /run/secrets/turn_shared_secret)
postgres_password=$(read_secret /run/secrets/postgres_password)

case "${POSTGRES_DB:-}" in
  ''|*[!A-Za-z0-9_]* ) printf '%s\n' 'POSTGRES_DB is invalid' >&2; exit 1 ;;
esac
case "${POSTGRES_USER:-}" in
  ''|*[!A-Za-z0-9_]* ) printf '%s\n' 'POSTGRES_USER is invalid' >&2; exit 1 ;;
esac
case "$postgres_password" in
  *[!A-Za-z0-9_-]* ) printf '%s\n' 'PostgreSQL password must be base64url' >&2; exit 1 ;;
esac

DATABASE_URL="postgresql://${POSTGRES_USER}:${postgres_password}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
export DATABASE_URL JWT_ACCESS_SECRET TURN_SHARED_SECRET
unset postgres_password

exec /usr/bin/setpriv \
  --reuid=1000 \
  --regid=1000 \
  --clear-groups \
  --no-new-privs \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  /usr/local/bin/node /app/dist/index.js
