#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"
: "${WIKI_LOCAL_CI_ARTIFACTS:?WIKI_LOCAL_CI_ARTIFACTS is required}"
: "${WIKI_BUILD_REVISION:?WIKI_BUILD_REVISION is required}"
if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
  echo 'Local browser scheduling requires Bash 5.1 or newer.' >&2
  exit 1
fi
if [[ ! "$WIKI_TEST_NAMESPACE" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ ||
      ! "$WIKI_TEST_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ||
      ! "$WIKI_BUILD_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Expected a Docker-safe tsepistle-ci- namespace, immutable image ID, and committed revision.' >&2
  exit 1
fi
browser_jobs=${WIKI_LOCAL_CI_BROWSER_JOBS:-1}
if [[ "$browser_jobs" != 1 && "$browser_jobs" != 2 ]]; then
  echo 'WIKI_LOCAL_CI_BROWSER_JOBS must be 1 or 2.' >&2
  exit 1
fi
if [[ "$WIKI_LOCAL_CI_ARTIFACTS" != /* || ! -d "$WIKI_LOCAL_CI_ARTIFACTS" ||
      -L "$WIKI_LOCAL_CI_ARTIFACTS" || ! -O "$WIKI_LOCAL_CI_ARTIFACTS" ||
      ! $(stat -c '%a' "$WIKI_LOCAL_CI_ARTIFACTS") =~ ^[0-7]00$ ]]; then
  echo 'WIKI_LOCAL_CI_ARTIFACTS must be an existing absolute, private, user-owned directory.' >&2
  exit 1
fi
for tool in bun node docker curl setsid; do
  command -v "$tool" >/dev/null || { echo "Missing browser prerequisite: $tool" >&2; exit 1; }
done
image_metadata=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$WIKI_TEST_IMAGE")
if [[ "$image_metadata" != "linux/amd64 $WIKI_BUILD_REVISION" ]]; then
  echo 'Browser image must be Linux AMD64 and labeled with WIKI_BUILD_REVISION.' >&2
  exit 1
fi

# Check every lane before creating anything. ci-setup also checks immediately before use.
suites=(chromium webkit firefox core)
for suite in "${suites[@]}"; do
  namespace="$WIKI_TEST_NAMESPACE-e2e-$suite"
  if docker container inspect "$namespace-wiki" >/dev/null 2>&1 ||
     docker container inspect "$namespace-db" >/dev/null 2>&1 ||
     docker volume inspect "$namespace-data" >/dev/null 2>&1 ||
     docker network inspect "$namespace-network" >/dev/null 2>&1; then
    echo "Browser namespace $namespace is already in use; refusing to touch it." >&2
    exit 1
  fi
done
export WIKI_CI_APP_MEMORY=${WIKI_CI_APP_MEMORY:-2g}
export WIKI_CI_APP_CPUS=${WIKI_CI_APP_CPUS:-2}
export WIKI_CI_POSTGRES_MEMORY=${WIKI_CI_POSTGRES_MEMORY:-1g}
export WIKI_CI_POSTGRES_CPUS=${WIKI_CI_POSTGRES_CPUS:-1}
source dev/ci/docker-resources.sh
export POSTGRES_MAJOR=18
export POSTGRES_TEST_IMAGE=postgres:18-alpine@sha256:a1d02e4bd40c94d3bf2bdd3678c137388e76d9efcd23c285e9429d336a834b44
export CI=1
unset READER_METADATA_ADMIN_USER READER_METADATA_ADMIN_PASS
# Never let inherited local diagnostic budgets relax the routine gate.
unset RUNTIME_MAX_CLS RUNTIME_MAX_DCL_MS RUNTIME_MAX_INTERACTION_MS RUNTIME_MAX_LCP_MS
artifact_root="$WIKI_LOCAL_CI_ARTIFACTS/e2e"
mkdir "$artifact_root"
for suite in "${suites[@]}"; do
  mkdir "$artifact_root/$suite"
done
printf 'suite\texit_status\n' > "$artifact_root/status.tsv"
# A per-invocation owner label prevents cleanup from deleting a foreign name collision.
export WIKI_CI_RESOURCE_OWNER
WIKI_CI_RESOURCE_OWNER=$(cat /proc/sys/kernel/random/uuid)
declare -A active=()
cleanup_failed=0
aggregate_status=0

owns_resource() {
  local kind=$1 name=$2 label
  label=$(docker "$kind" inspect --format '{{index .Labels "org.tsepistle.ci.owner"}}' "$name" 2>/dev/null) || return 1
  [[ "$label" == "$WIKI_CI_RESOURCE_OWNER" ]]
}

owns_container() {
  local label
  label=$(docker container inspect --format '{{index .Config.Labels "org.tsepistle.ci.owner"}}' "$1" 2>/dev/null) || return 1
  [[ "$label" == "$WIKI_CI_RESOURCE_OWNER" ]]
}

cleanup_lane() {
  local suite=$1 namespace="$WIKI_TEST_NAMESPACE-e2e-$1" name container_id
  for name in "$namespace-wiki" "$namespace-db"; do
    if owns_container "$name"; then
      if [[ -n "${WIKI_LOCAL_CI_PHASE_RUNNER:-}" ]]; then
        container_id=$(docker container inspect --format '{{.Id}}' "$name")
        if ! bun "$WIKI_LOCAL_CI_PHASE_RUNNER" snapshot --container "$container_id" >> "$artifact_root/cleanup.log" 2>&1; then
          cleanup_failed=1
        fi
      fi
      docker logs "$name" > "$artifact_root/$suite/${name##"$namespace-"}.log" 2>&1 || true
      if ! docker container rm --force --volumes "$name" >> "$artifact_root/cleanup.log" 2>&1; then
        cleanup_failed=1
      fi
    fi
  done
  if owns_resource volume "$namespace-data"; then
    docker volume rm "$namespace-data" >> "$artifact_root/cleanup.log" 2>&1 || cleanup_failed=1
  fi
  if owns_resource network "$namespace-network"; then
    docker network rm "$namespace-network" >> "$artifact_root/cleanup.log" 2>&1 || cleanup_failed=1
  fi
}

terminate_groups() {
  local pid attempt running
  for pid in "$@"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for attempt in {1..5}; do
    running=0
    for pid in "$@"; do
      if kill -0 -- "-$pid" 2>/dev/null; then running=1; fi
    done
    if (( running == 0 )); then break; fi
    sleep 1
  done
  for pid in "$@"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}

on_exit() {
  local status=$? pid suite
  trap - EXIT INT TERM HUP
  # Include a child interrupted between launching it and registering its PID.
  for pid in $(jobs -pr); do
    if [[ -z "${active[$pid]:-}" ]]; then active[$pid]=interrupted; fi
  done
  for pid in "${!active[@]}"; do
    suite=${active[$pid]}
    case "$suite" in
      chromium|webkit|firefox|core)
        printf '%s\t%s\n' "$suite" "$status" >> "$artifact_root/status.tsv"
        printf '%s\n' "$status" > "$artifact_root/$suite/exit-status"
        ;;
    esac
  done
  if (( ${#active[@]} )); then terminate_groups "${!active[@]}"; fi
  for suite in "${suites[@]}"; do cleanup_lane "$suite"; done
  if (( cleanup_failed )); then
    echo "Browser resource cleanup failed; see $artifact_root/cleanup.log" >&2
    if (( status == 0 )); then status=1; fi
  fi
  printf '%s\n' "$status" > "$artifact_root/exit-status"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

start_lane() {
  local suite=$1 lane="$artifact_root/$1"
  echo "Starting browser suite $suite (log: $lane/run.log)"
  # Fixtures keep authentication/browser storage in fresh contexts. Every filesystem
  # output is testInfo.outputPath except the explicit runtime metrics file below.
  env WIKI_TEST_NAMESPACE="$WIKI_TEST_NAMESPACE-e2e-$suite" WIKI_E2E_SUITE="$suite" \
    RUNTIME_PERFORMANCE_FILE="$lane/runtime-performance-postgres-18.json" \
    PLAYWRIGHT_JSON_OUTPUT_FILE="$lane/report.json" \
    PLAYWRIGHT_HTML_OUTPUT_DIR="$lane/html-report" \
    PLAYWRIGHT_BLOB_OUTPUT_DIR="$lane/blob-report" \
    setsid dev/e2e/ci-run.sh --workers=1 --retries=0 --reporter=list,json \
      --output="$lane/test-results" > "$lane/run.log" 2>&1 &
  active[$!]=$suite
}

# Reuse immutable browser revisions from the established user cache. The pinned
# @playwright/test CLI installs only missing revisions, without sudo/--with-deps.
# Resolve this package explicitly: production playwright-core can be older.
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
playwright_cli=$(node -p "require.resolve('@playwright/test/cli')")
echo "Preparing pinned Playwright browsers (log: $artifact_root/browser-install.log)"
setsid node "$playwright_cli" install chromium firefox webkit > "$artifact_root/browser-install.log" 2>&1 &
installer_pid=$!
active[$installer_pid]=installer
if wait "$installer_pid"; then status=0; else status=$?; fi
terminate_groups "$installer_pid"
unset 'active[$installer_pid]'
printf '%s\n' "$status" > "$artifact_root/browser-install.exit-status"
if (( status != 0 )); then
  echo "Playwright browser preparation failed; see $artifact_root/browser-install.log" >&2
  exit "$status"
fi

finish_lane() {
  local pid=$1 status=$2 suite=${active[$1]}
  terminate_groups "$pid"
  unset 'active[$pid]'
  printf '%s\t%s\n' "$suite" "$status" >> "$artifact_root/status.tsv"
  printf '%s\n' "$status" > "$artifact_root/$suite/exit-status"
  if (( status != 0 )); then aggregate_status=1; fi
  cleanup_lane "$suite"
  echo "Browser suite $suite exited $status (log: $artifact_root/$suite/run.log)"
}

# Start Chromium and WebKit first, then let Firefox use whichever slot frees first.
queue=(chromium webkit firefox)
next=0
while (( next < ${#queue[@]} || ${#active[@]} )); do
  while (( next < ${#queue[@]} && ${#active[@]} < browser_jobs )); do
    start_lane "${queue[$next]}"
    next=$((next + 1))
  done
  completed=''
  # Bash wait -n skips jobs that finished before it was called. Reap those
  # explicitly too, so an immediate setup failure still releases its lane.
  for pid in "${!active[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      completed=$pid
      if wait "$pid"; then status=0; else status=$?; fi
      break
    fi
  done
  if [[ -z "$completed" ]]; then
    if wait -n -p completed "${!active[@]}"; then status=0; else status=$?; fi
  fi
  if [[ -z "${completed:-}" ]]; then
    if (( status == 127 )); then continue; fi
    echo 'Browser scheduler could not identify a completed lane.' >&2
    exit 1
  fi
  finish_lane "$completed" "$status"
done

# Core includes accessibility and runtime-performance: no browser lane may overlap.
if (( cleanup_failed )); then
  echo 'Refusing to run exclusive performance checks while browser cleanup has failed.' >&2
  exit 1
fi
start_lane core
core_pid=${!active[*]}
if wait "$core_pid"; then status=0; else status=$?; fi
finish_lane "$core_pid" "$status"
exit "$aggregate_status"
