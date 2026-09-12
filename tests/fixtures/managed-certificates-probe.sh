#!/bin/sh
set -eu

runner=/opt/wo/certificates.sh
export APP_DOMAIN=wo.localhost WO_TLS_MODE=local
if WO_TLS_MODE=acme ACME_EMAIL=invalid sh "$runner" --renew-now >/tmp/first-failure.log 2>&1; then exit 1; fi
jq -e '.state == "error" and .errorCode == "ISSUANCE_FAILED" and .lastSuccessAt == null' /status/status.json >/dev/null
test ! -e /certs/current
printf '%s\n' 'INITIAL_FAILURE_STATUS_OK'
sh "$runner" --renew-now
sh "$runner" --check
openssl verify -CAfile /status/certificate.pem -partial_chain -verify_hostname wo.localhost \
  /certs/current/fullchain.pem >/dev/null
test "$(stat -c '%u:%g %a' /certs/current/key.pem)" = '65534:65533 400'
test "$(find /status -type f | wc -l)" -eq 2
! grep -q 'PRIVATE KEY' /status/*
jq -e '.version == 1 and .mode == "local" and .state == "ready" and .errorCode == null' /status/status.json >/dev/null
printf '%s\n' 'ISSUANCE_PERMISSIONS_OK'

first=$(readlink /certs/current)
sh "$runner" --renew-now
second=$(readlink /certs/current)
test "$first" != "$second"
test -r "/certs/$first/fullchain.pem"
printf '%s\n' 'ROTATION_PRESERVES_GENERATIONS_OK'

# A normal restart checks the certificate without forcing a new issuance.
sh "$runner" daemon > /tmp/daemon.log 2>&1 &
daemon=$!
attempts=0
while ! grep -q 'Certificate ready' /tmp/daemon.log; do
  sleep 1
  attempts=$((attempts + 1))
  test "$attempts" -lt 10
done
kill -TERM "$daemon"
wait "$daemon"
test "$second" = "$(readlink /certs/current)"
printf '%s\n' 'IDEMPOTENT_RESTART_OK'

# Holding the real kernel lock prevents a second writer from publishing.
flock /acme.sh/wo-certificate.lock sh -c 'touch /tmp/lock-ready; while [ ! -e /tmp/lock-release ]; do sleep 1; done' &
locker=$!
while [ ! -e /tmp/lock-ready ]; do sleep 1; done
result=0
sh "$runner" --renew-now >/tmp/locked.log 2>&1 || result=$?
test "$result" -eq 75
test "$second" = "$(readlink /certs/current)"
touch /tmp/lock-release
wait "$locker"
printf '%s\n' 'CONCURRENT_WRITER_REJECTED_OK'

# A faulty CA export must never replace a working generation. The test CA
# client succeeds, but delivers either an unrelated key or the wrong hostname.
mkdir -p /tmp/test-bin /tmp/candidate
cp /certs/current/fullchain.pem /tmp/candidate/fullchain.pem
cp /certs/current/key.pem /tmp/candidate/key.pem
cat > /tmp/test-bin/acme.sh <<'EOF'
#!/bin/sh
if [ "$1" = --install-cert ]; then
  cp /tmp/candidate/fullchain.pem /acme.sh/export/fullchain.pem
  cp /tmp/candidate/key.pem /acme.sh/export/key.pem
fi
exit 0
EOF
chmod 755 /tmp/test-bin/acme.sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /tmp/candidate/key.pem >/dev/null 2>&1
export PATH="/tmp/test-bin:$PATH" WO_TLS_MODE=acme ACME_EMAIL=admin@example.com
if sh "$runner" --renew-now; then exit 1; fi
test "$second" = "$(readlink /certs/current)"
sh "$runner" --check
jq -e '.state == "error" and .errorCode == "RENEWAL_FAILED" and .lastSuccessAt != null' /status/status.json >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -subj /CN=wrong.example -addext subjectAltName=DNS:wrong.example \
  -keyout /tmp/candidate/key.pem -out /tmp/candidate/fullchain.pem >/dev/null 2>&1
if sh "$runner" --renew-now; then exit 1; fi
test "$second" = "$(readlink /certs/current)"
cmp /status/certificate.pem /certs/current/fullchain.pem
printf '%s\n' 'INVALID_EXPORT_PRESERVES_CERTIFICATE_OK'
