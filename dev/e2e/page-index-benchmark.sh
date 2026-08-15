#!/usr/bin/env bash
set -euo pipefail

POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine}
container=wiki-page-index-benchmark-db
requested_port=${PAGE_INDEX_POSTGRES_PORT:-0}
report=${PAGE_INDEX_BENCHMARK_FILE:-page-index-benchmark.json}

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "$container" -p "127.0.0.1:${requested_port}:5432" \
  -e POSTGRES_PASSWORD='Password123!' \
  -e POSTGRES_USER=wiki \
  -e POSTGRES_DB=wiki_page_index_benchmark \
  "$POSTGRES_TEST_IMAGE" >/dev/null
port=$(docker port "$container" 5432/tcp | cut -d: -f2)
for attempt in {1..90}; do
  if docker exec "$container" pg_isready --username=wiki --dbname=wiki_page_index_benchmark >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for PostgreSQL page-index benchmark database' >&2
    exit 1
  fi
  sleep 1
done

WIKI_BENCHMARK_DATABASE_URL="postgresql://wiki:Password123!@127.0.0.1:${port}/wiki_page_index_benchmark" \
PAGE_INDEX_BENCHMARK_FILE="$report" \
node server/scripts/benchmark-page-index.ts
