FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS probe-build

RUN sed -i \
      -e 's|^# http://snapshot.debian.org/|URIs: http://snapshot.debian.org/|' \
      -e '/^URIs: http:\/\/deb.debian.org\//d' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 -o Acquire::Check-Valid-Until=false update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends build-essential libssl-dev \
  && rm -rf /var/lib/apt/lists/*
COPY deploy/coturn/health-probe.c /tmp/health-probe.c
COPY deploy/coturn/drop-privileges.c /tmp/drop-privileges.c
RUN cc -O2 -Wall -Wextra -static /tmp/health-probe.c \
  -lcrypto -pthread -ldl -o /tmp/turn-healthcheck \
  && cc -O2 -Wall -Wextra -static /tmp/drop-privileges.c \
  -o /tmp/wo-drop-privileges

FROM coturn/coturn:4.14.0-r0-alpine@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4

USER root

ARG BUILD_CREATED
ARG BUILD_REVISION
ARG BUILD_VERSION
ARG SOURCE_DATE_EPOCH

COPY --chmod=0755 deploy/scripts/validate-build-metadata.sh /tmp/validate-build-metadata
RUN /tmp/validate-build-metadata \
  "${BUILD_CREATED}" \
  "${BUILD_REVISION}" \
  "${BUILD_VERSION}" \
  "${SOURCE_DATE_EPOCH}" \
  && rm -f /tmp/validate-build-metadata

LABEL org.opencontainers.image.created="${BUILD_CREATED}" \
  org.opencontainers.image.revision="${BUILD_REVISION}" \
  org.opencontainers.image.source="https://github.com/kiritoko1029/WO" \
  org.opencontainers.image.version="${BUILD_VERSION}"

RUN cp -p /usr/bin/turnserver /tmp/turnserver \
  && rm -f /usr/bin/turnserver \
  && mv /tmp/turnserver /usr/bin/turnserver \
  && command -v ip >/dev/null \
  && ip -4 -o address show >/dev/null \
  && rm -f /var/log/apk.log

COPY --from=probe-build /tmp/turn-healthcheck /usr/local/bin/turn-healthcheck
COPY --from=probe-build /tmp/wo-drop-privileges /usr/local/bin/wo-drop-privileges
COPY --chmod=0755 deploy/coturn/entrypoint.sh /opt/wo/turn-entrypoint.sh
COPY deploy/coturn/turnserver.conf /etc/coturn/turnserver.wo.conf

ENTRYPOINT ["/bin/sh", "/opt/wo/turn-entrypoint.sh"]
