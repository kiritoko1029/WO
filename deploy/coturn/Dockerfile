FROM coturn/coturn:4.14.0-r0-alpine@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4 AS probe-build

USER root
RUN apk add --no-cache build-base openssl-dev
COPY deploy/coturn/health-probe.c /tmp/health-probe.c
RUN cc -O2 -Wall -Wextra /tmp/health-probe.c -lcrypto -o /tmp/turn-healthcheck

FROM coturn/coturn:4.14.0-r0-alpine@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4

ARG BUILD_CREATED=unknown
ARG BUILD_REVISION=unknown
ARG BUILD_VERSION=dev

LABEL org.opencontainers.image.created="${BUILD_CREATED}" \
  org.opencontainers.image.revision="${BUILD_REVISION}" \
  org.opencontainers.image.source="https://github.com/kiritoko1029/WO" \
  org.opencontainers.image.version="${BUILD_VERSION}"

USER root
RUN apk add --no-cache setpriv libcap \
  && setcap -r /usr/bin/turnserver \
  && apk del libcap \
  && rm -f /var/log/apk.log

COPY --from=probe-build /tmp/turn-healthcheck /usr/local/bin/turn-healthcheck
COPY --chmod=0755 deploy/coturn/entrypoint.sh /opt/wo/turn-entrypoint.sh
COPY deploy/coturn/turnserver.conf /etc/coturn/turnserver.wo.conf

ENTRYPOINT ["/bin/sh", "/opt/wo/turn-entrypoint.sh"]
