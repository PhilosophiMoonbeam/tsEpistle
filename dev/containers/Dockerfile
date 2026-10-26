# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
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
