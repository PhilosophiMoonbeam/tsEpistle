#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../ci/docker-resources.sh"

namespace=${WIKI_TEST_NAMESPACE:-tsepistle-ci-postgres-search-${$}-${RANDOM}}
if [[ ! "$namespace" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'WIKI_TEST_NAMESPACE must be a Docker-safe tsepistle-ci- namespace.' >&2
  exit 1
fi

POSTGRES_SEARCH_TEST_IMAGE=${POSTGRES_SEARCH_TEST_IMAGE:-postgres:17-alpine}
container="${namespace}-postgres-search-db"
requested_port=${POSTGRES_SEARCH_POSTGRES_PORT:-0}
report=${POSTGRES_SEARCH_BENCHMARK_FILE:-postgres-search-benchmark.json}
if docker container inspect "$container" >/dev/null 2>&1; then
  echo "Docker namespace $namespace is already in use." >&2
  exit 1
fi
umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/tsepistle-postgres-search.XXXXXX")
cidfile="$work/container-id"

cleanup() {
  local status=$? container_id='' cleanup_failed=false
  trap - EXIT HUP INT TERM
  # Docker writes this exclusive CID file after create, even when start fails.
  # A name collision must never authorize removing another run's container.
  if [[ -f "$cidfile" ]]; then
    read -r container_id < "$cidfile" || true
    if [[ "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
      if ! docker rm -f -v "$container_id" >/dev/null 2>&1; then
        echo "Could not remove owned PostgreSQL $container_id; retry using $cidfile." >&2
        status=1
        cleanup_failed=true
      fi
    else
      echo 'Invalid owned PostgreSQL container ID; cleanup was not attempted.' >&2
      status=1
      cleanup_failed=true
    fi
  fi
  if [[ "$cleanup_failed" = false ]]; then rm -rf -- "$work"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker run -d "${ci_postgres_docker_args[@]}" --cidfile "$cidfile" \
  --label "org.tsepistle.ci.owner=$namespace" --name "$container" -p "127.0.0.1:${requested_port}:5432" \
  -e POSTGRES_PASSWORD='Password123!' \
  -e POSTGRES_USER=wiki \
  -e POSTGRES_DB=wiki_postgres_search_benchmark \
  "$POSTGRES_SEARCH_TEST_IMAGE" >/dev/null
container_id=$(< "$cidfile")
if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Docker did not return a valid owned PostgreSQL container ID.' >&2
  exit 1
fi
port=$(docker port "$container_id" 5432/tcp | cut -d: -f2)
for attempt in {1..90}; do
  if docker exec "$container_id" psql --username=wiki --dbname=wiki_postgres_search_benchmark --command='SELECT 1' >/dev/null 2>&1; then
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
