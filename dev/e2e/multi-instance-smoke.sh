#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"
if [[ ! "$WIKI_TEST_NAMESPACE" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'WIKI_TEST_NAMESPACE must be a Docker-safe tsepistle-ci- namespace.' >&2
  exit 1
fi

WIKI_A_NAME="${WIKI_TEST_NAMESPACE}-wiki-a"
WIKI_B_NAME="${WIKI_TEST_NAMESPACE}-wiki-b"
LOCK_HOLDER_NAME="${WIKI_TEST_NAMESPACE}-lock-holder"
DB_CONTAINER_NAME="${WIKI_TEST_NAMESPACE}-db"
NETWORK_NAME="${WIKI_TEST_NAMESPACE}-network"
if docker container inspect "$WIKI_A_NAME" >/dev/null 2>&1 ||
  docker container inspect "$WIKI_B_NAME" >/dev/null 2>&1 ||
  docker container inspect "$LOCK_HOLDER_NAME" >/dev/null 2>&1 ||
  docker container inspect "$DB_CONTAINER_NAME" >/dev/null 2>&1 ||
  docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Docker namespace $WIKI_TEST_NAMESPACE is already in use." >&2
  exit 1
fi
WIKI_A_CONTAINER_ID=
WIKI_B_CONTAINER_ID=
LOCK_HOLDER_CONTAINER_ID=
DB_CONTAINER_ID=
NETWORK_ID=
WIKI_A_PORT=
WIKI_B_PORT=

ADMIN_EMAIL=multi-instance-smoke@example.com
ADMIN_PASSWORD=MultiInstanceSmoke123!
DB_PASSWORD=Password123!
SITE_ORIGIN=http://127.0.0.1:3000
SITE_HOST=127.0.0.1:3000
POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23}
COOKIE_DIR=$(mktemp -d)
COOKIE_A=$COOKIE_DIR/wiki-a.cookies
COOKIE_B=$COOKIE_DIR/wiki-b.cookies

cleanup() {
  if [ "${smoke_succeeded:-false}" != true ]; then
    if [ -n "$WIKI_A_CONTAINER_ID" ]; then docker logs "$WIKI_A_CONTAINER_ID" 2>/dev/null || true; fi
    if [ -n "$WIKI_B_CONTAINER_ID" ]; then docker logs "$WIKI_B_CONTAINER_ID" 2>/dev/null || true; fi
    if [ -n "$DB_CONTAINER_ID" ]; then docker logs "$DB_CONTAINER_ID" 2>/dev/null || true; fi
  fi
  if [ -n "$WIKI_A_CONTAINER_ID" ]; then docker rm -f "$WIKI_A_CONTAINER_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$WIKI_B_CONTAINER_ID" ]; then docker rm -f "$WIKI_B_CONTAINER_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$LOCK_HOLDER_CONTAINER_ID" ]; then docker rm -f "$LOCK_HOLDER_CONTAINER_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$DB_CONTAINER_ID" ]; then docker rm -f "$DB_CONTAINER_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$NETWORK_ID" ]; then docker network rm "$NETWORK_ID" >/dev/null 2>&1 || true; fi
  rm -rf "$COOKIE_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_url() {
  local port=$1
  local url=$2
  for attempt in {1..90}; do
    if curl --fail --silent --show-error --output /dev/null \
      --connect-to "127.0.0.1:3000:127.0.0.1:$port" "$url"; then
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
  local instance_id=$1
  local name=$2
  local container_id
  local mapping
  local port
  case "$instance_id" in
    wiki-a)
      WIKI_A_CONTAINER_ID=
      WIKI_A_PORT=
      ;;
    wiki-b)
      WIKI_B_CONTAINER_ID=
      WIKI_B_PORT=
      ;;
    *)
      echo "Unsupported logical instance ID: $instance_id" >&2
      return 1
      ;;
  esac
  if ! container_id=$(docker run -d --name "$name" --network="$NETWORK_NAME" \
    -p 127.0.0.1:0:3000 \
    -e HA_ACTIVE=true \
    -e "INSTANCE_ID=$instance_id" \
    -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
    -e DB_USER=wiki -e "DB_PASS=$DB_PASSWORD" \
    "$WIKI_TEST_IMAGE"); then
    echo "Could not create Docker container $name (name collision or Docker error)." >&2
    return 1
  fi
  case "$instance_id" in
    wiki-a) WIKI_A_CONTAINER_ID=$container_id ;;
    wiki-b) WIKI_B_CONTAINER_ID=$container_id ;;
  esac
  mapping=$(docker port "$container_id" 3000/tcp)
  case "$mapping" in
    127.0.0.1:*) port=${mapping##*:} ;;
    *)
      echo "Could not determine the loopback port for $name: $mapping" >&2
      return 1
      ;;
  esac
  case "$port" in
    ''|*[!0-9]*)
      echo "Invalid Docker-assigned port for $name: $mapping" >&2
      return 1
      ;;
  esac
  case "$instance_id" in
    wiki-a) WIKI_A_PORT=$port ;;
    wiki-b) WIKI_B_PORT=$port ;;
  esac
}

login() {
  local port=$1
  local cookie_file=$2
  local response
  # Keep the configured origin on :3000 while routing to this instance's assigned port.
  response=$(curl --silent --show-error \
    --connect-to "127.0.0.1:3000:127.0.0.1:$port" \
    --cookie-jar "$cookie_file" \
    --header "Host: $SITE_HOST" \
    --header "Origin: $SITE_ORIGIN" \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
    "$SITE_ORIGIN/_api/auth/login")
  if ! printf '%s' "$response" | jq --exit-status '.authenticated == true and (has("jwt") | not)' >/dev/null; then
    echo "Authentication through instance on port $port failed: $response" >&2
    return 1
  fi
}

if ! NETWORK_ID=$(docker network create "$NETWORK_NAME"); then
  echo "Could not create Docker network $NETWORK_NAME (name collision or Docker error)." >&2
  exit 1
fi
if ! DB_CONTAINER_ID=$(docker run -d --name "$DB_CONTAINER_NAME" --network="$NETWORK_NAME" \
  --network-alias db \
  -e "POSTGRES_PASSWORD=$DB_PASSWORD" -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  "$POSTGRES_TEST_IMAGE"); then
  echo "Could not create Docker container $DB_CONTAINER_NAME (name collision or Docker error)." >&2
  exit 1
fi
for attempt in {1..90}; do
  if docker exec "$DB_CONTAINER_ID" psql --username=wiki --dbname=wiki --command='SELECT 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for PostgreSQL' >&2
    exit 1
  fi
  sleep 1
done

start_wiki wiki-a "$WIKI_A_NAME"
wait_for_url "$WIKI_A_PORT" "$SITE_ORIGIN/"
setup_response=$(curl --fail --silent --show-error \
  --connect-to "127.0.0.1:3000:127.0.0.1:$WIKI_A_PORT" \
  --header "Host: $SITE_HOST" \
  --header "Origin: $SITE_ORIGIN" \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"$SITE_ORIGIN\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  "$SITE_ORIGIN/finalize")
printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
wait_for_url "$WIKI_A_PORT" "$SITE_ORIGIN/login"
sleep 3
login "$WIKI_A_PORT" "$COOKIE_A"

create_response=$(curl --fail --silent --show-error \
  --connect-to "127.0.0.1:3000:127.0.0.1:$WIKI_A_PORT" \
  --header "Host: $SITE_HOST" \
  --header "Origin: $SITE_ORIGIN" \
  --cookie "$COOKIE_A" \
  --header 'Content-Type: application/json' \
  --data '{"content":"# Multi-instance page","description":"release recovery smoke","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"multi-instance-smoke","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Multi-instance smoke"}' \
  "$SITE_ORIGIN/_api/pages")
page_id=$(printf '%s' "$create_response" | jq --exit-status --raw-output '.page.id')

if ! LOCK_HOLDER_CONTAINER_ID=$(docker run -d --name "$LOCK_HOLDER_NAME" --network="$NETWORK_NAME" \
  -e "PGPASSWORD=$DB_PASSWORD" \
  "$POSTGRES_TEST_IMAGE" \
  psql --host=db --username=wiki --dbname=wiki --set ON_ERROR_STOP=1 \
  --command 'BEGIN; LOCK TABLE pages IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); COMMIT;'); then
  echo "Could not create Docker container $LOCK_HOLDER_NAME (name collision or Docker error)." >&2
  exit 1
fi
for attempt in {1..30}; do
  page_lock_count=$(docker exec "$DB_CONTAINER_ID" psql --username wiki --dbname wiki --tuples-only --no-align --command "
    SELECT COUNT(*)
    FROM pg_locks AS locks
    JOIN pg_class AS relation ON relation.oid = locks.relation
    WHERE relation.relname = 'pages'
      AND locks.mode = 'AccessExclusiveLock'
      AND locks.granted;
  ")
  if [ "$page_lock_count" = '1' ]; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'Timed out waiting for the page-table lock used to hold the claimed job.' >&2
    exit 1
  fi
  sleep 1
done

recovery_job_id=11111111-1111-4111-8111-111111111111
docker exec "$DB_CONTAINER_ID" psql --username wiki --dbname wiki --set ON_ERROR_STOP=1 --command "
  INSERT INTO \"durableJobs\" (
    id, type, version, payload, state, attempts, \"maxAttempts\", \"nextRunAt\",
    \"leaseOwner\", \"leaseExpiresAt\", \"lastError\", \"deduplicationKey\",
    \"createdAt\", \"updatedAt\", \"completedAt\"
  ) VALUES (
    '$recovery_job_id', 'rerender-content-extension', 1, '{\"key\":\"qr\"}', 'pending', 0, 3, NOW(),
    NULL, NULL, NULL, 'multi-instance-process-death',
    NOW(), NOW(), NULL
  );
" >/dev/null

for attempt in {1..45}; do
  recovery_state=$(docker exec "$DB_CONTAINER_ID" psql --username wiki --dbname wiki --tuples-only --no-align --command "
    SELECT state || ':' || attempts || ':' || COALESCE(\"leaseOwner\", '')
    FROM \"durableJobs\"
    WHERE id = '$recovery_job_id';
  ")
  if [ "$recovery_state" = 'running:1:wiki-a' ]; then
    break
  fi
  if [ "$attempt" -eq 45 ]; then
    echo "Instance wiki-a did not claim the blocked durable job: $recovery_state" >&2
    exit 1
  fi
  sleep 1
done

docker rm -f "$WIKI_A_CONTAINER_ID" >/dev/null
WIKI_A_CONTAINER_ID=
WIKI_A_PORT=
docker exec "$DB_CONTAINER_ID" psql --username wiki --dbname wiki --set ON_ERROR_STOP=1 --command "
  SELECT pg_terminate_backend(locks.pid)
  FROM pg_locks AS locks
  JOIN pg_class AS relation ON relation.oid = locks.relation
  WHERE relation.relname = 'pages'
    AND locks.mode = 'AccessExclusiveLock'
    AND locks.granted;
" >/dev/null
docker rm -f "$LOCK_HOLDER_CONTAINER_ID" >/dev/null
LOCK_HOLDER_CONTAINER_ID=

start_wiki wiki-b "$WIKI_B_NAME"
wait_for_url "$WIKI_B_PORT" "$SITE_ORIGIN/login"
sleep 3
login "$WIKI_B_PORT" "$COOKIE_B"

for attempt in {1..45}; do
  recovery_state=$(docker exec "$DB_CONTAINER_ID" psql --username wiki --dbname wiki --tuples-only --no-align --command "
    SELECT state || ':' || attempts || ':' || COALESCE(\"leaseOwner\", '')
    FROM \"durableJobs\"
    WHERE id = '$recovery_job_id';
  ")
  if [ "$recovery_state" = 'succeeded:2:' ]; then
    break
  fi
  if [ "$attempt" -eq 45 ]; then
    echo "Durable job was not recovered exactly once after instance loss: $recovery_state" >&2
    exit 1
  fi
  sleep 1
done

read_response=$(curl --fail --silent --show-error \
  --connect-to "127.0.0.1:3000:127.0.0.1:$WIKI_B_PORT" \
  --cookie "$COOKIE_B" \
  "$SITE_ORIGIN/_api/pages/$page_id")
printf '%s' "$read_response" | jq --exit-status '.path == "multi-instance-smoke"' >/dev/null

wait_for_url "$WIKI_B_PORT" "$SITE_ORIGIN/healthz"

start_wiki wiki-a "$WIKI_A_NAME"
wait_for_url "$WIKI_A_PORT" "$SITE_ORIGIN/login"
sleep 3
login "$WIKI_A_PORT" "$COOKIE_A"

smoke_succeeded=true
echo 'Shared PostgreSQL state survived instance loss, the remaining instance recovered an expired durable-job lease exactly once, and the stopped instance rejoined.'
