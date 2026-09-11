# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
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
