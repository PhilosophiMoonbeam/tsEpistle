#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23}

docker rm --force wiki db >/dev/null 2>&1 || true
docker volume rm wiki-data >/dev/null 2>&1 || true
docker network rm wiki-e2e >/dev/null 2>&1 || true

docker volume create wiki-data >/dev/null
docker network create wiki-e2e >/dev/null
docker run -d --name db --network=wiki-e2e \
  -e POSTGRES_PASSWORD='Password123!' -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  "$POSTGRES_TEST_IMAGE"
for attempt in {1..90}; do
  if docker exec db psql --username=wiki --dbname=wiki --command='SELECT 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for PostgreSQL' >&2
    exit 1
  fi
  sleep 1
done
docker exec db psql --tuples-only --no-align --username=wiki --dbname=wiki --command='SHOW server_version'
docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
  --mount "type=bind,source=$PWD/dev/e2e/config.yml,target=/wiki/config.yml,readonly" \
  -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
  -e DB_USER=wiki -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"

for attempt in {1..60}; do
  if curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/; then
    exit 0
  fi
  if [ "$attempt" -eq 60 ]; then
    echo 'Wiki did not become ready within 60 seconds.' >&2
    docker logs wiki
    exit 1
  fi
  sleep 1
done
