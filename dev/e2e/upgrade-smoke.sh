#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
: "${POSTGRES_TEST_IMAGE:?POSTGRES_TEST_IMAGE is required}"

FIXTURE_DIR=${FIXTURE_DIR:-dev/e2e/fixtures}
FIXTURE_DIR=$(realpath "$FIXTURE_DIR")
FIXTURE_MANIFEST=${FIXTURE_MANIFEST:-$FIXTURE_DIR/wiki-js-2.5.314-postgres.json}
DATABASE_FIXTURE=$FIXTURE_DIR/$(jq -r '.databaseArtifact.path' "$FIXTURE_MANIFEST")
DATA_FIXTURE=$FIXTURE_DIR/$(jq -r '.dataArtifact.path' "$FIXTURE_MANIFEST")
SOURCE_IMAGE=$(jq -r '.sourceImage' "$FIXTURE_MANIFEST")
ADMIN_EMAIL=$(jq -r '.fixtureIdentity.administratorEmail' "$FIXTURE_MANIFEST")
ADMIN_PASSWORD=$(jq -r '.fixtureIdentity.administratorPassword' "$FIXTURE_MANIFEST")
MIGRATION_MAX_SECONDS=${MIGRATION_MAX_SECONDS:-120}
MIGRATION_MAX_DB_GROWTH_BYTES=${MIGRATION_MAX_DB_GROWTH_BYTES:-268435456}
MIGRATION_MAX_DB_AMPLIFICATION_PERCENT=${MIGRATION_MAX_DB_AMPLIFICATION_PERCENT:-500}
MIGRATION_MAX_DATA_GROWTH_BYTES=${MIGRATION_MAX_DATA_GROWTH_BYTES:-67108864}
MIGRATION_MAX_PEAK_MEMORY_BYTES=${MIGRATION_MAX_PEAK_MEMORY_BYTES:-1073741824}
MIGRATION_METRICS_FILE=${MIGRATION_METRICS_FILE:-migration-metrics-postgres.json}
RECOVERY_DIR=$(mktemp -d)
MIGRATION_SAMPLES_FILE=$RECOVERY_DIR/migration-resource-samples
MIGRATION_MONITOR_STOP=$RECOVERY_DIR/migration-resource-monitor.stop
migration_monitor_pid=
stop_migration_monitor() {
  if [ -n "$migration_monitor_pid" ]; then
    touch "$MIGRATION_MONITOR_STOP"
    wait "$migration_monitor_pid" || true
    migration_monitor_pid=
  fi
}


cleanup() {
  stop_migration_monitor
  if [ "${recovery_succeeded:-false}" != true ]; then
    docker logs wiki 2>/dev/null || true
    docker logs db 2>/dev/null || true
  fi
  docker rm -f wiki db >/dev/null 2>&1 || true
  docker volume rm wiki-data >/dev/null 2>&1 || true
  docker network rm wiki-e2e >/dev/null 2>&1 || true
  rm -rf "$RECOVERY_DIR"
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

wait_for_postgres() {
  for attempt in {1..90}; do
    if docker exec db pg_isready --username=wiki --dbname=wiki >/dev/null 2>&1; then
      return
    fi
    if [ "$attempt" -eq 90 ]; then
      echo 'Timed out waiting for PostgreSQL' >&2
      return 1
    fi
    sleep 1
  done
}

start_wiki() {
  local image=$1
  docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
    -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
    -e DB_USER=wiki -e 'DB_PASS=Password123!' "$image" >/dev/null
}

login_graphql() {
  local response
  response=$(curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data "$(jq --null-input --arg username "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{query: "mutation ($username: String!, $password: String!) { authentication { login(username: $username, password: $password, strategy: \"local\") { jwt responseResult { succeeded } } } }", variables: {username: $username, password: $password}}')" \
    http://127.0.0.1:3000/graphql)
  printf '%s' "$response" | jq --exit-status --raw-output \
    '.data.authentication.login | select(.responseResult.succeeded == true) | .jwt | select(type == "string" and length > 0)'
}

verify_legacy_login() {
  login_graphql >/dev/null
}

resource_report() {
  docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align --command="
    SELECT json_build_object(
      'pages', (SELECT COUNT(*) FROM pages),
      'users', (SELECT COUNT(*) FROM users),
      'groups', (SELECT COUNT(*) FROM groups),
      'navigation', (SELECT COUNT(*) FROM navigation),
      'assets', (SELECT COUNT(*) FROM assets),
      'pageHistory', (SELECT COUNT(*) FROM \"pageHistory\"),
      'tags', (SELECT COUNT(*) FROM tags),
      'migrationNames', (SELECT json_agg(name ORDER BY id) FROM migrations),
      'fixturePage', (SELECT json_build_object('id', id, 'path', path, 'title', title, 'content', content) FROM pages WHERE path = 'legacy-continuity'),
      'fixtureHistory', (SELECT COUNT(*) FROM \"pageHistory\" WHERE \"pageId\" = (SELECT id FROM pages WHERE path = 'legacy-continuity')),
      'fixtureAsset', (SELECT COUNT(*) FROM assets WHERE filename = 'continuity.txt')
    );" | jq --compact-output .
}

assert_fixture_report() {
  local report=$1
  jq --exit-status --argjson report "$report" \
    '.expectedBeforeUpgrade as $expected |
      ($report.pages == $expected.pages) and
      ($report.users == $expected.users) and
      ($report.groups == $expected.groups) and
      ($report.navigation == $expected.navigation) and
      ($report.assets == $expected.assets) and
      ($report.pageHistory == $expected.pageHistory) and
      ($report.tags == $expected.tags) and
      (($report.migrationNames | length) == $expected.migrations) and
      ($report.fixturePage.path == .fixtureIdentity.pagePath) and
      ($report.fixturePage.title == .fixtureIdentity.pageTitle) and
      ($report.fixtureHistory >= 2) and
      ($report.fixtureAsset == 1)' "$FIXTURE_MANIFEST" >/dev/null
}
assert_upgraded_report() {
  local report=$1
  jq --exit-status --argjson report "$report" \
    '.expectedBeforeUpgrade as $expected |
      ($report.pages == $expected.pages) and
      ($report.users == $expected.users) and
      ($report.groups == $expected.groups) and
      ($report.navigation == $expected.navigation) and
      ($report.assets == $expected.assets) and
      ($report.pageHistory >= $expected.pageHistory) and
      ($report.tags == $expected.tags) and
      (($report.migrationNames | length) >= $expected.migrations) and
      ($report.fixturePage.path == .fixtureIdentity.pagePath) and
      ($report.fixturePage.title == .fixtureIdentity.pageTitle) and
      ($report.fixtureHistory >= 2) and
      ($report.fixtureAsset == 1)' "$FIXTURE_MANIFEST" >/dev/null
}


database_size_bytes() {
  docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align \
    --command="SELECT pg_database_size('wiki')"
}

data_volume_size_bytes() {
  docker run --rm --user 0 --entrypoint sh -v wiki-data:/data:ro "$WIKI_TEST_IMAGE" \
    -c 'set -- $(du -sk /data); echo $(( $1 * 1024 ))'
}
monitor_migration_resources() {
  while [ ! -e "$MIGRATION_MONITOR_STOP" ]; do
    local database_bytes data_bytes
    database_bytes=$(database_size_bytes 2>/dev/null || printf '0')
    data_bytes=$(data_volume_size_bytes 2>/dev/null || printf '0')
    database_bytes=${database_bytes//[[:space:]]/}
    data_bytes=${data_bytes//[[:space:]]/}
    if [[ "$database_bytes" =~ ^[0-9]+$ ]] && [[ "$data_bytes" =~ ^[0-9]+$ ]]; then
      printf '%s %s\n' "$database_bytes" "$data_bytes" >> "$MIGRATION_SAMPLES_FILE"
    fi
    sleep 1
  done
}



snapshot_data_volume() {
  docker run --rm --user 0 --entrypoint tar \
    -v wiki-data:/source:ro -v "$RECOVERY_DIR":/backup "$WIKI_TEST_IMAGE" \
    -C /source -czf /backup/wiki-data.tar.gz .
}

restore_data_volume() {
  docker volume rm wiki-data >/dev/null
  docker volume create wiki-data >/dev/null
  docker run --rm --user 0 --entrypoint tar \
    -v wiki-data:/target -v "$RECOVERY_DIR":/backup:ro "$WIKI_TEST_IMAGE" \
    -C /target -xzf /backup/wiki-data.tar.gz
}

expected_database_sha=$(jq -r '.databaseArtifact.sha256' "$FIXTURE_MANIFEST")
expected_data_sha=$(jq -r '.dataArtifact.sha256' "$FIXTURE_MANIFEST")
printf '%s  %s\n' "$expected_database_sha" "$DATABASE_FIXTURE" | sha256sum --check --status
printf '%s  %s\n' "$expected_data_sha" "$DATA_FIXTURE" | sha256sum --check --status

docker volume create wiki-data >/dev/null
docker network create wiki-e2e >/dev/null
docker run -d --name db --network=wiki-e2e \
  -e POSTGRES_PASSWORD='Password123!' -e POSTGRES_USER=wiki -e POSTGRES_DB=wiki \
  "$POSTGRES_TEST_IMAGE" >/dev/null
wait_for_postgres
postgres_version=$(docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align --command='SHOW server_version')
postgres_version_num=$(docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align --command='SHOW server_version_num')

docker cp "$DATABASE_FIXTURE" db:/tmp/source.dump >/dev/null
docker exec db pg_restore --username=wiki --dbname=wiki /tmp/source.dump
docker run --rm --user 0 --entrypoint tar \
  -v wiki-data:/target -v "$FIXTURE_DIR":/fixtures:ro "$WIKI_TEST_IMAGE" \
  -C /target -xzf "/fixtures/$(basename "$DATA_FIXTURE")"

before_report=$(resource_report)
assert_fixture_report "$before_report"
start_wiki "$SOURCE_IMAGE"
wait_for_url http://127.0.0.1:3000/login
verify_legacy_login
docker rm -f wiki >/dev/null

docker exec db pg_dump --username=wiki --format=custom --compress=9 --file=/tmp/pre-upgrade.dump wiki
backup_sha=$(docker exec db sha256sum /tmp/pre-upgrade.dump | cut -d ' ' -f 1)
snapshot_data_volume
database_bytes_before=$(database_size_bytes)
database_bytes_before=${database_bytes_before//[[:space:]]/}
data_bytes_before=$(data_volume_size_bytes)
data_bytes_before=${data_bytes_before//[[:space:]]/}

rm -f "$MIGRATION_MONITOR_STOP"
: > "$MIGRATION_SAMPLES_FILE"
monitor_migration_resources &
migration_monitor_pid=$!
migration_started_at=$(date +%s)
start_wiki "$WIKI_TEST_IMAGE"
wait_for_url http://127.0.0.1:3000/healthz
migration_seconds=$(($(date +%s) - migration_started_at))
stop_migration_monitor
database_bytes_after=$(database_size_bytes)
database_bytes_after=${database_bytes_after//[[:space:]]/}
data_bytes_after=$(data_volume_size_bytes)
data_bytes_after=${data_bytes_after//[[:space:]]/}
database_bytes_peak=$database_bytes_after
data_bytes_peak=$data_bytes_after
while read -r sampled_database_bytes sampled_data_bytes; do
  if [ "$sampled_database_bytes" -gt "$database_bytes_peak" ]; then database_bytes_peak=$sampled_database_bytes; fi
  if [ "$sampled_data_bytes" -gt "$data_bytes_peak" ]; then data_bytes_peak=$sampled_data_bytes; fi
done < "$MIGRATION_SAMPLES_FILE"
peak_memory_bytes=$(docker exec wiki cat /sys/fs/cgroup/memory.peak)
peak_memory_bytes=${peak_memory_bytes//[[:space:]]/}
[[ "$peak_memory_bytes" =~ ^[0-9]+$ ]]
after_report=$(resource_report)
assert_upgraded_report "$after_report"

jwt=$(login_graphql)
whoami_response=$(curl --fail --silent --show-error --header "Authorization: Bearer $jwt" \
  http://127.0.0.1:3000/_api/users/whoami)
printf '%s' "$whoami_response" | jq --exit-status --arg email "$ADMIN_EMAIL" \
  '.authenticated == true and .user.email == $email' >/dev/null

create_response=$(curl --silent --show-error --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $jwt" \
  --data '{"content":"# Discard after rollback","description":"release recovery sentinel","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"rollback-discarded","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Rollback discarded"}' \
  http://127.0.0.1:3000/_api/pages)
if ! printf '%s' "$create_response" | jq --exit-status '.page.id | type == "number"' >/dev/null; then
  printf 'Could not create rollback sentinel page: %s\n' "$create_response" >&2
  exit 1
fi

database_growth=$((database_bytes_after - database_bytes_before))
data_growth=$((data_bytes_after - data_bytes_before))
database_peak_growth=$((database_bytes_peak - database_bytes_before))
data_peak_growth=$((data_bytes_peak - data_bytes_before))
if [ "$database_growth" -lt 0 ]; then database_growth=0; fi
if [ "$data_growth" -lt 0 ]; then data_growth=0; fi
if [ "$database_peak_growth" -lt 0 ]; then database_peak_growth=0; fi
if [ "$data_peak_growth" -lt 0 ]; then data_peak_growth=0; fi
database_peak_amplification_percent=$(((database_bytes_peak * 100 + database_bytes_before - 1) / database_bytes_before))
[ "$migration_seconds" -le "$MIGRATION_MAX_SECONDS" ]
[ "$database_peak_growth" -le "$MIGRATION_MAX_DB_GROWTH_BYTES" ]
[ "$database_peak_amplification_percent" -le "$MIGRATION_MAX_DB_AMPLIFICATION_PERCENT" ]
[ "$data_peak_growth" -le "$MIGRATION_MAX_DATA_GROWTH_BYTES" ]
[ "$peak_memory_bytes" -le "$MIGRATION_MAX_PEAK_MEMORY_BYTES" ]

docker rm -f wiki >/dev/null
docker exec db dropdb --username=wiki --force wiki
docker exec db createdb --username=wiki --owner=wiki wiki
docker exec db pg_restore --username=wiki --dbname=wiki /tmp/pre-upgrade.dump
restore_data_volume
rollback_report=$(resource_report)
[ "$rollback_report" = "$before_report" ]
rollback_discarded=$(docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align \
  --command="SELECT COUNT(*) FROM pages WHERE path = 'rollback-discarded'")
[ "${rollback_discarded//[[:space:]]/}" = 0 ]
start_wiki "$SOURCE_IMAGE"
wait_for_url http://127.0.0.1:3000/login
verify_legacy_login

jq --null-input \
  --arg sourceImage "$SOURCE_IMAGE" \
  --arg targetImage "$WIKI_TEST_IMAGE" \
  --arg targetPostgresImage "$POSTGRES_TEST_IMAGE" \
  --arg targetPostgresVersion "$postgres_version" \
  --argjson targetPostgresVersionNum "$postgres_version_num" \
  --arg fixtureDatabaseSha256 "$expected_database_sha" \
  --arg fixtureDataSha256 "$expected_data_sha" \
  --arg backupSha256 "$backup_sha" \
  --arg candidateRevision "${WIKI_BUILD_REVISION:-unknown}" \
  --argjson before "$before_report" \
  --argjson after "$after_report" \
  --argjson rollback "$rollback_report" \
  --argjson migrationSeconds "$migration_seconds" \
  --argjson databaseBytesBefore "$database_bytes_before" \
  --argjson databaseBytesAfter "$database_bytes_after" \
  --argjson databaseBytesPeak "$database_bytes_peak" \
  --argjson databaseGrowthBytes "$database_growth" \
  --argjson databasePeakGrowthBytes "$database_peak_growth" \
  --argjson databasePeakAmplificationPercent "$database_peak_amplification_percent" \
  --argjson dataBytesBefore "$data_bytes_before" \
  --argjson dataBytesAfter "$data_bytes_after" \
  --argjson dataBytesPeak "$data_bytes_peak" \
  --argjson dataPeakGrowthBytes "$data_peak_growth" \
  --argjson peakMemoryBytes "$peak_memory_bytes" \
  --argjson maxSeconds "$MIGRATION_MAX_SECONDS" \
  --argjson maxDatabaseGrowthBytes "$MIGRATION_MAX_DB_GROWTH_BYTES" \
  --argjson maxDatabaseAmplificationPercent "$MIGRATION_MAX_DB_AMPLIFICATION_PERCENT" \
  --argjson maxDataGrowthBytes "$MIGRATION_MAX_DATA_GROWTH_BYTES" \
  --argjson maxPeakMemoryBytes "$MIGRATION_MAX_PEAK_MEMORY_BYTES" \
  '{
    schemaVersion: 3,
    candidateRevision: $candidateRevision,
    sourceImage: $sourceImage,
    targetImage: $targetImage,
    targetPostgresImage: $targetPostgresImage,
    targetPostgresVersion: $targetPostgresVersion,
    targetPostgresVersionNum: $targetPostgresVersionNum,
    fixture: { databaseSha256: $fixtureDatabaseSha256, dataSha256: $fixtureDataSha256 },
    backupSha256: $backupSha256,
    resources: { before: $before, after: $after, rollback: $rollback },
    migration: {
      seconds: $migrationSeconds,
      databaseBytesBefore: $databaseBytesBefore,
      databaseBytesAfter: $databaseBytesAfter,
      databaseBytesPeak: $databaseBytesPeak,
      databaseGrowthBytes: $databaseGrowthBytes,
      databasePeakGrowthBytes: $databasePeakGrowthBytes,
      databasePeakAmplificationPercent: $databasePeakAmplificationPercent,
      dataBytesBefore: $dataBytesBefore,
      dataBytesAfter: $dataBytesAfter,
      dataBytesPeak: $dataBytesPeak,
      dataPeakGrowthBytes: $dataPeakGrowthBytes,
      peakMemoryBytes: $peakMemoryBytes
    },
    limits: {
      migrationSeconds: $maxSeconds,
      databaseGrowthBytes: $maxDatabaseGrowthBytes,
      databaseAmplificationPercent: $maxDatabaseAmplificationPercent,
      dataGrowthBytes: $maxDataGrowthBytes,
      peakMemoryBytes: $maxPeakMemoryBytes
    },
    rollbackVerified: true
  }' > "$MIGRATION_METRICS_FILE"
cat "$MIGRATION_METRICS_FILE"

recovery_succeeded=true
echo "Upgraded tracked Wiki.js 2.5.314 fixture on PostgreSQL $postgres_version, restored its backup, and authenticated with the previous image."
