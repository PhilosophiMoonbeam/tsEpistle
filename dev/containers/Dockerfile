# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
LABEL maintainer="tsFranki contributors"

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash curl git python3 make g++ nano openssh-server gnupg && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /wiki
WORKDIR /wiki

ENV dockerdev=1 \
    DEVDB=postgres
EXPOSE 3000
CMD ["tail", "-f", "/dev/null"]
