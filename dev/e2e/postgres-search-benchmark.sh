#!/usr/bin/env bash
set -euo pipefail

POSTGRES_SEARCH_TEST_IMAGE=${POSTGRES_SEARCH_TEST_IMAGE:-postgres:17-alpine}
container="wiki-postgres-search-benchmark-${$}"
requested_port=${POSTGRES_SEARCH_POSTGRES_PORT:-0}
report=${POSTGRES_SEARCH_BENCHMARK_FILE:-postgres-search-benchmark.json}

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup

docker run -d --name "$container" -p "127.0.0.1:${requested_port}:5432" \
  -e POSTGRES_PASSWORD='Password123!' \
  -e POSTGRES_USER=wiki \
  -e POSTGRES_DB=wiki_postgres_search_benchmark \
  "$POSTGRES_SEARCH_TEST_IMAGE" >/dev/null
port=$(docker port "$container" 5432/tcp | cut -d: -f2)
for attempt in {1..90}; do
  if docker exec "$container" psql --username=wiki --dbname=wiki_postgres_search_benchmark --command='SELECT 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo 'Timed out waiting for the isolated PostgreSQL search benchmark database' >&2
    exit 1
  fi
  sleep 1
done
rm -f "$report"

if WIKI_BENCHMARK_DATABASE_URL="postgresql://wiki:Password123!@127.0.0.1:${port}/wiki_postgres_search_benchmark" \
  POSTGRES_SEARCH_BENCHMARK_FILE="$report" \
  bun server/scripts/benchmark-postgres-search.ts; then
  benchmark_status=0
else
  benchmark_status=$?
fi

if [ ! -s "$report" ]; then
  echo "PostgreSQL search benchmark exited without a diagnostic report at $report" >&2
  benchmark_status=1
fi
exit "$benchmark_status"
