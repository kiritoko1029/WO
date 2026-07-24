FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS web-builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable \
  && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/media-policy/package.json packages/media-policy/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @wo/web...

COPY apps/web apps/web
COPY apps/desktop/src/preload apps/desktop/src/preload
COPY apps/desktop/src/renderer apps/desktop/src/renderer
COPY packages/media-policy packages/media-policy
COPY packages/protocol packages/protocol

RUN mkdir -p apps/desktop \
  && ln -s ../web/node_modules apps/desktop/node_modules \
  && pnpm --filter @wo/web build

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

COPY --from=web-builder /workspace/apps/web/dist /srv
