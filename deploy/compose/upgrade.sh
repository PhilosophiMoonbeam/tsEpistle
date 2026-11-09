#!/usr/bin/env bash

# Prebuilt-only, fail-closed app-only upgrader; browser acceptance runs off-box.

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly CONTRACTS_FILE="server/db/migration-deployment-contracts.json"

COMMAND=""
PROFILE_FILE=""
TARGET_REVISION=""
PLAN_FILE=""
CONFIRM_DIGEST=""
CANDIDATE_IMAGE=""
CANDIDATE_ID=""
CANDIDATE_ARCH=""
OUTPUT_JSON=false
BROWSER_SMOKE_PASSED=false
TARGET_CONTRACTS=""
STATE_FILE=""

REPO_ROOT=""
COMPOSE_FILE=""
ENV_FILE=""
STATE_DIR=""
RECOVERY_DIR=""
PROJECT=""
APP_SERVICE=""
DB_SERVICE=""
IMAGE_REPOSITORY=""
PUBLIC_URL=""
PROXY_NETWORK=""
PROXY_ALIAS=""
PLAN_LIFETIME=3600
WAIT_TIMEOUT=300
APP_CONTAINER=""
DB_CONTAINER=""
OLD_APP_CONTAINER=""
TEMP_ROOT=""
TEST_APP=""
TEST_DB=""
TEST_NETWORK=""
OLD_APP_STOPPED=false
PROXY_GATED=false
RECREATE_BEGUN=false
MIGRATION_COMMITTED=false
RECOVERY_PATH=""
OLD_IMAGE_SETTING=""

declare -a CONTROL_URLS=()
declare -a SENTINELS=()
declare -A BASELINE_HASHES=()
declare -A SENTINEL_STATE=()

usage() {
  cat <<'EOF'
Usage:
  sudo deploy/compose/upgrade.sh plan --profile PATH --revision APP_SHA --image REPOSITORY@sha256:DIGEST [--json]
  sudo deploy/compose/upgrade.sh apply --plan PATH --confirm PLAN_SHA256
  sudo deploy/compose/upgrade.sh accept --plan PATH --confirm PLAN_SHA256 --browser-smoke-passed

`plan` validates a locally present immutable image and writes a private expiring
plan. `apply` recreates only the app and leaves it awaiting external browser
verification. `accept` binds trusted operator browser confirmation to that app.

The tool never fetches, pulls source, checks out a branch, recreates PostgreSQL,
restores data, runs down migrations, removes volumes, or touches sentinel
containers. Unknown migration or persistent-state risk stops at plan time.
EOF
}

log() { printf '[upgrade] %s\n' "$*"; }
warn() { printf '[upgrade] WARNING: %s\n' "$*" >&2; }
die() { printf '[upgrade] ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"; }

parse_args() {
  (( $# > 0 )) || { usage; exit 2; }
  COMMAND="$1"; shift
  case "$COMMAND" in plan|apply|accept) ;; -h|--help) usage; exit 0 ;; *) die "Unknown command: $COMMAND" ;; esac
  while (( $# > 0 )); do
    case "$1" in
      --profile) PROFILE_FILE="${2:-}"; shift 2 ;;
      --revision) TARGET_REVISION="${2:-}"; shift 2 ;;
      --image) CANDIDATE_IMAGE="${2:-}"; shift 2 ;;
      --json) OUTPUT_JSON=true; shift ;;
      --browser-smoke-passed) BROWSER_SMOKE_PASSED=true; shift ;;
      --plan) PLAN_FILE="${2:-}"; shift 2 ;;
      --confirm) CONFIRM_DIGEST="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  if [[ "$COMMAND" == plan ]]; then
    [[ -n "$PROFILE_FILE" && -n "$TARGET_REVISION" && -n "$CANDIDATE_IMAGE" ]] || die 'plan requires --profile, --revision and --image'
    [[ -z "$PLAN_FILE$CONFIRM_DIGEST" && "$BROWSER_SMOKE_PASSED" == false ]] || die 'plan does not accept plan confirmation or browser confirmation'
    [[ "$TARGET_REVISION" =~ ^[0-9a-f]{40}$ ]] || die '--revision must be a full lowercase 40-character commit SHA'
    [[ "$CANDIDATE_IMAGE" != -* && "$CANDIDATE_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || die '--image must be an immutable repository@sha256 digest reference'
  else
    [[ -n "$PLAN_FILE" && -n "$CONFIRM_DIGEST" ]] || die "$COMMAND requires --plan and --confirm"
    [[ -z "$PROFILE_FILE$TARGET_REVISION$CANDIDATE_IMAGE" && "$OUTPUT_JSON" == false ]] || die "$COMMAND reads bindings from its plan"
    if [[ "$COMMAND" == accept ]]; then
      [[ "$BROWSER_SMOKE_PASSED" == true ]] || die 'accept requires --browser-smoke-passed'
    else
      [[ "$BROWSER_SMOKE_PASSED" == false ]] || die 'apply does not accept browser confirmation'
    fi
  fi
}

validate_private_file() {
  local file="$1" label="$2" mode owner
  [[ -f "$file" && ! -L "$file" ]] || die "$label must be a regular non-symlink file: $file"
  mode="$(stat -c '%a' "$file")"; owner="$(stat -c '%u' "$file")"
  (( (8#$mode & 8#022) == 0 )) || die "$label must not be group/world writable: $file"
  (( owner == 0 || owner == $(id -u) )) || die "$label has an unexpected owner: $file"
}

load_profile() {
  validate_private_file "$PROFILE_FILE" 'Operator profile'
  [[ "$(stat -c '%u' "$PROFILE_FILE")" == 0 ]] || die 'Operator profile must be root-owned'
  jq -e '
    .schemaVersion == 1 and
    ([.repositoryRoot,.composeFile,.envFile,.stateDirectory,.recoveryDirectory,.project,.appService,.databaseService,.imageRepository,.publicUrl,.proxyNetwork,.proxyAlias] | all(type == "string" and length > 0)) and
    (.controlUrls | type == "array" and all(type == "string")) and
    (.sentinelContainers | type == "array" and all(type == "string" and length > 0)) and
    (.planLifetimeSeconds | type == "number" and . >= 300 and . <= 86400) and
    (.waitTimeoutSeconds | type == "number" and . >= 30 and . <= 1800)
  ' "$PROFILE_FILE" >/dev/null || die 'Operator profile schema is invalid'
  REPO_ROOT="$(jq -r '.repositoryRoot' "$PROFILE_FILE")"
  COMPOSE_FILE="$(jq -r '.composeFile' "$PROFILE_FILE")"
  ENV_FILE="$(jq -r '.envFile' "$PROFILE_FILE")"
  STATE_DIR="$(jq -r '.stateDirectory' "$PROFILE_FILE")"
  RECOVERY_DIR="$(jq -r '.recoveryDirectory' "$PROFILE_FILE")"
  PROJECT="$(jq -r '.project' "$PROFILE_FILE")"
  APP_SERVICE="$(jq -r '.appService' "$PROFILE_FILE")"
  DB_SERVICE="$(jq -r '.databaseService' "$PROFILE_FILE")"
  IMAGE_REPOSITORY="$(jq -r '.imageRepository' "$PROFILE_FILE")"
  PUBLIC_URL="$(jq -r '.publicUrl | sub("/$"; "")' "$PROFILE_FILE")"
  PROXY_NETWORK="$(jq -r '.proxyNetwork' "$PROFILE_FILE")"
  PROXY_ALIAS="$(jq -r '.proxyAlias' "$PROFILE_FILE")"
  PLAN_LIFETIME="$(jq -r '.planLifetimeSeconds' "$PROFILE_FILE")"
  WAIT_TIMEOUT="$(jq -r '.waitTimeoutSeconds' "$PROFILE_FILE")"
  mapfile -t CONTROL_URLS < <(jq -r '.controlUrls[] | sub("/$"; "")' "$PROFILE_FILE")
  mapfile -t SENTINELS < <(jq -r '.sentinelContainers[]' "$PROFILE_FILE")
  [[ "$REPO_ROOT" == /* && "$COMPOSE_FILE" == /* && "$ENV_FILE" == /* && "$STATE_DIR" == /* && "$RECOVERY_DIR" == /* ]] || die 'Profile paths must be absolute'
  [[ -d "$REPO_ROOT/.git" && -f "$COMPOSE_FILE" && -f "$ENV_FILE" ]] || die 'Profile repository/Compose/env path is unavailable'
  [[ "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || die 'Run the upgrader from the repository named by the profile'
}

compose() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
psql_live() { docker exec "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U wiki -d wiki "$@"; }

check_prerequisites() {
  for command in git docker jq curl tar sha256sum stat awk grep sed find install date mktemp diff flock; do require_command "$command"; done
  docker compose version >/dev/null
  [[ $(id -u) -eq 0 ]] || die 'Upgrade commands must run as root so private state can remain mode 0600'
  git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- || die 'Working tree has unstaged tracked changes'
  git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules -- || die 'Working tree has staged changes'
  [[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]] || die 'Working tree has untracked files'
  install -d -m 0700 "$STATE_DIR"
  exec 9>"$STATE_DIR/upgrade.lock"
  flock -n 9 || die 'Another upgrade operation is in progress'
}

resolve_containers() {
  APP_CONTAINER="$(compose ps -a -q "$APP_SERVICE")"
  DB_CONTAINER="$(compose ps -a -q "$DB_SERVICE")"
  [[ -n "$APP_CONTAINER" && -n "$DB_CONTAINER" ]] || die 'Canonical app/database containers were not found'
  [[ "$(docker inspect "$DB_CONTAINER" --format '{{.State.Running}}')" == true ]] || die 'Database container is not running'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}')" == "$PROJECT" ]] || die 'App container belongs to another Compose project'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}')" == "$APP_SERVICE" ]] || die 'App container has an unexpected service identity'
}

live_revision() {
  local image
  image="$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')"
  docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
}

ledger_json() {
  psql_live -Atc "SELECT COALESCE(json_agg(name ORDER BY id)::text,'[]') FROM migrations;"
}

ledger_summary() {
  psql_live -AtF '|' -c "SELECT count(*),COALESCE(max(batch),0),(array_agg(name ORDER BY id DESC))[1],(SELECT is_locked FROM migrations_lock) FROM migrations;"
}

source_migrations_json() {
  git -C "$REPO_ROOT" ls-tree -r --name-only "$TARGET_REVISION" -- server/db/migrations/ \
    | sed -n 's@^server/db/migrations/\(tsepistle-.*\)\.ts$@\1.js@p' | sort | jq -Rsc 'split("\n") | map(select(length > 0))'
}

target_file() { git -C "$REPO_ROOT" show "$TARGET_REVISION:$1"; }

load_target_metadata() {
  [[ "$TARGET_REVISION" =~ ^[0-9a-f]{40}$ ]] || die '--revision must be a full lowercase 40-character commit SHA'
  git -C "$REPO_ROOT" cat-file -e "$TARGET_REVISION^{commit}" 2>/dev/null || die 'Application revision Git object is absent locally'
  TARGET_CONTRACTS="$(target_file "$CONTRACTS_FILE")" || die 'Application revision has no migration contract registry'
  target_file package.json | jq -e '.version | type == "string" and length > 0' >/dev/null || die 'Application package metadata is invalid'
}

validate_candidate_image() {
  local metadata host_arch
  [[ "$CANDIDATE_IMAGE" != -* && "$CANDIDATE_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || die '--image must be an immutable repository@sha256 digest reference'
  [[ "${CANDIDATE_IMAGE%@*}" == "$IMAGE_REPOSITORY" ]] || die 'Candidate image repository does not match the operator profile'
  metadata="$(docker image inspect "$CANDIDATE_IMAGE")" || die 'Candidate image is absent locally; pull the immutable image before planning'
  host_arch="$(docker info --format '{{.Architecture}}')"
  case "$host_arch" in x86_64|amd64) host_arch=amd64 ;; aarch64|arm64) host_arch=arm64 ;; *) die 'Unsupported Docker host architecture' ;; esac
  jq -e --arg image "$CANDIDATE_IMAGE" --arg revision "$TARGET_REVISION" --arg architecture "$host_arch" '
    length == 1 and (.[0] |
      (.Id | test("^sha256:[0-9a-f]{64}$")) and
      ((.RepoDigests // []) | index($image) != null) and
      .Os == "linux" and .Architecture == $architecture and
      .Config.Labels["org.opencontainers.image.revision"] == $revision and
      .Config.Labels["org.opencontainers.image.source"] == "https://github.com/PhilosophiMoonbeam/tsEpistle" and
      .Config.Labels["io.tsepistle.image.architecture"] == $architecture)
  ' <<< "$metadata" >/dev/null || die 'Candidate image digest, full OCI revision, source, image ID or architecture mismatch'
  local image_id
  image_id="$(jq -r '.[0].Id' <<< "$metadata")"
  [[ -z "$CANDIDATE_ID" || "$image_id" == "$CANDIDATE_ID" ]] || die 'Candidate image ID changed after planning'
  CANDIDATE_ID="$image_id"; CANDIDATE_ARCH="$host_arch"
}

normalized_app_contract() {
  docker inspect "$APP_CONTAINER" | jq -S --arg proxyAlias "$PROXY_ALIAS" '.[0] | {
    name:.Name,user:.Config.User,restart:.HostConfig.RestartPolicy,readonly:.HostConfig.ReadonlyRootfs,
    portBindings:.HostConfig.PortBindings,exposedPorts:.Config.ExposedPorts,
    mounts:([.Mounts[]|{type:.Type,source:.Source,destination:.Destination,rw:.RW}]|sort_by(.destination)),
    networks:(.NetworkSettings.Networks|to_entries|map({name:.key,proxyAliasPresent:(.value.Aliases|index($proxyAlias) != null)})|sort_by(.name)),
    service:(.Config.Labels["com.docker.compose.service"]),project:(.Config.Labels["com.docker.compose.project"])
  }'
}

plan_digest() {
  jq -S -c 'del(.digest)' "$1" | sha256sum | cut -d' ' -f1
}

make_plan() {
  load_target_metadata
  validate_candidate_image
  resolve_containers
  local live_rev live_image lock ledger_count ledger_batch ledger_tail applied source pending changed_files
  live_rev="$(live_revision)"; live_image="$(docker inspect "$APP_CONTAINER" --format '{{.Config.Image}}')"
  [[ "$live_rev" =~ ^[0-9a-f]{40}$ ]] || die 'Live image has no valid full revision label'
  git -C "$REPO_ROOT" cat-file -e "$live_rev^{commit}" 2>/dev/null || die 'Live revision is absent from the checkout'
  git -C "$REPO_ROOT" merge-base --is-ancestor "$live_rev" "$TARGET_REVISION" || die 'Target is not a descendant of the live revision'
  [[ "$live_rev" != "$TARGET_REVISION" ]] || die 'Requested revision is already deployed'
  IFS='|' read -r ledger_count ledger_batch ledger_tail lock <<< "$(ledger_summary)"
  [[ "$lock" == 0 ]] || die 'Migration ledger is locked'
  applied="$(ledger_json)"; source="$(source_migrations_json)"
  pending="$(jq -cn --argjson applied "$applied" --argjson source "$source" '$source - $applied')"
  changed_files="$(git -C "$REPO_ROOT" diff --name-only "$live_rev..$TARGET_REVISION" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  [[ "$(jq 'length' <<< "$changed_files")" -gt 0 ]] || die 'No changed files exist between live and target revisions'

  local path migration_name
  while IFS= read -r path; do
    [[ "$path" == server/db/migrations/*.ts ]] || continue
    migration_name="${path##*/}"; migration_name="${migration_name%.ts}.js"
    if jq -e --arg name "$migration_name" 'index($name) != null' <<< "$applied" >/dev/null; then
      die "Already-applied migration changed or was removed: $migration_name"
    fi
  done < <(git -C "$REPO_ROOT" diff --no-renames --name-only --diff-filter=MD "$live_rev..$TARGET_REVISION")

  local registry="$TARGET_CONTRACTS" enforce sequence contract recovery=false rehearsal=false rollback='image-only'
  jq -e '.schemaVersion == 1 and (.enforceFromSequence | type == "number") and (.migrations | type == "object")' <<< "$registry" >/dev/null || die 'Migration deployment contract registry is invalid'
  enforce="$(jq -r '.enforceFromSequence' <<< "$registry")"
  while IFS= read -r migration_name; do
    [[ -n "$migration_name" ]] || continue
    [[ "$migration_name" =~ ^tsepistle-([0-9]{6})-.+\.js$ ]] || die "Unsupported pending migration identity: $migration_name"
    sequence=$((10#${BASH_REMATCH[1]}))
    (( sequence >= enforce )) || die "Pending migration predates deployment-contract enforcement: $migration_name"
    contract="$(jq -ce --arg name "$migration_name" '.migrations[$name] // empty' <<< "$registry")" || die "Pending migration has no deployment contract: $migration_name"
    [[ -n "$contract" ]] || die "Pending migration has no deployment contract: $migration_name"
    jq -e '
      (.persistentState | IN("none","additive","stateful","destructive")) and
      (.reversible | type == "boolean") and
      (.writerCompatibility | IN("compatible","breaking")) and
      (.drain | IN("graceful","required")) and
      (.rehearsal | IN("none","required")) and
      (.recovery | IN("none","paired")) and
      (.rollback | IN("image-only","fix-forward-or-restore")) and
      (.rehearsalPostconditions | type == "array") and
      (.runtimePostconditions | type == "array") and
      ((.rehearsalPostconditions | length) + (.runtimePostconditions | length) > 0)
    ' <<< "$contract" >/dev/null || die "Incomplete deployment contract: $migration_name"
    local probe
    while IFS= read -r probe; do
      case "$probe" in
        site-logo-schema-v7|site-logo-pipeline-v7|agent-goal-budget-columns|agent-goal-budget-tier-selection|agent-google-search-grounding-columns|agent-google-search-consent-admission|agent-media-context-state-columns|native-page-ratings-and-recovery-schema|native-page-ratings-and-recovery) ;;
        agent-quota-daily-token-reset-credit-column|agent-media-table|agent-runs-media-request-column|native-gemini-profile-reconformance|historical-agent-content-retained|native-gemini-generate-content|retired-live-google-search-disabled|external-mcp-owner-isolation-and-grants|guarded-native-external-mcp-discovery-and-invocation|independent-decision-provider-configuration|native-typesafe-environment-fallback-and-validated-usage|immutable-model-task-declarations-and-routing-policy|eligible-owner-routing-and-accounted-safe-fallback|independent-draft-root-preserves-legacy-ciphertext|offline-draft-key-survives-session-protection-rotation|owner-root-bound-specialist-context-and-idempotent-invocation|delegated-context-reuse-preserves-incumbent-root-and-accounting|independent-media-provider-versions-preserve-legacy-models-prices-grants-and-credentials|authorized-current-media-version-bindings-and-retained-credentials) ;;
        native-page-creation-receipts-schema|native-live-notes-schema|native-glossary-schema|native-discussion-annotations-schema|native-discussion-notifications-schema|native-account-profile-schema|native-links-grid-registration) ;;
        native-page-accuracy-attestations-schema|native-page-history-reasons-schema) ;;
        native-browser-session-retirement-schema|native-hedgedoc-import-schema|native-page-feedback-schema|native-page-review-routing-schema|native-page-lifecycle-schema|native-governed-notifications-schema) ;;
        native-storage-page-import-owners-schema) ;;
        personal-mcp-credential-kind-and-owner-schema) ;;
        external-mcp-oauth-grants-and-pending-schema|external-mcp-generic-oauth-schema|external-mcp-retired-oauth-configuration-schema) ;;
        *) die "Unsupported named migration postcondition: $probe" ;;
      esac
    done < <(jq -r '.rehearsalPostconditions[],.runtimePostconditions[]' <<< "$contract")
    if [[ "$(jq -r '.rehearsal' <<< "$contract")" == required ]]; then rehearsal=true; fi
    if [[ "$(jq -r '.recovery' <<< "$contract")" == paired ]]; then recovery=true; fi
    if [[ "$(jq -r '.rollback' <<< "$contract")" == fix-forward-or-restore ]]; then rollback='fix-forward-or-restore'; fi
  done < <(jq -r '.[]' <<< "$pending")
  if [[ "$(jq 'length' <<< "$pending")" -gt 0 && "$rollback" == image-only ]]; then
    die 'A committed migration cannot be rolled back by image alone; require fix-forward-or-restore'
  fi

  if jq -e 'any(.[]; test("^(deploy/compose/compose\\.yml|dev/build/Dockerfile|server/(agents/(crypto|provider-secrets|profile-resolution)|modules/storage|repositories/storage|core/durable-jobs)|shared/agent-provider)"))' <<< "$changed_files" >/dev/null; then
    [[ "$(jq 'length' <<< "$pending")" -gt 0 ]] || die 'Delta touches a persistent/key/storage/topology risk path without a migration deployment contract'
  fi
  jq -e 'any(.[]; . == "deploy/compose/compose.yml")' <<< "$changed_files" >/dev/null && die 'Compose topology changed; app-only automation is unsupported'

  local version now expires run_dir draft digest plan_path contract_sha profile_sha app_contract_sha sentinel_inventory operator_head
  version="$(target_file package.json | jq -er '.version')"
  operator_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  now="$(date -u +%s)"; expires=$((now + PLAN_LIFETIME))
  run_dir="$STATE_DIR/upgrade-runs"; install -d -m 0700 "$run_dir"
  plan_path="$(mktemp "$run_dir/$(date -u +%Y%m%dT%H%M%SZ)-${TARGET_REVISION:0:8}.XXXXXX.json")"
  draft="$(mktemp "$run_dir/.plan.XXXXXX")"
  profile_sha="$(sha256sum "$PROFILE_FILE" | cut -d' ' -f1)"
  contract_sha="$(printf '%s' "$TARGET_CONTRACTS" | sha256sum | cut -d' ' -f1)"
  app_contract_sha="$(normalized_app_contract | sha256sum | cut -d' ' -f1)"
  sentinel_inventory="$({
    for path in "$DB_CONTAINER" "${SENTINELS[@]}"; do
      docker inspect "$path" --format '{{json .}}' || die "Sentinel container not found: $path"
    done
  } | jq -sc 'map({name:.Name,id:.Id,image:.Config.Image}) | unique_by(.id) | sort_by(.name)')"
  jq -n \
    --arg profile "$PROFILE_FILE" --arg profileSha "$profile_sha" --arg target "$TARGET_REVISION" --arg live "$live_rev" \
    --arg liveImage "$live_image" --arg candidateImage "$CANDIDATE_IMAGE" --arg appId "$APP_CONTAINER" --arg dbId "$DB_CONTAINER" \
    --arg candidateId "$CANDIDATE_ID" --arg architecture "$CANDIDATE_ARCH" --arg operatorHead "$operator_head" --arg version "$version" --arg publicUrl "$PUBLIC_URL" \
    --arg ledgerTail "$ledger_tail" --arg contractSha "$contract_sha" --arg appContractSha "$app_contract_sha" \
    --argjson createdAt "$now" --argjson expiresAt "$expires" --argjson ledgerCount "$ledger_count" --argjson ledgerBatch "$ledger_batch" \
    --argjson changes "$changed_files" --argjson migrations "$pending" --argjson sentinels "$sentinel_inventory" \
    --argjson recovery "$recovery" --argjson rehearsal "$rehearsal" --arg rollback "$rollback" \
    '{schemaVersion:2,phase:"planned",profile:$profile,profileSha256:$profileSha,createdAt:$createdAt,expiresAt:$expiresAt,
      operatorRevision:$operatorHead,targetRevision:$target,applicationVersion:$version,publicUrl:$publicUrl,
      liveRevision:$live,liveImage:$liveImage,candidateImage:$candidateImage,candidateImageId:$candidateId,candidateArchitecture:$architecture,appContainerId:$appId,databaseContainerId:$dbId,
      migrationLedger:{count:$ledgerCount,batch:$ledgerBatch,tail:$ledgerTail},sentinelInventory:$sentinels,
      changedFiles:$changes,pendingMigrations:$migrations,
      risk:{rehearsalRequired:$rehearsal,recoveryRequired:$recovery,rollback:$rollback},
      migrationContractsSha256:$contractSha,appRuntimeContractSha256:$appContractSha}' > "$draft"
  chmod 0600 "$draft"; digest="$(plan_digest "$draft")"
  jq --arg digest "$digest" '. + {digest:$digest}' "$draft" > "$plan_path"
  chmod 0600 "$plan_path"; unlink "$draft"
  if [[ "$OUTPUT_JSON" == true ]]; then
    jq -cn --arg plan "$plan_path" --arg digest "$digest" --arg revision "$TARGET_REVISION" --arg operatorRevision "$operator_head" --arg image "$CANDIDATE_IMAGE" --arg imageId "$CANDIDATE_ID" --arg publicUrl "$PUBLIC_URL" \
      '{schemaVersion:1,plan:$plan,confirm:$digest,operatorRevision:$operatorRevision,targetRevision:$revision,candidateImage:$image,candidateImageId:$imageId,publicUrl:$publicUrl}'
  else
    log "Plan: $plan_path"
    log "Digest: $digest"
    log "Delta: $(jq 'length' <<< "$changed_files") files; $(jq 'length' <<< "$pending") pending migrations"
    log "Risk: rehearsal=$rehearsal recovery=$recovery rollback=$rollback"
    printf '\nApply only after reviewing the plan:\n  sudo %q apply --plan %q --confirm %q\n' "$SCRIPT_DIR/upgrade.sh" "$plan_path" "$digest"
  fi
}

validate_plan() {
  validate_private_file "$PLAN_FILE" 'Deployment plan'
  jq -e '.schemaVersion == 2 and .phase == "planned" and (.digest | type == "string")' "$PLAN_FILE" >/dev/null || die 'Deployment plan schema is invalid'
  [[ "$(plan_digest "$PLAN_FILE")" == "$CONFIRM_DIGEST" && "$(jq -r '.digest' "$PLAN_FILE")" == "$CONFIRM_DIGEST" ]] || die 'Plan digest confirmation does not match'
  (( $(date -u +%s) <= $(jq -r '.expiresAt' "$PLAN_FILE") )) || die 'Deployment plan expired; create a new plan'
}

load_bound_plan() {
  PROFILE_FILE="$(jq -r '.profile' "$PLAN_FILE")"; load_profile; check_prerequisites
  [[ "$(sha256sum "$PROFILE_FILE" | cut -d' ' -f1)" == "$(jq -r '.profileSha256' "$PLAN_FILE")" ]] || die 'Operator profile changed after planning'
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$(jq -r '.operatorRevision' "$PLAN_FILE")" ]] || die 'Operator HEAD changed after planning'
  TARGET_REVISION="$(jq -r '.targetRevision' "$PLAN_FILE")"
  load_target_metadata
  [[ "$(printf '%s' "$TARGET_CONTRACTS" | sha256sum | cut -d' ' -f1)" == "$(jq -r '.migrationContractsSha256' "$PLAN_FILE")" ]] || die 'Application migration contracts changed after planning'
  CANDIDATE_IMAGE="$(jq -r '.candidateImage' "$PLAN_FILE")"; CANDIDATE_ID="$(jq -r '.candidateImageId' "$PLAN_FILE")"
  validate_candidate_image
  STATE_FILE="${PLAN_FILE}.state.json"
  resolve_containers
}

load_apply_plan() {
  load_bound_plan
  [[ ! -e "$STATE_FILE" ]] || die 'Plan has already been applied or attempted; inspect its deployment state'
  [[ "$(live_revision)" == "$(jq -r '.liveRevision' "$PLAN_FILE")" ]] || die 'Live revision changed after planning'
  [[ "$APP_CONTAINER" == "$(jq -r '.appContainerId' "$PLAN_FILE")" && "$DB_CONTAINER" == "$(jq -r '.databaseContainerId' "$PLAN_FILE")" ]] || die 'App/database container identity changed after planning'
  [[ "$(ledger_summary | cut -d'|' -f1-3)" == "$(jq -r '[.migrationLedger.count,.migrationLedger.batch,.migrationLedger.tail]|join("|")' "$PLAN_FILE")" ]] || die 'Migration ledger changed after planning'
  [[ "$(ledger_summary | cut -d'|' -f4)" == 0 ]] || die 'Migration ledger became locked'
  [[ "$(normalized_app_contract | sha256sum | cut -d' ' -f1)" == "$(jq -r '.appRuntimeContractSha256' "$PLAN_FILE")" ]] || die 'App runtime contract changed after planning'
  local sentinel
  while IFS= read -r sentinel; do
    [[ "$(docker inspect "$(jq -r '.name' <<< "$sentinel")" --format '{{.Id}}')" == "$(jq -r '.id' <<< "$sentinel")" ]] || die 'A sentinel container changed after planning'
  done < <(jq -c '.sentinelInventory[]' "$PLAN_FILE")
}

cleanup_temp() {
  [[ -z "$TEST_APP" ]] || docker container rm --force --volumes "$TEST_APP" >/dev/null 2>&1 || true
  [[ -z "$TEST_DB" ]] || docker container rm --force --volumes "$TEST_DB" >/dev/null 2>&1 || true
  [[ -z "$TEST_NETWORK" ]] || docker network rm "$TEST_NETWORK" >/dev/null 2>&1 || true
  if [[ -n "$TEMP_ROOT" && "$TEMP_ROOT" == /opt/tsepistle-upgrade.* && -d "$TEMP_ROOT" ]]; then find "$TEMP_ROOT" -depth -delete; fi
}

on_exit() {
  local status=$?
  cleanup_temp
  if (( status != 0 )); then
    if [[ "$OLD_APP_STOPPED" == true && "$RECREATE_BEGUN" == false ]]; then
      warn 'Failure occurred before candidate start; restarting the unchanged old app.'
      [[ -z "$OLD_IMAGE_SETTING" ]] || set_candidate_image "$OLD_IMAGE_SETTING"
      docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
      if [[ "$PROXY_GATED" == true ]]; then docker network connect --alias "$PROXY_ALIAS" "$PROXY_NETWORK" "$APP_CONTAINER" >/dev/null 2>&1 || true; fi
    elif [[ "$RECREATE_BEGUN" == true && -n "$OLD_APP_CONTAINER" ]] && docker inspect "$OLD_APP_CONTAINER" >/dev/null 2>&1; then
      warn 'Candidate creation failed before replacing the old container; restarting the unchanged old app.'
      [[ -z "$OLD_IMAGE_SETTING" ]] || set_candidate_image "$OLD_IMAGE_SETTING"
      docker start "$OLD_APP_CONTAINER" >/dev/null 2>&1 || true
      if [[ "$PROXY_GATED" == true ]]; then docker network connect --alias "$PROXY_ALIAS" "$PROXY_NETWORK" "$OLD_APP_CONTAINER" >/dev/null 2>&1 || true; fi
    elif [[ "$RECREATE_BEGUN" == true ]]; then
      if [[ "$(ledger_summary | cut -d'|' -f1)" -gt "$(jq -r '.migrationLedger.count' "$PLAN_FILE")" ]]; then MIGRATION_COMMITTED=true; fi
      if [[ "$PROXY_GATED" == true ]]; then
        warn 'Candidate verification failed; admission remains gated. Health alone does not authorize reconnecting the candidate.'
      fi
      warn 'Candidate recreation began; no automatic rollback was attempted.'
      [[ "$MIGRATION_COMMITTED" == false ]] || warn 'A migration committed. Never start the old image against this database.'
      [[ -z "$RECOVERY_PATH" ]] || warn "Recovery point: $RECOVERY_PATH"
    fi
  fi
  exit "$status"
}

write_state() {
  local phase="$1" temp env_sha contract_sha private_sha started_at protected ledger
  env_sha="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" || die 'Cannot fingerprint deployment environment'
  contract_sha="$(normalized_app_contract | sha256sum | cut -d' ' -f1)" || die 'Cannot fingerprint app runtime contract'
  private_sha="$(private_files_fingerprints | sha256sum | cut -d' ' -f1)" || die 'Cannot fingerprint configuration/secrets'
  started_at="$(docker inspect "$APP_CONTAINER" --format '{{.State.StartedAt}}')" || die 'Cannot identify applied app start'
  protected="$(protected_container_state)" || die 'Cannot inventory protected containers'
  ledger="$(ledger_json)" || die 'Cannot read applied migration ledger'
  temp="$(mktemp "${STATE_FILE}.XXXXXX")"
  jq -n --arg phase "$phase" --arg digest "$CONFIRM_DIGEST" --arg app "$APP_CONTAINER" --arg db "$DB_CONTAINER" \
    --arg imageId "$CANDIDATE_ID" --arg recovery "$RECOVERY_PATH" --argjson at "$(date -u +%s)" \
    --arg envSha "$env_sha" --arg contractSha "$contract_sha" --arg privateSha "$private_sha" \
    --arg startedAt "$started_at" --argjson protected "$protected" --argjson ledger "$ledger" \
    '{schemaVersion:1,phase:$phase,planDigest:$digest,appContainerId:$app,databaseContainerId:$db,candidateImageId:$imageId,
      updatedAt:$at,recoveryPath:$recovery,envSha256:$envSha,privateFilesSha256:$privateSha,appStartedAt:$startedAt,
      protectedContainers:$protected,appRuntimeContractSha256:$contractSha,migrationLedger:$ledger,
      browserSmokePassed:false,browserVerification:null}' > "$temp"
  install -m 0600 "$temp" "$STATE_FILE"; unlink "$temp"
}

wait_health() {
  local container="$1" elapsed=0 status
  while (( elapsed < WAIT_TIMEOUT )); do
    status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == exited || "$status" == unhealthy || "$status" == dead ]] && return 1
    sleep 2; (( elapsed += 2 ))
  done
  return 1
}

rehearse_migrations() {
  [[ "$(jq -r '.risk.rehearsalRequired' "$PLAN_FILE")" == true ]] || return 0
  local token db_image config_source db_user db_name before after lock candidate
  TEMP_ROOT="$(mktemp -d /opt/tsepistle-upgrade.XXXXXX)"; chmod 0700 "$TEMP_ROOT"; install -d -m 0750 -o 1000 -g 1000 "$TEMP_ROOT/data"
  token="upgrade-$RANDOM-$$"; TEST_NETWORK="$token-network"; TEST_DB="$token-database"; TEST_APP="$token-migrator"
  db_image="$(docker inspect "$DB_CONTAINER" --format '{{.Config.Image}}')"
  config_source="$(docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/wiki/config.yml"}}{{.Source}}{{end}}{{end}}')"
  db_user="$(docker exec "$DB_CONTAINER" sh -ec 'printf %s "$POSTGRES_USER"')"; db_name="$(docker exec "$DB_CONTAINER" sh -ec 'printf %s "$POSTGRES_DB"')"
  candidate="$(jq -r '.candidateImage' "$PLAN_FILE")"
  docker exec "$DB_CONTAINER" sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$TEMP_ROOT/live.pgdump"; chmod 0600 "$TEMP_ROOT/live.pgdump"
  docker network create --internal "$TEST_NETWORK" >/dev/null
  docker run -d --name "$TEST_DB" --network "$TEST_NETWORK" --network-alias database \
    -e "POSTGRES_DB=$db_name" -e "POSTGRES_USER=$db_user" -e POSTGRES_PASSWORD_FILE=/run/secrets/db-password \
    -v "$STATE_DIR/app-db-password:/run/secrets/db-password:ro" "$db_image" >/dev/null
  local i
  for i in $(seq 1 60); do docker exec "$TEST_DB" pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1 && break; (( i < 60 )) || die 'Rehearsal PostgreSQL failed readiness'; sleep 1; done
  docker exec -i "$TEST_DB" pg_restore -U "$db_user" -d "$db_name" --no-owner < "$TEMP_ROOT/live.pgdump"
  before="$(docker exec "$TEST_DB" psql -X -U "$db_user" -d "$db_name" -Atc 'SELECT count(*) FROM migrations;')"
  docker run --pull never --name "$TEST_APP" --network "$TEST_NETWORK" \
    -e TSEPISTLE_MIGRATION_ONLY=1 -e CONFIG_FILE=/wiki/config.yml -e DB_PASS_FILE=/run/secrets/db-password \
    -v "$config_source:/wiki/config.yml:ro" -v "$TEMP_ROOT/data:/wiki/data" -v "$STATE_DIR/app-db-password:/run/secrets/db-password:ro" \
    "$candidate" >/dev/null
  [[ "$(docker inspect "$TEST_APP" --format '{{.State.ExitCode}}')" == 0 ]] || { docker logs "$TEST_APP" >&2; die 'Migration-only rehearsal failed'; }
  after="$(docker exec "$TEST_DB" psql -X -U "$db_user" -d "$db_name" -Atc 'SELECT count(*) FROM migrations;')"
  lock="$(docker exec "$TEST_DB" psql -X -U "$db_user" -d "$db_name" -Atc 'SELECT is_locked FROM migrations_lock;')"
  (( after - before == $(jq '.pendingMigrations|length' "$PLAN_FILE") )) || die 'Rehearsal ledger suffix did not match the plan'
  [[ "$lock" == 0 ]] || die 'Rehearsal migration lock remained set'
  verify_postconditions rehearsalPostconditions "$TEST_DB" "$db_user" "$db_name"
  log "Migration-only rehearsal passed: ledger $before -> $after"
  cleanup_temp; TEMP_ROOT=""; TEST_APP=""; TEST_DB=""; TEST_NETWORK=""
}

verify_native_page_schema() {
  local container="$1" user="$2" database="$3" result
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    WITH expected(table_name, column_name, data_type, max_length, nullable, default_kind) AS (VALUES
      ('users','reduceMotion','boolean',NULL,'NO','false'),
      ('users','underlineLinks','boolean',NULL,'NO','false'),
      ('users','contentTextSize','character varying',16,'NO','default'),
      ('users','communicationLocale','character varying',35,'YES','none'),
      ('pageRatings','pageId','integer',NULL,'NO','none'),
      ('pageRatings','userId','integer',NULL,'NO','none'),
      ('pageRatings','kind','character varying',8,'NO','none'),
      ('pageRatings','value','integer',NULL,'NO','none'),
      ('pageRatings','createdAt','timestamp with time zone',NULL,'NO','none'),
      ('pageRatings','updatedAt','timestamp with time zone',NULL,'NO','none'),
      ('deletedPageRecovery','pageId','integer',NULL,'NO','none'),
      ('deletedPageRecovery','deletionVersionId','integer',NULL,'NO','none'),
      ('deletedPageRecovery','deletionRevision','bigint',NULL,'NO','none'),
      ('deletedPageRecovery','securityContext','jsonb',NULL,'NO','none'),
      ('deletedPageRecovery','createdAt','timestamp with time zone',NULL,'NO','none')
    )
    SELECT count(*) FROM expected e JOIN information_schema.columns c
      ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
    WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length
      AND c.is_nullable=e.nullable AND (
        (e.default_kind='none' AND c.column_default IS NULL) OR
        (e.default_kind='false' AND c.column_default='false') OR
        (e.default_kind='default' AND c.column_default LIKE '''default''%')
      );")"
  [[ "$result" == 15 ]] || die "Postcondition failed: native-page-ratings-and-recovery-schema ($result/15 columns)"

  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    WITH expected(name, table_name, kind, target_table, delete_mode) AS (VALUES
      ('users_content_text_size_check','users','c',NULL,NULL),
      ('users_communication_locale_fk','users','f','locales','n'),
      ('page_ratings_page_fk','pageRatings','f','pages','c'),
      ('page_ratings_user_fk','pageRatings','f','users','c'),
      ('page_ratings_page_user_unique','pageRatings','u',NULL,NULL),
      ('page_ratings_kind_value_check','pageRatings','c',NULL,NULL),
      ('deleted_page_recovery_pkey','deletedPageRecovery','p',NULL,NULL),
      ('deleted_page_recovery_history_fk','deletedPageRecovery','f','pageHistory','c')
    )
    SELECT count(*) FROM expected e JOIN pg_constraint c ON c.conname=e.name
      JOIN pg_class t ON t.oid=c.conrelid AND t.relname=e.table_name
    WHERE t.relnamespace=current_schema()::regnamespace AND c.contype::text=e.kind
      AND (e.target_table IS NULL OR c.confrelid=to_regclass(format('%I',e.target_table)))
      AND (e.delete_mode IS NULL OR c.confdeltype::text=e.delete_mode);")"
  [[ "$result" == 8 ]] || die "Postcondition failed: native-page-ratings-and-recovery-schema ($result/8 constraints)"

  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    SELECT count(*) FROM pg_class t JOIN pg_index i ON i.indrelid=t.oid
      JOIN pg_class idx ON idx.oid=i.indexrelid
    WHERE t.relnamespace=current_schema()::regnamespace AND (
      (t.relname='pageRatings' AND idx.relname='page_ratings_page_kind_idx'
        AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='pageId'
        AND replace(pg_get_indexdef(idx.oid,2,true),'\"','')='kind') OR
      (t.relname='deletedPageRecovery' AND idx.relname='deleted_page_recovery_version_idx'
        AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='deletionVersionId'
        AND i.indnkeyatts=1)
    );")"
  [[ "$result" == 2 ]] || die "Postcondition failed: native-page-ratings-and-recovery-schema ($result/2 indexes)"
}

verify_page_accuracy_schema() {
  local container="$1" user="$2" database="$3" result
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    WITH expected(column_name, data_type, nullable) AS (VALUES
      ('id','uuid','NO'), ('pageId','integer','NO'), ('sourceRevision','bigint','NO'),
      ('verifiedBy','integer','YES'), ('verifiedAt','timestamp with time zone','NO')
    )
    SELECT count(*) FROM expected e JOIN information_schema.columns c
      ON c.table_schema=current_schema() AND c.table_name='pageAccuracyAttestations' AND c.column_name=e.column_name
    WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable AND c.column_default IS NULL;")"
  [[ "$result" == 5 ]] || die "Postcondition failed: native-page-accuracy-attestations-schema ($result/5 columns)"
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND c.conkey=ARRAY[a.attnum]
    WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='pageAccuracyAttestations' AND c.convalidated AND (
      (c.contype='p' AND a.attname='id') OR
      (c.contype='f' AND a.attname='pageId' AND c.confrelid=to_regclass('pages') AND c.confdeltype='c'
        AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('pages') AND attname='id')]) OR
      (c.contype='f' AND a.attname='verifiedBy' AND c.confrelid=to_regclass('users') AND c.confdeltype='n'
        AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('users') AND attname='id')]) OR
      (c.contype='c' AND c.conname='page_accuracy_source_revision_check'
        AND regexp_replace(replace(pg_get_constraintdef(c.oid),'\"',''),'[[:space:]()]','','g')
          IN ('CHECKsourceRevision>0','CHECKsourceRevision>0::bigint'))
    );")"
  [[ "$result" == 4 ]] || die "Postcondition failed: native-page-accuracy-attestations-schema ($result/4 constraints)"
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    SELECT count(*) FROM pg_class t JOIN pg_index i ON i.indrelid=t.oid
      JOIN pg_class idx ON idx.oid=i.indexrelid
    WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='pageAccuracyAttestations'
      AND idx.relname='page_accuracy_current_revision_idx' AND i.indisvalid AND i.indisready AND i.indnkeyatts=4
      AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='pageId'
      AND replace(pg_get_indexdef(idx.oid,2,true),'\"','')='sourceRevision'
      AND replace(pg_get_indexdef(idx.oid,3,true),'\"','')='verifiedAt'
      AND replace(pg_get_indexdef(idx.oid,4,true),'\"','')='id';")"
  [[ "$result" == 1 ]] || die "Postcondition failed: native-page-accuracy-attestations-schema ($result/1 indexes)"
}

verify_page_history_reasons_schema() {
  local container="$1" user="$2" database="$3" result
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name IN ('pages','pageHistory')
      AND column_name='changeReason' AND data_type='character varying'
      AND character_maximum_length=200 AND is_nullable='YES' AND column_default IS NULL;")"
  [[ "$result" == 2 ]] || die "Postcondition failed: native-page-history-reasons-schema ($result/2 columns)"
  result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
    WITH source_columns AS (
      SELECT column_name, position FROM unnest(ARRAY[
        'path','hash','title','description','visibility','ownerId','isPublished','isSearchable',
        'publishStartDate','publishEndDate','content','contentType','editorKey','localeCode',
        'authorId','creatorId','changeReason'
      ]) WITH ORDINALITY AS columns(column_name, position)
    ), expected AS (
      SELECT 'BEGIN IF ROW(' || string_agg(format('NEW.\"%s\"',column_name), ', ' ORDER BY position)
        || ', NEW.extra::text) IS DISTINCT FROM ROW('
        || string_agg(format('OLD.\"%s\"',column_name), ', ' ORDER BY position)
        || ', OLD.extra::text) THEN NEW.\"sourceRevision\" := OLD.\"sourceRevision\" + 1; END IF; RETURN NEW; END;' AS body
      FROM source_columns
    )
    SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
      CROSS JOIN expected e
    WHERE c.relnamespace=current_schema()::regnamespace AND c.relname='pages'
      AND t.tgname='pages_source_revision_trigger' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND t.tgattr::text=''
      AND t.tgqual IS NULL AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgconstraint=0
      AND p.pronamespace=c.relnamespace AND p.proname='wiki_increment_page_source_revision'
      AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND l.lanname='plpgsql'
      AND regexp_replace(p.prosrc,'[[:space:]]','','g')
        = regexp_replace(e.body,'[[:space:]]','','g');")"
  [[ "$result" == 1 ]] || die "Postcondition failed: native-page-history-reasons-schema ($result/1 source-revision trigger)"
}

verify_postconditions() {
  local phase="$1" container="$2" user="$3" database="$4" probe result
  while IFS= read -r probe; do
    case "$probe" in
      site-logo-schema-v7)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM pg_trigger WHERE tgname IN ('\''site_logo_revision_writer_fence_trigger'\'','\''site_logo_state_writer_fence_trigger'\'') AND NOT tgisinternal;')"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result)"
        ;;
      site-logo-pipeline-v7)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT r."pipelineVersion"||'\''|'\''||r.status||'\''|'\''||(s."activeRevisionId"=s."desiredRevisionId") FROM "siteLogoState" s JOIN "siteLogoRevisions" r ON r.id=s."activeRevisionId";')"
        [[ "$result" == '7|ready|t' ]] || die "Postcondition failed: $probe ($result)"
        ;;
      agent-goal-budget-columns)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agentGoals' AND column_name IN ('budgetPolicyVersion','budgetSelection','tokenTier','tokenAllowance','budgetCycle','budgetLimitReason');")"
        [[ "$result" == 6 ]] || die "Postcondition failed: $probe ($result/6 columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conname IN ('agent_goals_budget_selection_check','agent_goals_budget_tier_check','agent_goals_budget_limit_reason_check');")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 constraints)"
        ;;
      agent-goal-budget-tier-selection)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentGoals\" WHERE (\"budgetSelection\"='legacy' AND (\"budgetPolicyVersion\" IS NOT NULL OR \"tokenTier\" IS NOT NULL OR \"tokenAllowance\" IS NOT NULL OR \"budgetCycle\" IS DISTINCT FROM 0)) OR (\"budgetSelection\"='pending' AND (\"budgetPolicyVersion\" IS DISTINCT FROM 2 OR \"tokenTier\" IS NOT NULL OR \"tokenAllowance\" IS NOT NULL OR \"budgetCycle\" IS DISTINCT FROM 0)) OR (\"budgetSelection\" IN ('utility','fallback') AND (\"budgetPolicyVersion\" NOT IN (1,2) OR \"tokenTier\" IS NULL OR (\"budgetPolicyVersion\"=1 AND \"tokenTier\"='small') OR \"tokenAllowance\" IS NULL OR \"budgetCycle\" IS NULL OR \"budgetCycle\"<1));")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result inconsistent goals)"
        ;;
      agent-google-search-grounding-columns)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name IN ('agentSessions','agentRuns') AND column_name='googleSearchEnabled' AND data_type='boolean' AND is_nullable='NO' AND column_default='false') OR (table_name='agentMessages' AND column_name='googleSearchGrounding' AND data_type='text' AND is_nullable='YES'));")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 columns)"
        ;;
      agent-google-search-consent-admission)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentRuns\" WHERE \"googleSearchEnabled\" AND (\"transportKind\" <> 'gemini-api' OR model !~ '^gemini-3(\\.[0-9]+)?(-[a-z0-9][a-z0-9._-]*)?$');")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result incompatible search runs)"
        ;;
      agent-media-context-state-columns)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agentMedia' AND ((column_name='promptTokens' AND data_type='integer' AND is_nullable='YES') OR (column_name='detachedAt' AND data_type='timestamp with time zone' AND is_nullable='YES'));")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 columns)"
        ;;
      native-page-history-reasons-schema)
        verify_page_history_reasons_schema "$container" "$user" "$database"
        ;;
      native-page-accuracy-attestations-schema)
        verify_page_accuracy_schema "$container" "$user" "$database"
        ;;
      native-page-ratings-and-recovery-schema)
        verify_native_page_schema "$container" "$user" "$database"
        ;;
      native-page-ratings-and-recovery)
        verify_native_page_schema "$container" "$user" "$database"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "deletedPageRecovery" r LEFT JOIN "pageHistory" h ON h.id=r."deletionVersionId" WHERE h.id IS NULL OR h."pageId"<>r."pageId" OR h.action<> '\''deleted'\'' OR jsonb_typeof(r."securityContext")<> '\''object'\'';')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid recovery records)"
        ;;
      # These read-only probes check persisted prerequisites and invariants.
      # Native transport, cancellation and key-rotation behavior are exercised by the native suites.
      agent-quota-daily-token-reset-credit-column)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agentQuotaDaily' AND column_name='tokenResetCredit' AND data_type='bigint' AND is_nullable='NO' AND column_default IN ('0', '''0''::bigint');")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (credit column)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conrelid='\"agentQuotaDaily\"'::regclass AND conname='agent_quota_daily_token_reset_credit_check' AND contype='c' AND convalidated;")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (credit bound constraint)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentQuotaDaily\" WHERE \"tokenResetCredit\" < 0 OR \"tokenResetCredit\" > 9007199254740991;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid credits)"
        ;;
      agent-media-table)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agentMedia' AND column_name IN ('id','ownerId','sessionId','messageId','runId','kind','mimeType','filename','byteLength','sha256','payload','createdAt','expiresAt','metadata');")"
        [[ "$result" == 14 ]] || die "Postcondition failed: $probe ($result/14 columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentMedia" m LEFT JOIN "agentSessions" s ON s.id=m."sessionId" WHERE s.id IS NULL OR s."ownerId"<>m."ownerId" OR m."byteLength"<>octet_length(m.payload);')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid owned payloads)"
        ;;
      agent-runs-media-request-column)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agentRuns' AND column_name='mediaRequest' AND data_type='text' AND is_nullable='YES';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe"
        ;;
      native-gemini-profile-reconformance|native-gemini-generate-content)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentProviderProfiles\" p LEFT JOIN \"agentProviderProfileVersions\" v ON v.id=p.\"currentVersionId\" AND v.\"profileId\"=p.id WHERE p.\"currentVersionId\" IS NOT NULL AND (v.id IS NULL OR v.\"capabilityRevision\" IS DISTINCT FROM 'wiki-protocol-capabilities-v4:'||v.\"transportKind\" OR (p.status='enabled' AND (NOT p.conformed OR NOT v.conformed)));")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid current conformance bindings)"
        ;;
      historical-agent-content-retained)
        # Runs retain resolved transport/model/capability/pricing snapshots. Legacy migrations 2.5.148
        # and 2.5.153 rewrote version capabilities without rewriting admitted runs;
        # declaration equality is not a historical preservation invariant.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentRuns" r LEFT JOIN "agentProviderProfileVersions" v ON v.id=r."providerProfileVersionId" LEFT JOIN "agentSessions" s ON s.id=r."sessionId" WHERE v.id IS NULL OR s.id IS NULL OR s."ownerId"<>r."ownerId" OR length(btrim(r."transportKind"))=0 OR length(btrim(r.model))=0 OR length(btrim(r."capabilityRevision"))=0 OR length(btrim(r."pricingRevision"))=0;')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result broken historical bindings)"
        ;;
      retired-live-google-search-disabled)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentSessions" WHERE "googleSearchEnabled";')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result live opt-ins)"
        ;;
      external-mcp-owner-isolation-and-grants|guarded-native-external-mcp-discovery-and-invocation)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('agentExternalMcpServers','agentExternalMcpGrants','agentExternalMcpGroupPolicies');")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 tables)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentExternalMcpServers\" WHERE ((scope='admin' AND \"ownerId\" IS NULL) OR (scope='personal' AND \"ownerId\" IS NOT NULL)) IS NOT TRUE OR status NOT IN ('enabled','disabled') OR revision<1 OR ((\"authMode\" IN ('none','oauth') AND \"secretReference\" IS NULL) OR (\"authMode\"='bearer' AND \"secretReference\" LIKE 'managed:%')) IS NOT TRUE;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid ownership/auth configurations)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT (SELECT count(*) FROM "agentExternalMcpGrants" g LEFT JOIN "agentExternalMcpServers" s ON s.id=g."serverId" LEFT JOIN groups p ON p.id=g."groupId" WHERE s.id IS NULL OR p.id IS NULL) + (SELECT count(*) FROM "agentExternalMcpGroupPolicies" p LEFT JOIN groups g ON g.id=p."groupId" WHERE g.id IS NULL OR p.revision<1);')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid grants/policies)"
        ;;
      external-mcp-oauth-grants-and-pending-schema|external-mcp-generic-oauth-schema|external-mcp-retired-oauth-configuration-schema)
        # All pending contracts run against the final target schema. Legacy grants may
        # remain unbound, expired or stale until explicit reconnect/reconfiguration.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema()
            AND table_type='BASE TABLE' AND table_name IN ('agentExternalMcpOAuthGrants','agentExternalMcpOAuthPending');")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 OAuth grant and pending tables)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,max_length,nullable) AS (VALUES
            ('agentExternalMcpOAuthGrants','id','uuid',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','userId','integer',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','serverId','uuid',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','serverRevision','integer',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','authVersion','integer',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','authorizationStamp','text',NULL,'NO'),
            ('agentExternalMcpOAuthGrants','secretReference','character varying',128,'YES'),
            ('agentExternalMcpOAuthPending','stateHash','character varying',64,'NO'),
            ('agentExternalMcpOAuthPending','grantId','uuid',NULL,'NO'),
            ('agentExternalMcpOAuthPending','sessionHash','character varying',64,'NO'),
            ('agentExternalMcpOAuthPending','secretReference','character varying',128,'NO'),
            ('agentExternalMcpOAuthPending','expiresAt','timestamp with time zone',NULL,'NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;")"
        [[ "$result" == 12 ]] || die "Postcondition failed: $probe ($result/12 OAuth grant and pending columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,parent_table) AS (VALUES
            ('agentExternalMcpOAuthGrants','userId','users'),
            ('agentExternalMcpOAuthGrants','serverId','agentExternalMcpServers'),
            ('agentExternalMcpOAuthPending','grantId','agentExternalMcpOAuthGrants')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_class t JOIN pg_constraint c ON c.conrelid=t.oid
              JOIN pg_class parent ON parent.oid=c.confrelid
              JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname=e.column_name AND NOT a.attisdropped
              JOIN pg_attribute referenced ON referenced.attrelid=parent.oid AND referenced.attname='id' AND NOT referenced.attisdropped
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND parent.relnamespace=current_schema()::regnamespace AND parent.relname=e.parent_table
              AND c.contype='f' AND c.convalidated AND c.confdeltype='c'
              AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.confkey=ARRAY[referenced.attnum]::smallint[]
          );")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 OAuth owner, endpoint and pending cascade foreign keys)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,first_column,second_column,primary_key) AS (VALUES
            ('agentExternalMcpOAuthGrants','id',NULL,true),
            ('agentExternalMcpOAuthGrants','userId','serverId',false),
            ('agentExternalMcpOAuthPending','stateHash',NULL,true)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_class t JOIN pg_index i ON i.indrelid=t.oid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND (NOT e.primary_key OR i.indisprimary)
              AND i.indpred IS NULL AND i.indexprs IS NULL
              AND i.indnkeyatts=CASE WHEN e.second_column IS NULL THEN 1 ELSE 2 END
              AND pg_get_indexdef(i.indexrelid,1,true)=quote_ident(e.first_column)
              AND (e.second_column IS NULL OR pg_get_indexdef(i.indexrelid,2,true)=quote_ident(e.second_column))
          );")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 OAuth grant identity, owner/endpoint and state uniqueness indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,trigger_name,trigger_type) AS (VALUES
            ('agentExternalMcpOAuthGrants','external_mcp_oauth_secret_cleanup',9),
            ('agentExternalMcpOAuthPending','external_mcp_oauth_secret_cleanup',9),
            ('users','external_mcp_oauth_user_cleanup',11)
          ) SELECT count(*) FROM expected e JOIN pg_class t
            ON t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
            JOIN pg_trigger g ON g.tgrelid=t.oid AND g.tgname=e.trigger_name
            JOIN pg_proc f ON f.oid=g.tgfoid AND f.pronamespace=t.relnamespace AND f.proname=e.trigger_name
          WHERE NOT g.tgisinternal AND g.tgenabled IN ('O','A') AND g.tgtype=e.trigger_type
            AND g.tgnargs=0 AND g.tgqual IS NULL AND f.prorettype='trigger'::regtype;")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe ($result/3 enabled OAuth credential/account cleanup trigger bindings)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc '
          SELECT (SELECT count(*) FROM "agentExternalMcpOAuthGrants" g
            LEFT JOIN users u ON u.id=g."userId" LEFT JOIN "agentExternalMcpServers" s ON s.id=g."serverId"
            WHERE u.id IS NULL OR s.id IS NULL)
          + (SELECT count(*) FROM "agentExternalMcpOAuthPending" p
            LEFT JOIN "agentExternalMcpOAuthGrants" g ON g.id=p."grantId" WHERE g.id IS NULL);')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result orphaned OAuth grant/pending records)"
        if [[ "$probe" != external-mcp-oauth-grants-and-pending-schema ]]; then
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema()
              AND table_type='BASE TABLE' AND table_name='agentExternalMcpOAuthRegistrations';")"
          [[ "$result" == 1 ]] || die "Postcondition failed: $probe (OAuth registration table)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            WITH expected(table_name,column_name,data_type,max_length,nullable) AS (VALUES
              ('agentExternalMcpServers','authMode','character varying',16,'NO'),
              ('agentExternalMcpServers','secretReference','character varying',128,'YES'),
              ('agentExternalMcpServers','oauthConfiguration','text',NULL,'YES'),
              ('agentExternalMcpServers','oauthClientSecretReference','character varying',128,'YES'),
              ('agentExternalMcpOAuthGrants','binding','text',NULL,'YES'),
              ('agentExternalMcpOAuthRegistrations','serverId','uuid',NULL,'NO'),
              ('agentExternalMcpOAuthRegistrations','configurationHash','character varying',64,'NO'),
              ('agentExternalMcpOAuthRegistrations','binding','text',NULL,'NO'),
              ('agentExternalMcpOAuthRegistrations','secretReference','character varying',128,'NO')
            ) SELECT count(*) FROM expected e JOIN information_schema.columns c
              ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
            WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;")"
          [[ "$result" == 9 ]] || die "Postcondition failed: $probe ($result/9 generic OAuth endpoint, binding and registration columns)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM pg_class t JOIN pg_constraint c ON c.conrelid=t.oid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='agentExternalMcpServers'
              AND c.contype='c' AND c.convalidated AND (
                (c.conname='external_mcp_auth_mode' AND cardinality(c.conkey)=1
                  AND pg_get_constraintdef(c.oid) LIKE '%authMode%'
                  AND pg_get_constraintdef(c.oid) LIKE '%''none''%' AND pg_get_constraintdef(c.oid) LIKE '%''bearer''%'
                  AND pg_get_constraintdef(c.oid) LIKE '%''oauth''%' AND pg_get_constraintdef(c.oid) NOT LIKE '%''google''%') OR
                (c.conname='external_mcp_auth_secret' AND cardinality(c.conkey)=2
                  AND pg_get_constraintdef(c.oid) LIKE '%authMode%' AND pg_get_constraintdef(c.oid) LIKE '%secretReference%'
                  AND pg_get_constraintdef(c.oid) LIKE '%''none''%' AND pg_get_constraintdef(c.oid) LIKE '%''oauth''%'
                  AND pg_get_constraintdef(c.oid) LIKE '%''bearer''%' AND pg_get_constraintdef(c.oid) LIKE '%managed:%'
                  AND pg_get_constraintdef(c.oid) LIKE '%IS NULL%' AND pg_get_constraintdef(c.oid) LIKE '%IS NOT NULL%')
              );")"
          [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 current OAuth authentication and bearer-secret constraints)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM pg_class t JOIN pg_constraint c ON c.conrelid=t.oid
              JOIN pg_class parent ON parent.oid=c.confrelid
              JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='serverId' AND NOT a.attisdropped
              JOIN pg_attribute referenced ON referenced.attrelid=parent.oid AND referenced.attname='id' AND NOT referenced.attisdropped
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='agentExternalMcpOAuthRegistrations'
              AND parent.relnamespace=current_schema()::regnamespace AND parent.relname='agentExternalMcpServers'
              AND c.contype='f' AND c.convalidated AND c.confdeltype='c'
              AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.confkey=ARRAY[referenced.attnum]::smallint[];")"
          [[ "$result" == 1 ]] || die "Postcondition failed: $probe (OAuth registration endpoint cascade foreign key)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM pg_class t JOIN pg_index i ON i.indrelid=t.oid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='agentExternalMcpOAuthRegistrations'
              AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=1
              AND i.indpred IS NULL AND i.indexprs IS NULL
              AND pg_get_indexdef(i.indexrelid,1,true)=quote_ident('serverId');")"
          [[ "$result" == 1 ]] || die "Postcondition failed: $probe (OAuth registration endpoint uniqueness)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            WITH expected(table_name,trigger_name) AS (VALUES
              ('agentExternalMcpOAuthRegistrations','external_mcp_oauth_secret_cleanup'),
              ('agentExternalMcpServers','external_mcp_oauth_client_cleanup')
            ) SELECT count(*) FROM expected e JOIN pg_class t
              ON t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              JOIN pg_trigger g ON g.tgrelid=t.oid AND g.tgname=e.trigger_name
              JOIN pg_proc f ON f.oid=g.tgfoid AND f.pronamespace=t.relnamespace AND f.proname=e.trigger_name
            WHERE NOT g.tgisinternal AND g.tgenabled IN ('O','A') AND g.tgtype=9
              AND g.tgnargs=0 AND g.tgqual IS NULL AND f.prorettype='trigger'::regtype;")"
          [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 enabled OAuth registration/client cleanup trigger bindings)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM \"agentExternalMcpServers\"
            WHERE ((\"authMode\" IN ('none','oauth') AND \"secretReference\" IS NULL)
              OR (\"authMode\"='bearer' AND \"secretReference\" LIKE 'managed:%' AND \"secretReference\" IS NOT NULL)) IS NOT TRUE;")"
          [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid current OAuth/bearer authentication configurations)"
          # Check references only: do not decrypt credentials, require legacy bindings,
          # compare consent to mutable endpoint revisions, or reject expired pending state.
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            WITH credential_references AS (
              SELECT \"secretReference\" AS reference FROM \"agentExternalMcpOAuthGrants\" WHERE \"secretReference\" IS NOT NULL
              UNION ALL SELECT \"secretReference\" FROM \"agentExternalMcpOAuthPending\"
              UNION ALL SELECT \"secretReference\" FROM \"agentExternalMcpOAuthRegistrations\"
              UNION ALL SELECT \"oauthClientSecretReference\" FROM \"agentExternalMcpServers\" WHERE \"oauthClientSecretReference\" IS NOT NULL
              UNION ALL SELECT \"secretReference\" FROM \"agentExternalMcpServers\" WHERE \"secretReference\" IS NOT NULL
            ) SELECT count(*) FROM credential_references r LEFT JOIN \"agentProviderSecrets\" s ON r.reference='managed:'||s.id::text
              WHERE s.id IS NULL;")"
          [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result missing or invalid retained managed credential references)"
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc '
            SELECT count(*) FROM "agentExternalMcpOAuthRegistrations" r
              LEFT JOIN "agentExternalMcpServers" s ON s.id=r."serverId" WHERE s.id IS NULL;')"
          [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result orphaned OAuth registrations)"
        fi
        if [[ "$probe" == external-mcp-retired-oauth-configuration-schema ]]; then
          # Archived configuration is retained, not executable authority. Operators may
          # legitimately reconfigure, reconsent and enable an endpoint after migrations 65/66.
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
              AND table_name='agentExternalMcpServers' AND column_name='retiredOAuthConfiguration'
              AND data_type='text' AND is_nullable='YES';")"
          [[ "$result" == 1 ]] || die "Postcondition failed: $probe (retained archived OAuth configuration column)"
        fi
        ;;
      independent-decision-provider-configuration|native-typesafe-environment-fallback-and-validated-usage)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentDecisionProviderConfiguration" WHERE id=1 AND revision>0;')"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (configuration singleton)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentDecisionProviders\" WHERE revision<1 OR (\"isDefault\" AND NOT enabled) OR jsonb_typeof(config::jsonb) IS DISTINCT FROM 'object' OR (config::jsonb->>'kind') IS NULL OR (config::jsonb->>'kind') NOT IN ('typesafe','openai-compatible') OR NULLIF(config::jsonb->>'model','') IS NULL;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid independent providers)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentDecisionProviders" WHERE "isDefault";')"
        (( result <= 1 )) || die "Postcondition failed: $probe (multiple defaults)"
        ;;
      immutable-model-task-declarations-and-routing-policy|eligible-owner-routing-and-accounted-safe-fallback)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentRoutingPolicy\" WHERE id=1 AND revision>0 AND jsonb_typeof(config::jsonb)='object' AND jsonb_typeof(config::jsonb->'enabled')='boolean';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (routing singleton)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentRoutingModelPolicies\" p LEFT JOIN \"agentProviderProfileVersions\" v ON v.id=p.\"profileVersionId\" AND v.\"profileId\"=p.\"profileId\" WHERE v.id IS NULL OR p.revision<1 OR jsonb_typeof(p.config::jsonb) IS DISTINCT FROM 'object' OR jsonb_typeof(p.config::jsonb->'acceptableTasks') IS DISTINCT FROM 'array';")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid immutable task declarations)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentRuns" r JOIN "agentSessions" s ON s.id=r."sessionId" WHERE s."ownerId"<>r."ownerId" OR r."inputTokens"<0 OR r."outputTokens"<0 OR r."estimatedCostMicros"<0;')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid owner/accounting receipts)"
        ;;
      independent-draft-root-preserves-legacy-ciphertext|offline-draft-key-survives-session-protection-rotation)
        # Roots may legitimately diverge after session-key rotation; never print secret values.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM settings WHERE key='offlineDraftSecret' AND jsonb_typeof(value::jsonb->'v')='string' AND length(value::jsonb->>'v')>0;")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (independent encryption root)"
        ;;
      owner-root-bound-specialist-context-and-idempotent-invocation|delegated-context-reuse-preserves-incumbent-root-and-accounting)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('agentSpecialistContexts','agentSpecialistInvocations');")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 tables)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT (SELECT count(*) FROM "agentSpecialistContexts" c LEFT JOIN "agentSessions" s ON s.id=c."rootSessionId" WHERE s.id IS NULL OR c."ownerId"<>s."ownerId" OR c.version<1 OR c."turnCount"<0) + (SELECT count(*) FROM "agentSpecialistInvocations" i LEFT JOIN "agentRuns" r ON r.id=i."rootRunId" WHERE r.id IS NULL OR i."ownerId"<>r."ownerId" OR i."rootSessionId"<>r."sessionId" OR i."contextVersion"<1 OR i."rootAttempt"<1 OR i."maximumContextBytes" NOT BETWEEN 4096 AND 262144) + (SELECT count(*) FROM (SELECT "rootRunId" FROM "agentSpecialistInvocations" GROUP BY "rootRunId" HAVING count(*)>1) duplicates);')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid root/idempotency receipts)"
        # Expired contexts may be scrubbed/deleted while invocation receipts remain.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentRoutingPolicy\" WHERE NOT (config::jsonb ?& ARRAY['specialistEnabled','specialistMaxContexts','specialistMaxContextBytes','specialistMaxReportTokens','specialistMaxTurns']) OR jsonb_typeof(config::jsonb->'specialistEnabled') IS DISTINCT FROM 'boolean' OR (config::jsonb->>'specialistMaxContexts')::integer NOT BETWEEN 1 AND 8 OR (config::jsonb->>'specialistMaxContextBytes')::integer NOT BETWEEN 4096 AND 262144 OR (config::jsonb->>'specialistMaxReportTokens')::integer NOT BETWEEN 128 AND 4096 OR (config::jsonb->>'specialistMaxTurns')::integer NOT BETWEEN 1 AND 8;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid specialist policies)"
        ;;
      independent-media-provider-versions-preserve-legacy-models-prices-grants-and-credentials|authorized-current-media-version-bindings-and-retained-credentials)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('agentMediaProviders','agentMediaProviderVersions','agentMediaProviderGrants','agentMediaProviderConfiguration');")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe ($result/4 independent tables)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentMediaProviderConfiguration" WHERE id=1 AND revision>0;')"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (configuration singleton)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace=current_schema()::regnamespace AND c.conname IN ('agent_media_current_version_fk','agent_media_versions_sequence_unique','agent_media_versions_owner_unique','agent_media_grants_pk');")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe ($result/4 binding constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentMediaProviders\" p LEFT JOIN \"agentMediaProviderVersions\" v ON v.id=p.\"currentVersionId\" AND v.\"providerId\"=p.id WHERE p.revision<1 OR p.\"exposureMode\" NOT IN ('all_agent_users','groups') OR (p.\"currentVersionId\" IS NOT NULL AND v.id IS NULL) OR (p.enabled AND p.\"deletedAt\" IS NULL AND (v.id IS NULL OR v.\"secretReference\" IS NULL)) OR (p.\"isDefault\" AND (NOT p.enabled OR p.\"deletedAt\" IS NOT NULL));")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid current bindings/defaults)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentMediaProviderVersions\" v LEFT JOIN \"agentMediaProviders\" p ON p.id=v.\"providerId\" WHERE p.id IS NULL OR v.version<1 OR jsonb_typeof(v.config::jsonb) IS DISTINCT FROM 'object' OR (v.config::jsonb->>'kind') IS NULL OR (v.config::jsonb->>'kind') NOT IN ('image','video','music','transcription') OR NULLIF(v.config::jsonb->>'model','') IS NULL OR jsonb_typeof(v.config::jsonb->'pricing') IS DISTINCT FROM 'object';")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid retained versions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc 'SELECT count(*) FROM "agentMediaProviderGrants" g LEFT JOIN "agentMediaProviders" p ON p.id=g."providerId" LEFT JOIN groups a ON a.id=g."groupId" WHERE p.id IS NULL OR a.id IS NULL;')"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid grants)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentMediaProviderVersions\" v LEFT JOIN \"agentProviderSecrets\" s ON 'managed:'||s.id::text=v.\"secretReference\" WHERE v.\"secretReference\" LIKE 'managed:%' AND s.id IS NULL;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result missing retained managed credentials)"
        if [[ "$probe" == independent-media-provider-versions-preserve-legacy-models-prices-grants-and-credentials ]]; then
          # Compare retained immutable copies, not operator-mutable current/default selections.
          result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
            WITH legacy AS (
              SELECT p.id AS profile_id, v.id AS version_id, v.\"secretReference\", v.\"baseUrl\", v.\"adapterConfig\"::jsonb AS adapter,
                operation.kind, operation.config
              FROM \"agentProviderProfiles\" p
              JOIN \"agentProviderProfileVersions\" v ON v.id=p.\"currentVersionId\" AND v.\"profileId\"=p.id
              CROSS JOIN LATERAL (VALUES
                ('image',v.\"adapterConfig\"::jsonb->'media'->'imageGeneration'),
                ('video',v.\"adapterConfig\"::jsonb->'media'->'videoGeneration'),
                ('music',v.\"adapterConfig\"::jsonb->'media'->'musicGeneration'),
                ('transcription',v.\"adapterConfig\"::jsonb->'media'->'transcription')
              ) operation(kind,config)
              WHERE p.\"deletedAt\" IS NULL AND operation.config IS NOT NULL AND operation.config<>'null'::jsonb
            )
            SELECT count(*) FROM legacy l WHERE NOT EXISTS (
              SELECT 1 FROM \"agentMediaProviderVersions\" v WHERE v.config::jsonb->>'kind'=l.kind
                AND v.\"secretReference\" IS NOT DISTINCT FROM l.\"secretReference\"
                AND v.config::jsonb->>'model'=l.config->>'model'
                AND v.config::jsonb->>'baseUrl'=regexp_replace(l.\"baseUrl\",'/$','')
                AND v.config::jsonb->'timeoutMs'=l.adapter->'timeoutMs'
                AND v.config::jsonb->>'maxInputTokens'='32768' AND v.config::jsonb->>'maxOutputTokens'='8192'
                AND v.config::jsonb->>'api'=CASE WHEN l.kind IN ('video','music') THEN 'gemini-interactions' ELSE 'gemini-generate-content' END
                AND CASE WHEN l.kind='music'
                  THEN v.config::jsonb->'pricing'=jsonb_build_object('kind','fixed','pricingRevision','legacy-media-'||l.version_id::text,'costMicros',l.config->'costMicrosPerSong')
                  ELSE v.config::jsonb->'pricing'=jsonb_build_object('kind','tokens','pricingRevision',l.config->'pricingRevision') ||
                    CASE WHEN l.kind='video' THEN jsonb_build_object('textOutputMicrosPerMillionTokens',l.config->'textOutputMicrosPerMillionTokens') ELSE '{}'::jsonb END
                END
                AND NOT EXISTS (
                  SELECT 1 FROM \"agentProviderGrants\" g WHERE g.\"profileId\"=l.profile_id AND NOT EXISTS (
                    SELECT 1 FROM \"agentMediaProviderGrants\" copied WHERE copied.\"providerId\"=v.\"providerId\" AND copied.\"groupId\"=g.\"groupId\"
                  )
                )
            );")"
          [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result legacy operations without preserved copies)"
        fi
        ;;
      native-page-creation-receipts-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          WITH expected(column_name,data_type,max_length,nullable) AS (VALUES
            ('ownerId','integer',NULL,'NO'),('requestId','uuid',NULL,'NO'),
            ('pageId','integer',NULL,'NO'),('sourceRevision','bigint',NULL,'NO'),
            ('originKind','character varying',16,'YES'),('originId','uuid',NULL,'YES'),
            ('originRevision','bigint',NULL,'YES'),('originSessionId','uuid',NULL,'YES'),
            ('createdAt','timestamp with time zone',NULL,'NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name='pageCreationReceipts' AND c.column_name=e.column_name
            WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;
          COMMIT;")"
        [[ "$result" == 9 ]] || die "Postcondition failed: $probe ($result/9 receipt columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT count(*) FROM pg_constraint c
          WHERE c.conrelid='\"pageCreationReceipts\"'::regclass AND c.contype='p' AND c.convalidated
            AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o)
              JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o)=ARRAY['ownerId','requestId'];
          COMMIT;")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (owner/request identity)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT CASE WHEN count(*)=1 AND bool_and(c.confrelid='users'::regclass AND c.confdeltype='c' AND c.convalidated
            AND cardinality(c.conkey)=1 AND a.attname='ownerId' AND b.attname='id') THEN 1 ELSE 0 END
          FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
            JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[1]
          WHERE c.conrelid='\"pageCreationReceipts\"'::regclass AND c.contype='f';
          COMMIT;")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (owner foreign key or destructive source/destination foreign key)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT count(*) FROM pg_constraint c WHERE c.conrelid='\"pageCreationReceipts\"'::regclass
            AND c.contype='c' AND c.convalidated
            AND c.conname IN ('page_creation_source_revision_check','page_creation_origin_check');
          COMMIT;")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (validated revision/origin checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT count(*) FROM pg_index i WHERE i.indrelid='\"pageCreationReceipts\"'::regclass
            AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=4
            AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,o)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n WHERE k.o<=4 ORDER BY k.o)
              =ARRAY['ownerId','originKind','originId','requestId'];
          COMMIT;")"
        [[ "$result" -ge 1 ]] || die "Postcondition failed: $probe (origin inventory index)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT count(*) FROM \"pageCreationReceipts\" r
          WHERE r.\"sourceRevision\"<=0 OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id=r.\"ownerId\")
            OR ((r.\"originKind\" IS NULL AND r.\"originId\" IS NULL AND r.\"originRevision\" IS NULL AND r.\"originSessionId\" IS NULL)
              OR (r.\"originKind\" IS NOT NULL AND r.\"originKind\"='live-note' AND r.\"originId\" IS NOT NULL
                AND r.\"originRevision\" IS NOT NULL AND r.\"originRevision\">=0 AND r.\"originRevision\"<=9007199254740991 AND r.\"originSessionId\" IS NULL)
              OR (r.\"originKind\" IS NOT NULL AND r.\"originKind\"='agent-answer' AND r.\"originId\" IS NOT NULL
                AND r.\"originSessionId\" IS NOT NULL AND r.\"originRevision\" IS NULL)) IS NOT TRUE;
          COMMIT;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid authoritative receipt rows)"
        ;;
      native-live-notes-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -Atc "
          WITH expected(table_name,column_name,data_type,max_length,nullable) AS (VALUES
            ('liveNotes','id','uuid',NULL,'NO'),('liveNotes','key','character varying',64,'NO'),
            ('liveNotes','ownerId','integer',NULL,'YES'),('liveNotes','access','character varying',8,'NO'),
            ('liveNotes','state','text',NULL,'NO'),('liveNotes','title','character varying',200,'NO'),
            ('liveNotes','revision','bigint',NULL,'NO'),('liveNotes','everEdited','boolean',NULL,'NO'),
            ('liveNotes','createdAt','timestamp with time zone',NULL,'NO'),('liveNotes','updatedAt','timestamp with time zone',NULL,'NO'),
            ('liveNotes','touchedAt','timestamp with time zone',NULL,'NO'),('liveNotes','deletedAt','timestamp with time zone',NULL,'YES'),
            ('liveNoteRevisions','noteId','uuid',NULL,'NO'),('liveNoteRevisions','revision','bigint',NULL,'NO'),
            ('liveNoteRevisions','state','text',NULL,'NO'),('liveNoteRevisions','title','character varying',200,'NO'),
            ('liveNoteRevisions','access','character varying',8,'NO'),('liveNoteRevisions','actorId','integer',NULL,'YES'),
            ('liveNoteRevisions','createdAt','timestamp with time zone',NULL,'NO'),
            ('liveNoteRequests','noteId','uuid',NULL,'NO'),('liveNoteRequests','actorId','integer',NULL,'NO'),
            ('liveNoteRequests','requestId','character varying',128,'NO'),('liveNoteRequests','updateHash','character varying',64,'NO'),
            ('liveNoteConnections','id','character varying',128,'NO'),('liveNoteConnections','noteId','uuid',NULL,'NO'),
            ('liveNoteConnections','expiresAt','timestamp with time zone',NULL,'NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;")"
        [[ "$result" == 26 ]] || die "Postcondition failed: $probe ($result/26 columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -Atc "
          WITH expected(tab,kind,cols) AS (VALUES
            ('liveNotes','p',ARRAY['id']),('liveNotes','u',ARRAY['key']),
            ('liveNoteRevisions','p',ARRAY['noteId','revision']),
            ('liveNoteRequests','p',ARRAY['noteId','actorId','requestId']),
            ('liveNoteConnections','p',ARRAY['id'])
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.tab AND c.contype::text=e.kind AND c.convalidated
              AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.n ORDER BY k.o)=e.cols);")"
        [[ "$result" == 5 ]] || die "Postcondition failed: $probe ($result/5 identity constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -Atc "
          WITH expected(tab,col,target,action) AS (VALUES
            ('liveNotes','ownerId','users','n'),('liveNoteRevisions','actorId','users','n'),
            ('liveNoteRequests','actorId','users','c'),
            ('liveNoteRevisions','noteId','liveNotes','c'),('liveNoteRequests','noteId','liveNotes','c'),
            ('liveNoteConnections','noteId','liveNotes','c')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            JOIN pg_class r ON r.oid=c.confrelid
            JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[1]
            JOIN pg_attribute b ON b.attrelid=r.oid AND b.attnum=c.confkey[1]
            WHERE t.relnamespace=current_schema()::regnamespace AND r.relnamespace=t.relnamespace
              AND t.relname=e.tab AND r.relname=e.target AND a.attname=e.col AND b.attname='id'
              AND c.contype='f' AND c.convalidated AND c.confdeltype::text=e.action AND cardinality(c.conkey)=1);")"
        [[ "$result" == 6 ]] || die "Postcondition failed: $probe ($result/6 foreign keys)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='liveNoteConnections'
            AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=2
            AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,o)
              JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.n WHERE k.o<=2 ORDER BY k.o)=ARRAY['noteId','expiresAt'];")"
        [[ "$result" -ge 1 ]] || die "Postcondition failed: $probe (active lease index)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          WITH expected(col,definition) AS (VALUES
            ('access','CHECKaccess=ANYARRAY[''private'',''read'',''edit'']'),
            ('revision','CHECKrevision>=0ANDrevision<=9007199254740991')
          ), checks AS (
            SELECT c.conkey,t.oid,
              -- Preserve quoted values while removing only deparser syntax and casts.
              replace(replace(regexp_replace(pg_get_constraintdef(c.oid),
                '(''[^'']*'')|::character varying|::text\\[\\]|::text|::bigint|[[:space:]()]', '\\1', 'g'),
                '''0''','0'), '''9007199254740991''','9007199254740991') AS definition
            FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='liveNotes'
              AND c.contype='c' AND c.convalidated
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM checks c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=c.conkey[1]
            WHERE cardinality(c.conkey)=1 AND a.attname=e.col AND c.definition=e.definition);
          COMMIT;")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 access and safe revision checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -v ON_ERROR_STOP=1 -qAtc "
          BEGIN READ ONLY;
          SELECT (SELECT count(*) FROM \"liveNotes\" WHERE access NOT IN ('private','read','edit') OR revision<0 OR revision>9007199254740991)
            + (SELECT count(*) FROM \"liveNoteRevisions\" WHERE access NOT IN ('private','read','edit') OR revision<0 OR revision>9007199254740991)
            + (SELECT count(*) FROM \"liveNoteRevisions\" r JOIN \"liveNotes\" n ON n.id=r.\"noteId\" WHERE r.revision>n.revision)
            + (SELECT count(*) FROM \"liveNotes\" n WHERE NOT EXISTS (
                SELECT 1 FROM \"liveNoteRevisions\" r WHERE r.\"noteId\"=n.id AND r.revision=n.revision
                  AND r.state=n.state AND r.access=n.access AND r.title=n.title));
          COMMIT;")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result invalid document/history rows)"
        ;;
      native-glossary-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,max_length,nullable) AS (VALUES
            ('glossaryTerms','id','integer',NULL,'NO'),
            ('glossaryTerms','locale','character varying',35,'NO'),
            ('glossaryTerms','term','character varying',255,'NO'),
            ('glossaryTerms','expansion','character varying',255,'NO'),
            ('glossaryTerms','definition','text',NULL,'NO'),
            ('glossaryTerms','category','character varying',255,'NO'),
            ('glossaryTerms','documentationPageId','integer',NULL,'YES'),
            ('glossaryTerms','documentationLabel','character varying',255,'NO'),
            ('glossaryTerms','references','jsonb',NULL,'NO'),
            ('glossaryTerms','caseSensitive','boolean',NULL,'NO'),
            ('glossaryTerms','autoLink','boolean',NULL,'NO'),
            ('glossaryTerms','revision','integer',NULL,'NO'),
            ('glossaryTerms','createdAt','timestamp with time zone',NULL,'NO'),
            ('glossaryTerms','updatedAt','timestamp with time zone',NULL,'NO'),
            ('glossaryNames','locale','character varying',35,'NO'),
            ('glossaryNames','key','text',NULL,'NO'),
            ('glossaryNames','name','character varying',255,'NO'),
            ('glossaryNames','termId','integer',NULL,'NO'),
            ('glossaryNames','isAlias','boolean',NULL,'NO'),
            ('glossaryTermRelations','locale','character varying',35,'NO'),
            ('glossaryTermRelations','leftId','integer',NULL,'NO'),
            ('glossaryTermRelations','rightId','integer',NULL,'NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;")"
        [[ "$result" == 22 ]] || die "Postcondition failed: $probe ($result/22 columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,name,kind) AS (VALUES
            ('glossaryTerms','glossary_terms_id_locale_unique','u'),
            ('glossaryTerms','glossary_terms_revision_positive','c'),
            ('glossaryNames','glossary_names_locale_key_unique','p'),
            ('glossaryTermRelations','glossary_relation_order','c')
          ) SELECT count(*) FROM expected e JOIN pg_class t ON t.relname=e.table_name AND t.relnamespace=current_schema()::regnamespace
            JOIN pg_constraint c ON c.conrelid=t.oid AND c.conname=e.name AND c.contype::text=e.kind AND c.convalidated;")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe ($result/4 namespace and revision constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND c.contype='f' AND c.convalidated AND (
            (t.relname='glossaryTerms' AND c.confrelid=to_regclass('pages') AND c.confdeltype='n' AND cardinality(c.conkey)=1) OR
            (t.relname IN ('glossaryNames','glossaryTermRelations') AND c.confrelid=to_regclass('\"glossaryTerms\"') AND c.confdeltype='c' AND cardinality(c.conkey)=2)
          );")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe ($result/4 page and locale relation foreign keys)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='glossaryNames'
            AND idx.relname='glossary_names_one_canonical' AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1
            AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='termId'
            AND replace(pg_get_expr(i.indpred,i.indrelid),'\"','')='(NOT isAlias)';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (canonical name uniqueness)"
        ;;
      native-discussion-annotations-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(column_name,data_type,nullable) AS (VALUES
            ('id','integer','NO'),('commentId','integer','NO'),('position','integer','NO'),
            ('note','text','NO'),('anchor','jsonb','NO'),('revision','integer','NO'),
            ('resolvedAt','timestamp with time zone','YES'),('resolvedById','integer','YES'),
            ('createdAt','timestamp with time zone','NO'),('updatedAt','timestamp with time zone','NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name='commentAnnotations' AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;")"
        [[ "$result" == 10 ]] || die "Postcondition failed: $probe ($result/10 columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='commentAnnotations' AND c.convalidated AND (
            (c.contype='u' AND c.conname='comment_annotations_position_unique') OR
            (c.contype='c' AND c.conname IN ('comment_annotations_position_check','comment_annotations_revision_check','comment_annotations_note_check','comment_annotations_anchor_check')) OR
            (c.contype='f' AND c.confrelid=to_regclass('comments') AND c.confdeltype='c') OR
            (c.contype='f' AND c.confrelid=to_regclass('users') AND c.confdeltype='n') OR c.contype='p'
          );")"
        [[ "$result" == 8 ]] || die "Postcondition failed: $probe ($result/8 annotation constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='comments' AND idx.relname='comments_author_recent_order'
            AND i.indisvalid AND i.indnkeyatts=3
            AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='authorId'
            AND replace(pg_get_indexdef(idx.oid,2,true),'\"','')='createdAt'
            AND replace(pg_get_indexdef(idx.oid,3,true),'\"','')='id';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (owner contribution ordering index)"
        ;;
      native-discussion-notifications-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,max_length,nullable) AS (VALUES
            ('userNotificationPreferences','userId','integer',NULL,'NO'),
            ('userNotificationPreferences','category','character varying',32,'NO'),
            ('userNotificationPreferences','inAppEnabled','boolean',NULL,'NO'),
            ('userNotificationPreferences','emailEnabled','boolean',NULL,'NO'),
            ('userNotificationPreferences','updatedAt','timestamp with time zone',NULL,'NO'),
            ('pageWatchNotifications','category','character varying',32,'YES'),
            ('pageWatchNotifications','commentId','integer',NULL,'YES')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;")"
        [[ "$result" == 7 ]] || die "Postcondition failed: $probe ($result/7 preference and routing columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='userNotificationPreferences'
            AND column_name IN ('inAppEnabled','emailEnabled') AND column_default='false';")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (new notification channels default off)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='userNotificationPreferences' AND c.convalidated AND (
            (c.contype='p' AND c.conname='user_notification_preferences_primary' AND cardinality(c.conkey)=2) OR
            (c.contype='f' AND c.confrelid=to_regclass('users') AND c.confdeltype='c')
          );")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 owner and category constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='userNotificationPreferences'
            AND idx.relname='user_notification_preferences_audience_lookup' AND i.indisvalid AND i.indnkeyatts=2
            AND replace(pg_get_indexdef(idx.oid,1,true),'\"','')='category'
            AND replace(pg_get_indexdef(idx.oid,2,true),'\"','')='userId';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (bounded audience lookup index)"
        ;;
      native-account-profile-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT
            (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
              AND table_name='users' AND column_name IN ('location','jobTitle') AND data_type='character varying')
            || '|' || (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
              AND table_name='users' AND column_name='pronouns')
            || '|' || (SELECT count(*) FROM authentication WHERE jsonb_typeof(config::jsonb)='object'
              AND jsonb_exists_any(config::jsonb, ARRAY['mappingPronouns','pronounsClaim']));")"
        [[ "$result" == '2|0|0' ]] || die "Postcondition failed: $probe (supported fields retained; retired field and mappings removed)"
        ;;
      personal-mcp-credential-kind-and-owner-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='apiKeys'
            AND ((column_name='personalOwnerId' AND data_type='integer' AND is_nullable='YES')
              OR (column_name='personalAccess' AND data_type='character varying' AND character_maximum_length=16 AND is_nullable='YES'));")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 personal credential columns)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='apiKeys' AND c.convalidated AND (
            (c.contype='f' AND c.confrelid=to_regclass('users') AND c.confdeltype='n'
              AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=t.oid AND attname='personalOwnerId')]::smallint[]
              AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[]) OR
            (c.contype='c' AND c.conname='api_keys_personal_access_check'
              AND pg_get_constraintdef(c.oid) LIKE '%personalOwnerId%IS NULL%personalAccess%IS NOT NULL%'
              AND pg_get_constraintdef(c.oid) LIKE '%personalAccess%IS NULL%read-only%read-write%')
          );")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe ($result/2 owner deletion and permanent credential-kind constraints)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='apiKeys'
            AND idx.relname='api_keys_personal_owner_idx' AND i.indisvalid AND i.indnkeyatts=1
            AND pg_get_indexdef(idx.oid,1,true)=quote_ident('personalOwnerId');")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (owner lookup index)"
        ;;
      native-links-grid-registration)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='contentExtensions'
            AND ((column_name='key' AND data_type='character varying' AND is_nullable='NO')
              OR (column_name='version' AND data_type='integer' AND is_nullable='NO')
              OR (column_name='isEnabled' AND data_type='boolean' AND is_nullable='NO')
              OR (column_name='updatedAt' AND data_type='timestamp with time zone' AND is_nullable='NO')
              OR (column_name='updatedBy' AND data_type='integer' AND is_nullable='YES'));")"
        [[ "$result" == 5 ]] || die "Postcondition failed: $probe ($result/5 registry columns)"
        # Existing registry rows retain administrator-managed enablement and version state.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"contentExtensions\" WHERE key='links-grid';")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (native extension registration)"
        ;;
      native-browser-session-retirement-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('sessions','sid','character varying','NO'),
            ('sessions','sess','json','NO'),
            ('sessions','expired','timestamp with time zone','NO'),
            ('browserSessionLifecycles','sid','character varying','NO'),
            ('browserSessionLifecycles','generation','uuid','NO'),
            ('browserSessionLifecycles','retiredAt','timestamp with time zone','YES'),
            ('browserSessionLifecycles','expiresAt','timestamp with time zone','NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 7 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('sessions','sid',true),
            ('browserSessionLifecycles','sid',true)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns) AS (VALUES
            ('sessions','expired'),
            ('browserSessionLifecycles','expiresAt')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (bounded lookup and recovery indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM \"sessions\" s LEFT JOIN \"browserSessionLifecycles\" l USING (sid)
          WHERE l.sid IS NULL OR l.\"retiredAt\" IS NOT NULL OR l.\"expiresAt\" IS DISTINCT FROM s.expired;
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-hedgedoc-import-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('hedgedocImports','namespace','character varying','NO'),
            ('hedgedocImports','sourceId','character varying','NO'),
            ('hedgedocImports','sourceDigest','character varying','NO'),
            ('hedgedocImports','snapshotDigest','character varying','NO'),
            ('hedgedocImports','reviewDigest','character varying','NO'),
            ('hedgedocImports','noteId','uuid','NO'),
            ('hedgedocImports','nativeRevision','bigint','NO'),
            ('hedgedocImports','importedBy','integer','YES'),
            ('hedgedocImports','source','text','NO'),
            ('hedgedocImports','assets','text','NO'),
            ('hedgedocImports','importedAt','timestamp with time zone','NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 11 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('hedgedocImports','noteId',false),
            ('hedgedocImports','namespace,sourceId',true)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,target_table,target_columns,delete_mode) AS (VALUES
            ('hedgedocImports','noteId','liveNotes','id','r'),
            ('hedgedocImports','importedBy','users','id','n')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND target.relnamespace=current_schema()::regnamespace
              AND t.relname=e.table_name AND target.relname=e.target_table AND c.contype='f' AND c.convalidated
              AND c.confdeltype::text=e.delete_mode
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.attnum)=e.target_columns
          );
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (native foreign keys and retention actions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM \"hedgedocImports\" WHERE \"nativeRevision\"<0
            OR length(\"sourceDigest\")<>64 OR length(\"snapshotDigest\")<>64 OR length(\"reviewDigest\")<>64;
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-page-feedback-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('feedbackBoards','id','uuid','NO'),
            ('feedbackBoards','boardPageId','integer','NO'),
            ('feedbackBoards','name','character varying','NO'),
            ('feedbackBoards','enabled','boolean','NO'),
            ('feedbackBoards','boardRevision','bigint','NO'),
            ('feedbackBoards','createdAt','timestamp with time zone','NO'),
            ('feedbackBoards','updatedAt','timestamp with time zone','NO'),
            ('feedbackCategories','id','uuid','NO'),
            ('feedbackCategories','boardId','uuid','NO'),
            ('feedbackCategories','label','character varying','NO'),
            ('feedbackCategories','active','boolean','NO'),
            ('feedbackCategories','displayOrder','integer','NO'),
            ('feedbackCategories','createdAt','timestamp with time zone','NO'),
            ('feedbackCategories','updatedAt','timestamp with time zone','NO'),
            ('feedbackIdeas','id','uuid','NO'),
            ('feedbackIdeas','boardId','uuid','NO'),
            ('feedbackIdeas','pageId','integer','NO'),
            ('feedbackIdeas','submittedBy','integer','YES'),
            ('feedbackIdeas','state','character varying','NO'),
            ('feedbackIdeas','previousState','character varying','YES'),
            ('feedbackIdeas','ideaRevision','bigint','NO'),
            ('feedbackIdeas','categoryId','uuid','YES'),
            ('feedbackIdeas','categoryLabel','character varying','YES'),
            ('feedbackIdeas','withdrawnAt','timestamp with time zone','YES'),
            ('feedbackIdeas','moderatorWithdrawal','boolean','NO'),
            ('feedbackIdeas','submittedAt','timestamp with time zone','NO'),
            ('feedbackIdeas','createdAt','timestamp with time zone','NO'),
            ('feedbackIdeas','updatedAt','timestamp with time zone','NO'),
            ('feedbackVotes','ideaId','uuid','NO'),
            ('feedbackVotes','userId','integer','NO'),
            ('feedbackVotes','voted','boolean','NO'),
            ('feedbackVotes','activatedAt','timestamp with time zone','YES'),
            ('feedbackVotes','updatedAt','timestamp with time zone','NO'),
            ('feedbackSubscriptions','ideaId','uuid','NO'),
            ('feedbackSubscriptions','userId','integer','NO'),
            ('feedbackSubscriptions','createdAt','timestamp with time zone','NO'),
            ('feedbackTransitions','id','uuid','NO'),
            ('feedbackTransitions','boardId','uuid','NO'),
            ('feedbackTransitions','ideaId','uuid','YES'),
            ('feedbackTransitions','actorId','integer','YES'),
            ('feedbackTransitions','kind','character varying','NO'),
            ('feedbackTransitions','fromState','character varying','YES'),
            ('feedbackTransitions','toState','character varying','YES'),
            ('feedbackTransitions','explanation','text','YES'),
            ('feedbackTransitions','categoryLabel','character varying','YES'),
            ('feedbackTransitions','details','jsonb','NO'),
            ('feedbackTransitions','createdAt','timestamp with time zone','NO'),
            ('feedbackRequestReceipts','requestId','uuid','NO'),
            ('feedbackRequestReceipts','actorId','integer','YES'),
            ('feedbackRequestReceipts','boardId','uuid','NO'),
            ('feedbackRequestReceipts','ideaId','uuid','NO'),
            ('feedbackRequestReceipts','commandHash','character varying','NO'),
            ('feedbackRequestReceipts','result','jsonb','NO'),
            ('feedbackRequestReceipts','createdAt','timestamp with time zone','NO'),
            ('feedbackAdmissions','id','uuid','NO'),
            ('feedbackAdmissions','boardId','uuid','NO'),
            ('feedbackAdmissions','actorId','integer','YES'),
            ('feedbackAdmissions','createdAt','timestamp with time zone','NO'),
            ('feedbackWriteAdmissions','id','uuid','NO'),
            ('feedbackWriteAdmissions','actorId','integer','NO'),
            ('feedbackWriteAdmissions','createdAt','timestamp with time zone','NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 61 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('feedbackBoards','id',true),
            ('feedbackBoards','boardPageId',false),
            ('feedbackCategories','id',true),
            ('feedbackCategories','id,boardId',false),
            ('feedbackIdeas','id',true),
            ('feedbackIdeas','pageId',false),
            ('feedbackVotes','ideaId,userId',true),
            ('feedbackSubscriptions','ideaId,userId',true),
            ('feedbackTransitions','id',true),
            ('feedbackRequestReceipts','requestId',true),
            ('feedbackAdmissions','id',true),
            ('feedbackWriteAdmissions','id',true)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 12 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,target_table,target_columns,delete_mode) AS (VALUES
            ('feedbackCategories','boardId','feedbackBoards','id','c'),
            ('feedbackIdeas','boardId','feedbackBoards','id','c'),
            ('feedbackIdeas','submittedBy','users','id','n'),
            ('feedbackIdeas','categoryId,boardId','feedbackCategories','id,boardId','a'),
            ('feedbackVotes','ideaId','feedbackIdeas','id','c'),
            ('feedbackVotes','userId','users','id','c'),
            ('feedbackSubscriptions','ideaId','feedbackIdeas','id','c'),
            ('feedbackSubscriptions','userId','users','id','c'),
            ('feedbackTransitions','boardId','feedbackBoards','id','c'),
            ('feedbackTransitions','ideaId','feedbackIdeas','id','c'),
            ('feedbackTransitions','actorId','users','id','n'),
            ('feedbackRequestReceipts','actorId','users','id','n'),
            ('feedbackRequestReceipts','boardId','feedbackBoards','id','c'),
            ('feedbackRequestReceipts','ideaId','feedbackIdeas','id','c'),
            ('feedbackAdmissions','boardId','feedbackBoards','id','c'),
            ('feedbackAdmissions','actorId','users','id','n'),
            ('feedbackWriteAdmissions','actorId','users','id','c')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND target.relnamespace=current_schema()::regnamespace
              AND t.relname=e.table_name AND target.relname=e.target_table AND c.contype='f' AND c.convalidated
              AND c.confdeltype::text=e.delete_mode
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.attnum)=e.target_columns
          );
        ")"
        [[ "$result" == 17 ]] || die "Postcondition failed: $probe (native foreign keys and retention actions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns) AS (VALUES
            ('feedbackIdeas','boardId,submittedAt,id'),
            ('feedbackTransitions','ideaId,createdAt'),
            ('feedbackAdmissions','boardId,actorId,createdAt'),
            ('feedbackWriteAdmissions','actorId,createdAt')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe (bounded lookup and recovery indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,expression) AS (VALUES
            ('feedbackBoards','boardrevision>0'),
            ('feedbackIdeas','statein''proposed'',''planned'',''in-progress'',''completed'',''closed'',''withdrawn'''),
            ('feedbackIdeas','idearevision>0')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name AND c.contype='c' AND c.convalidated
              AND replace(regexp_replace(lower(replace(replace(pg_get_expr(c.conbin,c.conrelid),
                '::character varying',''),'::text','')), '[[:space:]()\"\\[\\]]', '', 'g'),'=anyarray','in')=e.expression
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (validated native value and revision checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,default_value) AS (VALUES
            ('feedbackBoards','enabled','false'),
            ('feedbackBoards','boardRevision','1'),
            ('feedbackCategories','active','true'),
            ('feedbackCategories','displayOrder','0'),
            ('feedbackIdeas','ideaRevision','1'),
            ('feedbackIdeas','moderatorWithdrawal','false')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE regexp_replace(replace(replace(replace(c.column_default,'::bigint',''),'::integer',''),'::boolean',''),
            '[()''[:space:]]','','g')=e.default_value;
        ")"
        [[ "$result" == 6 ]] || die "Postcondition failed: $probe (native defaults including explicit opt-in)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT (SELECT count(*) FROM \"feedbackBoards\" WHERE \"boardRevision\"<=0)
            + (SELECT count(*) FROM \"feedbackIdeas\" WHERE \"ideaRevision\"<=0
              OR state NOT IN ('proposed','planned','in-progress','completed','closed','withdrawn'))
            + (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('\"feedbackBoards\"'::regclass,'\"feedbackIdeas\"'::regclass)
              AND contype='f' AND confrelid='pages'::regclass);
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-page-review-routing-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('pageReviewRouting','pageId','integer','NO'),
            ('pageReviewRouting','revision','bigint','NO'),
            ('pageReviewRouting','mode','character varying','NO'),
            ('pageReviewRouting','enabled','boolean','NO'),
            ('pageReviewRouting','scheduleMode','character varying','NO'),
            ('pageReviewRouting','scheduleGeneration','bigint','NO'),
            ('pageReviewRouting','independentAnchorAt','timestamp with time zone','YES'),
            ('pageReviewRouting','independentIntervalDays','integer','YES'),
            ('pageReviewRouting','enabledAt','timestamp with time zone','YES'),
            ('pageReviewRouting','observedSourceRevision','bigint','NO'),
            ('pageReviewRouting','unverifiedAt','timestamp with time zone','NO'),
            ('pageReviewRouting','createdBy','integer','YES'),
            ('pageReviewRouting','updatedBy','integer','YES'),
            ('pageReviewRouting','createdAt','timestamp with time zone','NO'),
            ('pageReviewRouting','updatedAt','timestamp with time zone','NO'),
            ('pageReviewRouting','lastScannedAt','timestamp with time zone','NO'),
            ('pageReviewCycles','id','uuid','NO'),
            ('pageReviewCycles','pageId','integer','NO'),
            ('pageReviewCycles','scheduleGeneration','bigint','NO'),
            ('pageReviewCycles','epochKey','character varying','NO'),
            ('pageReviewCycles','milestone','character varying','NO'),
            ('pageReviewCycles','cycleNo','bigint','YES'),
            ('pageReviewCycles','dueAt','timestamp with time zone','NO'),
            ('pageReviewCycles','sourceRevision','bigint','NO'),
            ('pageReviewCycles','status','character varying','NO'),
            ('pageReviewCycles','audienceRevision','bigint','NO'),
            ('pageReviewCycles','coalescedThrough','bigint','YES'),
            ('pageReviewCycles','createdAt','timestamp with time zone','NO'),
            ('pageReviewConsumed','pageId','integer','NO'),
            ('pageReviewConsumed','scheduleGeneration','bigint','NO'),
            ('pageReviewConsumed','epochKey','character varying','NO'),
            ('pageReviewConsumed','milestone','character varying','NO'),
            ('pageReviewConsumed','highWater','bigint','YES'),
            ('pageReviewConsumed','updatedAt','timestamp with time zone','NO'),
            ('pageReviewChannelReceipts','id','uuid','NO'),
            ('pageReviewChannelReceipts','cycleId','uuid','NO'),
            ('pageReviewChannelReceipts','userId','integer','NO'),
            ('pageReviewChannelReceipts','channel','character varying','NO'),
            ('pageReviewChannelReceipts','status','character varying','NO'),
            ('pageReviewChannelReceipts','consentAtAdmission','boolean','NO'),
            ('pageReviewChannelReceipts','attempt','integer','NO'),
            ('pageReviewChannelReceipts','messageId','character varying','YES'),
            ('pageReviewChannelReceipts','handoffJobId','uuid','YES'),
            ('pageReviewChannelReceipts','handoffLeaseOwner','character varying','YES'),
            ('pageReviewChannelReceipts','handoffLeaseToken','uuid','YES'),
            ('pageReviewChannelReceipts','safeFailureReason','character varying','YES'),
            ('pageReviewChannelReceipts','createdAt','timestamp with time zone','NO'),
            ('pageReviewChannelReceipts','updatedAt','timestamp with time zone','NO'),
            ('pageReviewChannelReceipts','acknowledgedAt','timestamp with time zone','YES'),
            ('pageReviewEmailAttempts','receiptId','uuid','NO'),
            ('pageReviewEmailAttempts','attempt','integer','NO'),
            ('pageReviewEmailAttempts','messageId','character varying','NO'),
            ('pageReviewEmailAttempts','status','character varying','NO'),
            ('pageReviewEmailAttempts','createdAt','timestamp with time zone','NO'),
            ('pageReviewEmailAttempts','updatedAt','timestamp with time zone','NO'),
            ('pageReviewRoutingAudit','id','uuid','NO'),
            ('pageReviewRoutingAudit','pageId','integer','NO'),
            ('pageReviewRoutingAudit','routingRevision','bigint','NO'),
            ('pageReviewRoutingAudit','scheduleGeneration','bigint','NO'),
            ('pageReviewRoutingAudit','actorId','integer','YES'),
            ('pageReviewRoutingAudit','command','character varying','NO'),
            ('pageReviewRoutingAudit','createdAt','timestamp with time zone','NO'),
            ('pageReviewRoutingUsers','pageId','integer','NO'),
            ('pageReviewRoutingUsers','referenceId','integer','NO'),
            ('pageReviewRoutingUsers','userId','integer','YES'),
            ('pageReviewRoutingGroups','pageId','integer','NO'),
            ('pageReviewRoutingGroups','referenceId','integer','NO'),
            ('pageReviewRoutingGroups','groupId','integer','YES')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 68 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('pageReviewRouting','pageId',true),
            ('pageReviewCycles','id',true),
            ('pageReviewCycles','pageId,scheduleGeneration,epochKey,milestone',false),
            ('pageReviewConsumed','pageId,scheduleGeneration,epochKey,milestone',true),
            ('pageReviewChannelReceipts','id',true),
            ('pageReviewChannelReceipts','cycleId,userId,channel',false),
            ('pageReviewEmailAttempts','receiptId,attempt',true),
            ('pageReviewRoutingAudit','id',true),
            ('pageReviewRoutingUsers','pageId,referenceId',true),
            ('pageReviewRoutingUsers','pageId,userId',false),
            ('pageReviewRoutingGroups','pageId,referenceId',true),
            ('pageReviewRoutingGroups','pageId,groupId',false)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 12 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,target_table,target_columns,delete_mode) AS (VALUES
            ('pageReviewRouting','pageId','pages','id','c'),
            ('pageReviewRouting','createdBy','users','id','n'),
            ('pageReviewRouting','updatedBy','users','id','n'),
            ('pageReviewCycles','pageId','pageReviewRouting','pageId','c'),
            ('pageReviewConsumed','pageId','pageReviewRouting','pageId','c'),
            ('pageReviewChannelReceipts','cycleId','pageReviewCycles','id','c'),
            ('pageReviewChannelReceipts','userId','users','id','c'),
            ('pageReviewChannelReceipts','handoffJobId','durableJobs','id','n'),
            ('pageReviewEmailAttempts','receiptId','pageReviewChannelReceipts','id','c'),
            ('pageReviewRoutingAudit','pageId','pageReviewRouting','pageId','c'),
            ('pageReviewRoutingAudit','actorId','users','id','n'),
            ('pageReviewRoutingUsers','pageId','pageReviewRouting','pageId','c'),
            ('pageReviewRoutingUsers','userId','users','id','n'),
            ('pageReviewRoutingGroups','pageId','pageReviewRouting','pageId','c'),
            ('pageReviewRoutingGroups','groupId','groups','id','n')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND target.relnamespace=current_schema()::regnamespace
              AND t.relname=e.table_name AND target.relname=e.target_table AND c.contype='f' AND c.convalidated
              AND c.confdeltype::text=e.delete_mode
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.attnum)=e.target_columns
          );
        ")"
        [[ "$result" == 15 ]] || die "Postcondition failed: $probe (native foreign keys and retention actions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns) AS (VALUES
            ('pageReviewRouting','enabled,lastScannedAt,pageId'),
            ('pageReviewCycles','pageId,createdAt'),
            ('pageReviewChannelReceipts','status,updatedAt')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (bounded lookup and recovery indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,expression) AS (VALUES
            ('pageReviewRouting','revision>0andschedulegeneration>0andobservedsourcerevision>0'),
            ('pageReviewRouting','modein''contacts'',''users'',''groups'''),
            ('pageReviewRouting','schedulemode=''accuracy-age''andindependentanchoratisnullandindependentintervaldaysisnullorschedulemode=''independent''andindependentanchoratisnotnullandindependentintervaldays>=1andindependentintervaldays<=3650'),
            ('pageReviewChannelReceipts','channelin''email'',''in-app''')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name AND c.contype='c' AND c.convalidated
              AND replace(regexp_replace(lower(replace(replace(pg_get_expr(c.conbin,c.conrelid),
                '::character varying',''),'::text','')), '[[:space:]()\"\\[\\]]', '', 'g'),'=anyarray','in')=e.expression
          );
        ")"
        [[ "$result" == 4 ]] || die "Postcondition failed: $probe (validated native value and revision checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,default_value) AS (VALUES
            ('pageReviewRouting','revision','1'),
            ('pageReviewRouting','enabled','false'),
            ('pageReviewRouting','scheduleGeneration','1'),
            ('pageReviewCycles','audienceRevision','0'),
            ('pageReviewChannelReceipts','attempt','0')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE regexp_replace(replace(replace(replace(c.column_default,'::bigint',''),'::integer',''),'::boolean',''),
            '[()''[:space:]]','','g')=e.default_value;
        ")"
        [[ "$result" == 5 ]] || die "Postcondition failed: $probe (native defaults including explicit opt-in)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT (SELECT count(*) FROM \"pageReviewRouting\" WHERE revision<=0 OR \"scheduleGeneration\"<=0 OR \"observedSourceRevision\"<=0
              OR mode NOT IN ('contacts','users','groups') OR (
                (\"scheduleMode\"='accuracy-age' AND \"independentAnchorAt\" IS NULL AND \"independentIntervalDays\" IS NULL)
                OR (\"scheduleMode\"='independent' AND \"independentAnchorAt\" IS NOT NULL AND \"independentIntervalDays\" BETWEEN 1 AND 3650)) IS NOT TRUE)
            + (SELECT count(*) FROM \"pageReviewChannelReceipts\" WHERE channel NOT IN ('email','in-app'));
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-page-lifecycle-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('pageLifecycleClocks','pageId','integer','NO'),
            ('pageLifecycleClocks','bodyEpoch','uuid','NO'),
            ('pageLifecycleClocks','bodyAnchorAt','timestamp with time zone','YES'),
            ('pageLifecycleClocks','bodyAnchorKind','character varying','NO'),
            ('pageLifecycleClocks','bodyDigest','character varying','NO'),
            ('pageLifecycleClocks','bodyObservedSourceRevision','bigint','NO'),
            ('pageLifecycleClocks','commentEpoch','uuid','NO'),
            ('pageLifecycleClocks','commentAnchorAt','timestamp with time zone','YES'),
            ('pageLifecycleClocks','commentAnchorKind','character varying','NO'),
            ('pageLifecycleClocks','lastCommentEvent','character varying','YES'),
            ('pageLifecycleCommentEvents','pageId','integer','NO'),
            ('pageLifecycleCommentEvents','eventId','character varying','NO'),
            ('pageLifecycleRules','id','uuid','NO'),
            ('pageLifecycleRules','version','integer','NO'),
            ('pageLifecycleRules','revision','integer','NO'),
            ('pageLifecycleRules','humanOwnerId','integer','YES'),
            ('pageLifecycleRules','authVersion','integer','NO'),
            ('pageLifecycleRules','unattendedConsent','boolean','NO'),
            ('pageLifecycleRules','definition','jsonb','NO'),
            ('pageLifecycleRules','status','character varying','NO'),
            ('pageLifecycleRules','reason','character varying','YES'),
            ('pageLifecycleRules','selectorFingerprint','character varying','NO'),
            ('pageLifecycleRules','selectedPages','jsonb','NO'),
            ('pageLifecycleRules','executionId','uuid','YES'),
            ('pageLifecycleRules','currentBatchId','uuid','YES'),
            ('pageLifecycleRules','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleRules','updatedAt','timestamp with time zone','NO'),
            ('pageLifecycleRules','retiredAt','timestamp with time zone','YES'),
            ('pageLifecycleRules','lastScannedAt','timestamp with time zone','YES'),
            ('pageLifecyclePreviews','id','uuid','NO'),
            ('pageLifecyclePreviews','actorId','integer','YES'),
            ('pageLifecyclePreviews','ruleId','uuid','YES'),
            ('pageLifecyclePreviews','ruleRevision','integer','YES'),
            ('pageLifecyclePreviews','authVersion','integer','NO'),
            ('pageLifecyclePreviews','fingerprint','character varying','NO'),
            ('pageLifecyclePreviews','request','jsonb','NO'),
            ('pageLifecyclePreviews','pages','jsonb','NO'),
            ('pageLifecyclePreviews','createdAt','timestamp with time zone','NO'),
            ('pageLifecyclePreviews','expiresAt','timestamp with time zone','NO'),
            ('pageLifecyclePreviews','consumedAt','timestamp with time zone','YES'),
            ('pageLifecycleRulePages','ruleId','uuid','NO'),
            ('pageLifecycleRulePages','pageId','integer','NO'),
            ('pageLifecycleRulePages','originalRelativePath','text','NO'),
            ('pageLifecycleRulePages','originalLocale','character varying','NO'),
            ('pageLifecycleRulePages','consumedBodyEpoch','uuid','YES'),
            ('pageLifecycleRulePages','consumedCommentEpoch','uuid','YES'),
            ('pageLifecycleRulePages','intervalHighWater','bigint','NO'),
            ('pageLifecycleRulePages','attemptedRevision','integer','NO'),
            ('pageLifecycleRulePages','attemptedBodyEpoch','uuid','YES'),
            ('pageLifecycleRulePages','attemptedCommentEpoch','uuid','YES'),
            ('pageLifecycleRulePages','attemptedIntervalHighWater','bigint','NO'),
            ('pageLifecycleRulePages','lastExecutionId','uuid','YES'),
            ('pageLifecycleRulePages','updatedAt','timestamp with time zone','NO'),
            ('pageLifecycleBatches','id','uuid','NO'),
            ('pageLifecycleBatches','ruleId','uuid','NO'),
            ('pageLifecycleBatches','ruleRevision','integer','NO'),
            ('pageLifecycleBatches','pages','jsonb','NO'),
            ('pageLifecycleBatches','scheduledCount','integer','NO'),
            ('pageLifecycleBatches','status','character varying','NO'),
            ('pageLifecycleBatches','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleBatches','completedAt','timestamp with time zone','YES'),
            ('pageLifecycleCycles','id','uuid','NO'),
            ('pageLifecycleCycles','ruleId','uuid','NO'),
            ('pageLifecycleCycles','batchId','uuid','NO'),
            ('pageLifecycleCycles','ruleRevision','integer','NO'),
            ('pageLifecycleCycles','pageId','integer','NO'),
            ('pageLifecycleCycles','conditionKey','character varying','NO'),
            ('pageLifecycleCycles','executionKey','uuid','NO'),
            ('pageLifecycleCycles','conditionEpoch','uuid','YES'),
            ('pageLifecycleCycles','cycleNo','bigint','YES'),
            ('pageLifecycleCycles','coalescedFrom','bigint','YES'),
            ('pageLifecycleCycles','coalescedThrough','bigint','YES'),
            ('pageLifecycleCycles','dueAt','timestamp with time zone','NO'),
            ('pageLifecycleCycles','selectedSourceRevision','bigint','NO'),
            ('pageLifecycleCycles','nextExpectedSourceRevision','bigint','NO'),
            ('pageLifecycleCycles','selectorFingerprint','character varying','NO'),
            ('pageLifecycleCycles','status','character varying','NO'),
            ('pageLifecycleCycles','reason','character varying','YES'),
            ('pageLifecycleCycles','jobId','uuid','YES'),
            ('pageLifecycleCycles','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleCycles','updatedAt','timestamp with time zone','NO'),
            ('pageLifecycleCycles','completedAt','timestamp with time zone','YES'),
            ('pageLifecycleActionReceipts','cycleId','uuid','NO'),
            ('pageLifecycleActionReceipts','effectIndex','integer','NO'),
            ('pageLifecycleActionReceipts','kind','character varying','NO'),
            ('pageLifecycleActionReceipts','state','character varying','NO'),
            ('pageLifecycleActionReceipts','reason','character varying','YES'),
            ('pageLifecycleActionReceipts','beforeSourceRevision','bigint','NO'),
            ('pageLifecycleActionReceipts','afterSourceRevision','bigint','NO'),
            ('pageLifecycleActionReceipts','operationId','uuid','YES'),
            ('pageLifecycleActionReceipts','proposalId','uuid','YES'),
            ('pageLifecycleActionReceipts','outboxId','uuid','YES'),
            ('pageLifecycleActionReceipts','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleActionReceipts','updatedAt','timestamp with time zone','NO'),
            ('pageLifecycleNotices','ruleId','uuid','NO'),
            ('pageLifecycleNotices','pageId','integer','NO'),
            ('pageLifecycleNotices','text','text','NO'),
            ('pageLifecycleNotices','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleNotices','updatedAt','timestamp with time zone','NO'),
            ('pageLifecycleMoveProposals','id','uuid','NO'),
            ('pageLifecycleMoveProposals','ruleId','uuid','NO'),
            ('pageLifecycleMoveProposals','cycleId','uuid','NO'),
            ('pageLifecycleMoveProposals','effectIndex','integer','NO'),
            ('pageLifecycleMoveProposals','ruleRevision','integer','NO'),
            ('pageLifecycleMoveProposals','pageId','integer','NO'),
            ('pageLifecycleMoveProposals','sourceRevision','bigint','NO'),
            ('pageLifecycleMoveProposals','sourcePath','text','NO'),
            ('pageLifecycleMoveProposals','sourceLocale','character varying','NO'),
            ('pageLifecycleMoveProposals','destinationPath','text','NO'),
            ('pageLifecycleMoveProposals','destinationLocale','character varying','NO'),
            ('pageLifecycleMoveProposals','selectorFingerprint','character varying','NO'),
            ('pageLifecycleMoveProposals','status','character varying','NO'),
            ('pageLifecycleMoveProposals','reason','character varying','YES'),
            ('pageLifecycleMoveProposals','resultSourceRevision','bigint','YES'),
            ('pageLifecycleMoveProposals','fulfilledBy','integer','YES'),
            ('pageLifecycleMoveProposals','outboxId','uuid','YES'),
            ('pageLifecycleMoveProposals','createdAt','timestamp with time zone','NO'),
            ('pageLifecycleMoveProposals','expiresAt','timestamp with time zone','NO'),
            ('pageLifecycleMoveProposals','settledAt','timestamp with time zone','YES')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 119 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('pageLifecycleClocks','pageId',true),
            ('pageLifecycleCommentEvents','pageId,eventId',true),
            ('pageLifecycleRules','id',true),
            ('pageLifecyclePreviews','id',true),
            ('pageLifecycleRulePages','ruleId,pageId',true),
            ('pageLifecycleBatches','id',true),
            ('pageLifecycleCycles','id',true),
            ('pageLifecycleCycles','ruleId,ruleRevision,pageId,conditionKey,executionKey',false),
            ('pageLifecycleActionReceipts','cycleId,effectIndex',true),
            ('pageLifecycleNotices','ruleId,pageId',true),
            ('pageLifecycleMoveProposals','id',true),
            ('pageLifecycleMoveProposals','cycleId,effectIndex',false)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 12 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,target_table,target_columns,delete_mode) AS (VALUES
            ('pageLifecycleClocks','pageId','pages','id','c'),
            ('pageLifecycleCommentEvents','pageId','pages','id','c'),
            ('pageLifecycleRules','humanOwnerId','users','id','n'),
            ('pageLifecyclePreviews','actorId','users','id','n'),
            ('pageLifecycleRulePages','ruleId','pageLifecycleRules','id','r'),
            ('pageLifecycleBatches','ruleId','pageLifecycleRules','id','r'),
            ('pageLifecycleCycles','ruleId','pageLifecycleRules','id','r'),
            ('pageLifecycleCycles','batchId','pageLifecycleBatches','id','r'),
            ('pageLifecycleActionReceipts','cycleId','pageLifecycleCycles','id','c'),
            ('pageLifecycleNotices','ruleId','pageLifecycleRules','id','r'),
            ('pageLifecycleNotices','pageId','pages','id','c'),
            ('pageLifecycleMoveProposals','ruleId','pageLifecycleRules','id','r'),
            ('pageLifecycleMoveProposals','cycleId','pageLifecycleCycles','id','r'),
            ('pageLifecycleMoveProposals','fulfilledBy','users','id','n')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND target.relnamespace=current_schema()::regnamespace
              AND t.relname=e.table_name AND target.relname=e.target_table AND c.contype='f' AND c.convalidated
              AND c.confdeltype::text=e.delete_mode
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.attnum)=e.target_columns
          );
        ")"
        [[ "$result" == 14 ]] || die "Postcondition failed: $probe (native foreign keys and retention actions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns) AS (VALUES
            ('pageLifecycleRules','status,lastScannedAt,id'),
            ('pageLifecycleRules','humanOwnerId,status'),
            ('pageLifecyclePreviews','expiresAt'),
            ('pageLifecycleBatches','ruleId,status'),
            ('pageLifecycleCycles','batchId,status'),
            ('pageLifecycleCycles','completedAt'),
            ('pageLifecycleMoveProposals','ruleId,pageId,status'),
            ('pageLifecycleMoveProposals','expiresAt')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 8 ]] || die "Postcondition failed: $probe (bounded lookup and recovery indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,expression) AS (VALUES
            ('pageLifecycleClocks','bodyanchorkindin''known-change'',''observed-baseline'',''unknown'''),
            ('pageLifecycleClocks','commentanchorkindin''known-change'',''observed-baseline'',''unknown'''),
            ('pageLifecycleRules','version=1andrevision>0')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name AND c.contype='c' AND c.convalidated
              AND replace(regexp_replace(lower(replace(replace(pg_get_expr(c.conbin,c.conrelid),
                '::character varying',''),'::text','')), '[[:space:]()\"\\[\\]]', '', 'g'),'=anyarray','in')=e.expression
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (validated native value and revision checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,default_value) AS (VALUES
            ('pageLifecycleRules','unattendedConsent','false'),
            ('pageLifecycleRulePages','intervalHighWater','-1'),
            ('pageLifecycleRulePages','attemptedRevision','0'),
            ('pageLifecycleRulePages','attemptedIntervalHighWater','-1'),
            ('pageLifecycleBatches','scheduledCount','0')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE regexp_replace(replace(replace(replace(c.column_default,'::bigint',''),'::integer',''),'::boolean',''),
            '[()''[:space:]]','','g')=e.default_value;
        ")"
        [[ "$result" == 5 ]] || die "Postcondition failed: $probe (native defaults including explicit opt-in)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT (SELECT count(*) FROM pages p LEFT JOIN \"pageLifecycleClocks\" c ON c.\"pageId\"=p.id
              WHERE c.\"pageId\" IS NULL OR c.\"bodyObservedSourceRevision\">p.\"sourceRevision\")
            + (SELECT count(*) FROM \"pageLifecycleClocks\" WHERE length(\"bodyDigest\")<>64 OR \"bodyObservedSourceRevision\"<=0
              OR (\"bodyAnchorKind\"='unknown' AND \"bodyAnchorAt\" IS NOT NULL)
              OR (\"commentAnchorKind\"='unknown' AND \"commentAnchorAt\" IS NOT NULL)
              OR \"bodyAnchorKind\" NOT IN ('known-change','observed-baseline','unknown')
              OR \"commentAnchorKind\" NOT IN ('known-change','observed-baseline','unknown'))
            + (SELECT count(*) FROM \"pageLifecycleRules\" WHERE version<>1 OR revision<=0)
            + (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('\"pageLifecycleRulePages\"'::regclass,
                '\"pageLifecycleCycles\"'::regclass,'\"pageLifecycleMoveProposals\"'::regclass)
              AND contype='f' AND confrelid='pages'::regclass);
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-governed-notifications-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,data_type,nullable) AS (VALUES
            ('governedNotificationReceipts','id','uuid','NO'),
            ('governedNotificationReceipts','eventId','uuid','NO'),
            ('governedNotificationReceipts','userId','integer','NO'),
            ('governedNotificationReceipts','pageId','integer','NO'),
            ('governedNotificationReceipts','category','character varying','NO'),
            ('governedNotificationReceipts','channel','character varying','NO'),
            ('governedNotificationReceipts','status','character varying','NO'),
            ('governedNotificationReceipts','attempt','integer','NO'),
            ('governedNotificationReceipts','messageId','text','YES'),
            ('governedNotificationReceipts','safeFailureReason','text','YES'),
            ('governedNotificationReceipts','admittedAt','timestamp with time zone','NO'),
            ('governedNotificationReceipts','createdAt','timestamp with time zone','NO'),
            ('governedNotificationReceipts','updatedAt','timestamp with time zone','NO'),
            ('governedNotificationEmailAttempts','receiptId','uuid','NO'),
            ('governedNotificationEmailAttempts','attempt','integer','NO'),
            ('governedNotificationEmailAttempts','status','character varying','NO'),
            ('governedNotificationEmailAttempts','messageId','text','YES'),
            ('governedNotificationEmailAttempts','duplicateAcknowledged','boolean','NO'),
            ('governedNotificationEmailAttempts','createdAt','timestamp with time zone','NO'),
            ('governedNotificationEmailAttempts','updatedAt','timestamp with time zone','NO')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 20 ]] || die "Postcondition failed: $probe (native columns and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,is_primary) AS (VALUES
            ('governedNotificationReceipts','id',true),
            ('governedNotificationReceipts','eventId,userId,channel',false),
            ('governedNotificationEmailAttempts','receiptId,attempt',true)
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
              AND i.indisprimary=e.is_primary AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns,target_table,target_columns,delete_mode) AS (VALUES
            ('governedNotificationReceipts','eventId','outboxEvents','id','r'),
            ('governedNotificationReceipts','userId','users','id','c'),
            ('governedNotificationEmailAttempts','receiptId','governedNotificationReceipts','id','c')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND target.relnamespace=current_schema()::regnamespace
              AND t.relname=e.table_name AND target.relname=e.target_table AND c.contype='f' AND c.convalidated
              AND c.confdeltype::text=e.delete_mode
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.attnum)=e.target_columns
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (native foreign keys and retention actions)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,columns) AS (VALUES
            ('governedNotificationReceipts','userId,updatedAt,id'),
            ('governedNotificationReceipts','status,updatedAt'),
            ('governedNotificationEmailAttempts','status,updatedAt')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indnkeyatts=i.indnatts
              AND (SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum)=e.columns
          );
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (bounded lookup and recovery indexes)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,expression) AS (VALUES
            ('governedNotificationReceipts','categoryin''feedbackstatus'',''pagelifecycle'''),
            ('governedNotificationReceipts','channelin''in-app'',''email'''),
            ('governedNotificationReceipts','statusin''pending'',''sending'',''delivered'',''sent'',''suppressed'',''unknown'',''failed'''),
            ('governedNotificationReceipts','attempt>=0'),
            ('governedNotificationEmailAttempts','statusin''sending'',''sent'',''suppressed'',''unknown'',''retry-before-handoff'',''failed'''),
            ('governedNotificationEmailAttempts','attempt>=0')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname=e.table_name AND c.contype='c' AND c.convalidated
              AND replace(regexp_replace(lower(replace(replace(pg_get_expr(c.conbin,c.conrelid),
                '::character varying',''),'::text','')), '[[:space:]()\"\\[\\]]', '', 'g'),'=anyarray','in')=e.expression
          );
        ")"
        [[ "$result" == 6 ]] || die "Postcondition failed: $probe (validated native value and revision checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(table_name,column_name,default_value) AS (VALUES
            ('governedNotificationReceipts','attempt','0'),
            ('governedNotificationEmailAttempts','duplicateAcknowledged','false')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name=e.table_name AND c.column_name=e.column_name
          WHERE regexp_replace(replace(replace(replace(c.column_default,'::bigint',''),'::integer',''),'::boolean',''),
            '[()''[:space:]]','','g')=e.default_value;
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (native defaults including explicit opt-in)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT (SELECT count(*) FROM \"governedNotificationReceipts\" WHERE category NOT IN ('feedbackStatus','pageLifecycle')
              OR channel NOT IN ('in-app','email') OR status NOT IN ('pending','sending','delivered','sent','suppressed','unknown','failed') OR attempt<0)
            + (SELECT count(*) FROM \"governedNotificationEmailAttempts\" WHERE attempt<0
              OR status NOT IN ('sending','sent','suppressed','unknown','retry-before-handoff','failed'));
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid durable rows or destructive canonical-page foreign keys)"
        ;;
      native-storage-page-import-owners-schema)
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(column_name,data_type,max_length,nullable) AS (VALUES
            ('pageId','integer',NULL,'NO'),('sourceKey','character varying',64,'NO'),
            ('sourcePath','text',NULL,'NO'),('sourceSha256','character varying',64,'NO'),
            ('locationKey','character varying',64,'NO'),('mapped','boolean',NULL,'NO'),
            ('nativeRevision','bigint',NULL,'NO'),('nativePath','text',NULL,'NO'),
            ('nativeLocaleCode','character varying',255,'NO'),('status','character varying',16,'NO'),
            ('operationId','uuid',NULL,'NO'),('moveBinding','jsonb',NULL,'YES'),
            ('updatedAt','timestamp with time zone',NULL,'NO'),('deletedAt','timestamp with time zone',NULL,'YES')
          ) SELECT count(*) FROM expected e JOIN information_schema.columns c
            ON c.table_schema=current_schema() AND c.table_name='storagePageImportOwners' AND c.column_name=e.column_name
          WHERE c.data_type=e.data_type AND c.character_maximum_length IS NOT DISTINCT FROM e.max_length AND c.is_nullable=e.nullable;
        ")"
        [[ "$result" == 14 ]] || die "Postcondition failed: $probe (native columns, bounds and nullability)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='storagePageImportOwners'
            AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
            AND i.indnkeyatts=1 AND i.indnatts=1 AND pg_get_indexdef(i.indexrelid,1,true)=quote_ident('pageId');
        ")"
        [[ "$result" == 1 ]] || die "Postcondition failed: $probe (durable primary and unique identities)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='storagePageImportOwners'
            AND i.indisvalid AND i.indisready AND i.indnkeyatts=2 AND i.indnatts=2
            AND pg_get_indexdef(i.indexrelid,1,true)=quote_ident('sourceKey')
            AND pg_get_indexdef(i.indexrelid,2,true)=quote_ident('sourcePath') AND (
              (idx.relname='storage_page_import_source_idx' AND NOT i.indisunique AND i.indpred IS NULL)
              OR (idx.relname='storage_page_import_active_source_unique' AND i.indisunique
                AND regexp_replace(replace(replace(pg_get_expr(i.indpred,i.indrelid),'::character varying',''),'::text',''),
                  '[[:space:]()\"]','','g')='status=''active''')
            );
        ")"
        [[ "$result" == 2 ]] || die "Postcondition failed: $probe (bounded lookup and active-only source uniqueness)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          WITH expected(name,expression) AS (VALUES
            ('storage_page_import_native_identity_check','pageid>0andnativerevision>0'),
            ('storage_page_import_digest_check','sourcekey~''^[a-f0-9]{64}\$''andsourcesha256~''^[a-f0-9]{64}\$''andlocationkey~''^[a-f0-9]{64}\$'''),
            ('storage_page_import_path_bounds_check','lengthsourcepath>=1andlengthsourcepath<=4096andlengthnativepath>=1andlengthnativepath<=2048andlengthnativelocalecode>=1andlengthnativelocalecode<=255'),
            ('storage_page_import_status_check','status=''active''anddeletedatisnullorstatus=''deleted''anddeletedatisnotnull'),
            ('storage_page_import_move_binding_check','movebindingisnullorjsonb_typeofmovebinding=''object''')
          ) SELECT count(*) FROM expected e WHERE EXISTS (
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='storagePageImportOwners'
              AND c.conname=e.name AND c.contype='c' AND c.convalidated
              AND regexp_replace(lower(replace(replace(pg_get_expr(c.conbin,c.conrelid),'::character varying',''),'::text','')),
                '[[:space:]()\"]','','g')=e.expression
          );
        ")"
        [[ "$result" == 5 ]] || die "Postcondition failed: $probe (validated native identity, digest, path, retirement and JSON checks)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='storagePageImportOwners'
            AND ((column_name='mapped' AND column_default='false')
              OR (column_name='status' AND replace(column_default,'::character varying','')='''active''')
              OR (column_name='updatedAt' AND lower(column_default) IN ('current_timestamp','now()')));
        ")"
        [[ "$result" == 3 ]] || die "Postcondition failed: $probe (native unmapped, active and timestamp defaults)"
        # These receipts deliberately outlive canonical pages and pruned root
        # outbox events; existence of those referenced objects is not a probe.
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relnamespace=current_schema()::regnamespace AND t.relname='storagePageImportOwners' AND c.contype='f';
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (ownership must survive canonical and outbox deletion)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM \"storagePageImportOwners\" WHERE \"pageId\"<=0 OR \"nativeRevision\"<=0
            OR \"sourceKey\" !~ '^[a-f0-9]{64}\$' OR \"sourceSha256\" !~ '^[a-f0-9]{64}\$' OR \"locationKey\" !~ '^[a-f0-9]{64}\$'
            OR length(\"sourcePath\") NOT BETWEEN 1 AND 4096 OR length(\"nativePath\") NOT BETWEEN 1 AND 2048
            OR length(\"nativeLocaleCode\") NOT BETWEEN 1 AND 255
            OR \"sourcePath\" ~ '(^|/)([.]|[.][.]|)(/|\$)' OR position(chr(92) in \"sourcePath\")>0
            OR \"sourcePath\" ~ '[\\x01-\\x1f\\x7f]' OR \"nativeLocaleCode\" ~ '[[:space:]/]'
            OR position(chr(92) in \"nativeLocaleCode\")>0 OR \"nativeLocaleCode\" ~ '[\\x01-\\x1f\\x7f]'
            OR ((status='active' AND \"deletedAt\" IS NULL) OR (status='deleted' AND \"deletedAt\" IS NOT NULL)) IS NOT TRUE
            OR (\"moveBinding\" IS NOT NULL AND jsonb_typeof(\"moveBinding\")<>'object');
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid retained native ownership rows)"
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "
          SELECT count(*) FROM \"storagePageImportOwners\" o WHERE \"moveBinding\" IS NOT NULL AND
            CASE WHEN jsonb_typeof(\"moveBinding\")='object' THEN (
              \"moveBinding\" ?& ARRAY['phase','fromGitRevision','toGitRevision','oldSourcePath','newSourcePath',
                'oldSourceSha256','newSourceSha256','previousNativeRevision','previousNativePath',
                'previousNativeLocaleCode','moveOperationId','moveNativeRevision']
              AND (SELECT count(*) FROM jsonb_object_keys(\"moveBinding\"))=12
              AND NOT EXISTS (SELECT 1 FROM jsonb_each(\"moveBinding\") field WHERE jsonb_typeof(field.value)<>'string')
              AND \"moveBinding\"->>'phase' IN ('moved','completed')
              AND \"moveBinding\"->>'fromGitRevision' ~ '^([a-f0-9]{40}|[a-f0-9]{64})\$'
              AND \"moveBinding\"->>'toGitRevision' ~ '^([a-f0-9]{40}|[a-f0-9]{64})\$'
              AND \"moveBinding\"->>'oldSourceSha256' ~ '^[a-f0-9]{64}\$'
              AND \"moveBinding\"->>'newSourceSha256' ~ '^[a-f0-9]{64}\$'
              AND NOT EXISTS (
                SELECT 1 FROM (VALUES ('oldSourcePath',4096),('newSourcePath',4096),
                  ('previousNativePath',2048),('previousNativeLocaleCode',255)) field(name,max_length)
                WHERE length(o.\"moveBinding\"->>field.name) NOT BETWEEN 1 AND field.max_length
              )
              AND NOT EXISTS (
                SELECT 1 FROM (VALUES ('oldSourcePath'),('newSourcePath')) field(name)
                WHERE o.\"moveBinding\"->>field.name ~ '(^|/)([.]|[.][.]|)(/|\$)'
                  OR position(chr(92) in (o.\"moveBinding\"->>field.name))>0
                  OR o.\"moveBinding\"->>field.name ~ '[\\x01-\\x1f\\x7f]'
              )
              AND \"moveBinding\"->>'previousNativeLocaleCode' !~ '[[:space:]/]'
              AND position(chr(92) in (\"moveBinding\"->>'previousNativeLocaleCode'))=0
              AND \"moveBinding\"->>'previousNativeLocaleCode' !~ '[\\x01-\\x1f\\x7f]'
              AND NOT EXISTS (
                SELECT 1 FROM (VALUES ('previousNativeRevision'),('moveNativeRevision')) field(name)
                WHERE o.\"moveBinding\"->>field.name !~ '^[1-9][0-9]{0,18}\$'
                  OR (length(o.\"moveBinding\"->>field.name)=19
                    AND (o.\"moveBinding\"->>field.name) COLLATE \"C\">'9223372036854775807')
              )
              AND \"moveBinding\"->>'moveOperationId' ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$'
            ) IS NOT TRUE ELSE true END;
        ")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe (invalid finite native move binding)"
        ;;
      *) die "Unsupported named migration postcondition: $probe" ;;
    esac
  done < <(jq -r --arg phase "$phase" --argjson registry "$TARGET_CONTRACTS" \
    '.pendingMigrations[] as $name | $registry.migrations[$name][$phase][]' "$PLAN_FILE")
}

table_hash() {
  local table="$1" sql_table="$1"; [[ "$table" == pageHistory ]] && sql_table='"pageHistory"'
  if [[ "$table" == users ]]; then
    local excluded_user_columns=()
    if jq -e '.pendingMigrations | index("tsepistle-000048-scarlett-native-adaptations.js") != null' "$PLAN_FILE" >/dev/null; then
      excluded_user_columns+=("'reduceMotion'" "'underlineLinks'" "'contentTextSize'" "'communicationLocale'")
    fi
    if jq -e '.pendingMigrations | index("tsepistle-000061-retire-profile-field.js") != null' "$PLAN_FILE" >/dev/null; then
      excluded_user_columns+=("'pronouns'")
    fi
    # Planned column changes must not weaken the fence around retained account data.
    local excluded_columns
    excluded_columns="$(IFS=,; printf '%s' "${excluded_user_columns[*]}")"
    psql_live -Atc "COPY (SELECT (to_jsonb(t) - ARRAY[$excluded_columns]::text[])::text FROM users t ORDER BY id) TO STDOUT" | sha256sum | cut -d' ' -f1
    return
  fi
  if [[ "$table" == pages || "$table" == pageHistory ]] &&
    jq -e '.pendingMigrations | index("tsepistle-000069-page-history-reasons.js") != null' "$PLAN_FILE" >/dev/null; then
    # Canonicalize both sides while these planned columns are absent at baseline.
    psql_live -Atc "COPY (SELECT (to_jsonb(t) - 'changeReason')::text FROM $sql_table t ORDER BY id) TO STDOUT" | sha256sum | cut -d' ' -f1
    return
  fi
  psql_live -Atc "COPY (SELECT row_to_json(t)::text FROM $sql_table t ORDER BY id) TO STDOUT" | sha256sum | cut -d' ' -f1
}

private_files_fingerprints() {
  local source destination
  docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{printf "%s|%s\n" .Source .Destination}}{{end}}' |
    while IFS='|' read -r source destination; do
      if [[ "$destination" == /run/secrets/* || "$destination" == /wiki/config.yml ]]; then sha256sum "$source"; fi
    done | sort
}

protected_container_state() {
  docker inspect "$DB_CONTAINER" "${SENTINELS[@]}" |
    jq -Sc 'map({id:.Id,restartCount:.RestartCount,startedAt:.State.StartedAt}) | unique_by(.id) | sort_by(.id)'
}

capture_baseline() {
  TEMP_ROOT="$(mktemp -d /opt/tsepistle-upgrade.XXXXXX)"; chmod 0700 "$TEMP_ROOT"
  local table name source destination
  for table in pages pageHistory users assets groups; do BASELINE_HASHES[$table]="$(table_hash "$table")"; done
  normalized_app_contract > "$TEMP_ROOT/app-contract-before.json"
  private_files_fingerprints > "$TEMP_ROOT/private-files.sha256"
  for name in "$DB_CONTAINER" "${SENTINELS[@]}"; do
    docker inspect "$name" >/dev/null 2>&1 || die "Sentinel container not found: $name"
    SENTINEL_STATE[$name]="$(docker inspect "$name" --format '{{.Id}}|{{.RestartCount}}|{{.State.StartedAt}}')"
  done
}

drain_and_recover() {
  local recovery_required
  recovery_required="$(jq -r '.risk.recoveryRequired' "$PLAN_FILE")"
  if [[ "$recovery_required" == true ]]; then
    docker network disconnect "$PROXY_NETWORK" "$APP_CONTAINER"; PROXY_GATED=true
  fi
  OLD_APP_CONTAINER="$APP_CONTAINER"
  docker stop --time 90 "$APP_CONTAINER" >/dev/null; OLD_APP_STOPPED=true
  [[ "$(psql_live -Atc 'SELECT is_locked FROM migrations_lock;')" == 0 ]] || die 'Migration ledger locked during the deployment window'
  [[ "$recovery_required" == true ]] || return 0
  local drain
  drain="$(psql_live -Atc "SELECT (SELECT is_locked FROM migrations_lock)||'|'||(SELECT count(*) FROM \"durableJobs\" WHERE state IN ('pending','running','leased','retrying'))||'|'||(SELECT count(*) FROM \"agentRuns\" WHERE status IN ('queued','running','leased','cancelling'))||'|'||(SELECT count(*) FROM \"agentQuotaReservations\" WHERE status NOT IN ('consumed','released','expired','reconciled') AND (\"reservedTokens\">\"consumedTokens\" OR \"reservedCostMicros\">\"consumedCostMicros\"));")"
  [[ "$drain" == '0|0|0|0' ]] || die "Writer drain did not settle: $drain"
  RECOVERY_PATH="$RECOVERY_DIR/pre-$(jq -r '.targetRevision[0:8]' "$PLAN_FILE")-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$RECOVERY_PATH"
  docker inspect "$APP_CONTAINER" "$DB_CONTAINER" > "$RECOVERY_PATH/container-inspect.json"
  compose config > "$RECOVERY_PATH/compose.resolved.yml"
  docker exec "$DB_CONTAINER" sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$RECOVERY_PATH/postgres.dump"
  docker exec -i "$DB_CONTAINER" pg_restore -l < "$RECOVERY_PATH/postgres.dump" > "$RECOVERY_PATH/postgres.list"
  docker cp --archive "$APP_CONTAINER:/wiki/data/." - | gzip -c > "$RECOVERY_PATH/wiki-data.tar.gz"
  tar -czf "$RECOVERY_PATH/config-and-keys.tar.gz" -P "$ENV_FILE" "$COMPOSE_FILE" "$SCRIPT_DIR/config.yml" \
    "$STATE_DIR/agent-runtime.env" "$STATE_DIR/db-password" "$STATE_DIR/app-db-password" \
    "$STATE_DIR/agent-profile-resolution-keys.json" "$STATE_DIR/agent-provider-secret-keys.json" "$STATE_DIR/agent-snapshot-signing-secret"
  tar -tzf "$RECOVERY_PATH/wiki-data.tar.gz" > "$RECOVERY_PATH/wiki-data.list"
  tar -tzf "$RECOVERY_PATH/config-and-keys.tar.gz" > "$RECOVERY_PATH/config-and-keys.list"
  chmod 0600 "$RECOVERY_PATH"/*
  (cd "$RECOVERY_PATH" && sha256sum compose.resolved.yml container-inspect.json postgres.dump postgres.list wiki-data.tar.gz wiki-data.list config-and-keys.tar.gz config-and-keys.list > SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null)
  log "Validated paired recovery point: $RECOVERY_PATH"
}

set_candidate_image() {
  local image="$1" count temp mode uid gid
  count="$(grep -c '^TSEPISTLE_IMAGE=' "$ENV_FILE" || true)"; [[ "$count" == 1 ]] || die 'Compose env must contain exactly one TSEPISTLE_IMAGE entry'
  temp="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v image="$image" '/^TSEPISTLE_IMAGE=/{print "TSEPISTLE_IMAGE=" image; next}{print}' "$ENV_FILE" > "$temp"
  mode="$(stat -c '%a' "$ENV_FILE")"; uid="$(stat -c '%u' "$ENV_FILE")"; gid="$(stat -c '%g' "$ENV_FILE")"
  install -m "$mode" -o "$uid" -g "$gid" "$temp" "$ENV_FILE"; unlink "$temp"
}

start_candidate() {
  local candidate material
  candidate="$(jq -r '.candidateImage' "$PLAN_FILE")"; material="$(jq -r '.risk.recoveryRequired' "$PLAN_FILE")"
  OLD_IMAGE_SETTING="$(grep '^TSEPISTLE_IMAGE=' "$ENV_FILE" | cut -d= -f2-)"
  set_candidate_image "$candidate"
  RECREATE_BEGUN=true
  if [[ "$material" == true ]]; then
    compose up --no-start --no-deps --no-build --pull never --force-recreate "$APP_SERVICE"
    APP_CONTAINER="$(compose ps -a -q "$APP_SERVICE")"
    docker network disconnect "$PROXY_NETWORK" "$APP_CONTAINER" >/dev/null 2>&1 || true
    [[ -n "$RECOVERY_PATH" && -s "$RECOVERY_PATH/wiki-data.tar.gz" ]] || die 'Complete application data recovery archive is missing'
    gzip -dc "$RECOVERY_PATH/wiki-data.tar.gz" | docker cp --archive - "$APP_CONTAINER:/wiki/data"
    docker start "$APP_CONTAINER" >/dev/null
    wait_health "$APP_CONTAINER" || { docker logs --tail 160 "$APP_CONTAINER" >&2; die 'Candidate failed internal readiness'; }
  else
    if ! compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "$APP_SERVICE"; then
      APP_CONTAINER="$(compose ps -a -q "$APP_SERVICE")"
      [[ -z "$APP_CONTAINER" ]] || docker logs --tail 160 "$APP_CONTAINER" >&2
      die 'Candidate failed Compose readiness'
    fi
    APP_CONTAINER="$(compose ps -q "$APP_SERVICE")"
  fi
  OLD_APP_STOPPED=false
  local count
  count="$(psql_live -Atc 'SELECT count(*) FROM migrations;')"
  if (( count > $(jq -r '.migrationLedger.count' "$PLAN_FILE") )); then MIGRATION_COMMITTED=true; fi
}

verify_candidate() {
  local candidate target lock pending table name value
  candidate="$(jq -r '.candidateImage' "$PLAN_FILE")"; target="$(jq -r '.targetRevision' "$PLAN_FILE")"
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.Config.Image}}')" == "$candidate" ]] || die 'Live app image does not match candidate'
  [[ "$(docker image inspect "$candidate" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$target" ]] || die 'Live image revision label mismatch'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')" == "$CANDIDATE_ID" ]] || die 'Live container image ID mismatch'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.State.Health.Status}}|{{.RestartCount}}')" == 'healthy|0' ]] || die 'Candidate is unhealthy or restarted'
  local elapsed=0
  while (( elapsed < WAIT_TIMEOUT )); do
    lock="$(psql_live -Atc 'SELECT is_locked FROM migrations_lock;')"
    pending="$(psql_live -Atc "SELECT count(*) FROM \"durableJobs\" WHERE state IN ('pending','running','leased','retrying');")"
    [[ "$lock" == 0 && "$pending" == 0 ]] && break
    sleep 2; (( elapsed += 2 ))
  done
  [[ "$lock" == 0 && "$pending" == 0 ]] || die 'Migration lock or durable jobs did not settle'
  for table in pages pageHistory users assets groups; do [[ "$(table_hash "$table")" == "${BASELINE_HASHES[$table]}" ]] || die "$table changed unexpectedly"; done
  private_files_fingerprints > "$TEMP_ROOT/private-files-after.sha256"
  diff -u "$TEMP_ROOT/private-files.sha256" "$TEMP_ROOT/private-files-after.sha256" >/dev/null || die 'Config/secret path fingerprints changed'
  normalized_app_contract > "$TEMP_ROOT/app-contract-after.json"
  diff -u "$TEMP_ROOT/app-contract-before.json" "$TEMP_ROOT/app-contract-after.json" >/dev/null || die 'App runtime contract changed'
  for name in "${!SENTINEL_STATE[@]}"; do value="$(docker inspect "$name" --format '{{.Id}}|{{.RestartCount}}|{{.State.StartedAt}}')"; [[ "$value" == "${SENTINEL_STATE[$name]}" ]] || die "Sentinel changed: $name"; done
  verify_postconditions runtimePostconditions "$DB_CONTAINER" wiki wiki
  docker exec "$APP_CONTAINER" curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null || die 'Internal app health failed'
}

admit_and_check() {
  if [[ "$PROXY_GATED" == true ]]; then
    docker network connect --alias "$PROXY_ALIAS" "$PROXY_NETWORK" "$APP_CONTAINER"; PROXY_GATED=false
  fi
  curl --fail --silent --show-error --max-time 30 "$PUBLIC_URL/healthz" >/dev/null || die 'Public candidate health failed'
  local url; for url in "${CONTROL_URLS[@]}"; do curl --fail --silent --show-error --max-time 30 "$url/healthz" >/dev/null || die "Control URL failed: $url"; done
  local severe
  severe="$(docker logs --since 30m "$APP_CONTAINER" 2>&1 | grep -Eia '(^|[^a-z])(fatal|panic|unhandled|uncaught|migration failed)([^a-z]|$)' || true)"
  [[ -z "$severe" ]] || die "Severe candidate logs detected: $severe"
}

apply_plan() {
  load_apply_plan
  trap on_exit EXIT
  write_state applying
  rehearse_migrations
  drain_and_recover
  capture_baseline
  start_candidate
  verify_candidate
  admit_and_check
  write_state awaiting-external-browser-verification
  trap - EXIT; cleanup_temp
  log "Awaiting external browser verification: $CANDIDATE_IMAGE"
  printf 'After off-box login smoke succeeds:\n  sudo %q accept --plan %q --confirm %q --browser-smoke-passed\n' "$SCRIPT_DIR/upgrade.sh" "$PLAN_FILE" "$CONFIRM_DIGEST"
  [[ -z "$RECOVERY_PATH" ]] || log "Recovery point: $RECOVERY_PATH"
  [[ "$MIGRATION_COMMITTED" == false ]] || warn 'Schema changed: rollback is fix-forward or an explicitly authorized matching-state restore.'
}

verify_applied_bindings() {
  [[ "$APP_CONTAINER" == "$(jq -r '.appContainerId' "$STATE_FILE")" && "$DB_CONTAINER" == "$(jq -r '.databaseContainerId' "$STATE_FILE")" ]] || die 'Applied app/database candidate was replaced'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')" == "$CANDIDATE_ID" && "$CANDIDATE_ID" == "$(jq -r '.candidateImageId' "$STATE_FILE")" ]] || die 'Applied candidate image ID changed'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.Config.Image}}')" == "$CANDIDATE_IMAGE" && "$(live_revision)" == "$TARGET_REVISION" ]] || die 'Applied candidate reference or revision changed'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.State.Health.Status}}|{{.RestartCount}}')" == 'healthy|0' ]] || die 'Applied candidate is unhealthy or restarted'
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.State.StartedAt}}')" == "$(jq -r '.appStartedAt' "$STATE_FILE")" ]] || die 'Applied candidate was restarted'
  [[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" == "$(jq -r '.envSha256' "$STATE_FILE")" ]] || die 'Deployment environment changed after apply'
  [[ "$(private_files_fingerprints | sha256sum | cut -d' ' -f1)" == "$(jq -r '.privateFilesSha256' "$STATE_FILE")" ]] || die 'Applied configuration or secrets changed'
  [[ "$(protected_container_state)" == "$(jq -Sc '.protectedContainers' "$STATE_FILE")" ]] || die 'A protected container was replaced or restarted after apply'
  [[ "$(normalized_app_contract | sha256sum | cut -d' ' -f1)" == "$(jq -r '.appRuntimeContractSha256' "$STATE_FILE")" ]] || die 'Applied runtime contract changed'
  [[ "$(ledger_json | jq -c .)" == "$(jq -c '.migrationLedger' "$STATE_FILE")" && "$(ledger_summary | cut -d'|' -f4)" == 0 ]] || die 'Applied migration ledger changed or locked'
  local sentinel
  while IFS= read -r sentinel; do
    [[ "$(docker inspect "$(jq -r '.name' <<< "$sentinel")" --format '{{.Id}}')" == "$(jq -r '.id' <<< "$sentinel")" ]] || die 'A protected container changed after planning'
  done < <(jq -c '.sentinelInventory[]' "$PLAN_FILE")
}

accept_plan() {
  STATE_FILE="${PLAN_FILE}.state.json"
  validate_private_file "$STATE_FILE" 'Applied deployment state'
  jq -e --arg digest "$CONFIRM_DIGEST" '.schemaVersion == 1 and .phase == "awaiting-external-browser-verification" and .planDigest == $digest' "$STATE_FILE" >/dev/null || die 'Plan is not awaiting external browser verification'
  load_bound_plan
  validate_private_file "$STATE_FILE" 'Applied deployment state'
  jq -e --arg digest "$CONFIRM_DIGEST" '.schemaVersion == 1 and .phase == "awaiting-external-browser-verification" and .planDigest == $digest' "$STATE_FILE" >/dev/null || die 'Applied state changed before acceptance acquired the upgrade lock'
  verify_applied_bindings
  verify_postconditions runtimePostconditions "$DB_CONTAINER" wiki wiki
  admit_and_check
  verify_applied_bindings
  local accepted_state
  accepted_state="$(mktemp "${STATE_FILE}.XXXXXX")"
  jq --argjson at "$(date -u +%s)" '
    .phase = "accepted" | .updatedAt = $at | .browserSmokePassed = true |
    .browserVerification = "trusted-operator-confirmation"
  ' "$STATE_FILE" > "$accepted_state"
  install -m 0600 "$accepted_state" "$STATE_FILE"; unlink "$accepted_state"
  log "Deployment accepted after operator-confirmed external browser verification: $CANDIDATE_IMAGE"
}

main() {
  parse_args "$@"
  case "$COMMAND" in
    plan) load_profile; check_prerequisites; make_plan ;;
    apply) validate_plan; apply_plan ;;
    accept) validate_plan; accept_plan ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
