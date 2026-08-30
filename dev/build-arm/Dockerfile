# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG WIKI_BUILD_DATE
ARG WIKI_BUILD_REVISION
ARG WIKI_PRODUCT_DESCRIPTION
ARG WIKI_PRODUCT_NAME
ARG WIKI_PRODUCT_VERSION
ARG WIKI_SOURCE_REPOSITORY
ARG WIKI_UPSTREAM_BASE

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS dependencies
ENV CI=true \
    NODE_ENV=production
RUN apk add --no-cache g++ make cmake python3
WORKDIR /wiki

COPY build/package.json ./package.json
COPY bun.lock ./
COPY patches ./patches
RUN --mount=type=cache,id=wiki-bun-arm64,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS runtime

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
      io.tsfranki.upstream-base="${WIKI_UPSTREAM_BASE}"
ENV NODE_ENV=production

RUN apk add --no-cache bash curl git openssh gnupg && \
    mkdir -p /wiki /logs /wiki/data/content /wiki/data/repo && \
    chown -R bun:bun /wiki /logs
WORKDIR /wiki

COPY --chown=bun:bun build/assets ./assets
COPY --chown=bun:bun --from=dependencies /wiki/node_modules ./node_modules
COPY --chown=bun:bun build/server ./server
COPY --chown=bun:bun build/shared ./shared
COPY --chown=bun:bun dev/build/config.yml ./config.yml
COPY --chown=bun:bun build/package.json ./package.json
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
