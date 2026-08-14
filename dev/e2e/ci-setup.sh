case $MATRIXENV in
postgres)
  echo "Using PostgreSQL..."
  docker run -d -p 5432:5432 --name db --network="host" -e "POSTGRES_PASSWORD=Password123!" -e "POSTGRES_USER=wiki" -e "POSTGRES_DB=wiki" postgres:11
  while ! docker exec db psql -U wiki -d wiki -c "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=postgres" -e "DB_HOST=localhost" -e "DB_PORT=5432" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mysql)
  echo "Using MySQL..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" mysql:8
  while ! docker exec db mysql --user=root --password=Password123! -e "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mysql" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mariadb)
  echo "Using MariaDB..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" mariadb:10
  while ! docker exec db mysql --user=root --password=Password123! -e "SELECT 1" &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mariadb" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
mssql)
  echo "Using MS SQL Server..."
  docker run -d -p 1433:1433 --name db --network="host" -e "MSSQL_SA_PASSWORD=Password123!" -e "ACCEPT_EULA=Y" mcr.microsoft.com/mssql/server:2022-latest
  while ! docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Password123!" -Q 'SELECT 1' &> /dev/null ; do
    echo "Waiting for database connection..."
    sleep 2
  done
  docker exec db /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Password123!" -Q 'CREATE DATABASE wiki'
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mssql" -e "DB_HOST=localhost" -e "DB_PORT=1433" -e "DB_NAME=wiki" -e "DB_USER=sa" -e "DB_PASS=Password123!" "$WIKI_TEST_IMAGE"
  ;;
sqlite)
  echo "Using SQLite..."
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=sqlite" -e "DB_FILEPATH=db.sqlite" "$WIKI_TEST_IMAGE"
  ;;
*)
  echo "Invalid DB Type!"
  ;;
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
