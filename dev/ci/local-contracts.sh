#!/usr/bin/env bash
# Routine nonbrowser gates. Run from the frozen repository root, after ci and the AMD64 build.
# Required: WIKI_TEST_IMAGE (sha256 ID), WIKI_BUILD_REVISION (40 hex),
# WIKI_TEST_NAMESPACE (unique tsepistle-ci- prefix, <=44 characters),
# WIKI_LOCAL_CI_ARTIFACTS (absolute private directory), WIKI_LOCAL_CI_PHASE_RUNNER
# (absolute frozen-worktree helper). Optional: WIKI_LOCAL_CI_TOOLS, BUILDX_BUILDER,
# WIKI_CI_{APP,POSTGRES}_{MEMORY,CPUS}, WIKI_LOCAL_CI_KIND_{MEMORY,CPUS}.
# ARM64 binfmt/QEMU must already be configured by the host administrator.
set -euo pipefail
umask 077
phase=
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != --phase ]; then
    echo 'Usage: local-contracts.sh [--phase NAME]' >&2
    exit 2
  fi
  phase=$2
  case "$phase" in
    ledger-pg16|ledger-pg17|native-pg18|page-index-pg15|page-index-pg16|page-index-pg17|page-index-pg18|\
    upgrade-pg15|upgrade-pg16|upgrade-pg17|upgrade-pg18|recovery-pg15|recovery-pg18|kubernetes-tools|\
    helm-lifecycle|agent-browser-multiarch|linux-bundle|arm64-application|site-logo-amd64|site-logo-arm64) ;;
    *) printf 'Unknown local contract phase: %s\n' "$phase" >&2; exit 2 ;;
  esac
fi
export WIKI_CI_APP_MEMORY=${WIKI_CI_APP_MEMORY:-2g}
export WIKI_CI_POSTGRES_MEMORY=${WIKI_CI_POSTGRES_MEMORY:-1g}
export WIKI_LOCAL_CI_KIND_MEMORY=${WIKI_LOCAL_CI_KIND_MEMORY:-6g}
source "$(dirname "${BASH_SOURCE[0]}")/docker-resources.sh"
: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"
: "${WIKI_LOCAL_CI_ARTIFACTS:?WIKI_LOCAL_CI_ARTIFACTS is required}"
: "${WIKI_BUILD_REVISION:?WIKI_BUILD_REVISION is required}"
: "${WIKI_LOCAL_CI_PHASE_RUNNER:?WIKI_LOCAL_CI_PHASE_RUNNER is required}"
[[ "$WIKI_TEST_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$WIKI_BUILD_REVISION" =~ ^[0-9a-f]{40}$ ]]
[[ "$WIKI_TEST_NAMESPACE" =~ ^tsepistle-ci-[a-z0-9][a-z0-9-]*$ && ${#WIKI_TEST_NAMESPACE} -le 44 ]]
[[ "$WIKI_LOCAL_CI_ARTIFACTS" = /* ]]
for tool in bun docker jq curl tar gzip sha256sum flock install realpath stat; do command -v "$tool" >/dev/null; done
[ "$(uname -m)" = x86_64 ]
[ "$(docker image inspect --format '{{.Id}}' "$WIKI_TEST_IMAGE")" = "$WIKI_TEST_IMAGE" ]
[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$WIKI_TEST_IMAGE")" = linux/amd64 ]
[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$WIKI_TEST_IMAGE")" = "$WIKI_BUILD_REVISION" ]
[ "$(git rev-parse HEAD)" = "$WIKI_BUILD_REVISION" ]
workspace=$(pwd -P)
script=$(realpath "${BASH_SOURCE[0]}")
[ "$script" = "$workspace/dev/ci/local-contracts.sh" ]
[[ "$WIKI_LOCAL_CI_PHASE_RUNNER" = /* ]]
[ "$WIKI_LOCAL_CI_PHASE_RUNNER" = "$workspace/server/scripts/local-ci-resources.ts" ]
[ -f "$WIKI_LOCAL_CI_PHASE_RUNNER" ]
base_namespace=$WIKI_TEST_NAMESPACE
artifacts="$WIKI_LOCAL_CI_ARTIFACTS/contracts"
# Child scopes may only reuse the parent's private, source-bound artifact tree.
if [ -n "$phase" ]; then
  [ "${WIKI_LOCAL_CI_ACTIVE_PHASE:-}" = "$phase" ]
  for directory in "$artifacts" "$artifacts/logs" "$artifacts/reports" "$artifacts/images" "$artifacts/helm" "$artifacts/phases"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] && [ -O "$directory" ]
    [ "$(stat -c '%a' "$directory")" = 700 ]
  done
  [ -f "$artifacts/context.json" ] && [ ! -L "$artifacts/context.json" ] && [ -O "$artifacts/context.json" ]
  [ "$(stat -c '%a' "$artifacts/context.json")" = 600 ]
  jq --exit-status --arg revision "$WIKI_BUILD_REVISION" --arg image "$WIKI_TEST_IMAGE" \
    --arg namespace "$base_namespace" --arg workspace "$workspace" \
    '.revision == $revision and .amd64ImageId == $image and .namespace == $namespace and .workspace == $workspace' \
    "$artifacts/context.json" >/dev/null
  [ ! -e "$artifacts/phases/$phase.success" ] && [ ! -L "$artifacts/phases/$phase.success" ]
else
  # Refuse to mix results from different runs or adopt existing artifacts.
  mkdir "$artifacts"
  mkdir "$artifacts/logs" "$artifacts/reports" "$artifacts/images" "$artifacts/helm" "$artifacts/phases"
  jq --null-input --arg revision "$WIKI_BUILD_REVISION" --arg image "$WIKI_TEST_IMAGE" \
    --arg namespace "$base_namespace" --arg workspace "$workspace" \
    '{revision:$revision, amd64ImageId:$image, namespace:$namespace, workspace:$workspace}' > "$artifacts/context.json"
fi
export WIKI_LOCAL_CI_TOOLS=${WIKI_LOCAL_CI_TOOLS:-${XDG_STATE_HOME:-$HOME/.local/state}/tsepistle/ci/tools}
[[ "$WIKI_LOCAL_CI_TOOLS" = /* ]]
mkdir -p "$WIKI_LOCAL_CI_TOOLS"
chmod 700 "$WIKI_LOCAL_CI_TOOLS"
metadata=$(GITHUB_SHA="$WIKI_BUILD_REVISION" bun server/scripts/export-build-environment.ts)
while IFS='=' read -r key value; do export "$key=$value"; done <<< "$metadata"
bun_version=$(bun --version)
[ "$bun_version" = "$(jq -r '.packageManager | sub("^bun@"; "")' package.json)" ]
if [ -n "$phase" ]; then
  [ "$(cat "$artifacts/images/amd64-image-id.txt")" = "$WIKI_TEST_IMAGE" ]
else
  printf '%s\n' "$WIKI_TEST_IMAGE" > "$artifacts/images/amd64-image-id.txt"
fi
phase_pid=
completed=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$phase_pid" ]; then
    kill -TERM -- "-$phase_pid" 2>/dev/null || true
    wait "$phase_pid" 2>/dev/null || true
  fi
  jq --null-input --arg revision "$WIKI_BUILD_REVISION" --arg image "$WIKI_TEST_IMAGE" \
    --arg root "$artifacts" --argjson exitCode "$status" \
    --args '$ARGS.positional as $phases | {revision:$revision, amd64ImageId:$image, artifacts:$root, exitCode:$exitCode, completedPhases:$phases}' \
    "${completed[@]}" > "$artifacts/result.json"
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -z "$phase" ]; then
  trap cleanup EXIT
  # The helper owns the scoped workload; this group owns the cancellable helper.
  set -m
fi
memory_gib() {
  local value=$1 amount unit divisor
  if [[ ! "$value" =~ ^([1-9][0-9]{0,15})([bBkKmMgG]?)$ ]]; then
    printf 'Cannot budget CI Docker memory quantity: %s\n' "$value" >&2
    return 1
  fi
  amount=${BASH_REMATCH[1]}
  unit=${BASH_REMATCH[2]}
  case "$unit" in
    ''|b|B) divisor=1073741824 ;;
    k|K) divisor=1048576 ;;
    m|M) divisor=1024 ;;
    g|G) divisor=1 ;;
  esac
  printf '%s\n' "$(((amount + divisor - 1) / divisor))"
}
app_gib=$(memory_gib "$WIKI_CI_APP_MEMORY")
postgres_gib=$(memory_gib "$WIKI_CI_POSTGRES_MEMORY")
# The complete native suite stores a 250 MiB original; keep its PostgreSQL cap
# at least 4 GiB without lowering a larger configured cap or changing other lanes.
native_postgres_memory=4g
native_postgres_gib=4
if [ "$postgres_gib" -gt "$native_postgres_gib" ]; then
  native_postgres_memory=$WIKI_CI_POSTGRES_MEMORY
  native_postgres_gib=$postgres_gib
fi
kind_gib=$(memory_gib "$WIKI_LOCAL_CI_KIND_MEMORY")
run_phase() {
  local name=$1 host_gib=$2 docker_gib=$3 status receipt
  shift 3
  receipt="$artifacts/phases/$name.success"
  [ ! -e "$receipt" ] && [ ! -L "$receipt" ]
  printf 'Local contracts: %s (log: %s/logs/%s.log)\n' "$name" "$artifacts" "$name"
  (trap - EXIT INT TERM; set +m
    exec bun "$WIKI_LOCAL_CI_PHASE_RUNNER" run --name "$name" --host-gib "$host_gib" --docker-gib "$docker_gib" \
      "$@" -- bash "$script" --phase "$name"
  ) > "$artifacts/logs/$name.log" 2>&1 &
  phase_pid=$!
  if wait "$phase_pid"; then status=0; else status=$?; fi
  phase_pid=
  if [ "$status" -eq 0 ]; then
    if [ ! -f "$receipt" ] || [ -L "$receipt" ] || [ ! -O "$receipt" ] ||
      [ "$(stat -c '%a' "$receipt")" != 600 ] || [ "$(cat "$receipt")" != "$name" ]; then
      echo "Local contracts phase $name exited without its child success receipt." >&2
      status=1
    fi
  fi
  if [ "$status" -ne 0 ]; then
    printf 'Local contracts phase %s failed (%s); see %s/logs/%s.log\n' "$name" "$status" "$artifacts" "$name" >&2
    return "$status"
  fi
  completed+=("$name")
}
postgres_image() {
  case "$1" in
    15) printf '%s\n' 'postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23' ;;
    16) printf '%s\n' 'postgres:16-alpine@sha256:44c4ee9810eff91f7eab4d822642e01115b1a9eccce4bcbdde7604752d68eac6' ;;
    17) printf '%s\n' 'postgres:17-alpine@sha256:d4bb0a8c1b7bb2e29f976d099e7bfb9a5d8858cffe9e46b35cd302cd1f1f8168' ;;
    18) printf '%s\n' 'postgres:18-alpine@sha256:a1d02e4bd40c94d3bf2bdd3678c137388e76d9efcd23c285e9429d336a834b44' ;;
    *) return 1 ;;
  esac
}
postgres_contract() (
  version=$1
  suite=$2
  namespace="$base_namespace-$suite-pg$version"
  container_id=
  cleanup_database() {
    local status=$?
    trap - EXIT INT TERM
    if [ -n "$container_id" ]; then
      if ! bun "$WIKI_LOCAL_CI_PHASE_RUNNER" snapshot --container "$container_id"; then status=1; fi
      docker logs "$container_id" > "$artifacts/logs/$suite-pg$version-postgres.log" 2>&1 || true
      docker rm -f -v "$container_id" >/dev/null 2>&1 || true
    fi
    exit "$status"
  }
  trap cleanup_database EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if docker container inspect "$namespace-db" >/dev/null 2>&1; then
    echo "Refusing to adopt $namespace-db" >&2
    exit 1
  fi
  database=wiki_agents_test
  if [ "$suite" = native ]; then
    database=wiki_native_test
    ci_fill_docker_resources ci_postgres_docker_args "$native_postgres_memory" "${WIKI_CI_POSTGRES_CPUS:-}"
  fi
  container_id=$(docker run -d "${ci_postgres_docker_args[@]}" --name "$namespace-db" \
    --label "tsepistle-ci.owner=$namespace" -p 127.0.0.1:0:5432 \
    -e POSTGRES_USER=wiki -e POSTGRES_PASSWORD=test -e "POSTGRES_DB=$database" \
    --health-cmd "pg_isready -U wiki -d $database" --health-interval 5s --health-timeout 5s --health-retries 20 \
    "$(postgres_image "$version")")
  for attempt in {1..100}; do
    health=$(docker inspect --format '{{.State.Health.Status}}' "$container_id")
    if [ "$health" = healthy ]; then break; fi
    [ "$health" != unhealthy ] && [ "$attempt" -ne 100 ]
    sleep 1
  done
  mapping=$(docker port "$container_id" 5432/tcp)
  [[ "$mapping" =~ ^127\.0\.0\.1:([0-9]+)$ ]]
  export WIKI_TEST_POSTGRES_HOST=127.0.0.1 WIKI_TEST_POSTGRES_PASSWORD=test WIKI_TEST_POSTGRES_USER=wiki
  export WIKI_TEST_POSTGRES_PORT=${BASH_REMATCH[1]}
  if [ "$suite" = ledger ]; then
    bun run test:postgres server/test/db/agents-migration.postgres.integration.test.ts
    bun run test:postgres server/test/agents/repository.postgres.test.ts
  else
    bun run test:postgres
  fi
)
provision_tools() (
  exec 9>"$WIKI_LOCAL_CI_TOOLS/kubernetes.lock"
  flock 9
  tools="$WIKI_LOCAL_CI_TOOLS/kubernetes-kind0.32.0-helm4.0.4-kubectl1.36.1"
  mkdir -p "$tools"
  download() {
    local url=$1 file=$2 checksum=$3
    if [ ! -f "$file" ]; then
      curl --fail --silent --show-error --location --output "$file.download" "$url"
      printf '%s  %s\n' "$checksum" "$file.download" | sha256sum --check
      install -m 0600 "$file.download" "$file"
      rm -f "$file.download"
    fi
    printf '%s  %s\n' "$checksum" "$file" | sha256sum --check
  }
  download https://github.com/kubernetes-sigs/kind/releases/download/v0.32.0/kind-linux-amd64 "$tools/kind" 50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54
  download https://dl.k8s.io/release/v1.36.1/bin/linux/amd64/kubectl "$tools/kubectl" 629d3f410e09bf49b64ae7079f7f0bda1191efed311f7d37fdbab0ad5b0ec2b7
  download https://get.helm.sh/helm-v4.0.4-linux-amd64.tar.gz "$tools/helm.tar.gz" 29454bc351f4433e66c00f5d37841627cbbcc02e4c70a6d796529d355237671c
  extract=$(mktemp -d "$tools/extract.XXXXXX")
  trap 'rm -rf "$extract"' EXIT
  tar -xzf "$tools/helm.tar.gz" -C "$extract" linux-amd64/helm
  install -m 0755 "$extract/linux-amd64/helm" "$tools/helm"
  chmod 0755 "$tools/kind" "$tools/kubectl"
)
helm_lifecycle() (
  export PATH="$WIKI_LOCAL_CI_TOOLS/kubernetes-kind0.32.0-helm4.0.4-kubectl1.36.1:$PATH"
  export KUBECONFIG="$artifacts/helm/kubeconfig"
  export HELM_CACHE_HOME="$artifacts/helm/cache" HELM_CONFIG_HOME="$artifacts/helm/config" HELM_DATA_HOME="$artifacts/helm/data"
  export KIND_EXPERIMENTAL_PROVIDER=docker
  export KIND_CLUSTER_NAME="$base_namespace-helm"
  export KIND_EXPERIMENTAL_DOCKER_NETWORK="$KIND_CLUSTER_NAME-network"
  export WIKI_TEST_PREVIOUS_IMAGE='ghcr.io/requarks/wiki:2.5.314@sha256:68f0d1848261ae76492ba358e30a96a76fed5d97a3fff381656082bf90f70d7e'
  export WIKI_TEST_IMAGE_REPOSITORY="$base_namespace/helm-app" WIKI_TEST_IMAGE_TAG=local
  export POSTGRES_TEST_IMAGE_REPOSITORY="$base_namespace/helm-postgres" POSTGRES_TEST_IMAGE_TAG=15
  candidate="$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG"
  postgres="$POSTGRES_TEST_IMAGE_REPOSITORY:$POSTGRES_TEST_IMAGE_TAG"
  node_name="$KIND_CLUSTER_NAME-control-plane"
  network_id=
  node_id=
  create_pid=
  tagged_candidate=false
  tagged_postgres=false
  cleanup_helm() {
    local status=$?
    trap - EXIT INT TERM
    if [ -n "$create_pid" ]; then kill "$create_pid" 2>/dev/null || true; wait "$create_pid" 2>/dev/null || true; fi
    # Cancellation can arrive after Docker created the node but before its ID was recorded.
    if [ -n "$network_id" ] && [ -z "$node_id" ]; then
      node_id=$(docker container inspect --format '{{.Id}}' "$node_name" 2>/dev/null || true)
      if [ -n "$node_id" ] && ! docker inspect "$node_id" | jq --exit-status \
        --arg cluster "$KIND_CLUSTER_NAME" --arg network "$network_id" \
        '.[0] | .Config.Labels["io.x-k8s.kind.cluster"] == $cluster and any(.NetworkSettings.Networks[]; .NetworkID == $network)' >/dev/null; then
        node_id=
      fi
    fi
    if [ -n "$node_id" ]; then
      if ! bun "$WIKI_LOCAL_CI_PHASE_RUNNER" snapshot --container "$node_id"; then status=1; fi
      kind export logs --name "$KIND_CLUSTER_NAME" "$artifacts/helm/cluster-logs" >/dev/null 2>&1 || true
      docker rm -f -v "$node_id" >/dev/null 2>&1 || true
    fi
    if [ -n "$network_id" ]; then docker network rm "$network_id" >/dev/null 2>&1 || true; fi
    if [ "$tagged_candidate" = true ]; then docker image rm "$candidate" >/dev/null 2>&1 || true; fi
    if [ "$tagged_postgres" = true ]; then docker image rm "$postgres" >/dev/null 2>&1 || true; fi
    exit "$status"
  }
  trap cleanup_helm EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for tag in "$candidate" "$postgres"; do
    if docker image inspect "$tag" >/dev/null 2>&1; then echo "Refusing to replace $tag" >&2; exit 1; fi
  done
  if docker container inspect "$node_name" >/dev/null 2>&1 || docker network inspect "$KIND_EXPERIMENTAL_DOCKER_NETWORK" >/dev/null 2>&1 ||
    [ -n "$(docker ps -aq --filter "label=io.x-k8s.kind.cluster=$KIND_CLUSTER_NAME")" ]; then
    echo "Refusing to adopt existing kind resources for $KIND_CLUSTER_NAME" >&2
    exit 1
  fi
  docker pull --platform linux/amd64 "$WIKI_TEST_PREVIOUS_IMAGE"
  docker pull postgres@sha256:a2c20749c564b4eb73a77bfda626f8a3cde1bbfae020fb97c616a00cdc1a2181
  docker tag "$WIKI_TEST_IMAGE" "$candidate"
  tagged_candidate=true
  docker tag postgres@sha256:a2c20749c564b4eb73a77bfda626f8a3cde1bbfae020fb97c616a00cdc1a2181 "$postgres"
  tagged_postgres=true
  network_id=$(docker network create --label "tsepistle-ci.owner=$KIND_CLUSTER_NAME" "$KIND_EXPERIMENTAL_DOCKER_NETWORK")
  # kind has no Docker resource-limit flags: cap only the new, isolated node as soon as it exists.
  memory=${WIKI_LOCAL_CI_KIND_MEMORY:-6g}
  cpus=${WIKI_LOCAL_CI_KIND_CPUS:-4}
  [[ "$memory" =~ ^[1-9][0-9]*([bBkKmMgG])?$ && "$cpus" =~ ^[1-9][0-9]*$ ]]
  kind create cluster --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG" \
    --image kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5 --retain &
  create_pid=$!
  while kill -0 "$create_pid" 2>/dev/null; do
    if node_id=$(docker container inspect --format '{{.Id}}' "$node_name" 2>/dev/null); then
      [ "$(docker inspect --format '{{index .Config.Labels "io.x-k8s.kind.cluster"}}' "$node_id")" = "$KIND_CLUSTER_NAME" ]
      docker update --memory "$memory" --memory-swap "$memory" --cpus "$cpus" "$node_id"
      break
    fi
    sleep 0.2
  done
  wait "$create_pid"
  create_pid=
  [ -n "$node_id" ]
  kind load docker-image --name "$KIND_CLUSTER_NAME" "$candidate" "$postgres"
  dev/e2e/helm-lifecycle-smoke.sh
)
linux_bundle() {
  dev/build/create-linux-bundle.sh "$WIKI_TEST_IMAGE" "$artifacts/tsepistle-linux.tar.gz"
  test -s "$artifacts/tsepistle-linux.tar.gz"
  sha256sum "$artifacts/tsepistle-linux.tar.gz" > "$artifacts/tsepistle-linux.sha256"
}
arm_application() {
  # The disposable worktree owns this ignored build directory; never reuse stale contents.
  if [ -e build ]; then echo 'ARM build staging directory already exists; refusing to reuse it.' >&2; return 1; fi
  mkdir build
  tar -xzf "$artifacts/tsepistle-linux.tar.gz" -C build --exclude=node_modules
  local args=() key
  for key in WIKI_BUILD_DATE WIKI_BUILD_REVISION WIKI_PRODUCT_DESCRIPTION WIKI_PRODUCT_NAME WIKI_PRODUCT_VERSION WIKI_SOURCE_REPOSITORY WIKI_UPSTREAM_BASE; do
    args+=(--build-arg "$key=${!key}")
  done
  docker buildx build --file dev/build-arm/Dockerfile --platform linux/arm64 --load \
    --provenance=false --sbom=false --iidfile "$artifacts/images/arm64-image-id.txt" \
    "${args[@]}" .
  local image
  image=$(cat "$artifacts/images/arm64-image-id.txt")
  [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/arm64 ]
  [ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$WIKI_BUILD_REVISION" ]
}
worker_image() {
  docker buildx build --file dev/build/Dockerfile.agent-browser --platform linux/amd64,linux/arm64 \
    --output "type=oci,dest=$artifacts/images/wiki-agent-browser.oci.tar" .
  test -s "$artifacts/images/wiki-agent-browser.oci.tar"
  tar -xOf "$artifacts/images/wiki-agent-browser.oci.tar" index.json > "$artifacts/images/agent-browser-oci-index.json"
  sha256sum "$artifacts/images/wiki-agent-browser.oci.tar" > "$artifacts/images/agent-browser-oci.sha256"
}
execute_phase() {
  local name=$1 version
  case "$name" in
    ledger-pg16|ledger-pg17)
      postgres_contract "${name#ledger-pg}" ledger
      ;;
    native-pg18)
      postgres_contract 18 native
      ;;
    page-index-pg15|page-index-pg16|page-index-pg17|page-index-pg18)
      version=${name#page-index-pg}
      env WIKI_TEST_NAMESPACE="$base_namespace-page-index-pg$version" \
        POSTGRES_TEST_IMAGE="$(postgres_image "$version")" PAGE_INDEX_BENCHMARK_FILE="$artifacts/reports/page-index-pg$version.json" \
        bun run benchmark:page-index
      ;;
    upgrade-pg15|upgrade-pg16|upgrade-pg17|upgrade-pg18)
      version=${name#upgrade-pg}
      env WIKI_TEST_NAMESPACE="$base_namespace-upgrade-pg$version" \
        POSTGRES_TEST_IMAGE="$(postgres_image "$version")" MIGRATION_METRICS_FILE="$artifacts/reports/migration-pg$version.json" \
        dev/e2e/upgrade-smoke.sh
      ;;
    recovery-pg15|recovery-pg18)
      version=${name#recovery-pg}
      env WIKI_TEST_NAMESPACE="$base_namespace-recovery-pg$version" \
        POSTGRES_TEST_IMAGE="$(postgres_image "$version")" dev/e2e/multi-instance-smoke.sh
      ;;
    kubernetes-tools) provision_tools ;;
    helm-lifecycle) helm_lifecycle ;;
    agent-browser-multiarch) worker_image ;;
    linux-bundle) linux_bundle ;;
    arm64-application) arm_application ;;
    site-logo-amd64)
      dev/build/run-site-logo-processing-gate.sh --local-image-id "$WIKI_TEST_IMAGE" \
        linux/amd64 "$artifacts/reports/site-logo-amd64/site-logo-processing-benchmark-amd64.json" "$bun_version"
      ;;
    site-logo-arm64)
      dev/build/run-site-logo-processing-gate.sh --local-image-id "$(cat "$artifacts/images/arm64-image-id.txt")" \
        linux/arm64 "$artifacts/reports/site-logo-arm64/site-logo-processing-benchmark-arm64.json" "$bun_version"
      ;;
    *) printf 'Unknown local contract phase: %s\n' "$name" >&2; return 2 ;;
  esac
}
if [ -n "$phase" ]; then
  execute_phase "$phase"
  # Only a successful child may publish a receipt; it never writes result.json.
  (set -C; printf '%s\n' "$phase" > "$artifacts/phases/$phase.success")
  exit 0
fi

# Budgets cover maximum simultaneous allocations, not just application services.
for version in 16 17; do run_phase "ledger-pg$version" 4 "$postgres_gib"; done
# Admission includes 4 GiB host + the native PostgreSQL cap + 8 GiB headroom.
run_phase native-pg18 4 "$native_postgres_gib"
for version in 15 16 17 18; do run_phase "page-index-pg$version" 4 "$postgres_gib"; done
# Migration monitoring runs a second app-capped volume helper alongside Wiki/PG.
for version in 15 16 17 18; do run_phase "upgrade-pg$version" 2 "$((2 * app_gib + postgres_gib))"; done
# Recovery retains both Wiki instances on rejoin, or Wiki/PG plus a PG-capped lock holder.
recovery_gib=$((2 * app_gib + postgres_gib))
recovery_lock_gib=$((app_gib + 2 * postgres_gib))
if [ "$recovery_lock_gib" -gt "$recovery_gib" ]; then recovery_gib=$recovery_lock_gib; fi
for version in 15 18; do run_phase "recovery-pg$version" 2 "$recovery_gib"; done
run_phase kubernetes-tools 2 0
run_phase helm-lifecycle 2 "$kind_gib"
run_phase agent-browser-multiarch 1 8 --builder
# Bundle extraction creates a stopped container, not another running Wiki.
run_phase linux-bundle 2 0
run_phase arm64-application 1 8 --builder
run_phase site-logo-amd64 2 "$app_gib"
run_phase site-logo-arm64 2 "$app_gib"
