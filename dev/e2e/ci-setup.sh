#!/usr/bin/env bash
set -euo pipefail

: "${MATRIXENV:?MATRIXENV is required}"
: "${WIKI_TEST_IMAGE:?WIKI_TEST_IMAGE is required}"
POSTGRES_TEST_IMAGE=${POSTGRES_TEST_IMAGE:-postgres:15-alpine@sha256:4006528dcbdd9be8c1aaa50389caea4e93c46d6f54c3533bcd3253725e526e23}
MYSQL_TEST_IMAGE=${MYSQL_TEST_IMAGE:-mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b}
MARIADB_TEST_IMAGE=${MARIADB_TEST_IMAGE:-mariadb:10.11@sha256:de61fed4a40d3842f3ee09944ba52792156cfd9adf489b2cc670fc6ded28df8d}
MSSQL_TEST_IMAGE=${MSSQL_TEST_IMAGE:-mcr.microsoft.com/mssql/server:2022-latest@sha256:ba4c8329f48fb8f02e1416be6a930ebfd71268caee78aa985f3af4315e457c89}


case $MATRIXENV in
postgres)
  echo "Using PostgreSQL..."
  docker run -d -p 5432:5432 --name db --network="host" -e "POSTGRES_PASSWORD=Password123!" -e "POSTGRES_USER=wiki" -e "POSTGRES_DB=wiki" "$POSTGRES_TEST_IMAGE"
  while ! docker exec db psql -U wiki -d wiki -c "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker exec db psql -At -U wiki -d wiki -c "SHOW server_version"
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=postgres" -e "DB_HOST=localhost" -e "DB_PORT=5432" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mysql)
  echo "Using MySQL..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" "$MYSQL_TEST_IMAGE"
  while ! docker exec db mysql --user=root --password=Password123! -e "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker exec db mysql --user=root --password=Password123! --batch --skip-column-names -e "SELECT VERSION()"
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mysql" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mariadb)
  echo "Using MariaDB..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" "$MARIADB_TEST_IMAGE"
  while ! docker exec db mysql --user=root --password=Password123! -e "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker exec db mariadb --user=root --password=Password123! --batch --skip-column-names -e "SELECT VERSION()"
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mariadb" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mssql)
  echo "Using MS SQL Server..."
  docker run -d -p 1433:1433 --name db --network="host" -e "MSSQL_SA_PASSWORD=Password123!" -e "ACCEPT_EULA=Y" "$MSSQL_TEST_IMAGE"
  while ! docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Password123!" -Q 'SELECT 1' &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Password123!" -Q 'CREATE DATABASE wiki'
  docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Password123!" -h -1 -W -Q "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(32))"
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mssql" -e "DB_HOST=localhost" -e "DB_PORT=1433" -e "DB_NAME=wiki" -e "DB_USER=sa" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
sqlite)
  echo "Using SQLite..."
  docker volume create wiki-data
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=sqlite" -e "DB_FILEPATH=/wiki/data/db.sqlite" -v wiki-data:/wiki/data "$WIKI_TEST_IMAGE"
  ;;
*)
  echo "Invalid DB Type: $MATRIXENV" >&2
  exit 1
esac

for attempt in {1..60}; do
  if curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "Wiki did not become ready within 60 seconds."
    docker logs wiki
    exit 1
  fi
  sleep 1
done
