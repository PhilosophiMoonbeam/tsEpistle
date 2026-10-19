#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${WIKI_TEST_IMAGE:?An immutable registry image is required}"
: "${WIKI_TEST_NAMESPACE:?An owned namespace is required}"
: "${WIKI_BUILD_REVISION:?The source revision is required}"
: "${WIKI_SMOKE_ARTIFACTS:?An artifact directory is required}"
[[ "$WIKI_TEST_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]
[[ "$WIKI_TEST_NAMESPACE" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ ]]
[[ "$WIKI_BUILD_REVISION" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$WIKI_SMOKE_ARTIFACTS"
export WIKI_CI_RESOURCE_OWNER
WIKI_CI_RESOURCE_OWNER=$(cat /proc/sys/kernel/random/uuid)
cleanup() {
  local status=$? name label kind
  trap - EXIT INT TERM
  for name in "$WIKI_TEST_NAMESPACE-wiki" "$WIKI_TEST_NAMESPACE-db"; do
    label=$(docker container inspect --format '{{index .Config.Labels "org.tsepistle.ci.owner"}}' "$name" 2>/dev/null) || continue
    if [[ "$label" == "$WIKI_CI_RESOURCE_OWNER" ]]; then
      docker logs "$name" > "$WIKI_SMOKE_ARTIFACTS/${name##*-}.log" 2>&1 || status=1
      docker container rm --force --volumes "$name" || status=1
    fi
  done
  for kind in volume network; do
    name="$WIKI_TEST_NAMESPACE-$kind"
    if [[ "$kind" == volume ]]; then name="$WIKI_TEST_NAMESPACE-data"; fi
    label=$(docker "$kind" inspect --format '{{index .Labels "org.tsepistle.ci.owner"}}' "$name" 2>/dev/null) || continue
    if [[ "$label" == "$WIKI_CI_RESOURCE_OWNER" ]]; then docker "$kind" rm "$name" || status=1; fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker pull "$WIKI_TEST_IMAGE"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$WIKI_TEST_IMAGE")" == "linux/amd64 $WIKI_BUILD_REVISION" ]]
export WIKI_CI_APP_MEMORY=2g WIKI_CI_APP_CPUS=2 WIKI_CI_POSTGRES_MEMORY=1g WIKI_CI_POSTGRES_CPUS=1
export POSTGRES_TEST_IMAGE=postgres:18-alpine@sha256:a1d02e4bd40c94d3bf2bdd3678c137388e76d9efcd23c285e9429d336a834b44
bash dev/e2e/ci-setup.sh
wiki_port=$(docker port "$WIKI_TEST_NAMESPACE-wiki" 3000/tcp)
export PLAYWRIGHT_BASE_URL="http://127.0.0.1:${wiki_port##*:}"
export PLAYWRIGHT_JSON_OUTPUT_FILE="$WIKI_SMOKE_ARTIFACTS/report.json"
# Reuse the actual application installation/session workflow, not a mocked login.
bun run e2e --project=chromium --workers=1 --retries=0 --reporter=list,json \
  --grep='installs tsEpistle with telemetry disabled and opens the login screen|authenticates the administrator and preserves the session on reload' \
  --output="$WIKI_SMOKE_ARTIFACTS/test-results"
