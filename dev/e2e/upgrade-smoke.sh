#!/usr/bin/env bash
set -euo pipefail

: "${MATRIXENV:?MATRIXENV is required}"
: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
WIKI_UPGRADE_SOURCE_IMAGE=${WIKI_UPGRADE_SOURCE_IMAGE:-ghcr.io/requarks/wiki:2.5.314}
ADMIN_EMAIL=upgrade-smoke@example.com
ADMIN_PASSWORD=UpgradeSmoke123!

cleanup() {
  if [ "${upgrade_succeeded:-false}" != true ]; then
    docker logs wiki 2>/dev/null || true
    docker logs db 2>/dev/null || true
  fi
  docker rm -f wiki db >/dev/null 2>&1 || true
  docker volume rm wiki-data >/dev/null 2>&1 || true
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

chmod u+x dev/e2e/ci-setup.sh
MATRIXENV=$MATRIXENV WIKI_TEST_IMAGE=$WIKI_UPGRADE_SOURCE_IMAGE dev/e2e/ci-setup.sh

setup_response=$(curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"http://127.0.0.1:3000\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  http://127.0.0.1:3000/finalize)
printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
wait_for_url http://127.0.0.1:3000/login

docker rm -f wiki >/dev/null

case $MATRIXENV in
postgres)
  docker run -d -p 3000:3000 --name wiki --network=host \
    -e DB_TYPE=postgres -e DB_HOST=localhost -e DB_PORT=5432 -e DB_NAME=wiki \
    -e DB_USER=wiki -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"
  ;;
mysql)
  docker run -d -p 3000:3000 --name wiki --network=host \
    -e DB_TYPE=mysql -e DB_HOST=localhost -e DB_PORT=3306 -e DB_NAME=wiki \
    -e DB_USER=wiki -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"
  ;;
mariadb)
  docker run -d -p 3000:3000 --name wiki --network=host \
    -e DB_TYPE=mariadb -e DB_HOST=localhost -e DB_PORT=3306 -e DB_NAME=wiki \
    -e DB_USER=wiki -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"
  ;;
mssql)
  docker run -d -p 3000:3000 --name wiki --network=host \
    -e DB_TYPE=mssql -e DB_HOST=localhost -e DB_PORT=1433 -e DB_NAME=wiki \
    -e DB_USER=sa -e 'DB_PASS=Password123!' "$WIKI_TEST_IMAGE"
  ;;
sqlite)
  docker run -d -p 3000:3000 --name wiki --network=host \
    -e DB_TYPE=sqlite -e DB_FILEPATH=/wiki/data/db.sqlite -v wiki-data:/wiki/data \
    "$WIKI_TEST_IMAGE"
  ;;
*)
  echo "Unsupported database engine: $MATRIXENV" >&2
  exit 1
  ;;
esac

wait_for_url http://127.0.0.1:3000/healthz

login_response=$(curl --fail --silent --show-error \
  --cookie-jar /tmp/wiki-upgrade-smoke.cookies \
  --header 'Content-Type: application/json' \
  --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
  http://127.0.0.1:3000/_api/auth/login)
printf '%s' "$login_response" | jq --exit-status '.jwt | type == "string" and length > 0' >/dev/null

whoami_response=$(curl --fail --silent --show-error \
  --cookie /tmp/wiki-upgrade-smoke.cookies \
  http://127.0.0.1:3000/_api/users/whoami)
printf '%s' "$whoami_response" | jq --exit-status --arg email "$ADMIN_EMAIL" \
  '.authenticated == true and .user.email == $email' >/dev/null

upgrade_succeeded=true
echo "Upgraded $MATRIXENV from $WIKI_UPGRADE_SOURCE_IMAGE and authenticated persisted administrator data."
