FROM coturn/coturn:4.14.0-r0-alpine AS probe-build

USER root
RUN apk add --no-cache build-base openssl-dev
COPY deploy/coturn/health-probe.c /tmp/health-probe.c
RUN cc -O2 -Wall -Wextra /tmp/health-probe.c -lcrypto -o /tmp/turn-healthcheck

FROM coturn/coturn:4.14.0-r0-alpine

COPY --from=probe-build /tmp/turn-healthcheck /usr/local/bin/turn-healthcheck
