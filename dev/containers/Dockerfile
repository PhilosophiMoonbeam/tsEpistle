# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
LABEL maintainer="tsEpistle contributors"

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash curl git python3 make g++ nano openssh-server gnupg && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /wiki
WORKDIR /wiki

ENV dockerdev=1 \
    DEVDB=postgres
EXPOSE 3000
CMD ["tail", "-f", "/dev/null"]
