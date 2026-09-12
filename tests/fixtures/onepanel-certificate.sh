#!/bin/sh
set -eu
umask 077
mkdir -p /out/sites/test/ssl
if [ ! -f /out/ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -subj '/CN=WO 1Panel test CA' -keyout /out/ca.key -out /out/ca.pem >/dev/null 2>&1
fi
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -subj '/CN=wo.panel.test' -keyout /out/next.key -out /out/next.csr >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:wo.panel.test' 'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' > /out/leaf.ext
openssl x509 -req -in /out/next.csr -CA /out/ca.pem -CAkey /out/ca.key \
  -set_serial "0x$(openssl rand -hex 16)" -days 30 -extfile /out/leaf.ext -out /out/next.pem >/dev/null 2>&1
cat /out/next.pem /out/ca.pem > /out/sites/test/ssl/fullchain.pem.next
if [ "${1:-normal}" = combined ]; then cat /out/next.key >> /out/sites/test/ssl/fullchain.pem.next; fi
cp /out/next.key /out/sites/test/ssl/privkey.pem.next
if [ "${1:-normal}" = wrong-key ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /out/sites/test/ssl/privkey.pem.next >/dev/null 2>&1
fi
mv /out/sites/test/ssl/privkey.pem.next /out/sites/test/ssl/privkey.pem
mv /out/sites/test/ssl/fullchain.pem.next /out/sites/test/ssl/fullchain.pem
chmod 644 /out/ca.pem /out/sites/test/ssl/fullchain.pem
echo TEST_CERTIFICATE_READY
