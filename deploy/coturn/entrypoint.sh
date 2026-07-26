#!/bin/sh
set -eu

static_config=/etc/coturn/turnserver.wo.conf
runtime_config=/run/wo-turn/turnserver.conf
runtime_tls_cert=/run/wo-turn/turn_tls_cert.pem
runtime_tls_key=/run/wo-turn/turn_tls_key.pem
secret_file=/run/secrets/turn_shared_secret
tls_cert=/run/secrets/turn_tls_cert
tls_key=/run/secrets/turn_tls_key

valid_ipv4() {
  printf '%s\n' "$1" | awk -F. '
    NF != 4 { exit 1 }
    {
      for (octet_index = 1; octet_index <= 4; octet_index += 1) {
        if ($octet_index !~ /^[0-9]+$/ || $octet_index + 0 > 255) {
          exit 1
        }
      }
    }
  '
}

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'TURN entrypoint must start as root to read mounted secrets' >&2
  exit 1
fi

for required_file in "$static_config" "$secret_file" "$tls_cert" "$tls_key"; do
  if [ ! -r "$required_file" ]; then
    printf '%s\n' "Required TURN file is not readable: $required_file" >&2
    exit 1
  fi
done

turn_secret=$(cat "$secret_file")
if [ -z "$turn_secret" ]; then
  printf '%s\n' 'TURN shared secret is empty' >&2
  exit 1
fi

case "${TURN_REALM:-}" in
  ''|*[!A-Za-z0-9.-]* ) printf '%s\n' 'TURN_REALM is invalid' >&2; exit 1 ;;
esac
if ! valid_ipv4 "${TURN_EXTERNAL_IP:-}"; then
  printf '%s\n' 'TURN_EXTERNAL_IP must be an IPv4 address' >&2
  exit 1
fi
if [ -n "${TURN_INTERNAL_IP:-}" ]; then
  if ! valid_ipv4 "$TURN_INTERNAL_IP"; then
    printf '%s\n' 'TURN_INTERNAL_IP must be an IPv4 address' >&2
    exit 1
  fi
  if ! command -v ip >/dev/null 2>&1; then
    printf '%s\n' 'The ip command is required when TURN_INTERNAL_IP is set' >&2
    exit 1
  fi
  if ! ip -4 -o address show | awk -v expected="$TURN_INTERNAL_IP" '
    {
      split($4, address, "/")
      if (address[1] == expected) {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '; then
    printf '%s\n' 'TURN_INTERNAL_IP is not assigned to a local interface' >&2
    exit 1
  fi
fi
for numeric_value in "${TURN_LISTEN_PORT:-}" "${TURN_TLS_LISTEN_PORT:-}" "${TURN_RELAY_MIN_PORT:-}" "${TURN_RELAY_MAX_PORT:-}"; do
  case "$numeric_value" in
    ''|*[!0-9]* ) printf '%s\n' 'TURN port values must be numeric' >&2; exit 1 ;;
  esac
done

umask 077
cat "$static_config" > "$runtime_config"
cp "$tls_cert" "$runtime_tls_cert"
cp "$tls_key" "$runtime_tls_key"
printf '%s\n' \
  "static-auth-secret=$turn_secret" \
  "realm=$TURN_REALM" \
  "denied-peer-ip=$TURN_EXTERNAL_IP-$TURN_EXTERNAL_IP" \
  "listening-port=$TURN_LISTEN_PORT" \
  "tls-listening-port=$TURN_TLS_LISTEN_PORT" \
  "min-port=$TURN_RELAY_MIN_PORT" \
  "max-port=$TURN_RELAY_MAX_PORT" \
  "pidfile=/run/wo-turn/turnserver.pid" \
  "cert=$runtime_tls_cert" \
  "pkey=$runtime_tls_key" >> "$runtime_config"
if [ -n "${TURN_INTERNAL_IP:-}" ]; then
  printf '%s\n' \
    "listening-ip=$TURN_INTERNAL_IP" \
    "relay-ip=$TURN_INTERNAL_IP" \
    "external-ip=$TURN_EXTERNAL_IP/$TURN_INTERNAL_IP" >> "$runtime_config"
else
  printf '%s\n' "external-ip=$TURN_EXTERNAL_IP" >> "$runtime_config"
fi
chmod 600 "$runtime_config" "$runtime_tls_key"
chmod 400 "$runtime_tls_cert"
chown 65534:65533 \
  "$runtime_config" \
  "$runtime_tls_cert" \
  "$runtime_tls_key" \
  /run/wo-turn
unset turn_secret

exec /usr/local/bin/wo-drop-privileges \
  65534 \
  65533 \
  /usr/bin/turnserver -c /run/wo-turn/turnserver.conf
