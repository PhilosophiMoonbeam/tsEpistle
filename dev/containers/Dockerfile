# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
LABEL maintainer="tsEpistle contributors"

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash curl git python3 make g++ nano openssh-server gnupg ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /wiki
WORKDIR /wiki

ENV dockerdev=1 \
    DEVDB=postgres
EXPOSE 3000
CMD ["tail", "-f", "/dev/null"]
