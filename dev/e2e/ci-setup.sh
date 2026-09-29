#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"
if [[ ! "$WIKI_TEST_NAMESPACE" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'WIKI_TEST_NAMESPACE must be a Docker-safe tsepistle-ci- namespace.' >&2
  exit 1
fi
POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23}
wiki_container="${WIKI_TEST_NAMESPACE}-wiki"
db_container="${WIKI_TEST_NAMESPACE}-db"
data_volume="${WIKI_TEST_NAMESPACE}-data"
network="${WIKI_TEST_NAMESPACE}-network"

if docker container inspect "$wiki_container" >/dev/null 2>&1 ||
  docker container inspect "$db_container" >/dev/null 2>&1 ||
  docker volume inspect "$data_volume" >/dev/null 2>&1 ||
  docker network inspect "$network" >/dev/null 2>&1; then
  echo "Docker namespace $WIKI_TEST_NAMESPACE is already in use." >&2
  exit 1
fi

docker volume create "$data_volume" >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$db_container" --network="$network" --network-alias db \
  -e POSTGRES_PASSWORD='Password123!' -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  "$POSTGRES_TEST_IMAGE"
for attempt in {1..90}; do
  if docker exec "$db_container" psql --username=wiki --dbname=wiki --command='SELECT 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for PostgreSQL' >&2
    exit 1
  fi
  sleep 1
done
docker exec "$db_container" psql --tuples-only --no-align --username=wiki --dbname=wiki --command='SHOW server_version'
docker run -d -p 127.0.0.1:0:3000 --name "$wiki_container" --network="$network" -v "$data_volume":/wiki/data \
  --mount "type=bind,source=$PWD/dev/e2e/config.yml,target=/wiki/config.yml,readonly" \
  -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
  -e DB_USER=wiki -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"
wiki_port=$(docker port "$wiki_container" 3000/tcp)
wiki_port=${wiki_port##*:}

for attempt in {1..60}; do
  if curl --fail --silent --show-error --output /dev/null "http://127.0.0.1:$wiki_port/"; then
    exit 0
  fi
  if [ "$attempt" -eq 60 ]; then
    echo 'Wiki did not become ready within 60 seconds.' >&2
    docker logs "$wiki_container"
    exit 1
  fi
  sleep 1
done
