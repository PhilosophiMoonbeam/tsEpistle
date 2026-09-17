#!/usr/bin/env bash

# Two-phase, fail-closed app-only upgrader for the canonical Compose deployment.

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly CONTRACTS_FILE="server/db/migration-deployment-contracts.json"
readonly BUN_IMAGE="oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f"

COMMAND=""
PROFILE_FILE=""
TARGET_REVISION=""
PLAN_FILE=""
CONFIRM_DIGEST=""

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
PLAYWRIGHT_IMAGE=""
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
  sudo deploy/compose/upgrade.sh plan  --profile PATH --revision FULL_40_SHA
  sudo deploy/compose/upgrade.sh apply --plan PATH --confirm PLAN_SHA256

`plan` performs read-only live discovery and writes one mode-0600 expiring plan
under the profile's state directory. `apply` revalidates the plan, builds the
exact revision, and recreates only the application service.

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
  case "$COMMAND" in plan|apply) ;; -h|--help) usage; exit 0 ;; *) die "Unknown command: $COMMAND" ;; esac
  while (( $# > 0 )); do
    case "$1" in
      --profile) PROFILE_FILE="${2:-}"; shift 2 ;;
      --revision) TARGET_REVISION="${2:-}"; shift 2 ;;
      --plan) PLAN_FILE="${2:-}"; shift 2 ;;
      --confirm) CONFIRM_DIGEST="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  if [[ "$COMMAND" == plan ]]; then
    [[ -n "$PROFILE_FILE" && -n "$TARGET_REVISION" ]] || die 'plan requires --profile and --revision'
    [[ -z "$PLAN_FILE$CONFIRM_DIGEST" ]] || die 'plan does not accept --plan or --confirm'
  else
    [[ -n "$PLAN_FILE" && -n "$CONFIRM_DIGEST" ]] || die 'apply requires --plan and --confirm'
    [[ -z "$PROFILE_FILE$TARGET_REVISION" ]] || die 'apply reads profile/revision from its plan'
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
  jq -e '
    .schemaVersion == 1 and
    ([.repositoryRoot,.composeFile,.envFile,.stateDirectory,.recoveryDirectory,.project,.appService,.databaseService,.imageRepository,.publicUrl,.proxyNetwork,.proxyAlias,.playwrightImage] | all(type == "string" and length > 0)) and
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
  PLAYWRIGHT_IMAGE="$(jq -r '.playwrightImage' "$PROFILE_FILE")"
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
  for command in git docker jq curl tar sha256sum stat awk grep sed find install date mktemp diff; do require_command "$command"; done
  docker compose version >/dev/null
  [[ $(id -u) -eq 0 ]] || die 'Plan and apply must run as root so private state can remain mode 0600'
  git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- || die 'Working tree has unstaged tracked changes'
  git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules -- || die 'Working tree has staged changes'
  [[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]] || die 'Working tree has untracked files'
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
  image="$(docker inspect "$APP_CONTAINER" --format '{{.Config.Image}}')"
  docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
}

ledger_json() {
  psql_live -Atc "SELECT COALESCE(json_agg(name ORDER BY id)::text,'[]') FROM migrations;"
}

ledger_summary() {
  psql_live -AtF '|' -c "SELECT count(*),COALESCE(max(batch),0),(array_agg(name ORDER BY id DESC))[1],(SELECT is_locked FROM migrations_lock) FROM migrations;"
}

source_migrations_json() {
  find "$REPO_ROOT/server/db/migrations" -maxdepth 1 -type f -name 'tsepistle-*.ts' -printf '%f\n' \
    | sort | sed 's/\.ts$/.js/' | jq -Rsc 'split("\n") | map(select(length > 0))'
}

normalized_app_contract() {
  docker inspect "$APP_CONTAINER" | jq -S '.[0] | {
    name:.Name,user:.Config.User,restart:.HostConfig.RestartPolicy,readonly:.HostConfig.ReadonlyRootfs,
    portBindings:.HostConfig.PortBindings,exposedPorts:.Config.ExposedPorts,
    mounts:([.Mounts[]|{type:.Type,source:.Source,destination:.Destination,rw:.RW}]|sort_by(.destination)),
    networks:(.NetworkSettings.Networks|to_entries|map({name:.key,aliases:(.value.Aliases|sort)})|sort_by(.name)),
    service:(.Config.Labels["com.docker.compose.service"]),project:(.Config.Labels["com.docker.compose.project"])
  }'
}

plan_digest() {
  jq -S -c 'del(.digest)' "$1" | sha256sum | cut -d' ' -f1
}

make_plan() {
  [[ "$TARGET_REVISION" =~ ^[0-9a-f]{40}$ ]] || die '--revision must be a full lowercase 40-character commit SHA'
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$TARGET_REVISION" ]] || die 'HEAD must equal the requested revision'
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

  local registry="$REPO_ROOT/$CONTRACTS_FILE" enforce sequence contract recovery=false rehearsal=false rollback='image-only'
  jq -e '.schemaVersion == 1 and (.enforceFromSequence | type == "number") and (.migrations | type == "object")' "$registry" >/dev/null || die 'Migration deployment contract registry is invalid'
  enforce="$(jq -r '.enforceFromSequence' "$registry")"
  while IFS= read -r migration_name; do
    [[ -n "$migration_name" ]] || continue
    [[ "$migration_name" =~ ^tsepistle-([0-9]{6})-.+\.js$ ]] || die "Unsupported pending migration identity: $migration_name"
    sequence=$((10#${BASH_REMATCH[1]}))
    (( sequence >= enforce )) || die "Pending migration predates deployment-contract enforcement: $migration_name"
    contract="$(jq -ce --arg name "$migration_name" '.migrations[$name] // empty' "$registry")" || die "Pending migration has no deployment contract: $migration_name"
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
        site-logo-schema-v7|site-logo-pipeline-v7|agent-goal-budget-columns|agent-goal-budget-tier-selection) ;;
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

  local version candidate_image now expires run_dir draft digest plan_path contract_sha profile_sha app_contract_sha sentinel_inventory
  version="$(jq -er '.version' "$REPO_ROOT/package.json")"
  candidate_image="${IMAGE_REPOSITORY}:${version}-${TARGET_REVISION:0:8}"
  now="$(date -u +%s)"; expires=$((now + PLAN_LIFETIME))
  run_dir="$STATE_DIR/upgrade-runs"; install -d -m 0700 "$run_dir"
  plan_path="$run_dir/$(date -u +%Y%m%dT%H%M%SZ)-${TARGET_REVISION:0:8}.json"
  draft="$(mktemp "$run_dir/.plan.XXXXXX")"
  profile_sha="$(sha256sum "$PROFILE_FILE" | cut -d' ' -f1)"
  contract_sha="$(sha256sum "$registry" | cut -d' ' -f1)"
  app_contract_sha="$(normalized_app_contract | sha256sum | cut -d' ' -f1)"
  sentinel_inventory="$({
    for path in "$DB_CONTAINER" "${SENTINELS[@]}"; do
      docker inspect "$path" --format '{{json .}}' || die "Sentinel container not found: $path"
    done
  } | jq -sc 'map({name:.Name,id:.Id,image:.Config.Image}) | unique_by(.id) | sort_by(.name)')"
  jq -n \
    --arg profile "$PROFILE_FILE" --arg profileSha "$profile_sha" --arg target "$TARGET_REVISION" --arg live "$live_rev" \
    --arg liveImage "$live_image" --arg candidateImage "$candidate_image" --arg appId "$APP_CONTAINER" --arg dbId "$DB_CONTAINER" \
    --arg ledgerTail "$ledger_tail" --arg contractSha "$contract_sha" --arg appContractSha "$app_contract_sha" \
    --argjson createdAt "$now" --argjson expiresAt "$expires" --argjson ledgerCount "$ledger_count" --argjson ledgerBatch "$ledger_batch" \
    --argjson changes "$changed_files" --argjson migrations "$pending" --argjson sentinels "$sentinel_inventory" \
    --argjson recovery "$recovery" --argjson rehearsal "$rehearsal" --arg rollback "$rollback" \
    '{schemaVersion:1,phase:"planned",profile:$profile,profileSha256:$profileSha,createdAt:$createdAt,expiresAt:$expiresAt,
      targetRevision:$target,liveRevision:$live,liveImage:$liveImage,candidateImage:$candidateImage,appContainerId:$appId,databaseContainerId:$dbId,
      migrationLedger:{count:$ledgerCount,batch:$ledgerBatch,tail:$ledgerTail},sentinelInventory:$sentinels,
      changedFiles:$changes,pendingMigrations:$migrations,
      risk:{rehearsalRequired:$rehearsal,recoveryRequired:$recovery,rollback:$rollback},
      migrationContractsSha256:$contractSha,appRuntimeContractSha256:$appContractSha}' > "$draft"
  chmod 0600 "$draft"; digest="$(plan_digest "$draft")"
  jq --arg digest "$digest" '. + {digest:$digest}' "$draft" > "$plan_path"
  chmod 0600 "$plan_path"; unlink "$draft"
  log "Plan: $plan_path"
  log "Digest: $digest"
  log "Delta: $(jq 'length' <<< "$changed_files") files; $(jq 'length' <<< "$pending") pending migrations"
  log "Risk: rehearsal=$rehearsal recovery=$recovery rollback=$rollback"
  printf '\nApply only after reviewing the plan:\n  sudo %q apply --plan %q --confirm %q\n' "$SCRIPT_DIR/upgrade.sh" "$plan_path" "$digest"
}

load_apply_plan() {
  validate_private_file "$PLAN_FILE" 'Deployment plan'
  jq -e '.schemaVersion == 1 and .phase == "planned" and (.digest | type == "string")' "$PLAN_FILE" >/dev/null || die 'Deployment plan schema is invalid'
  [[ "$(plan_digest "$PLAN_FILE")" == "$CONFIRM_DIGEST" && "$(jq -r '.digest' "$PLAN_FILE")" == "$CONFIRM_DIGEST" ]] || die 'Plan digest confirmation does not match'
  (( $(date -u +%s) <= $(jq -r '.expiresAt' "$PLAN_FILE") )) || die 'Deployment plan expired; create a new plan'
  PROFILE_FILE="$(jq -r '.profile' "$PLAN_FILE")"; load_profile; check_prerequisites; resolve_containers
  [[ "$(sha256sum "$PROFILE_FILE" | cut -d' ' -f1)" == "$(jq -r '.profileSha256' "$PLAN_FILE")" ]] || die 'Operator profile changed after planning'
  [[ "$(sha256sum "$REPO_ROOT/$CONTRACTS_FILE" | cut -d' ' -f1)" == "$(jq -r '.migrationContractsSha256' "$PLAN_FILE")" ]] || die 'Migration contracts changed after planning'
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$(jq -r '.targetRevision' "$PLAN_FILE")" ]] || die 'HEAD changed after planning'
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
      warn 'Candidate recreation began; no automatic rollback was attempted.'
      [[ "$MIGRATION_COMMITTED" == false ]] || warn 'A migration committed. Never start the old image against this database.'
      [[ -z "$RECOVERY_PATH" ]] || warn "Recovery point: $RECOVERY_PATH"
    fi
  fi
  exit "$status"
}

build_candidate() {
  local image target existing
  image="$(jq -r '.candidateImage' "$PLAN_FILE")"; target="$(jq -r '.targetRevision' "$PLAN_FILE")"
  if docker image inspect "$image" >/dev/null 2>&1; then
    existing="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    [[ "$existing" == "$target" ]] || die 'Candidate tag already identifies a different revision'
    log "Reusing exact candidate image: $image"
  elif command -v bun >/dev/null 2>&1; then
    (cd "$REPO_ROOT" && bun run docker:build "$image")
  else
    log 'Host Bun is unavailable; running the canonical builder in a pinned Bun container'
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$REPO_ROOT:/repo:ro" -w /repo "$BUN_IMAGE" \
      sh -ec 'apk add --no-cache docker-cli docker-cli-buildx git >/dev/null && bun server/scripts/build-docker.ts "$1"' sh "$image"
  fi
  [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$target" ]] || die 'Candidate OCI revision label mismatch'
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
  docker run --name "$TEST_APP" --network "$TEST_NETWORK" \
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
        result="$(docker exec "$container" psql -X -U "$user" -d "$database" -Atc "SELECT count(*) FROM \"agentGoals\" WHERE (\"budgetSelection\"='legacy' AND (\"budgetPolicyVersion\" IS NOT NULL OR \"tokenTier\" IS NOT NULL OR \"tokenAllowance\" IS NOT NULL OR \"budgetCycle\" IS DISTINCT FROM 0)) OR (\"budgetSelection\"='pending' AND (\"budgetPolicyVersion\" IS DISTINCT FROM 1 OR \"tokenTier\" IS NOT NULL OR \"tokenAllowance\" IS NOT NULL OR \"budgetCycle\" IS DISTINCT FROM 0)) OR (\"budgetSelection\" IN ('utility','fallback') AND (\"budgetPolicyVersion\" IS DISTINCT FROM 1 OR \"tokenTier\" IS NULL OR \"tokenAllowance\" IS NULL OR \"budgetCycle\" IS NULL OR \"budgetCycle\"<1));")"
        [[ "$result" == 0 ]] || die "Postcondition failed: $probe ($result inconsistent goals)"
        ;;
      *) die "Unsupported named migration postcondition: $probe" ;;
    esac
  done < <(jq -r --arg phase "$phase" --slurpfile registry "$REPO_ROOT/$CONTRACTS_FILE" \
    '.pendingMigrations[] as $name | $registry[0].migrations[$name][$phase][]' "$PLAN_FILE")
}

table_hash() {
  local table="$1" sql_table="$1"; [[ "$table" == pageHistory ]] && sql_table='"pageHistory"'
  psql_live -Atc "COPY (SELECT row_to_json(t)::text FROM $sql_table t ORDER BY id) TO STDOUT" | sha256sum | cut -d' ' -f1
}

capture_baseline() {
  TEMP_ROOT="$(mktemp -d /opt/tsepistle-upgrade.XXXXXX)"; chmod 0700 "$TEMP_ROOT"
  local table name source destination
  for table in pages pageHistory users assets groups; do BASELINE_HASHES[$table]="$(table_hash "$table")"; done
  normalized_app_contract > "$TEMP_ROOT/app-contract-before.json"
  docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' | while IFS='|' read -r source destination; do
    if [[ "$destination" == /run/secrets/* || "$destination" == /wiki/config.yml ]]; then sha256sum "$source"; fi
  done > "$TEMP_ROOT/private-files.sha256"
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
  docker run --rm --network none --volumes-from "$APP_CONTAINER":ro -v "$RECOVERY_PATH:/backup" alpine:3.22 \
    tar -czf /backup/wiki-data.tar.gz -C / wiki/data
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
    compose up --no-start --no-deps --no-build --force-recreate "$APP_SERVICE"
    APP_CONTAINER="$(compose ps -a -q "$APP_SERVICE")"
    docker network disconnect "$PROXY_NETWORK" "$APP_CONTAINER" >/dev/null 2>&1 || true
    docker start "$APP_CONTAINER" >/dev/null
    wait_health "$APP_CONTAINER" || { docker logs --tail 160 "$APP_CONTAINER" >&2; die 'Candidate failed internal readiness'; }
  else
    if ! compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "$APP_SERVICE"; then
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
  local candidate target lock pending table actual name value
  candidate="$(jq -r '.candidateImage' "$PLAN_FILE")"; target="$(jq -r '.targetRevision' "$PLAN_FILE")"
  [[ "$(docker inspect "$APP_CONTAINER" --format '{{.Config.Image}}')" == "$candidate" ]] || die 'Live app image does not match candidate'
  [[ "$(docker image inspect "$candidate" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$target" ]] || die 'Live image revision label mismatch'
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
  docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' | while IFS='|' read -r source destination; do
    if [[ "$destination" == /run/secrets/* || "$destination" == /wiki/config.yml ]]; then sha256sum "$source"; fi
  done > "$TEMP_ROOT/private-files-after.sha256"
  diff -u "$TEMP_ROOT/private-files.sha256" "$TEMP_ROOT/private-files-after.sha256" >/dev/null || die 'Config/secret path fingerprints changed'
  normalized_app_contract > "$TEMP_ROOT/app-contract-after.json"
  diff -u "$TEMP_ROOT/app-contract-before.json" "$TEMP_ROOT/app-contract-after.json" >/dev/null || die 'App runtime contract changed'
  for name in "${!SENTINEL_STATE[@]}"; do value="$(docker inspect "$name" --format '{{.Id}}|{{.RestartCount}}|{{.State.StartedAt}}')"; [[ "$value" == "${SENTINEL_STATE[$name]}" ]] || die "Sentinel changed: $name"; done
  verify_postconditions runtimePostconditions "$DB_CONTAINER" wiki wiki
  docker exec "$APP_CONTAINER" curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null || die 'Internal app health failed'
}

admit_and_smoke() {
  if [[ "$PROXY_GATED" == true ]]; then
    docker network connect --alias "$PROXY_ALIAS" "$PROXY_NETWORK" "$APP_CONTAINER"; PROXY_GATED=false
  fi
  curl --fail --silent --show-error --max-time 30 "$PUBLIC_URL/healthz" >/dev/null || die 'Public candidate health failed'
  local url; for url in "${CONTROL_URLS[@]}"; do curl --fail --silent --show-error --max-time 30 "$url/healthz" >/dev/null || die "Control URL failed: $url"; done
  docker run --rm --ipc=host --network host -e "TSEPISTLE_SMOKE_URL=$PUBLIC_URL" \
    -v "$SCRIPT_DIR/login-smoke.cjs:/work/login-smoke.cjs:ro" -w /tmp/smoke "$PLAYWRIGHT_IMAGE" \
    bash -ec 'npm init -y >/dev/null && npm install --no-audit --no-fund --no-save playwright@1.62.1 >/dev/null && NODE_PATH=/tmp/smoke/node_modules node /work/login-smoke.cjs'
  local severe
  severe="$(docker logs --since 30m "$APP_CONTAINER" 2>&1 | grep -Eia '(^|[^a-z])(fatal|panic|unhandled|uncaught|migration failed)([^a-z]|$)' || true)"
  [[ -z "$severe" ]] || die "Severe candidate logs detected: $severe"
}

apply_plan() {
  load_apply_plan
  trap on_exit EXIT
  build_candidate
  rehearse_migrations
  drain_and_recover
  capture_baseline
  start_candidate
  verify_candidate
  admit_and_smoke
  local completed temp
  completed="$(date -u +%s)"; temp="$(mktemp "${PLAN_FILE}.XXXXXX")"
  jq --argjson completed "$completed" --arg recovery "$RECOVERY_PATH" \
    '.phase="accepted" | .completedAt=$completed | if $recovery == "" then . else .recoveryPath=$recovery end' "$PLAN_FILE" > "$temp"
  chmod 0600 "$temp"; install -m 0600 "$temp" "$PLAN_FILE"; unlink "$temp"
  trap - EXIT; cleanup_temp
  log "Deployment accepted: $(jq -r '.candidateImage' "$PLAN_FILE")"
  [[ -z "$RECOVERY_PATH" ]] || log "Recovery point: $RECOVERY_PATH"
  [[ "$MIGRATION_COMMITTED" == false ]] || warn 'Schema changed: rollback is fix-forward or an explicitly authorized matching-state restore.'
}

main() {
  parse_args "$@"
  if [[ "$COMMAND" == plan ]]; then load_profile; check_prerequisites; make_plan; else apply_plan; fi
}

main "$@"
