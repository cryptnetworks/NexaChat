# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NEXA_IMAGE_SOURCE=https://github.com/cryptnetworks/NexaChat
ARG NEXA_IMAGE_REVISION=unknown
ARG NEXA_IMAGE_VERSION=0.1.0

FROM postgres:17.10-alpine3.23@sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4 AS postgres-runtime
ARG NEXA_IMAGE_SOURCE
ARG NEXA_IMAGE_REVISION
ARG NEXA_IMAGE_VERSION
LABEL org.opencontainers.image.title="NexaChat PostgreSQL" \
  org.opencontainers.image.source="${NEXA_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${NEXA_IMAGE_REVISION}" \
  org.opencontainers.image.version="${NEXA_IMAGE_VERSION}" \
  org.opencontainers.image.licenses="PostgreSQL"
RUN apk add --no-cache --upgrade \
  libcrypto3=3.5.7-r0 \
  libssl3=3.5.7-r0 \
  libxml2=2.13.9-r1 \
  xz-libs=5.8.3-r0 \
  && rm -f /usr/local/bin/gosu
COPY deploy/postgres/nexa-bootstrap-roles /usr/local/bin/nexa-bootstrap-roles
RUN chmod 0555 /usr/local/bin/nexa-bootstrap-roles
USER 70:70

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS build-dependencies
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/coordination/package.json packages/coordination/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/object-storage/package.json packages/object-storage/package.json
COPY packages/postgres/package.json packages/postgres/package.json
COPY packages/realtime-contracts/package.json packages/realtime-contracts/package.json
RUN npm ci --ignore-scripts

FROM build-dependencies AS production-build
COPY . .
RUN npm run build:production

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS server-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY apps/server/runtime/package.json apps/server/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS server-runtime
ARG NEXA_IMAGE_SOURCE
ARG NEXA_IMAGE_REVISION
ARG NEXA_IMAGE_VERSION
LABEL org.opencontainers.image.title="NexaChat server" \
  org.opencontainers.image.source="${NEXA_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${NEXA_IMAGE_REVISION}" \
  org.opencontainers.image.version="${NEXA_IMAGE_VERSION}" \
  org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production \
  NEXA_MIGRATIONS_DIR=/app/server/migrations
WORKDIR /app/server

COPY --from=server-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=production-build --chown=node:node /workspace/apps/server/dist-production/ ./
COPY --chown=node:node apps/server/migrations/ ./migrations/
RUN rm -rf /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  /opt/yarn-v1.22.22

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "main.mjs"]

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS backup-runtime
ARG NEXA_IMAGE_SOURCE
ARG NEXA_IMAGE_REVISION
ARG NEXA_IMAGE_VERSION
LABEL org.opencontainers.image.title="NexaChat backup and restore" \
  org.opencontainers.image.source="${NEXA_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${NEXA_IMAGE_REVISION}" \
  org.opencontainers.image.version="${NEXA_IMAGE_VERSION}" \
  org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production
WORKDIR /app/backup
RUN apk add --no-cache postgresql17-client=17.10-r0
COPY --from=server-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --chown=node:node scripts/backup/ ./
RUN rm -rf /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  /opt/yarn-v1.22.22
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/backup/command.mjs"]

FROM --platform=$BUILDPLATFORM golang:1.25.12-alpine3.23@sha256:cc985ef6f9c3bf9ece7488129c9abe0a150388ccdfa428d886fc709dca0b230a AS object-storage-build
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ENV GOTOOLCHAIN=local
ADD --checksum=sha256:2e37f5d8980256e490324e3759d38437ecfee734f60aa3e75528b05f7d19460e \
  https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/875cd1f67ea25e8965a4f5ba1e6aaf501ba6b6fa \
  /tmp/seaweedfs.tar.gz
WORKDIR /src
RUN tar --extract --gzip --file=/tmp/seaweedfs.tar.gz --strip-components=1 \
  && rm /tmp/seaweedfs.tar.gz \
  && go mod edit -require=google.golang.org/grpc@v1.82.1 \
  && go mod download -json google.golang.org/grpc@v1.82.1 > /tmp/grpc-module.json \
  && grep -F '"Sum": "h1:NnAxzGRA0677vCa4BUkOAnO5+FfQqVl9iUXeD0IqcGE="' /tmp/grpc-module.json \
  && grep -F '"GoModSum": "h1:yzTZ1TB1Z3SG+LIYaI+WiE8D5+PZ3ArnrSp8zF3+/ZA="' /tmp/grpc-module.json \
  && rm /tmp/grpc-module.json
WORKDIR /src/weed
RUN case "$TARGETARCH" in arm) export GOARM="${TARGETVARIANT#v}" ;; esac \
  && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -buildvcs=false -mod=mod -tags 5BytesOffset -trimpath \
      -ldflags '-s -w -extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=875cd1f67ea2-grpc.1.82.1' \
      -o /out/weed . \
  && go version -m /out/weed | grep -F 'google.golang.org/grpc' \
    | grep -F 'v1.82.1' \
    | grep -F 'h1:NnAxzGRA0677vCa4BUkOAnO5+FfQqVl9iUXeD0IqcGE='

FROM chrislusf/seaweedfs:4.40@sha256:52194fba4fecd0083c842158b3a902ba6e04a63619b2b0efcd08007bdb6a4602 AS object-storage-runtime
ARG NEXA_IMAGE_SOURCE
ARG NEXA_IMAGE_REVISION
ARG NEXA_IMAGE_VERSION
LABEL org.opencontainers.image.title="NexaChat object storage" \
  org.opencontainers.image.source="${NEXA_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${NEXA_IMAGE_REVISION}" \
  org.opencontainers.image.version="${NEXA_IMAGE_VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"
COPY --from=object-storage-build /out/weed /usr/bin/weed
ENV HOME=/tmp
RUN mkdir -p /data \
  && chown 1000:1000 /data \
  && chmod 0700 /data
USER 1000:1000
EXPOSE 8333
STOPSIGNAL SIGTERM

FROM nginx:1.31.3-alpine3.24@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS edge-runtime
ARG NEXA_IMAGE_SOURCE
ARG NEXA_IMAGE_REVISION
ARG NEXA_IMAGE_VERSION
LABEL org.opencontainers.image.title="NexaChat edge" \
  org.opencontainers.image.source="${NEXA_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${NEXA_IMAGE_REVISION}" \
  org.opencontainers.image.version="${NEXA_IMAGE_VERSION}" \
  org.opencontainers.image.licenses="GPL-3.0-only"
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -delete
COPY --from=production-build --chown=nginx:nginx /workspace/apps/web/dist/ /usr/share/nginx/html/
COPY --chown=nginx:nginx deploy/nginx/ /etc/nginx/

USER nginx
EXPOSE 8443
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --spider --no-check-certificate https://127.0.0.1:8443/health/live || exit 1
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]

FROM edge-runtime AS edge-cloudflare-runtime
COPY --chown=nginx:nginx deploy/nginx-cloudflare/nginx.conf /etc/nginx/nginx.conf
