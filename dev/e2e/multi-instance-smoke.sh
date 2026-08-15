#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
ADMIN_EMAIL=multi-instance-smoke@example.com
ADMIN_PASSWORD=MultiInstanceSmoke123!
DB_PASSWORD=Password123!

cleanup() {
  if [ "${smoke_succeeded:-false}" != true ]; then
    docker logs wiki-a 2>/dev/null || true
    docker logs wiki-b 2>/dev/null || true
    docker logs db 2>/dev/null || true
  fi
  docker rm -f wiki-a wiki-b db >/dev/null 2>&1 || true
  docker network rm wiki-multi-instance >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_url() {
  local url=$1
  for attempt in {1..90}; do
    if curl --fail --silent --show-error --output /dev/null "$url"; then
      return
    fi
    if [ "$attempt" -eq 90 ]; then
      echo "Timed out waiting for $url" >&2
      return 1
    fi
    sleep 1
  done
}

start_wiki() {
  local name=$1
  local port=$2
  docker run -d --name "$name" --network=wiki-multi-instance -p "$port:3000" \
    -e HA_ACTIVE=true \
    -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
    -e DB_USER=wiki -e "DB_PASS=$DB_PASSWORD" \
    "$WIKI_TEST_IMAGE"
}

login() {
  local port=$1
  local response
  response=$(curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
    "http://127.0.0.1:$port/_api/auth/login")
  printf '%s' "$response" | jq --exit-status --raw-output '.jwt | select(type == "string" and length > 0)'
}

docker network create wiki-multi-instance >/dev/null
docker run -d --name db --network=wiki-multi-instance \
  -e "POSTGRES_PASSWORD=$DB_PASSWORD" -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  postgres:17-alpine
for attempt in {1..90}; do
  if docker exec db pg_isready -U wiki -d wiki >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for PostgreSQL' >&2
    exit 1
  fi
  sleep 1
done

start_wiki wiki-a 3000
wait_for_url http://127.0.0.1:3000/
setup_response=$(curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"http://127.0.0.1:3000\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  http://127.0.0.1:3000/finalize)
printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
wait_for_url http://127.0.0.1:3000/healthz

start_wiki wiki-b 3001
wait_for_url http://127.0.0.1:3001/healthz
jwt_a=$(login 3000)
jwt_b=$(login 3001)

create_response=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $jwt_a" \
  --header 'Content-Type: application/json' \
  --data '{"content":"# Multi-instance page","description":"release recovery smoke","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"multi-instance-smoke","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Multi-instance smoke"}' \
  http://127.0.0.1:3000/_api/pages)
page_id=$(printf '%s' "$create_response" | jq --exit-status --raw-output '.page.id')

read_response=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $jwt_b" \
  "http://127.0.0.1:3001/_api/pages/$page_id")
printf '%s' "$read_response" | jq --exit-status '.path == "multi-instance-smoke"' >/dev/null

docker rm -f wiki-a >/dev/null
wait_for_url http://127.0.0.1:3001/healthz

start_wiki wiki-a 3000
wait_for_url http://127.0.0.1:3000/healthz
login 3000 >/dev/null

smoke_succeeded=true
echo 'Shared PostgreSQL state survived instance loss and the remaining instance stayed available.'
