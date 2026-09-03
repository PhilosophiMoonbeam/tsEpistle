# Migrating from Wiki.js v2

This procedure creates an isolated tsEpistle deployment from a Wiki.js v2 snapshot. The source application, database container, network, and volumes must remain separate and untouched.

Read the repository-level [migration guide](../../../MIGRATION.md) for the authoritative safety rationale, preflight inventory, authentication and Agent caveats, acceptance checklist, final synchronization, and rollback contract. This file is the shorter command-oriented companion.

Read the canonical [Compose deployment guide](../../compose/) first and prepare its `.env`, state directory, secrets, and proxy network. Use a temporary hostname only as routing configuration; do not use it as the durable project or volume identity.

## Safety boundaries

- Never attach tsEpistle to the source Wiki.js database network or PostgreSQL volume.
- Never start tsEpistle against the source database. Restore a logical dump into the separate PostgreSQL 16 volume.
- Snapshot PostgreSQL and `/wiki/data` from the same point in time.
- Keep `offline: true` during migration validation.
- Treat forward migrations as irreversible. Restore both cloned resources to roll back.

## Snapshot the source

Set operator-local paths and container names appropriate to the installation, then take a custom-format logical dump and copy the Wiki data tree:

```console
tsepistle_state_dir=/opt/tsepistle
source_db_container=your-wikijs-postgres-container
source_app_container=your-wikijs-app-container
tsepistle_snapshot=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 700 "$tsepistle_state_dir/backups"
docker exec "$source_db_container" pg_dump -U wiki -d wiki -Fc > "$tsepistle_state_dir/backups/wikijs-$tsepistle_snapshot.dump"
docker cp "$source_app_container":/wiki/data/. "$tsepistle_state_dir/data/"
```

Production can remain online for an initial canary snapshot. For an exact recovery point or final cutover, briefly quiesce source writes while capturing both resources.

## Restore and quarantine the clone

Start only the target database, restore the dump, and quarantine copied outbound integrations before starting tsEpistle:

```console
tsepistle_env=deploy/compose/.env
tsepistle_dump=/opt/tsepistle/backups/wikijs-<timestamp>.dump
tsepistle_target_url=https://wiki-canary.example.com

docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml up -d database
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml exec -T database \
  pg_restore --exit-on-error --no-owner --no-privileges -U wiki -d wiki < "$tsepistle_dump"
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml exec -T database \
  psql -U wiki -d wiki -v target_url="$tsepistle_target_url" \
  < deploy/migrations/from-wikijs-v2/quarantine.sql
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml up -d app
```

The quarantine transaction changes only the clone. It disables copied storage, analytics, logging, comments, external authentication, API access, telemetry, and mail delivery; enables local authentication; and revokes copied API keys. Re-enable integrations individually only after validating their destination and credentials. MCP requires API access to be re-enabled and a newly generated, narrowly scoped API key.

## Validate and cut over

Validate health, the migration ledger, page and history counts, asset hashes, authentication, representative pages, search, knowledge-projection completion, Agent permissions, and logs before exposing the target hostname. Changing from a temporary hostname to the permanent hostname requires only DNS/reverse-proxy and site-host updates; it does not require renaming the Compose project, containers, networks, or volumes.

For refresh or rollback, stop the target application and replace only the explicitly configured target database volume and target data directory from a matching snapshot. Resolve and verify their exact names first; never remove or mount the source Wiki.js volume.
