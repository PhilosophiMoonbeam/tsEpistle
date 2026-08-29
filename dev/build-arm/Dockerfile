# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG WIKI_BUILD_DATE
ARG WIKI_BUILD_REVISION
ARG WIKI_PRODUCT_DESCRIPTION
ARG WIKI_PRODUCT_NAME
ARG WIKI_PRODUCT_VERSION
ARG WIKI_SOURCE_REPOSITORY
ARG WIKI_UPSTREAM_BASE

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
ENV CI=true

RUN apk add --no-cache g++ make cmake python3

WORKDIR /wiki

RUN corepack enable

COPY build/package.json ./package.json
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches

RUN --mount=type=cache,id=wiki-pnpm-arm64,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile && \
    pnpm prune --prod && \
    rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

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
    chown -R node:node /wiki /logs

WORKDIR /wiki

COPY --chown=node:node build/assets ./assets
COPY --chown=node:node --from=dependencies /wiki/node_modules ./node_modules
COPY --chown=node:node build/server ./server
COPY --chown=node:node build/shared ./shared
COPY --chown=node:node dev/build/config.yml ./config.yml
COPY --chown=node:node build/package.json ./package.json
COPY --chown=node:node LICENSE ./
COPY --chown=node:node NOTICE ./

USER node

VOLUME ["/wiki/data/content"]
VOLUME ["/wiki/data/repo"]

EXPOSE 3000
EXPOSE 3443

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.ts"]
