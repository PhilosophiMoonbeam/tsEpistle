# Migrating from Wiki.js 2.5.314

This guide documents the migration path validated while moving an existing Docker-based Wiki.js installation to an isolated tsEpistle canary. Its primary rule is simple: **leave the source Wiki.js application, database, networks, and volumes intact until tsEpistle has been independently restored, migrated, and verified.**

tsEpistle currently supports migration only from exactly Wiki.js `2.5.314` on PostgreSQL. Other Wiki.js versions and database engines require separate testing and are not covered by this procedure.

The upstream [Wiki.js transfer guide](https://github.com/requarks/wiki-docs/blob/master/install/transfer.md) uses a custom-format PostgreSQL dump and `pg_restore`; the upstream [upgrade guide](https://github.com/requarks/wiki-docs/blob/master/install/upgrade.md) also calls for preserving `config.yml`. This guide extends those foundations for tsEpistle's separate database requirements, forward-only schema migrations, copied integration risks, `/wiki/data`, and Agent runtime.

## Migration model

Treat the migration as a clone followed by a controlled cutover:

```text
production Wiki.js ──snapshot──▶ isolated PostgreSQL + /wiki/data clone
                                      │
                                      ▼
                              tsEpistle migrations
                                      │
                                      ▼
                         temporary validation hostname
                                      │
                                      ▼
                           permanent hostname cutover
```

The temporary hostname is routing state, not deployment identity. Give the Compose project, PostgreSQL volume, proxy network, and application alias stable tsEpistle names so a later hostname change does not rename or replace stateful Docker resources.

## Non-negotiable safety boundaries

- Never point tsEpistle at the source Wiki.js database.
- Never mount the source PostgreSQL volume into the tsEpistle database container.
- Never attach tsEpistle to the source database network.
- Never start the old Wiki.js image against a database that tsEpistle has migrated.
- Restore PostgreSQL and `/wiki/data` from the same snapshot window.
- Keep the source deployment available as the rollback target until cutover is accepted.
- Resolve exact container, network, directory, and volume names before any replacement or deletion. Do not use broad paths, unresolved variables, or globs for destructive operations.
- Back up the new Agent key material with the migrated database. Provider credentials and signed state can become unusable if those keys are lost.

## What must be preserved

Capture all of the following before starting the target application:

1. A custom-format logical PostgreSQL dump created with `pg_dump -Fc`.
2. The complete source `/wiki/data` tree, even when some of its subdirectories appear empty.
3. The source `config.yml` as reference material. Do not overwrite the target configuration with it.
4. The exact Wiki.js image/version, PostgreSQL version, and relevant container/volume identities.
5. Baseline record counts and representative asset hashes for later comparison.
6. Authentication-provider and outbound-integration inventory.

A logical dump is essential when moving between PostgreSQL major versions. Copying a raw PostgreSQL data directory from an older server into the target PostgreSQL image is not a supported upgrade path. A Wiki.js PostgreSQL 11 custom dump was successfully restored into the isolated PostgreSQL 16 target during this migration.

## Phase 1: Preflight

Before taking a snapshot:

- Confirm the source reports Wiki.js `2.5.314`.
- Record the source image identifier and PostgreSQL version.
- Confirm sufficient disk space for the dump, copied data, target database, and rollback snapshots.
- Inventory page, page-history, asset, user, group, and navigation counts.
- Record which authentication providers are enabled and which groups they enroll.
- Inventory storage, analytics, logging, comments, mail, webhooks, telemetry, and API keys.
- Build tsEpistle from a clean reviewed commit or select an immutable published digest.
- Prepare the reusable [Compose deployment](deploy/compose/README.md) with operator-specific values outside Git.
- Choose a target PostgreSQL volume, data directory, project name, and proxy network that cannot collide with the source.

Do not infer the administrator password from deployment environment variables. The database password and Wiki login password are unrelated.

## Phase 2: Snapshot Wiki.js

Use operator-local names and a protected state directory:

```console
tsepistle_state_dir=/opt/tsepistle
source_db_container=your-wikijs-postgres-container
source_app_container=your-wikijs-app-container
tsepistle_snapshot=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 700 "$tsepistle_state_dir/backups"
docker exec "$source_db_container" pg_dump -U wiki -d wiki -Fc \
  > "$tsepistle_state_dir/backups/wikijs-$tsepistle_snapshot.dump"
docker cp "$source_app_container":/wiki/data/. "$tsepistle_state_dir/data/"
docker cp "$source_app_container":/wiki/config.yml \
  "$tsepistle_state_dir/backups/wikijs-config-$tsepistle_snapshot.yml"
sha256sum "$tsepistle_state_dir/backups/wikijs-$tsepistle_snapshot.dump" \
  > "$tsepistle_state_dir/backups/wikijs-$tsepistle_snapshot.dump.sha256"
```

`pg_dump` provides a consistent database snapshot while Wiki.js remains online, which is suitable for an initial canary. The separately copied `/wiki/data` tree is not transactionally synchronized with that dump. For a final cutover or an exact recovery point, quiesce source writes while capturing both resources.

Verify the dump checksum and confirm that the copied data tree is nonempty before continuing.

## Phase 3: Prepare an isolated target

Follow [deploy/compose/README.md](deploy/compose/README.md) to create:

- a target-only Compose environment file;
- a distinct target PostgreSQL volume;
- a target `/wiki/data` directory owned by the application UID;
- database password files;
- Agent profile-resolution, provider-secret, snapshot-signing, and MCP request-state keys;
- an internal proxy network; and
- a dedicated egress network for configured model providers.

The database and reverse-proxy networks should remain internal. Provider egress should not grant the application access to the source database network. Browser automation requires its own isolated worker and network controls; leave it disabled unless that separate boundary has been deliberately deployed and tested.

Validate the resolved Compose configuration before starting anything:

```console
docker compose --env-file deploy/compose/.env \
  -f deploy/compose/compose.yml config
```

Inspect the resolved project, volume, network, bind-mount, and image values. A successful YAML parse is not enough; the resolved resource identities must point only at the target.

## Phase 4: Restore and quarantine

Start only the target database and restore into an empty target database:

```console
tsepistle_env=deploy/compose/.env
tsepistle_dump=/opt/tsepistle/backups/wikijs-<timestamp>.dump
tsepistle_target_url=https://canary.example.com

docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml \
  up -d database
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml \
  exec -T database pg_restore --exit-on-error --no-owner --no-privileges \
  -U wiki -d wiki < "$tsepistle_dump"
```

Do not restore over a previously migrated target database. For a rehearsal refresh, stop the target application and restore into a newly created, explicitly verified target database/volume.

Before the first tsEpistle startup, apply the repository's fail-closed quarantine transaction:

```console
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml \
  exec -T database psql -U wiki -d wiki \
  -v target_url="$tsepistle_target_url" \
  < deploy/migrations/from-wikijs-v2/quarantine.sql
```

The transaction:

- changes the clone's site URL;
- disables copied storage, analytics, logging, comment, external-authentication, API, telemetry, and mail-delivery configuration;
- ensures local authentication is enabled; and
- revokes copied API keys.

These controls prevent a clone from writing to production storage, sending production mail, accepting old API credentials, emitting duplicate analytics or comment-provider traffic, or redirecting authentication through production callbacks. Re-enable each integration only after reviewing its destination and credentials for the target environment.

## Phase 5: Start tsEpistle and allow migrations to finish

Start the target application only after restore and quarantine succeed:

```console
docker compose --env-file "$tsepistle_env" -f deploy/compose/compose.yml \
  up -d app
```

Watch startup logs and health until migrations and background projection initialization settle. Do not interrupt the container merely because the first startup takes longer than Wiki.js. Stop and investigate any migration error, restart loop, schema-validation error, or persistent projection retry before continuing.

The migration creates tsEpistle-specific Agent, proposal, durable-job, knowledge-projection, search, and supporting tables. Those schema changes are forward-only from an operator perspective: rollback requires the original snapshot, not the old application image pointed at the new database.

## Phase 6: Validate the clone

Validate data, behavior, and containment—not just the health endpoint.

### Data continuity

- Compare page, history, asset, user, group, navigation, and tag counts with the source baseline.
- Compare representative asset binary hashes and open image/download assets through the public route.
- Open representative Markdown pages, long pages, pages with Unicode headings, and pages with revision history.
- Confirm PostgreSQL search reaches representative migrated content.
- Confirm all current pages eventually receive knowledge projections and no knowledge outbox entries remain persistently failed or retrying.

Useful target checks include:

```sql
SELECT count(*) FROM pages;
SELECT count(*) FROM "pageHistory";
SELECT count(*) FROM assets;
SELECT status, count(*)
FROM "pageMutationOutbox"
WHERE "effectKind" = 'knowledge'
GROUP BY status
ORDER BY status;
```

### Authentication

Test the local administrator before re-enabling external providers. Wiki.js can contain multiple user rows with the same email when they belong to different authentication providers. A Dropbox-backed row may have no local password while the local administrator row with the same email has a valid password hash. Authentication must be evaluated with both email and provider identity.

The database password from `.env` or a Docker secret is not the Wiki administrator password. Do not reset the source administrator while diagnosing a clone login. The copied local password hash should continue to work if the correct local account and original Wiki password are used.

External authentication remains disabled after quarantine. Before enabling a provider, register the target callback URL, review enrollment groups and domain rules, and ensure a failed provider login cannot lock out the local administrator.

### Integrations and containment

- Confirm source Wiki.js and source PostgreSQL containers retained their start times and health.
- Confirm the target resolves only its own database hostname and volume.
- Confirm storage, analytics, loggers, comments, external auth, telemetry, and mail remain inactive.
- Confirm the post-migration webhook registry is empty or that every webhook is disabled.
- Confirm copied API keys are revoked.
- Confirm the target hostname serves the expected TLS certificate and static assets.
- Confirm no unexpected outbound calls appear in logs.

### Wiki Agent

Wiki.js does not supply tsEpistle Agent runtime keys or provider profiles. After migration:

- keep all Agent key files outside Git and back them up securely;
- configure a provider under **Administration → Wiki Agent → Providers** and require successful conformance;
- remember that `manage:system` grants administrator access, while non-admin users need `use:agents`;
- re-enable API access only when needed for MCP;
- create a new narrowly scoped MCP group with `use:mcp` and the required page permissions;
- generate MCP API keys only after MCP is enabled so their tokens contain the MCP resource claim; and
- keep browser automation disabled unless its separate sandboxed worker has been deployed.

Feature flags alone do not grant permissions, configure a provider, or bypass proposal approval.

## Phase 7: Final synchronization and cutover

An initial canary becomes stale as users continue editing the source. For the final cutover:

1. Announce a write freeze and quiesce source Wiki.js writes.
2. Capture a fresh PostgreSQL dump and `/wiki/data` copy from the same window.
3. Stop the target application.
4. Restore the fresh snapshot into a clean, explicitly verified target database/volume and replace only the target data directory.
5. Reapply quarantine and start tsEpistle.
6. Repeat the validation checklist.
7. Update the site host and reverse-proxy/DNS routing to the permanent hostname.
8. Re-enable reviewed integrations one at a time.
9. Keep the original source deployment stopped but recoverable until the acceptance window ends.

Do not rename the Compose project, database volume, or networks during hostname cutover. Routing changes are safer and do not disturb the already validated stateful resources.

## Rollback

The preferred immediate rollback is to route traffic back to the untouched source Wiki.js deployment.

If the target itself must be rolled back to an earlier tsEpistle image:

1. Stop every target application instance.
2. Restore the PostgreSQL dump, `/wiki/data`, and Agent keys from the same pre-upgrade recovery point.
3. Start the matching older image only after all three resources are restored.

Never use an application-only rollback against a database that has completed newer migrations.

## Lessons from the validated migration

- A logical PostgreSQL dump made the PostgreSQL 11-to-16 move practical; a raw volume copy would not.
- Keeping source and target databases, volumes, and networks entirely separate made repeated validation safe.
- Database rows were not the whole backup contract; `/wiki/data` needed its own matched copy.
- A temporary hostname did not need to become a permanent Compose or repository identity.
- Copied external integrations and API keys were a greater immediate risk than the schema migration itself.
- Duplicate emails across authentication providers can make a correct password appear wrong when the provider identity is overlooked.
- New knowledge projections exposed a Unicode length-boundary defect that ordinary page rendering did not; wait for background work to drain and inspect warnings.
- Agent availability depends on feature flags, encryption/signing keys, permissions, provider conformance, API/MCP claims, and egress—not a single enable switch.
- Production health should be checked throughout the rehearsal, including unchanged container start times when isolation is a requirement.

The shorter command-oriented procedure remains at [deploy/migrations/from-wikijs-v2/README.md](deploy/migrations/from-wikijs-v2/README.md); this document is the authoritative migration rationale and acceptance checklist.
