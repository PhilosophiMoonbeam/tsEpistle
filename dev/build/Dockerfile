# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG WIKI_BUILD_DATE
ARG WIKI_BUILD_REVISION
ARG WIKI_PRODUCT_DESCRIPTION
ARG WIKI_PRODUCT_NAME
ARG WIKI_PRODUCT_VERSION
ARG WIKI_SOURCE_REPOSITORY
ARG WIKI_UPSTREAM_BASE

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS build
ARG WIKI_BUILD_DATE
ARG WIKI_BUILD_REVISION
ENV CI=true \
    WIKI_BUILD_DATE=$WIKI_BUILD_DATE \
    WIKI_BUILD_REVISION=$WIKI_BUILD_REVISION

RUN apk add --no-cache g++ make cmake python3
WORKDIR /wiki

COPY package.json bun.lock ./
COPY patches ./patches
RUN --mount=type=cache,id=wiki-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY client ./client
COPY shared ./shared
COPY server ./server
COPY vite.config.mts ./
RUN bun run build

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS dependencies
ENV NODE_ENV=production
WORKDIR /wiki
COPY package.json bun.lock ./
COPY patches ./patches
RUN --mount=type=cache,id=wiki-bun-production,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS runtime

ARG TARGETARCH
ARG WIKI_BUILD_DATE
ARG WIKI_BUILD_REVISION
ARG WIKI_PRODUCT_DESCRIPTION
ARG WIKI_PRODUCT_NAME
ARG WIKI_PRODUCT_VERSION
ARG WIKI_SOURCE_REPOSITORY
ARG WIKI_UPSTREAM_BASE
LABEL org.opencontainers.image.created="${WIKI_BUILD_DATE}" \
      org.opencontainers.image.description="${WIKI_PRODUCT_DESCRIPTION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${WIKI_BUILD_REVISION}" \
      org.opencontainers.image.source="${WIKI_SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="${WIKI_PRODUCT_NAME}" \
      org.opencontainers.image.version="${WIKI_PRODUCT_VERSION}" \
      io.tsfranki.image.architecture="${TARGETARCH}" \
      io.tsfranki.upstream-base="${WIKI_UPSTREAM_BASE}"
ENV NODE_ENV=production

RUN apk add --no-cache bash curl git openssh gnupg && \
    mkdir -p /wiki /logs /wiki/data/content /wiki/data/repo && \
    chown -R bun:bun /wiki /logs
WORKDIR /wiki

COPY --chown=bun:bun --from=build /wiki/assets ./assets
COPY --chown=bun:bun --from=dependencies /wiki/node_modules ./node_modules
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun --from=build /wiki/server ./server
COPY --chown=bun:bun dev/build/config.yml ./config.yml
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun LICENSE ./
COPY --chown=bun:bun NOTICE ./

USER bun
VOLUME ["/wiki/data/content"]
VOLUME ["/wiki/data/repo"]
EXPOSE 3000
EXPOSE 3443
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:3000/healthz || exit 1
CMD ["bun", "server/index.ts"]
