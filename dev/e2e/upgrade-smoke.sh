#!/usr/bin/env bash
set -euo pipefail

: "${MATRIXENV:?MATRIXENV is required}"
: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
WIKI_UPGRADE_SOURCE_IMAGE=${WIKI_UPGRADE_SOURCE_IMAGE:-ghcr.io/requarks/wiki:2.5.314@sha256:68f0d1848261ae76492ba358e30a96a76fed5d97a3fff381656082bf90f70d7e}
ADMIN_EMAIL=upgrade-smoke@example.com
ADMIN_PASSWORD=UpgradeSmoke123!
RECOVERY_DIR=$(mktemp -d)
MIGRATION_MAX_SECONDS=${MIGRATION_MAX_SECONDS:-120}
MIGRATION_MAX_DB_GROWTH_BYTES=${MIGRATION_MAX_DB_GROWTH_BYTES:-268435456}
MIGRATION_MAX_DB_AMPLIFICATION_PERCENT=${MIGRATION_MAX_DB_AMPLIFICATION_PERCENT:-500}
MIGRATION_MAX_DATA_GROWTH_BYTES=${MIGRATION_MAX_DATA_GROWTH_BYTES:-67108864}
MIGRATION_METRICS_FILE=${MIGRATION_METRICS_FILE:-migration-metrics-$MATRIXENV.json}

cleanup() {
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

start_wiki() {
  local image=$1
  case $MATRIXENV in
  postgres)
    docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
      -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_NAME=wiki \
      -e DB_USER=wiki -e 'DB_PASS=Password123!' "$image"
    ;;
  mysql)
    docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
      -e DB_TYPE=mysql -e DB_HOST=db -e DB_PORT=3306 -e DB_NAME=wiki \
      -e DB_USER=wiki -e 'DB_PASS=Password123!' "$image"
    ;;
  mariadb)
    docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
      -e DB_TYPE=mariadb -e DB_HOST=db -e DB_PORT=3306 -e DB_NAME=wiki \
      -e DB_USER=wiki -e 'DB_PASS=Password123!' "$image"
    ;;
  mssql)
    docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
      -e DB_TYPE=mssql -e DB_HOST=db -e DB_PORT=1433 -e DB_NAME=wiki \
      -e DB_USER=sa -e 'DB_PASS=Password123!' "$image"
    ;;
  sqlite)
    docker run -d -p 3000:3000 --name wiki --network=wiki-e2e -v wiki-data:/wiki/data \
      -e DB_TYPE=sqlite -e DB_FILEPATH=/wiki/data/db.sqlite "$image"
    ;;
  *)
    echo "Unsupported database engine: $MATRIXENV" >&2
    exit 1
    ;;
  esac
}

verify_legacy_login() {
  local response
  response=$(curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data "$(jq --null-input --arg username "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{query: "mutation ($username: String!, $password: String!) { authentication { login(username: $username, password: $password, strategy: \"local\") { jwt responseResult { succeeded } } } }", variables: {username: $username, password: $password}}')" \
    http://127.0.0.1:3000/graphql)
  printf '%s' "$response" | jq --exit-status \
    '.data.authentication.login.responseResult.succeeded == true and (.data.authentication.login.jwt | type == "string" and length > 0)' >/dev/null
}

write_data_marker() {
  local value=$1
  docker run --rm --user 0 --entrypoint sh -v wiki-data:/data "$WIKI_TEST_IMAGE" \
    -c 'printf "%s" "$1" > /data/recovery-marker' sh "$value"
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

database_size_bytes() {
  case $MATRIXENV in
  postgres)
    docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align \
      --command="SELECT pg_database_size('wiki')"
    ;;
  mysql)
    docker exec db mysql --user=root --password='Password123!' --batch --skip-column-names \
      -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = 'wiki'"
    ;;
  mariadb)
    docker exec db mariadb --user=root --password='Password123!' --batch --skip-column-names \
      -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = 'wiki'"
    ;;
  mssql)
    docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Password123!' \
      -d wiki -h -1 -W -Q 'SET NOCOUNT ON; SELECT SUM(size) * 8192 FROM sys.database_files'
    ;;
  sqlite)
    docker run --rm --user 0 --entrypoint stat -v wiki-data:/data:ro "$WIKI_TEST_IMAGE" \
      -c %s /data/db.sqlite
    ;;
  esac
}

data_volume_size_bytes() {
  docker run --rm --user 0 --entrypoint sh -v wiki-data:/data:ro "$WIKI_TEST_IMAGE" \
    -c 'set -- $(du -sk /data); echo $(( $1 * 1024 ))'
}

record_and_check_migration_metrics() {
  local seconds=$1
  local database_before=$2
  local database_after=$3
  local data_before=$4
  local data_after=$5
  local database_growth=$((database_after - database_before))
  local data_growth=$((data_after - data_before))
  local amplification_percent=$(((database_after * 100 + database_before - 1) / database_before))
  if [ "$database_growth" -lt 0 ]; then database_growth=0; fi
  if [ "$data_growth" -lt 0 ]; then data_growth=0; fi

  jq --null-input \
    --arg database "$MATRIXENV" \
    --argjson seconds "$seconds" \
    --argjson databaseBytesBefore "$database_before" \
    --argjson databaseBytesAfter "$database_after" \
    --argjson databaseGrowthBytes "$database_growth" \
    --argjson databaseAmplificationPercent "$amplification_percent" \
    --argjson dataBytesBefore "$data_before" \
    --argjson dataBytesAfter "$data_after" \
    --argjson dataGrowthBytes "$data_growth" \
    --argjson maxSeconds "$MIGRATION_MAX_SECONDS" \
    --argjson maxDatabaseGrowthBytes "$MIGRATION_MAX_DB_GROWTH_BYTES" \
    --argjson maxDatabaseAmplificationPercent "$MIGRATION_MAX_DB_AMPLIFICATION_PERCENT" \
    --argjson maxDataGrowthBytes "$MIGRATION_MAX_DATA_GROWTH_BYTES" \
    '{
      database: $database,
      migrationSeconds: $seconds,
      databaseBytesBefore: $databaseBytesBefore,
      databaseBytesAfter: $databaseBytesAfter,
      databaseGrowthBytes: $databaseGrowthBytes,
      databaseAmplificationPercent: $databaseAmplificationPercent,
      dataBytesBefore: $dataBytesBefore,
      dataBytesAfter: $dataBytesAfter,
      dataGrowthBytes: $dataGrowthBytes,
      limits: {
        migrationSeconds: $maxSeconds,
        databaseGrowthBytes: $maxDatabaseGrowthBytes,
        databaseAmplificationPercent: $maxDatabaseAmplificationPercent,
        dataGrowthBytes: $maxDataGrowthBytes
      }
    }' > "$MIGRATION_METRICS_FILE"
  cat "$MIGRATION_METRICS_FILE"

  [ "$seconds" -le "$MIGRATION_MAX_SECONDS" ]
  [ "$database_growth" -le "$MIGRATION_MAX_DB_GROWTH_BYTES" ]
  [ "$amplification_percent" -le "$MIGRATION_MAX_DB_AMPLIFICATION_PERCENT" ]
  [ "$data_growth" -le "$MIGRATION_MAX_DATA_GROWTH_BYTES" ]
}

backup_database() {
  case $MATRIXENV in
  postgres)
    docker exec db pg_dump --username=wiki --format=custom --file=/tmp/wiki-backup.dump wiki
    ;;
  mysql)
    docker exec db sh -c 'mysqldump --single-transaction --user=root --password="Password123!" wiki > /tmp/wiki-backup.sql'
    ;;
  mariadb)
    docker exec db sh -c 'mariadb-dump --single-transaction --user=root --password="Password123!" wiki > /tmp/wiki-backup.sql'
    ;;
  mssql)
    docker exec --user root db sh -c 'mkdir -p /var/opt/mssql/backup && chown mssql:mssql /var/opt/mssql/backup'
    docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Password123!' \
      -Q "BACKUP DATABASE [wiki] TO DISK = N'/var/opt/mssql/backup/wiki-backup.bak' WITH INIT, CHECKSUM"
    ;;
  sqlite)
    ;;
  esac
}

restore_database() {
  case $MATRIXENV in
  postgres)
    docker exec db dropdb --username=wiki --force wiki
    docker exec db createdb --username=wiki --owner=wiki wiki
    docker exec db pg_restore --username=wiki --dbname=wiki /tmp/wiki-backup.dump
    ;;
  mysql)
    docker exec db mysql --user=root --password='Password123!' \
      -e 'DROP DATABASE wiki; CREATE DATABASE wiki CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
    docker exec db sh -c 'mysql --user=root --password="Password123!" wiki < /tmp/wiki-backup.sql'
    ;;
  mariadb)
    docker exec db mariadb --user=root --password='Password123!' \
      -e 'DROP DATABASE wiki; CREATE DATABASE wiki CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
    docker exec db sh -c 'mariadb --user=root --password="Password123!" wiki < /tmp/wiki-backup.sql'
    ;;
  mssql)
    docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Password123!' \
      -Q "USE [master]; ALTER DATABASE [wiki] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; RESTORE DATABASE [wiki] FROM DISK = N'/var/opt/mssql/backup/wiki-backup.bak' WITH REPLACE; ALTER DATABASE [wiki] SET MULTI_USER"
    ;;
  sqlite)
    ;;
  esac
}

assert_candidate_page_absent() {
  local count
  case $MATRIXENV in
  postgres)
    count=$(docker exec db psql --username=wiki --dbname=wiki --tuples-only --no-align \
      --command="SELECT COUNT(*) FROM pages WHERE path = 'rollback-discarded'")
    ;;
  mysql)
    count=$(docker exec db mysql --user=root --password='Password123!' --batch --skip-column-names \
      -e "SELECT COUNT(*) FROM wiki.pages WHERE path = 'rollback-discarded'")
    ;;
  mariadb)
    count=$(docker exec db mariadb --user=root --password='Password123!' --batch --skip-column-names \
      -e "SELECT COUNT(*) FROM wiki.pages WHERE path = 'rollback-discarded'")
    ;;
  mssql)
    count=$(docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'Password123!' \
      -d wiki -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM pages WHERE path = 'rollback-discarded'")
    ;;
  sqlite)
    return
    ;;
  esac
  [ "${count//[[:space:]]/}" = 0 ]
}

chmod u+x dev/e2e/ci-setup.sh
MATRIXENV=$MATRIXENV WIKI_TEST_IMAGE=$WIKI_UPGRADE_SOURCE_IMAGE dev/e2e/ci-setup.sh

setup_response=$(curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"http://127.0.0.1:3000\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  http://127.0.0.1:3000/finalize)
printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
wait_for_url http://127.0.0.1:3000/login
verify_legacy_login

write_data_marker pre-upgrade
backup_database
snapshot_data_volume
database_bytes_before=$(database_size_bytes)
database_bytes_before=${database_bytes_before//[[:space:]]/}
data_bytes_before=$(data_volume_size_bytes)
data_bytes_before=${data_bytes_before//[[:space:]]/}

docker rm -f wiki >/dev/null
migration_started_at=$(date +%s)
start_wiki "$WIKI_TEST_IMAGE" >/dev/null
wait_for_url http://127.0.0.1:3000/healthz
migration_seconds=$(($(date +%s) - migration_started_at))
database_bytes_after=$(database_size_bytes)
database_bytes_after=${database_bytes_after//[[:space:]]/}
data_bytes_after=$(data_volume_size_bytes)
data_bytes_after=${data_bytes_after//[[:space:]]/}
record_and_check_migration_metrics "$migration_seconds" "$database_bytes_before" "$database_bytes_after" "$data_bytes_before" "$data_bytes_after"

login_response=$(curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
  http://127.0.0.1:3000/_api/auth/login)
jwt=$(printf '%s' "$login_response" | jq --exit-status --raw-output '.jwt | select(type == "string" and length > 0)')

whoami_response=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $jwt" \
  http://127.0.0.1:3000/_api/users/whoami)
printf '%s' "$whoami_response" | jq --exit-status --arg email "$ADMIN_EMAIL" \
  '.authenticated == true and .user.email == $email' >/dev/null

create_response=$(curl --fail --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $jwt" \
  --data '{"content":"# Discard after rollback","description":"release recovery sentinel","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"rollback-discarded","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Rollback discarded"}' \
  http://127.0.0.1:3000/_api/pages)
printf '%s' "$create_response" | jq --exit-status '.page.id | type == "number"' >/dev/null
write_data_marker post-upgrade

docker rm -f wiki >/dev/null
restore_database
restore_data_volume
assert_candidate_page_absent
start_wiki "$WIKI_UPGRADE_SOURCE_IMAGE" >/dev/null
wait_for_url http://127.0.0.1:3000/login
verify_legacy_login

restored_marker=$(docker run --rm --user 0 --entrypoint cat -v wiki-data:/data:ro "$WIKI_TEST_IMAGE" /data/recovery-marker)
[ "$restored_marker" = pre-upgrade ]

recovery_succeeded=true
echo "Upgraded $MATRIXENV from $WIKI_UPGRADE_SOURCE_IMAGE, restored its backup, and authenticated the rolled-back administrator."
