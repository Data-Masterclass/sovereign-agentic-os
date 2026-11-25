# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# langfuse-oss — the OS's Langfuse web and worker images, built from source WITHOUT any code under the
# Langfuse Enterprise License.
#
# WHY. Langfuse's root LICENSE puts ee/, web/src/ee/ and worker/src/ee/ under the Langfuse Enterprise
# License; the rest is MIT. The upstream images (langfuse/langfuse, langfuse/langfuse-worker) contain that
# EE code compiled, and there is no upstream OSS-only build. Owner decision 2026-11-24 ("B"): our own build
# without the enterprise folders. Where MIT code imports an EE module, an ORIGINAL stub of the same name
# (overlay/) says the feature is unavailable; nothing is copied from, adapted from or written after the EE
# code (docs/components/langfuse-oss.md "Stubs").
#
# PINNED INPUTS
#   - Langfuse source: git commit LANGFUSE_COMMIT (the v3.194.1 tag), checked after fetch.
#   - Base images by digest (node:24-alpine, golang:1.26 for the ClickHouse migrate CLI).
#   - turbo + pnpm (build) and the Prisma CLI (runtime migrations) with `npm ci` from committed lockfiles.
#   - Langfuse's own dependencies: `pnpm install --frozen-lockfile` against upstream's pnpm-lock.yaml
#     (minus the @langfuse/ee workspace entry, prepare-source.mjs).
#   - golang-migrate v4.19.1 built from source; Go's checksum database verifies the module.
#
# WHAT MATCHES UPSTREAM (the chart relies on each): ports 3000 / 3030, the dumb-init entrypoints
# ./web/entrypoint.sh (Postgres + ClickHouse migrations, then the server) and ./worker/entrypoint.sh, the
# same packages/shared/prisma and packages/shared/clickhouse migration files, UID/GID 1001, the same
# runtime layout under /app.
#
# DIFFERENCES: no EE code; NEXT_PUBLIC_BASE_PATH=/tools/langfuse is baked into the web build (the OS
# serves the console through os-ui's same-origin proxy there); no dd-trace / Sentry / PostHog / cloud
# build arguments; the worker's EE queue consumers default to off.
#
# Build:  docker build --target web    -t langfuse-oss-web    images/extensions/langfuse-oss
#         docker build --target worker -t langfuse-oss-worker images/extensions/langfuse-oss
# Gate:   node scripts/license-gate-image.mjs --image langfuse-oss-web --scope langfuse-oss --rootfs ...
ARG NODE_BASE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG GO_BASE=golang:1.26@sha256:6e59e17a20f13c102e49d82dffab66d41cffe6c266b225d82794328aea859ab5

# ------------------------------------------------------------------------------------------------
# source: the pinned Langfuse commit, with every EE directory removed and the stubs in place.
FROM ${NODE_BASE} AS source
ARG LANGFUSE_VERSION=3.194.1
ARG LANGFUSE_COMMIT=a75766c15365b668c8517cbfea2e6347d465ce8d
RUN apk add --no-cache git
WORKDIR /src
RUN set -eux; \
    git init -q .; \
    git fetch -q --depth 1 https://github.com/langfuse/langfuse.git "$LANGFUSE_COMMIT"; \
    git checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$LANGFUSE_COMMIT"; \
    grep -q "\"version\": \"$LANGFUSE_VERSION\"" web/package.json; \
    rm -rf .git
COPY prepare-source.mjs /opt/langfuse-oss/prepare-source.mjs
COPY overlay/ /opt/langfuse-oss/overlay/
RUN node /opt/langfuse-oss/prepare-source.mjs /src /opt/langfuse-oss/overlay /opt/langfuse-oss/ee-fingerprints.txt

# The EE fingerprints alone, for the image licence gate (scripts/license-gate-image.mjs --ee-fingerprints):
#   docker build --target ee-fingerprints --output type=local,dest=<dir> images/extensions/langfuse-oss
# Never part of an image.
FROM scratch AS ee-fingerprints
COPY --from=source /opt/langfuse-oss/ee-fingerprints.txt /ee-fingerprints.txt

# ------------------------------------------------------------------------------------------------
FROM ${NODE_BASE} AS build-base
# GNU grep for verify-build.sh: busybox grep with hundreds of -F patterns is far too slow.
RUN apk add --no-cache grep
COPY build-tools/package.json build-tools/package-lock.json /opt/build-tools/
RUN cd /opt/build-tools && npm ci --no-audit --no-fund
ENV PATH=/opt/build-tools/node_modules/.bin:$PATH \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NEXT_TELEMETRY_DISABLED=1

FROM build-base AS pruned-web
WORKDIR /app
COPY --from=source /src/ .
RUN turbo prune --scope=web --docker

FROM build-base AS pruned-worker
WORKDIR /app
COPY --from=source /src/ .
RUN turbo prune --scope=worker --docker

# ------------------------------------------------------------------------------------------------
FROM ${GO_BASE} AS migrate-builder
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOBIN=/out GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOFLAGS=-mod=mod GOSUMDB=sum.golang.org
# Only the ClickHouse driver, as upstream does (prebuilt releases bundle every driver).
RUN go install -trimpath -tags 'clickhouse' -ldflags='-s -w' github.com/golang-migrate/migrate/v4/cmd/migrate@v4.19.1

# ------------------------------------------------------------------------------------------------
FROM build-base AS web-builder
WORKDIR /app
COPY --from=pruned-web /app/out/pnpm-lock.yaml /app/out/pnpm-workspace.yaml ./
COPY --from=pruned-web /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruned-web /app/out/full/ .
# Upstream removes the cloud-only middleware for self-hosted builds; so do we.
RUN rm -f ./web/src/middleware.ts
ENV DOCKER_BUILD=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    CI=true \
    NEXT_PUBLIC_BASE_PATH=/tools/langfuse
RUN NODE_OPTIONS='--max-old-space-size-percentage=75' turbo run build --filter=web...
COPY --from=source /opt/langfuse-oss/ee-fingerprints.txt /tmp/ee-fingerprints.txt
COPY verify-build.sh /tmp/verify-build.sh
# sharp's prebuilt libvips (@img/sharp-libvips-*, LGPL-3.0-or-later) and its native binding are left out:
# nothing in Langfuse calls sharp, and next.config sets images.unoptimized (prepare-source.mjs).
RUN find /app/web/.next/standalone -type d -path '*/@img/sharp-*' -prune -exec rm -rf {} +
RUN sh /tmp/verify-build.sh web /tmp/ee-fingerprints.txt /app/web/.next/static /app/web/.next/standalone

FROM build-base AS worker-builder
WORKDIR /app
COPY --from=pruned-worker /app/out/pnpm-lock.yaml /app/out/pnpm-workspace.yaml ./
COPY --from=pruned-worker /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruned-worker /app/out/full/ .
RUN turbo run build --filter=worker...
# Production payload only (as upstream): the deployed worker plus the generated Prisma client.
RUN set -eux; \
    pnpm --filter worker deploy --legacy --prod /prod/worker; \
    b="$(find /app/node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d | head -n 1)"; \
    d="$(find /prod/worker/node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d | head -n 1)"; \
    rm -rf "$d" "$(dirname "$(dirname "$d")")/.prisma"; \
    cp -R "$b" "$d"; cp -R "$(dirname "$(dirname "$b")")/.prisma" "$(dirname "$(dirname "$d")")/.prisma"
COPY --from=source /opt/langfuse-oss/ee-fingerprints.txt /tmp/ee-fingerprints.txt
COPY verify-build.sh /tmp/verify-build.sh
# sharp's prebuilt libvips (@img/sharp-libvips-*, LGPL-3.0-or-later) and its native binding are left out:
# nothing in Langfuse calls sharp, and next.config sets images.unoptimized (prepare-source.mjs).
RUN find /prod/worker -type d -path '*/@img/sharp-*' -prune -exec rm -rf {} +
RUN sh /tmp/verify-build.sh worker /tmp/ee-fingerprints.txt /prod/worker

# ------------------------------------------------------------------------------------------------
FROM ${NODE_BASE} AS runtime-base
# Package managers are build-only. dumb-init is the entrypoint upstream documents; tzdata as upstream (web).
RUN set -eux; \
    apk add --no-cache dumb-init tzdata; \
    rm -rf /usr/local/lib/node_modules/corepack /root/.cache/node/corepack; \
    rm -f /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG UID=1001
ARG GID=1001
WORKDIR /app
COPY LICENSE-NOTICE.md /usr/share/licenses/langfuse-oss/LICENSE-NOTICE.md

# ------------------------------------------------------------------------------------------------
FROM runtime-base AS web
ARG UID
ARG GID
# The Prisma CLI for web/entrypoint.sh's `prisma migrate deploy` (upstream: `npm install -g prisma@6.19.3`).
COPY prisma-cli/package.json prisma-cli/package-lock.json /opt/prisma-cli/
RUN set -eux; \
    cd /opt/prisma-cli && npm ci --no-audit --no-fund; \
    ln -s /opt/prisma-cli/node_modules/.bin/prisma /usr/local/bin/prisma; \
    prisma --version; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm; \
    addgroup --system --gid ${GID} nodejs; adduser --system --uid ${UID} nextjs
COPY --from=migrate-builder /out/migrate /usr/bin/migrate
COPY --from=web-builder --chown=nextjs:nodejs /app/web/next.config.mjs /app/web/package.json ./
COPY --from=web-builder --chown=nextjs:nodejs /app/web/.next/standalone ./
COPY --from=web-builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=web-builder --chown=nextjs:nodejs /app/web/public ./web/public
COPY --from=web-builder --chown=nextjs:nodejs /app/packages/shared/prisma ./packages/shared/prisma
COPY --from=web-builder --chown=nextjs:nodejs /app/packages/shared/clickhouse ./packages/shared/clickhouse
COPY --from=web-builder --chown=nextjs:nodejs /app/web/entrypoint.sh ./web/entrypoint.sh
COPY --from=web-builder --chown=nextjs:nodejs /app/packages/shared/scripts/cleanup.sql ./packages/shared/scripts/cleanup.sql
COPY --from=source /src/LICENSE /usr/share/licenses/langfuse-oss/LANGFUSE-LICENSE
RUN chmod +x ./web/entrypoint.sh
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DOCKER_BUILD=0 \
    NEXT_MANUAL_SIG_HANDLE=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0
LABEL org.opencontainers.image.title="langfuse-oss-web" \
      org.opencontainers.image.description="Langfuse 3.194.1 web (MIT core) without the Langfuse Enterprise Edition; base path /tools/langfuse" \
      org.opencontainers.image.source="https://github.com/Data-Masterclass/sovereign-agentic-os" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0" \
      org.sovereign-os.langfuse-version="3.194.1" \
      org.sovereign-os.langfuse-commit="a75766c15365b668c8517cbfea2e6347d465ce8d" \
      org.sovereign-os.langfuse-ee="absent" \
      org.sovereign-os.langfuse-base-path="/tools/langfuse"
USER ${UID}:${GID}
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--", "./web/entrypoint.sh"]
CMD ["node", "./web/server.js", "--keepAliveTimeout", "110000"]

# ------------------------------------------------------------------------------------------------
FROM runtime-base AS worker
ARG UID
ARG GID
RUN set -eux; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx; \
    addgroup --system --gid ${GID} expressjs; adduser --system --uid ${UID} expressjs
COPY --from=worker-builder --chown=expressjs:expressjs /prod/worker ./worker
COPY --from=source /src/LICENSE /usr/share/licenses/langfuse-oss/LANGFUSE-LICENSE
RUN chmod +x ./worker/entrypoint.sh
# The queue consumers whose upstream handlers are EE default to off here (the stubs fail if switched on).
ENV NODE_ENV=production \
    DOCKER_BUILD=0 \
    PORT=3030 \
    QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED=false \
    QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED=false \
    QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED=false \
    QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED=false \
    LANGFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED=false
LABEL org.opencontainers.image.title="langfuse-oss-worker" \
      org.opencontainers.image.description="Langfuse 3.194.1 worker (MIT core) without the Langfuse Enterprise Edition" \
      org.opencontainers.image.source="https://github.com/Data-Masterclass/sovereign-agentic-os" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0" \
      org.sovereign-os.langfuse-version="3.194.1" \
      org.sovereign-os.langfuse-commit="a75766c15365b668c8517cbfea2e6347d465ce8d" \
      org.sovereign-os.langfuse-ee="absent"
USER ${UID}:${GID}
EXPOSE 3030
ENTRYPOINT ["dumb-init", "--", "./worker/entrypoint.sh"]
CMD ["node", "worker/dist/index.js"]
