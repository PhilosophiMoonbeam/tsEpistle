#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
ADMIN_EMAIL=multi-instance-smoke@example.com
ADMIN_PASSWORD=MultiInstanceSmoke123!
DB_PASSWORD=Password123!
POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23}

cleanup() {
  if [ "${smoke_succeeded:-false}" != true ]; then
    docker logs wiki-a 2>/dev/null || true
    docker logs wiki-b 2>/dev/null || true
    docker logs db 2>/dev/null || true
  fi
  docker rm -f wiki-a wiki-b lock-holder db >/dev/null 2>&1 || true
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
    -e "INSTANCE_ID=$name" \
    -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
    -e DB_USER=wiki -e "DB_PASS=$DB_PASSWORD" \
    "$WIKI_TEST_IMAGE"
}

login() {
  local port=$1
  local response
  local jwt
  response=$(curl --silent --show-error \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
    "http://127.0.0.1:$port/_api/auth/login")
  if ! jwt=$(printf '%s' "$response" | jq --exit-status --raw-output '.jwt | select(type == "string" and length > 0)' 2>/dev/null); then
    echo "Authentication through instance on port $port failed: $response" >&2
    return 1
  fi
  printf '%s\n' "$jwt"
}

docker network create wiki-multi-instance >/dev/null
docker run -d --name db --network=wiki-multi-instance \
  -e "POSTGRES_PASSWORD=$DB_PASSWORD" -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  "$POSTGRES_TEST_IMAGE"
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
wait_for_url http://127.0.0.1:3000/login
sleep 3
jwt_a=$(login 3000)

create_response=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $jwt_a" \
  --header 'Content-Type: application/json' \
  --data '{"content":"# Multi-instance page","description":"release recovery smoke","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"multi-instance-smoke","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Multi-instance smoke"}' \
  http://127.0.0.1:3000/_api/pages)
page_id=$(printf '%s' "$create_response" | jq --exit-status --raw-output '.page.id')

docker run -d --name lock-holder --network=wiki-multi-instance \
  -e "PGPASSWORD=$DB_PASSWORD" \
  "$POSTGRES_TEST_IMAGE" \
  psql --host=db --username=wiki --dbname=wiki --set ON_ERROR_STOP=1 \
  --command 'BEGIN; LOCK TABLE pages IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); COMMIT;' >/dev/null
for attempt in {1..30}; do
  page_lock_count=$(docker exec db psql --username wiki --dbname wiki --tuples-only --no-align --command "
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
docker exec db psql --username wiki --dbname wiki --set ON_ERROR_STOP=1 --command "
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
  recovery_state=$(docker exec db psql --username wiki --dbname wiki --tuples-only --no-align --command "
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

docker rm -f wiki-a >/dev/null
docker exec db psql --username wiki --dbname wiki --set ON_ERROR_STOP=1 --command "
  SELECT pg_terminate_backend(locks.pid)
  FROM pg_locks AS locks
  JOIN pg_class AS relation ON relation.oid = locks.relation
  WHERE relation.relname = 'pages'
    AND locks.mode = 'AccessExclusiveLock'
    AND locks.granted;
" >/dev/null
docker rm -f lock-holder >/dev/null

start_wiki wiki-b 3001
wait_for_url http://127.0.0.1:3001/login
sleep 3
jwt_b=$(login 3001)

for attempt in {1..45}; do
  recovery_state=$(docker exec db psql --username wiki --dbname wiki --tuples-only --no-align --command "
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
  --header "Authorization: Bearer $jwt_b" \
  "http://127.0.0.1:3001/_api/pages/$page_id")
printf '%s' "$read_response" | jq --exit-status '.path == "multi-instance-smoke"' >/dev/null

wait_for_url http://127.0.0.1:3001/healthz

start_wiki wiki-a 3000
wait_for_url http://127.0.0.1:3000/login
sleep 3
login 3000 >/dev/null

smoke_succeeded=true
echo 'Shared PostgreSQL state survived instance loss, the remaining instance recovered an expired durable-job lease exactly once, and the stopped instance rejoined.'
