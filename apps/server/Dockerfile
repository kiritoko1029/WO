FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN sed -i \
      -e 's|^# http://snapshot.debian.org/|URIs: http://snapshot.debian.org/|' \
      -e '/^URIs: http:\/\/deb.debian.org\//d' \
      /etc/apt/sources.list.d/debian.sources \
  && corepack enable \
  && corepack prepare pnpm@10.32.1 --activate \
  && apt-get -o Acquire::Retries=3 -o Acquire::Check-Valid-Until=false update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends build-essential ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/media-policy/package.json packages/media-policy/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY apps/desktop/src/preload apps/desktop/src/preload
COPY apps/desktop/src/renderer apps/desktop/src/renderer
COPY packages/config packages/config
COPY packages/database packages/database
COPY packages/media-policy packages/media-policy
COPY packages/protocol packages/protocol

RUN pnpm --filter @wo/config build \
  && pnpm --filter @wo/database build \
  && pnpm --filter @wo/protocol build \
  && pnpm --filter @wo/server build \
  && mkdir -p apps/desktop \
  && ln -s ../web/node_modules apps/desktop/node_modules \
  && pnpm --filter @wo/web build \
  && pnpm --filter @wo/server --prod deploy /opt/wo-server --legacy \
  && find /opt/wo-server -type f \( \
    -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' \
  \) -delete \
  && rm -f /opt/wo-server/node_modules/.modules.yaml

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

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

ENV NODE_ENV=production
ENV DOWNLOADS_ROOT=/app/downloads
WORKDIR /app

RUN sed -i \
      -e 's|^# http://snapshot.debian.org/|URIs: http://snapshot.debian.org/|' \
      -e '/^URIs: http:\/\/deb.debian.org\//d' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 -o Acquire::Check-Valid-Until=false update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /var/log/apt/* \
  && rm -f /var/cache/ldconfig/aux-cache /var/log/alternatives.log /var/log/dpkg.log \
  && mkdir -p /app/downloads

COPY --from=workspace --chown=node:node /opt/wo-server/ ./
COPY --from=workspace --chown=node:node /workspace/apps/web/dist /app/web
COPY --chmod=0755 deploy/server/entrypoint.sh /usr/local/bin/wo-server-entrypoint

USER root
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/wo-server-entrypoint"]
