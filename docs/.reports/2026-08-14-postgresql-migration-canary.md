# PostgreSQL Migration and Private-Page Deployment — 2026-08-14

## Outcome

The migration passed every acceptance gate and was promoted.

- Active service: `wiki-tailnet`
- Active Docker address: `127.0.0.1:3013 -> 3000/tcp`; no public or LAN bind
- Active database: PostgreSQL 17.11 in `wiki-postgres`
- Active application image: `wiki-private-pages:15a87230`
- Application image ID: `sha256:ed152ffda6497f4e50fc637df12b6c48daaa25e5830b07e4a7487123ae0ca13b`
- Source revision: `15a87230ce320def8bd8d0c0942de3f861a6a493`
- Upstream base: Wiki.js 2.5.314, originally deployed image digest `sha256:2f6064a10157f79ff7db90ce1f1ae8486da4a7e3892ce862976282c6d8e66434`
- Final health: HTTP 200 `{"ok":true}` after promoting the published-revision image; both the Wiki container and PostgreSQL had also passed earlier restart-persistence checks
- Tailnet URL: `https://agents8c48g.tail41a24a.ts.net:10443/`
- Tailnet publication verification: Tailscale Serve exposes the loopback-only Docker port over tailnet HTTPS. `/healthz` returned HTTP 200 through the HTTPS MagicDNS URL, and a browser rendered `Page Home | Wiki.js` with no console or runtime errors.

The original SQLite container is stopped, not removed, under `wiki-tailnet-sqlite-rollback-20260814`. Its image, container configuration, `wiki-tailnet-data` volume, and frozen database remain intact. An isolated rollback container using that exact image and volume rendered the home page and returned HTTP 200 from `/healthz` on `127.0.0.1:3015`; the proof container was then removed.

## Starting deployment preserved

- Original container: `wiki-tailnet`, renamed only during promotion
- Original image tag: `ghcr.io/philosophimoonbeam/wiki:0.1.0-alpha.1`
- Original image ID: `sha256:3ac6fe5582b4782ab7eceef76f03d0666b905193b9093b4b6011be23ecc81b7c`
- Original OCI revision: `f215d06c8580beea2b6fffc732051db5aaa5e32d`
- Original database: SQLite at `/wiki/data/content/wiki.sqlite`
- Preserved volume: `wiki-tailnet-data:/wiki/data/content`
- Original and rollback address: `127.0.0.1:3013 -> 3000/tcp`
- Restart policy: `unless-stopped`
- Health check: HTTP `GET /healthz`
- Browser baseline: `Page Home | Wiki.js`; existing `Your content here` rendered; setup absent

The SQLite database and volume were never overwritten, deleted, or attached to PostgreSQL. The active SQLite process was stopped only for the final frozen backup and controlled cutover.

## Documentation and migration decision

Sources checked:

- Wiki.js transfer guide: <https://github.com/requarks/wiki-docs/blob/master/install/transfer.md>
- PostgreSQL versioning policy: <https://www.postgresql.org/support/versioning/>
- Official PostgreSQL container image: <https://hub.docker.com/_/postgres>
- Knex migrations: <https://knexjs.org/guide/migrations.html>
- Context7 library `/requarks/wiki-docs`, database requirements and transfer guidance

The Wiki.js transfer guide says cross-engine conversion is unsupported and documents full database restore only for PostgreSQL-to-PostgreSQL. Therefore, no SQLite dump was restored directly into PostgreSQL.

The repository selects separate PostgreSQL and SQLite migration directories. A clean PostgreSQL schema was initialized through Wiki's own Knex migrations first. Application rows were then transferred table-by-table with explicit type conversion, identifier preservation, sequence repair, and relationship verification.

## PostgreSQL topology

PostgreSQL 17 was selected because the repository deployment example pins major 17, major 17 remains supported through November 2029, and the pinned image contains PostgreSQL 17.11.

- Image: `postgres@sha256:84560e3b9c6874893fc4e2854f5dc3e7c1a37bc9d1dfd7a8c641310ae22ba5ad`
- Version: `17.11 (Debian 17.11-1.pgdg12+2)`
- Container: `wiki-postgres`
- Network: `wiki-pg-migration-net`
- Data volume: `wiki-postgres-data:/var/lib/postgresql/data`
- Wiki content volume: `wiki-postgres-content:/wiki/data/content`
- PostgreSQL host ports: none; `5432/tcp` is private to the Docker network
- Restart policy: `unless-stopped`
- Health check: `pg_isready --username=postgres --dbname=postgres`
- Encoding: UTF8
- Timezone: UTC at server, database, and Wiki-role levels
- PostgreSQL `max_connections`: 40
- Wiki role connection limit: 20
- Wiki role: login only; not superuser, database creator, or role creator
- Wiki database owned by the Wiki role; schema creation revoked from `PUBLIC`
- Credential files: `/home/bbferko/.local/state/wiki-migration/2026-08-14/`, outside Git, under a mode-700 parent directory

`pg_stat_activity` showed four promoted application connections with `application_name=Wiki.js`, database `wiki`, and least-privilege user `wiki`. Application logs reported `Using database driver pg for postgres [ OK ]` and `Database Connection Successful [ OK ]`.

## Transfer method

1. The exact original image initialized an empty PostgreSQL schema through Wiki's PostgreSQL migrations.
2. The source SQLite backup was opened read-only and passed `PRAGMA quick_check`.
3. A local one-time Node transfer tool introspected source and destination schemas, parameterized every insert, and preserved explicit numeric and relational identifiers.
4. Boolean values were normalized; every JSON value was parsed; bytea, integer, text, JSON, boolean, and timestamp destinations were validated.
5. PostgreSQL `migrations` and `migrations_lock` remained from fresh PostgreSQL initialization rather than receiving incompatible SQLite bookkeeping.
6. Runtime tables were created by Wiki before the complete transfer pass.
7. All application/runtime tables were truncated and reloaded in a transaction. PostgreSQL sequences were reset above migrated maxima.
8. Every PostgreSQL foreign key was introspected and checked for orphans.
9. The source preview schema used legacy `isPrivate` / `privateNS` columns. The frozen source contained zero private rows. A separate transfer-only SQLite copy replaced those legacy columns with `visibility='public'` and `ownerId=NULL` for `pages`, `pageHistory`, and `pageTree`; the canonical frozen backup was not modified.
10. After browser probes were removed, the active SQLite service was stopped, a final online SQLite backup was made and validated, and that exact frozen state was transferred again.

No dual writes were introduced.

## Final reconciliation evidence

Source and destination counts matched across all 31 transferred application/runtime tables:

| Domain / tables | Source = destination |
|---|---:|
| users | 2 |
| groups | 2 |
| userGroups | 2 |
| authentication | 1 |
| sessions | 1 |
| pages | 1 |
| pageTree | 1 |
| pageHistory / pageHistoryTags | 0 / 0 |
| tags / pageTags | 0 / 0 |
| pageLinks | 0 |
| comments | 0 |
| commentProviders | 4 |
| assets / assetFolders / assetData | 0 / 0 / 0 |
| navigation | 1 |
| settings | 16 |
| analytics | 16 |
| editors | 7 |
| renderers | 27 |
| searchEngines | 9 |
| storage | 11 |
| loggers | 12 |
| locales | 1 |
| apiKeys / userKeys | 0 / 0 |
| userAvatars | 0 |
| auth rate-limit tables | 0 / 0 |

Additional evidence:

- 29 PostgreSQL foreign-key constraints checked; 0 orphan rows
- Active unique constraints rejected duplicate identities; no migration duplicates
- Page sample: page 1, locale `en`, path `home`, author 1, creator 1, page-tree row 1 -> page 1
- Membership samples: Administrator -> Administrators; Guest -> Guests
- JSON parsing completed for every JSON field; PostgreSQL accepted every boolean and timestamp conversion
- PostgreSQL migration bookkeeping contains 17 migrations through `2.5.129.js`
- A post-transfer page insert received ID 2, proving sequence repair; it survived Wiki and PostgreSQL restarts and was then removed
- Browser fixtures, temporary users, tags, assets, pages, and orphan history rows were removed before the final backup and promotion

## Source revision required for acceptance

The exact originally deployed preview image could not create or authorize private pages and rejected Administrator asset upload. Promotion remained blocked until those required behaviors were implemented and verified. The promoted source revision is therefore intentionally different from the original application image while retaining the same Wiki.js 2.5.314 upstream base.

The source changes provide:

- explicit `visibility` and nullable `ownerId` page identity
- owner-scoped private routes at `/_private/{locale}/{path}`
- independent public and private pages at the same locale/path
- private-aware create, read, edit, move, delete, history, source, download, restore, convert, and ownership-transfer paths
- private exclusion from public list, recent, tree, links, tags, search, search indexes, storage targets, comments, and navigation surfaces
- publication confirmation and collision protection
- PostgreSQL and SQLite migrations through `2.5.129`
- runtime-safe asset authorization initialization
- a system-administrator-only by-ID preview route for private pages

## Browser and runtime verification

A real Chromium browser exercised the canary at `127.0.0.1:3014` and the promoted service at `127.0.0.1:3013`.

Migration and deployment gates:

- `/healthz`: HTTP 200
- setup absent
- existing home page and content rendered
- existing Administrator authenticated; authentication survived reload and restart
- logout and reauthentication succeeded
- Users, Groups, Pages, General, Authentication, Search, and Storage administration surfaces loaded
- Users = 2, Groups = 2 with one member each, Pages = 1
- a public page was created, read, edited, moved, deleted, and its history viewed
- a write survived both Wiki and PostgreSQL restarts
- an SVG test asset was uploaded through the browser, listed through the API, read as `image/svg+xml`, and deleted; the read returned 404 after deletion
- a separate 71-byte binary asset was uploaded through the browser, read with SHA-256 `3543c670f1dee09af8ff8f889c9c333e018849ce0afeb55ff568291d901ba617`, survived Wiki and PostgreSQL restarts with the same byte length and digest, remained listed with `fileSize=71`, and was deleted cleanly
- search index rebuild and page search completed without database/runtime errors
- promoted service passed health, home, Administrator, and administration checks after its own restart
- application logs contained no database/runtime errors; the only warning was the pre-existing mail-not-configured warning

Private-page gates:

- private-page creation used the editor's Private page control
- the owner read, edited, moved, and deleted private pages
- private history was generated, paginated, and viewed at the private history route
- public and private pages coexisted at the same locale/path
- explicit publication confirmation was required; confirmed conversion changed route visibility correctly
- a public-path collision prevented publication without overwriting either page; the final API maps this collision to HTTP 409
- an ordinary authenticated local user received 404 for the private page, could read the public counterpart, and was denied the Administrator user query
- an anonymous client received 404 for private page, history, source, and download routes
- list, recent, tree, tag, and search probes did not expose the private page; stale search documents and suggestions were filtered
- private-tag probes were absent from anonymous tag and search responses
- ownership transfer changed access to the new owner; deletion of the former owner no longer broke the private page
- private-page assets were explicitly presented as site-wide and blocked from being treated as private content
- a system Administrator opened a private page owned by another principal through `/i/{id}` and was redirected to `/_admin/private/{id}`; the page rendered while the anonymous request returned 404
- the temporary administrator-preview page and ephemeral verification credential were removed after the check
- the final audit-remediation canary loaded the Administrator users surface, accepted the page-ID comment query, and created a temporary private page
- after that page was published, its private historical revision remained visible to the Administrator but returned `null` to a non-owner with page and history-read permissions
- after returning the fixture to private visibility, the non-owner search returned zero hits; the page, history, temporary group membership, session, and token artifacts were then removed
- the remediated image was promoted, both Wiki and PostgreSQL were restarted, `/healthz` returned HTTP 200, and `Page Home | Wiki.js` rendered at the deployed address
- the final canary accepted a partial `pages.update` mutation that omitted optional fields and tags; description, publication state, scripts, dates, and the existing tag remained unchanged, and the verification page was removed

## Repository verification

```text
pnpm test
147 test files passed, 1 skipped
1184 tests passed, 4 skipped

pnpm typecheck:server
passed

pnpm typecheck:client
passed

pnpm exec vitest run server/test/db/private-pages.postgres.integration.test.ts
1 file passed, 4 tests passed against an isolated PostgreSQL database

pnpm exec vitest run server/test/db/private-pages.sqlite.integration.test.ts
1 file passed, 2 tests passed against in-memory SQLite

```

GitHub protected-branch checks passed at revision `15a87230ce320def8bd8d0c0942de3f861a6a493`: Quality, image/bundle build, and Playwright on PostgreSQL, SQLite, MySQL, MariaDB, and SQL Server. Local fresh-schema startup probes also verified the visibility check and normalized owner-identity unique index on MySQL, MariaDB, and SQL Server.

The final Docker image build completed successfully and embedded source revision `15a87230ce320def8bd8d0c0942de3f861a6a493`.

## Backups

Backups are outside Git under `/home/bbferko/.local/state/wiki-migration/2026-08-14/`. No credential value or generated database content is committed.

- Initial SQLite: `wiki-pre-postgres.sqlite`
  - `PRAGMA quick_check`: `ok`
  - SHA-256: `449dd59ed61c9968f78cc6d264db1c6e15073f613b3919f642734d5c99d85e28`
- Final frozen SQLite: `wiki-final-pre-cutover.sqlite`
  - `PRAGMA quick_check`: `ok`; 34 tables readable
  - SHA-256: `a571d205ffd58d78b316e5ee1647cdb25e16540e57445858df46f41b75892ae3`
- Final PostgreSQL custom-format dump: `wiki-final-pre-promotion.dump`
  - `pg_restore --list`: readable, 209 TOC entries
  - SHA-256: `dafa97aa8c7cb80d4c3a017f3d813e109a44cdaa31d3fbf938680401a19d48f6`

`wiki-final-transfer.sqlite` is a non-canonical, schema-adapted transfer artifact. Rollback uses `wiki-final-pre-cutover.sqlite` or, preferably, the untouched `wiki-tailnet-data` volume.

## Promotion and rollback

Current topology:

- Active Wiki: `wiki-tailnet`, source revision `54b6b481916cf43c89dde1bcd9f68a57986a3736`, published image `ghcr.io/philosophimoonbeam/wiki:canary` / `sha256:feb9a5a4ea1a9dc5a8907f4c5d30b89a1f964b1443ab04099f34b058eae93481`, PostgreSQL, healthy, Docker-published only on `127.0.0.1:3013`; tailnet HTTPS proxies to that loopback endpoint
- Active database: `wiki-postgres`, PostgreSQL 17.11, healthy, no host port
- Preserved immediately previous PostgreSQL container: `wiki-tailnet-pre-54b6b481`, stopped, image `sha256:9deb3261a447c14db050332662c0c20ec99a45e158f47f7a22b09211ac83c912`, source revision `8e8a65138dda678683449b344d051fcf0428556d`; the locally built and verified copy of revision `54b6b481` is stopped as `wiki-tailnet-local-54b6b481`; earlier verified containers remain stopped
- Preserved rollback container: `wiki-tailnet-sqlite-rollback-20260814`, stopped
- Preserved rollback image ID: `sha256:3ac6fe5582b4782ab7eceef76f03d0666b905193b9093b4b6011be23ecc81b7c`
- Preserved rollback volume: `wiki-tailnet-data:/wiki/data/content`

Rollback procedure:

```bash
docker stop wiki-tailnet
docker rename wiki-tailnet wiki-tailnet-postgres-rollback-$(date +%Y%m%d%H%M%S)
docker rename wiki-tailnet-sqlite-rollback-20260814 wiki-tailnet
docker start wiki-tailnet
curl --fail http://127.0.0.1:3013/healthz
```

Then verify the home page and Administrator login in a browser. Do not attach PostgreSQL to `wiki-tailnet-data`; do not overwrite `wiki.sqlite`.

There is no reverse synchronization. Any writes accepted after PostgreSQL promotion are outside the frozen SQLite rollback view and would be lost on rollback unless explicitly exported and reconciled first. This is the rollback data-loss boundary.

## Remaining risks

- Rollback is immediate at the container/configuration level but is intentionally not a reverse data migration.
- The original SQLite schema contains legacy `isPrivate` / `privateNS` columns. It contains zero private rows; PostgreSQL is now canonical for new owner-scoped private-page data.
- Mail remains unconfigured, matching the pre-migration deployment.
- PostgreSQL backups require normal operational rotation and off-host retention beyond this one-time local migration backup.

## Content-extension deployment — 2026-08-15

Revision `54b6b481916cf43c89dde1bcd9f68a57986a3736` was built from the committed tree with the production Dockerfile, exercised as an isolated canary on `127.0.0.1:3014` against the canonical PostgreSQL service, passed the complete Build + Publish workflow, and was promoted from the published `ghcr.io/philosophimoonbeam/wiki:canary` image without changing the database, secret, content volume, Docker network, restart policy, or loopback-only publication boundary.

Promotion evidence:

- the local candidate and published image both reported OCI revision `54b6b481916cf43c89dde1bcd9f68a57986a3736`;
- GitHub Actions run `31900261842` passed quality, production build, five-database browser, five-database upgrade, multi-instance recovery, Helm lifecycle, AMD64 publication, and ARM64 publication gates; an isolated first-attempt MySQL search timing failure passed on retry while the other four database browser jobs had already passed;
- candidate and promoted `/healthz` returned HTTP 200 with `{"ok":true}`;
- migration `2.5.138` left the complete 13-extension registry present and disabled by default;
- the authenticated `/_api/content-extensions` response reported host version 1 and all 13 compatible extension definitions;
- the tailnet URL `https://agents8c48g.tail41a24a.ts.net:10443/` rendered `Page Home | Wiki.js` in Chromium with no console or page errors;
- a promoted-container restart preserved healthy status, the PostgreSQL connection, loopback health, tailnet HTTPS health, and the rendered home page;
- runtime logs identified the exact revision, successful PostgreSQL connection, GraphQL schema load, HTTP startup, and completed page-tree rebuild; the only warning remained the pre-existing unconfigured mail service.

Immediate application rollback preserves PostgreSQL and the additive disabled extension rows:

```bash
docker stop wiki-tailnet
docker rename wiki-tailnet wiki-tailnet-post-54b6b481-rollback-$(date +%Y%m%d%H%M%S)
docker rename wiki-tailnet-pre-54b6b481 wiki-tailnet
docker start wiki-tailnet
curl --fail http://127.0.0.1:3013/healthz
```

The older SQLite rollback path remains available but is still subject to the post-promotion data-loss boundary documented above.

## Completed synthesis deployment — 2026-08-16

Revision `6f05d1f564b56ee752e0a07cfbcbb58af7244e49` was promoted at `2026-08-16T01:03:43Z` from the immutable published image `ghcr.io/philosophimoonbeam/wiki@sha256:c6a532f98584f07ff99807c4d9190f44266076a36d15c8dd4bdb9a32d8df2776`. The replacement retained PostgreSQL 17, `wiki-postgres-data`, `wiki-postgres-content`, the database password file, `wiki-pg-migration-net`, restart policy `unless-stopped`, and the loopback-only `127.0.0.1:3013` publication boundary. No volume replacement was appropriate: the canonical database already contained migration `2.5.138`, and the completed synthesis added no later migration.

Pre-promotion backups are outside Git under `/home/bbferko/.local/state/wiki-deploy/2026-08-16-6f05d1f5/`:

- PostgreSQL custom-format dump `wiki-pre-6f05d1f5.dump`, SHA-256 `a3fa9d76cd8626eecd988973c9f70dcdd617162572d7cfa71918d89a6b9a697d`; `pg_restore --list` read 304 lines;
- content-volume archive `wiki-content-pre-6f05d1f5.tar.gz`, SHA-256 `1d4d4383f93beb60a3a0400ca920f6b215130c8a578eb8ad28ed187b672fda21`.

Promotion evidence:

- `wiki-tailnet` is healthy, reports OCI revision `6f05d1f564b56ee752e0a07cfbcbb58af7244e49`, connects successfully to supported PostgreSQL 17.11, loads the GraphQL schema, starts HTTP on port 3000, and completes the page-tree rebuild;
- local and tailnet `/healthz` requests return HTTP 200 with `{"ok":true}`;
- Chromium loaded `https://agents8c48g.tail41a24a.ts.net:10443/` as `Page Home | Wiki.js` with no console errors, page errors, or failed requests;
- the existing authenticated session read the administrator identity and the three retained pages through the REST API;
- a promoted-container restart preserved health, the tailnet route, authentication, and the retained page data;
- the replaced container remains stopped as `wiki-tailnet-pre-6f05d1f5`.

Immediate application rollback preserves the same PostgreSQL and content volumes:

```bash
docker stop wiki-tailnet
docker rename wiki-tailnet wiki-tailnet-post-6f05d1f5-rollback-$(date +%Y%m%d%H%M%S)
docker rename wiki-tailnet-pre-6f05d1f5 wiki-tailnet
docker start wiki-tailnet
curl --fail http://127.0.0.1:3013/healthz
```
