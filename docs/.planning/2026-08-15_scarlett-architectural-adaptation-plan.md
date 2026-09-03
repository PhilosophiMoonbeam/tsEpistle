# Scarlett architectural adaptation plan

**Status:** accepted fork-native decision record and implementation plan  
**Date:** 2026-08-15  
**Revised:** 2026-08-15T16:48:30Z — PostgreSQL-only target accepted after operator inventory confirmed zero non-PostgreSQL installations
**tsFranki revision assessed:** `a7ecf37e4582834b522ee1de7f48066751bd1ada`
**Scarlett revision assessed:** `d0c5a8bfa90acee73a2f4c71033978bea1925468` (`feat: add unlock aspect ratio option to block-gallery`)  
**Common ancestor:** `b5b4b0880ae26f4b137242267b6674b51af8688c`

This report reopens every Scarlett architectural choice previously classified as “not inherited.” Implementation size and merge friction are deliberately excluded from the decision criteria. A large change is accepted when it produces a stronger product contract; a small change is rejected when it creates a second architecture, loses compatibility, or has no measurable user or maintainer benefit.

This report supplements the authoritative [Scarlett design-synthesis roadmap](./2026-08-14_scarlett-design-synthesis-roadmap.md). It does not replace that roadmap’s security, data-continuity, API, or release invariants.

## Executive decision

Scarlett contains valuable architectural direction, but its repository replacement is not the valuable part. tsEpistle should adopt clearer package ownership, typed boundaries, safer migration detection, PostgreSQL as its sole database platform, bounded derived projections, and isolated extension runtimes where those changes prove a concrete benefit. It should not adopt Scarlett’s destructive migration reset, parallel ORM, global Tailwind design system, stale privileged index, canonical-source deletion, unfinished workflow persistence, or dependency downgrades.

| Previously not inherited | Merit-first disposition | What tsEpistle gains |
| --- | --- | --- |
| wholesale `backend/` + `frontend/` repository replacement | **Adapt boundaries; do not copy layout** | explicit contracts and dependency ownership without pretending currently coupled code is independently deployable |
| migration reset / fresh database | **Reject reset; accept a verified shadow-schema bridge when redesign is justified** | schema modernization without abandoning installed data or rollback |
| Drizzle ORM | **Conditional bounded pilot; no platform cutover now** | evidence on typed schema/query value before accepting a second migration and transaction model |
| Lit block runtime | **Conditional per-extension implementation detail** | lifecycle isolation for genuinely interactive blocks, only if it beats the existing native host |
| Tailwind UI/runtime | **Reject as a second global design system** | one theme, focus, responsive, localization, and accessibility model remains authoritative |
| PostgreSQL-only database portfolio | **Adopt deliberately, independent of Scarlett’s reset** | one deeply supported database, stronger HA/search/job primitives, and removal of unused dialect complexity |
| pre-rendered or unbounded page index | **Adapt as a visibility-neutral, rebuildable projection only after profiling** | scalable indexes without stale authorization decisions or privileged cached HTML |
| broad reuse of unfinished watching/approval/collaboration code | **Reject persistence/state transplant; compare UX only** | retain the fork’s completed policy, revision, outbox, retry, and recovery contracts |
| disabled-block source stripping | **Reject deletion; current escaped-source behavior is the target** | immediate active-output removal with exact canonical recovery |
| dependency alignment or downgrade to Scarlett | **Compare package-by-package** | current fixes and compatibility retained; upgrades remain evidence-driven |

The answer is therefore not “avoid Scarlett because adaptation is difficult.” The answer is: implement the useful contracts, including large structural work where justified, and reject only the portions whose end state is worse.

## Evidence baseline

At assessment time:

- `origin/scarlett` is `249758e3`; upstream Scarlett is 73 commits beyond it at `d0c5a8bf`.
- The upstream delta changes 521 files with 96,069 insertions and 27,147 deletions.
- Historical branch comparison: former tsFranki `main...upstream/scarlett` is 694 commits on the former tsFranki side and 343 on the Scarlett side. This divergence explains why copying is unsafe, but it is not used as a reason to reject an idea.
- Scarlett’s pivotal architecture commits include:
  - `6f492f00`: split API schemas;
  - `ee7a15fb`: TypeScript backend migration;
  - `937cecea`: WIP replacement UI library and Tailwind migration across 224 frontend files;
  - `6db53d4f`: deletion and reset of prior Drizzle migrations;
  - `99ccdc13`: refusal to run against a Wiki.js 2 database;
  - `14e1efae`: WIP page watching and rate limiting;
  - `957efebe`: WIP approvals/profile-auth flows.
- Scarlett currently has independent `backend/package.json`, `frontend/package.json`, and `blocks/package.json` manifests. Its backend uses `drizzle-orm/node-postgres`, requires PostgreSQL 16, installs `ltree` and `pg_trgm`, and exposes one generated PostgreSQL initial migration at `backend/db/migrations/20260809235619_init/migration.sql`.
- tsEpistle is one released root package. Vite emits the setup and application browser entries consumed by Express; the Docker and release pipelines install, build, prune, inventory, attest, and package that single revision together.
- tsEpistle uses Vue 3, Vuetify 4, Pinia, Vue Router, CKEditor, Vite, Express, Knex, and Objection. Its current database initializer and CI still support PostgreSQL, MySQL, MariaDB, MSSQL, and SQLite.
- Operator inventory on 2026-08-15 records zero non-PostgreSQL tsEpistle installations. PostgreSQL is therefore the sole target for the future stable product; no cross-dialect customer-data converter is required.
- Existing PostgreSQL / Wiki.js 2.x installations remain the mandatory upgrade source. tsEpistle migration preflight already rejects unknown, partial, out-of-order, and locked ledgers before current migrations write.
- The content-extension host already provides strict versioned envelopes, disabled-by-default registry rows, sanitized server rendering, escaped-source fallback, editor insertion, dynamic browser hydration, and policy-filtered page-index queries.

External implementation references used for the bounded technology decisions:

- [Drizzle ORM overview](https://orm.drizzle.team/docs/overview)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Lit component model](https://lit.dev/docs/components/overview/)

These references show what the tools can do. They do not establish that introducing them improves this codebase; the acceptance experiments below must establish that.

## Decision criteria

Every adaptation must improve at least one observable dimension without regressing a release invariant:

1. **Data continuity:** existing PostgreSQL installations upgrade in place or through a verified shadow schema without reinstallation.
2. **Correctness:** one policy, transaction, source, and error contract owns each behavior.
3. **Operability:** failure, retry, rollback, and multi-instance behavior are explicit.
4. **PostgreSQL continuity:** behavior remains correct across every declared PostgreSQL source-product and server-version floor.
5. **Performance:** representative p95/p99 latency, memory, connections, queue age, or bundle transfer improves.
6. **Maintainability:** dependencies and ownership become enforceable, not merely rearranged.
7. **Accessibility and privacy:** the change preserves the current theme/focus/localization model and does not add silent remote loading.
8. **Release integrity:** all images, bundles, charts, SBOMs, checksums, manifests, and attestations still identify one source revision.

A proposed change fails if its only measurable result is a renamed directory, a newer framework label, fewer merge conflicts with Scarlett, or fewer lines in one subsystem offset by duplicate behavior elsewhere.

## 1. Repository and package boundaries

### Problem worth solving

The current root package still contains real coupling:

- server startup initializes the global `WIKI` runtime used by legacy modules;
- some transports still reach into global models, logger, and emitters;
- Vite and Express share an asset-manifest contract;
- `shared/` has no independent package export surface;
- browser and server TypeScript coverage is improving but still excludes legacy JavaScript and test surfaces.

Scarlett’s separate manifests make dependency ownership and local builds clearer. Those properties would improve tsEpistle. Renaming `server/` to `backend/` and `client/` to `frontend/` would not.

### Decision

**Accept an incremental package-boundary program. Do not copy Scarlett’s directory tree or create nominally independent packages before the code boundaries are real.**

Target boundaries:

- `shared`: runtime-free versioned contracts and pure policy/schema helpers;
- `server`: transport, domain operations, repositories, workers, and server adapters;
- `client`: Vue application, editor integrations, and browser-only adapters;
- content-extension definitions: shared envelopes plus separately lazy-loadable browser runtimes where warranted.

The current physical directories may remain. A later move is accepted only when it removes forbidden imports or unlocks independently cached/tested artifacts. Package names and folder names are not architecture.

### Implementation slices

1. Generate an import graph and declare allowed edges: `client -> shared`, `server -> shared`, never `shared -> client|server` and never `server -> client`.
2. Remove transport reach-through to `WIKI.models`, `WIKI.GQLEmitter`, and untyped globals by routing through operations and injected adapters.
3. Give `shared`, `server`, and `client` explicit TypeScript project references and export maps before adding independent manifests.
4. Prove a frozen clean install, application/setup Vite manifest, real Express startup, Docker prune, license inventory, and release bundle from the new boundary.
5. Only then decide whether separate manifests reduce install/build scope. If they do, cut over every caller, build script, Docker context, license/SBOM aggregator, Windows/Linux packager, and documentation reference in one change. No parallel root-plus-split architecture remains.

### Implemented boundary evidence and manifest decision

The first boundary cutover is complete on the existing directory layout:

- `eslint.config.js` enforces `client -> shared`, `server -> shared`, and a dependency-free `shared` layer; the transport scope also rejects direct `WIKI` / `globalThis.WIKI` access.
- `tsconfig.shared.json` emits the shared declaration contract, `tsconfig.client.json` and `tsconfig.server.json` reference it, and `shared/index.ts` is the explicit public surface.
- HTTP controllers receive their runtime from `master.ts` through the configured transport boundary. GraphQL schema construction and resolver factories receive a `GraphRuntime`; `core/servers.ts` receives `ServerWiki` from the kernel composition root. No controller, GraphQL module, master transport, or server transport reads the process-global runtime.
- The root `package.json` remains authoritative. A split manifest cutover is rejected at this boundary because the client and server still produce one Vite/Express runtime and one atomic release artifact, while no measurement shows an independently installable or cacheable package. Creating `client`, `server`, or `shared` manifests now would duplicate dependency and release ownership without reducing install or build scope. Reconsider only after the clean-install, Docker prune, license/SBOM aggregation, and independently cached artifact gates demonstrate a smaller real build graph; any later cutover must replace the root graph atomically.
- Focused transport, GraphQL, and API suites pass, as do lint, shared/server/client typechecks, and the full `1,409`-test suite. The production build is intentionally verified from the clean committed boundary because build metadata refuses dirty source trees.

### Acceptance gates

- no undeclared or reverse cross-boundary imports;
- no duplicate business operation or compatibility shim;
- strict client and server typechecks cover the exported boundary;
- unchanged REST/OpenAPI, GraphQL compatibility, editor round-trip, policy, and browser behavior;
- existing initial/lazy bundle ceilings do not increase without an approved budget change;
- PostgreSQL fresh-install, Wiki.js 2.x upgrade, backup/restore, multi-instance recovery, and Helm lifecycle remain green across the declared PostgreSQL version floor;
- released source, Linux, Windows, OCI, chart, SPDX, license inventory, checksums, manifest, and attestations identify the same full commit SHA.

### Rollback

Boundary refactors contain no database change. Until a release is promoted, rollback is a source revert. After promotion, old and new package layouts must consume the same config, database, content, and artifact metadata; an operator can run the previous image without conversion. Physical cutover is prohibited if it requires runtime aliases or two package graphs.

## 2. Migration reset and schema redesign

### What Scarlett improves

Scarlett correctly refuses to mutate a Wiki.js 2 database with a migration history it does not understand. Its `99ccdc13` guard checks legacy tables before creating the new schema. tsEpistle has already adapted the safety principle through `server/db/migration-preflight.ts` while retaining an upgrade path.

Scarlett’s reset in `6db53d4f` collapses earlier Drizzle migrations into one PostgreSQL initial migration and instructs legacy operators to use a fresh database. That simplifies development history but transfers all cost and risk to operators. It does not improve the installed product.

### Decision

**Permanently reject migration-history reset as a release mechanism. Accept major schema redesign through a verified shadow-schema bridge when the redesigned schema has independently proven value.**

Large schema work is allowed. Data abandonment is not.

### Migration strategy for a future major redesign

1. **Inventory:** recognize exact PostgreSQL source product and migration versions before writes.
2. **Backup boundary:** require and verify a restorable database plus external asset/storage inventory.
3. **Shadow target:** create versioned target tables or a target schema without renaming/dropping source objects.
4. **Deterministic copy:** migrate stable IDs or persist explicit ID maps; preserve pages, source, renders, history, owners, permissions, assets, navigation, auth identities, settings, editor metadata, extension envelopes, jobs, and audit rows.
5. **Validation:** compare row counts, relationship counts, canonical source hashes, ownership, ACL decisions, asset hashes, and sampled rendered behavior.
6. **Cutover:** enter bounded maintenance mode, stop writers/workers, copy final deltas, validate again, and atomically switch the application-owned schema marker.
7. **Observation:** retain source tables read-only for one supported rollback window; monitor invariant and query failures.
8. **Retirement:** remove old tables only in a later explicitly destructive release with tested backup/restore.

### Acceptance gates

For every advertised PostgreSQL source product version:

- restore a representative, tracked pre-upgrade artifact;
- prove preflight performs zero writes for locked, unknown/newer, partial, missing-ledger, and out-of-order states;
- prove the migration ledger is an exact recognized extension rather than a rewritten history;
- assert stable IDs, foreign keys, canonical content hashes, history, ownership, assets, navigation, permissions, editor metadata, and extension source;
- run critical login, read, edit, history/restore, asset, and administration journeys after migration;
- record migration duration, peak storage, peak memory, and maintenance-window requirements;
- restore the backup and boot the previous image, documenting the post-cutover write-loss boundary.

### Implemented PostgreSQL continuity evidence

The PostgreSQL-only cutover is complete:

- startup now accepts current minor releases of PostgreSQL 15, 16, 17, and 18 and rejects older or unknown major lines before application migrations;
- the tracked Wiki.js 2.5.314 fixture contains an administrator, public page, two revisions, tags, navigation, and a stored asset, with pinned source-image, database-dump, and data-archive SHA-256 identities;
- CI restores that fixture on every supported PostgreSQL major, verifies the exact legacy migration prefix, starts the previous image and authenticates, snapshots database and data volumes, upgrades the candidate, verifies identity and resource counts, authenticates and writes through the candidate, restores both snapshots, boots the previous image again, and proves post-snapshot writes were discarded;
- migration artifacts record the full candidate revision, PostgreSQL image and reported version, fixture and backup identities, before/after/rollback resources, duration, peak database/data storage, peak memory, and enforced ceilings. Local proofs completed on PostgreSQL 15.19, 16.15, 17.11, and 18.6; the observed migration window was 2–3 seconds with 109% peak database amplification and no data-volume growth. The instrumented PostgreSQL 15.19 run peaked at 374,689,792 bytes of container memory;
- legacy MySQL, MariaDB, Microsoft SQL Server, and SQLite adapters, migrations, installer choices, dependencies, and release jobs were removed only after this proof path existed. Knex/Objection remain the single PostgreSQL schema and transaction authority.

The accepted rollback contract is snapshot restoration, not down migrations. Writes accepted after the snapshot are intentionally lost when an operator rolls back.

### Rollback

Before cutover: discard the shadow target. After cutover but before new writes: switch back to the validated source. After new writes: rollback requires a tested reverse-delta process or restoration of the cutover snapshot; documentation must state which data written after promotion will be lost. “Run down migrations” is not sufficient proof for a major rewrite.

## 3. Drizzle adoption

### Potential value

Scarlett demonstrates useful properties: schema definitions and query types share a source, PostgreSQL-specific indexes/types are explicit, and migration generation can expose schema drift. tsEpistle would benefit from stronger repository typing and schema verification.

### Current disadvantage

Scarlett’s implementation is specifically `drizzle-orm/node-postgres`, PostgreSQL 16, `ltree`, `pg_trgm`, arrays, `jsonb`, generated columns, GIN/GiST indexes, and one Drizzle migration ledger. PostgreSQL-only removes tsEpistle’s dialect-portability objection, but tsEpistle still owns installed Knex migration histories, Objection models, and operation transaction boundaries. Adding Drizzle without a clean cutover would create two schema authorities and two transaction/query semantics.

### Decision

**Do not adopt Drizzle platform-wide in the same cutover as PostgreSQL-only support. Run one bounded comparative pilot after the PostgreSQL upgrade path and repository boundary are explicit.** The remaining question is whether Drizzle materially improves one-database correctness and maintenance, not whether it can reproduce five dialects.

Pilot candidate: a new, isolated, low-risk repository with meaningful transactions and indexed reads, not `pages`, users, permissions, or migrations. Durable job observability or a derived projection is preferable because it can be discarded and rebuilt.

The pilot must compare:

- existing typed Knex repository;
- proposed Drizzle repository;
- identical operation and error interface;
- identical transaction, cancellation, connection, timestamp, JSON, locking, and pagination behavior;
- PostgreSQL behavior across every declared supported server version, including transaction, lock, JSONB, timestamp, pagination, cancellation, and pool semantics.

### Promotion gates

Promote only if the pilot demonstrates a material improvement in at least two of:

- compile-time detection of real schema/query errors;
- lower p95 latency, allocations, or connection occupancy;
- fewer hand-maintained row/DTO transformations;
- safer migration drift detection;
- reduced repository implementation complexity without generated or duplicated glue.

It must also show one migration authority, one transaction owner, no dual writes, no parallel ledgers, clean rollback, and preservation of every installed PostgreSQL migration history. Otherwise remove the pilot dependency and retain typed Knex repositories.

## 4. Lit and Tailwind

### Split the decision

Lit and Tailwind solve different problems and must not be accepted or rejected as a bundle.

### Lit

Lit can provide an encapsulated custom-element lifecycle for highly interactive content extensions. It does not improve the main Vue application, whose router, Pinia state, Vuetify theme/display/locale, i18n, focus management, and dialog system already form one coherent runtime. The current extension browser host is framework-neutral and performs bounded DOM hydration without Lit.

**Decision: allow Lit only as a lazy, per-extension implementation detail after a native-host comparison.** The first candidate must have enough state to justify it—tabs alone do not. PDF/media controls or a complex diagram interaction are better candidates.

Gate:

- no Lit code in the main application/setup entry;
- lazy chunk loaded only when the matching enabled extension exists;
- server-rendered accessible fallback remains complete without JavaScript;
- auth, asset policy, navigation, locale, theme, reduced motion, forced colors, focus restoration, page replacement, and abort lifecycle are explicit adapters;
- route transfer and gzip budgets beat or equal the native implementation;
- no private state or server value is injected through `innerHTML`.

If Lit does not beat the native controller on correctness, accessibility, bundle cost, or maintainability, remove it.

### Tailwind

Scarlett’s `937cecea` is explicitly WIP and replaces a broad component library across 224 frontend files. Adding Tailwind beside Vuetify/SCSS would create a second token, reset, responsive, dark-mode, and focus vocabulary. Extension output also shares a document with authored page CSS, making global utility/preflight behavior especially risky.

**Decision: reject Tailwind as a global or extension-host design system.** Reproduce worthwhile Scarlett UX in Vue/Vuetify and scoped semantic CSS. A build-time utility compiler could be reconsidered only if it emits fully isolated shadow-root CSS for one extension and proves a smaller, more accessible result than semantic CSS; Tailwind class compatibility never becomes persisted content.

### Rollback

Every experimental custom-element runtime is selected by its extension registration and lazy import. Rollback disables that runtime and returns to the server fallback/native controller without rewriting canonical source. No page migration is permitted merely to change browser frameworks.

## 5. PostgreSQL-only platform

### Decision

**PostgreSQL is the sole database target for the future stable tsEpistle product.**

This is an affirmative fork decision, not incidental inheritance from Scarlett. The operator inventory records zero non-PostgreSQL installations, while maintaining five dialects consumes schema, migration, locking, CI, debugging, and release capacity. Concentrating that capacity on PostgreSQL should improve upgrade proof, multi-instance behavior, search, durable jobs, performance analysis, backup/restore guidance, and operational support.

PostgreSQL-only does not imply:

- accepting Scarlett’s fresh-database requirement;
- resetting or replacing the installed Knex migration ledger;
- adopting PostgreSQL 16 without a support-floor decision;
- adopting Drizzle in the same cutover;
- copying Scarlett’s schema;
- abandoning an existing PostgreSQL / Wiki.js 2.x installation.

### Required continuity

The supported source is the existing PostgreSQL schema and data produced by Wiki.js 2.x and this fork. Its upgrade path is a release blocker. It must preserve stable IDs, users, authentication identities, groups, permissions, pages, canonical source, rendered output, history, private ownership, assets, navigation, search settings, editor metadata, extensions, jobs, workflow state, and audit records.

No MySQL, MariaDB, MSSQL, or SQLite converter will be built without evidence of an actual installation. Building speculative conversion tooling would retain the support burden the decision is intended to remove.

### Transition sequence

1. Freeze new non-PostgreSQL compatibility work; existing adapters remain only as temporary code until the cutover is proven.
2. Choose and document the PostgreSQL minimum from security support, extension requirements, deployment availability, and upgrade testing. Scarlett’s PostgreSQL 16 floor is a candidate, not inherited authority.
3. Add representative PostgreSQL Wiki.js 2.x and current-fork database artifacts at every declared source floor.
4. Prove additive migration, invariant validation, backup/restore, previous-image rollback, multi-instance recovery, and Helm upgrade/rollback on the PostgreSQL version matrix.
5. Change configuration, setup, documentation, and release metadata to PostgreSQL-only.
6. Remove MySQL, MariaDB, MSSQL, and SQLite drivers, configuration branches, migration branches, fixtures, CI jobs, dependencies, and documentation in one clean cutover. Do not leave dormant adapters or compatibility aliases.
7. Only after continuity proof, introduce PostgreSQL-native schema/query improvements such as JSONB/GIN, `ltree`, `pg_trgm`, `tsvector`, partial/expression indexes, `SKIP LOCKED`, advisory locks, and `LISTEN`/`NOTIFY` where each improves a measured contract.

### Acceptance gates

- fresh install succeeds on every declared PostgreSQL server version;
- representative PostgreSQL Wiki.js 2.x and tsEpistle sources upgrade without a migration-ledger reset;
- preflight rejects unknown/newer, locked, partial, missing-ledger, and out-of-order states with zero writes;
- stable IDs, foreign keys, canonical content hashes, ownership, permissions, history, assets, navigation, editor metadata, extension source, workflow state, and audit records survive;
- login, read, edit, history/restore, protected content, asset, search, administration, job recovery, and multi-instance journeys pass after upgrade;
- migration duration, lock time, storage amplification, memory, connection use, and required maintenance window are recorded on a representative dataset;
- PostgreSQL backup/restore boots the previous image and passes the critical read/auth journey;
- configuration and setup reject removed database types with a precise migration/support message;
- no non-PostgreSQL runtime driver, migration path, CI job, or advertised support statement remains after cutover.

### Rollback

Removing unused adapters must not mutate PostgreSQL data. Before release promotion, rollback is the previous image against the same PostgreSQL database or the verified pre-upgrade backup according to the migration boundary. After a schema migration accepts new writes, rollback follows the tested reverse-delta or snapshot restore procedure defined in the migration section; adapter removal never justifies manual SQL or a fresh database.

## 6. Bounded page indexes and materialized projections

### Current design

The native `index` extension is safer than Scarlett’s page-list approach:

- path length is bounded; depth is 0–5; caller-visible limit is 1–200;
- the server scopes locale/path before a 5,001-row ceiling;
- visibility, private ownership, tags, and page rules are applied for the current requester;
- responses are private, non-cacheable, and varied by cookie;
- browser hydration validates at most 200 items and constructs text/attribute DOM, not `innerHTML`.

The remaining risk is performance, not stale authorization. A broad root index can still load and sort up to 5,000 candidates in process. SQL `LIKE` wildcard characters in paths can broaden database work even though final prefix checks prevent disclosure.

### Decision

**Keep the dynamic authorized query as the correctness implementation. Accept a materialized projection only as visibility-neutral derived data after representative profiling breaches an approved budget.**

A valid projection may store page ID, site, locale, normalized path segments, title, icon, tags, update timestamp, publish/search/browse state, and a projection version. It must never store:

- requester-specific allow/deny decisions;
- owner-private visibility conclusions;
- pre-rendered privileged HTML;
- an unbounded all-pages response;
- data that cannot be rebuilt from canonical tables.

Authorization is always evaluated at request time. Mutations enqueue versioned idempotent projection updates through the existing transaction/outbox/job foundation. A stale or unavailable projection falls back to the bounded direct query or returns an explicit retryable state; it never serves a stale privileged result.

### Prerequisites and gates

Before materialization:

- escape or structurally replace `LIKE` prefix matching;
- add an actual 5,001-candidate `PAGE_INDEX_TOO_BROAD` regression;
- version a representative deep/wide multi-locale tree dataset;
- measure direct-query p50/p95/p99 latency, rows scanned, memory, query count, and connection occupancy for anonymous, owner, restricted-group, and administrator principals.

Projection promotion requires:

- identical item sets and ordering against the direct query for every principal matrix case;
- bounded pagination/limit at the repository and response boundaries;
- transaction rollback, worker death, duplicate event, out-of-order event, permission revocation, move, delete, locale, tag, and rebuild coverage;
- measured p95 improvement large enough to justify the extra moving parts;
- rebuild progress, lag, failure, and retry observability;
- `DROP`/rebuild rollback with canonical data untouched.

## 7. Upstream workflow reuse

### Decision

**Do not transplant Scarlett’s WIP persistence or state machines. Continue comparing its UX and route decomposition.** This is no longer merely a precaution: tsEpistle has completed stronger native contracts.

Current native implementations include:

- page watching with readable-page checks, permission-revocation cleanup, transactional page events, durable delivery, and independent channels;
- revision-bound approvals with explicit state transitions, required comments, reviewer eligibility, assignment/reassignment, stale-revision checks, transactional publication, inboxes, and immutable audit history;
- collaboration with authenticated rooms, durable versions, replay, cross-instance fanout, continuous authorization, and explicit conflict/local-preservation behavior;
- outbox and durable-job leases with rollback, idempotency, retry, and expired-lease recovery.

Upstream presentation ideas may be adapted only by calling these operations. No upstream UI may write statuses or tables directly, weaken revision binding, send notifications inside page transactions, or bypass centralized page policy.

### Remaining improvement gates

- representative approval-inbox query-count and p95 budget; eliminate N+1 page lookup if measured;
- every transition family, concurrent/stale decision, rollback, permission-revocation, process-loss, retry/idempotency, and multi-instance scenario;
- browser UX for the same operation contract on desktop, narrow/mobile, keyboard, dark, and serious/critical axe profiles;
- no GraphQL/REST/UI path owns a second workflow implementation.

### Rollback

Workflow presentation can roll back independently because operation contracts and persisted state remain stable. A domain-state change requires an additive migration plus forward/backward compatibility across a rolling deployment; UI-only rollback must not orphan states introduced by a newer server.

## 8. Disabled extension source handling

### Decision

**The fork’s current design supersedes Scarlett source stripping and should be strengthened, not replaced.**

The canonical fenced JSON remains in `pages.content`, history, source editing, export, and print inputs. The renderer activates only canonical, installed, enabled, compatible, exact-version envelopes. Disabled, incompatible, unknown, malformed, or failed extensions fall through to an escaped inert code fence. Enabling or disabling changes derived render output, never source bytes.

This delivers Scarlett’s security goal—remove active output immediately—without data loss.

### Required hardening

Current toggle handling commits registry state and then scans candidate pages and rerenders sequentially. A process failure can leave partially refreshed derived renders. Replace that tail with the existing durable-job foundation:

1. commit the registry state and a versioned rerender request;
2. enumerate candidates in bounded pages;
3. enqueue idempotent per-page renders keyed by extension/version/page revision;
4. expose total, completed, failed, retrying, and terminal state;
5. invalidate caches only with the corresponding render result;
6. make enable/disable safe to repeat and safe across process loss.

Acceptance includes a parameterized QR/gallery/index lifecycle proving exact source bytes through save, reopen in both editors, disable, rerender, re-enable, history/restore, export, and print; include unknown future key/version and renderer failure. Candidate scan memory, queue age, completion time, retry, and crash recovery are measured on a representative dataset.

Rollback disables the extension or the new worker and reruns the derived render queue. Canonical source is unchanged, so no content rollback is required.

## 9. Dependency alignment and downgrade policy

### Decision

**Never replace manifests or lockfiles to resemble Scarlett. Evaluate direct dependencies one at a time against current use. Do not downgrade a working dependency solely for parity.**

Current controls—frozen pnpm lock, pinned package manager/runtime, install-script allowlist, tracked patches, transitive security overrides, deterministic production license inventory, bundle budgets, and release SBOM/provenance—remain mandatory.

Each dependency change must state:

- current direct usage and reproduced problem or supported-version need;
- API/behavior difference being accepted;
- transitive/install-script/native-build/license change;
- client bundle or server startup/runtime impact;
- clean install, relevant typecheck/lint/test, production build, runtime smoke, and license/SBOM result;
- rollback version and any irreversible data/serialization change.

Before package splitting, reconcile manifest ranges with the exact-save policy, make the tracked/released license inventory reproducibly identical, and define an explicit allowed/denied/review-required license policy. Independent package manifests, if eventually introduced, still produce one aggregate product SBOM, license inventory, version, and revision.

## Cross-cutting execution roadmap

These architectural adaptations are independent workstreams. They must not block the already-unblocked content-extension goal unless a block directly needs one.

### Architecture A — prove boundaries

- publish the allowed import graph;
- remove transport/global reach-through;
- establish explicit shared/server/client exports and TypeScript references;
- run the package-boundary cutover experiment only after those facts are true.

### Architecture B — complete migration evidence

- add representative PostgreSQL Wiki.js 2.x and current-fork source artifacts;
- choose and test the PostgreSQL server-version floor;
- extend migration reports with source/build identity, invariant results, duration, lock time, and resource budgets;
- prove backup/restore, previous-image rollback, and the clean removal of unused database adapters.

### Architecture C — bounded persistence experiments

- measure and harden the direct page-index query;
- pilot a rebuildable projection if the measured budget requires it;
- compare Drizzle only within an isolated repository after the repository contract exists;
- remove the pilot if it does not meet promotion gates.

### Architecture D — extension lifecycle durability

- move registry-triggered rerenders to durable bounded jobs;
- add byte-preserving full lifecycle tests;
- add per-extension lazy browser modules only when required;
- consider Lit on one complex extension only after native comparison.

### Architecture E — dependency/release policy closure

- reconcile exact manifest policy;
- make generated and tracked license inventories identical;
- define license compatibility policy;
- preserve all existing reproducibility, PostgreSQL upgrade, multi-instance, Helm, SBOM, provenance, and artifact-identity gates through any layout change.

No architecture workstream is complete until obsolete code, manifests, routes, flags, and compatibility paths are removed in the same cutover.

## Completed goal: remaining visible Scarlett content extensions

The extension platform now implements the remaining visible capabilities as fork-native extensions without waiting for or importing Scarlett's repository, ORM, UI-framework, or custom-element architecture.

### Scope and order

1. **Static semantic group:** tabs, spoiler, and infobox.
   - accessible server HTML first;
   - keyboard tabs with static heading/section fallback;
   - spoiler disclosure using native semantics;
   - infobox as semantic definition/table content;
   - no remote runtime or persisted framework classes.
2. **Local asset group:** PDF and generic audio/video media.
   - same-origin authorized asset references;
   - MIME/size/range behavior;
   - accessible title, transcript/caption metadata, and direct download/open fallback;
   - print/export fallback link rather than an empty player.
3. **Remote media group:** YouTube and explicitly approved providers.
   - privacy-enhanced endpoint where available;
   - no request before deliberate consent or administrator policy;
   - CSP/provider allowlist, referrer policy, sandbox, title, and static link fallback;
   - no arbitrary iframe HTML in canonical props.
4. **Diagram group:** local diagram rendering first, then optional external Kroki/PlantUML-style providers.
   - local rendering preferred;
   - external egress requires administrator allowlist, SSRF-safe URL construction, time/size limits, content-type validation, bounded cache, secret-free errors, and deterministic source fallback.
5. **Map/external embed group.**
   - provider-specific typed envelopes, never arbitrary HTML/URL embeds;
   - consent before remote requests, precise CSP/sandbox/referrer policy, accessible label and link fallback;
   - static/print/export representation and offline behavior.

### Contract required for every extension

- add a discriminated, strict, bounded version-1 envelope to `shared/content-extensions.ts`;
- seed one disabled-by-default registry row through a new additive PostgreSQL migration; never rewrite `2.5.135` or `2.5.137`;
- register a sanitized server renderer with an accessible no-JavaScript fallback;
- add type-specific source and Visual Markdown editor configuration while preserving the exact canonical fence;
- authorize assets and page-derived resources at request time for the current principal;
- load browser behavior only on pages containing the enabled extension and abort it on page replacement;
- preserve source for disabled, unknown, incompatible, malformed, failed, unauthorized, offline, print, and export cases;
- expose clear administrator compatibility, network, privacy, and failure diagnostics;
- prohibit scripts, event-handler attributes, unsanitized `innerHTML`, remote SVG references, arbitrary styles, and arbitrary foreign content.

### Completion gate for every extension

The extension is not complete until edit, save, reopen in source and Visual Markdown, render, no-JavaScript fallback, keyboard, narrow/mobile, dark, reduced-motion/forced-colors where relevant, disable, re-enable, history, restore, export, print, unauthorized asset/resource, offline/remote-failure, migration, and rollback scenarios pass.

The full goal additionally requires:

- client and server typechecks, focused lint, focused contract tests, production build and bundle budgets;
- real browser authoring and rendering of every extension group;
- no serious/critical accessibility findings on exercised surfaces;
- no network request before policy/consent;
- PostgreSQL fresh-install and Wiki.js 2.x upgrade migration coverage; while unused adapters remain before the platform cutover, do not knowingly break the transitional matrix;
- documentation of provider/egress/CSP requirements;
- cleanup of all temporary pages, assets, credentials, settings, and registry state after smoke verification;
- one committed and pushed clean cutover with no placeholder extension.

### Completion record (2026-08-15)

- migration `2.5.138` adds the ten extension rows as an additive, disabled-by-default change in both primary and SQLite migration paths; fresh, repeat, downgrade, and prior-version upgrade contracts pass;
- strict version-1 envelopes cover tabs, spoiler, infobox, PDF, audio/video media, YouTube, Mermaid, Kroki, PlantUML, and OpenStreetMap; each rejects unknown properties, bounds every field, and preserves one canonical fenced representation;
- server renderers produce escaped semantic or inert fallback HTML and pass the shared sanitizer; same-origin asset paths preserve the existing authorization/range boundary, Mermaid SVG is locally sanitized, and remote providers are fixed typed targets with no request before consent;
- the shared source/Visual Markdown fence path, page history/restore, export, print, disable/re-enable rerender, compatibility diagnostics, and escaped-source failure behavior apply to the complete catalog without per-extension shadow state;
- 74 focused assertions, complete lint, client/server typechecks, the 1,406-test Vitest suite, production build, and all bundle budgets pass;
- the durable Chromium workflow authors and renders every extension group, exercises accessible controls and consent transitions with external requests aborted, verifies no pre-consent egress, repeats the surface at 390×844 under dark/reduced-motion/forced-colors preferences, and reports no serious or critical Axe violations;
- a separate live browser smoke rendered all ten new types on the actual page surface, confirmed local Mermaid output, inert remote fallbacks, zero active scripts, and no horizontal overflow; every temporary page, database, credential, configuration, and registry change was isolated and removed.

## Stop conditions

Stop and redesign an adaptation when evidence shows any of:

- source or migration history must be discarded;
- two packages/frameworks/ORMs remain authoritative for the same concern;
- an existing PostgreSQL / Wiki.js 2.x installation cannot upgrade without resetting or reimporting its database;
- authorization is cached or projected as user-neutral data;
- extension source must change merely to enable, disable, or replace a renderer;
- remote content loads without explicit policy and consent;
- rollback requires undocumented manual SQL or cannot boot the previous release;
- release artifacts no longer share one revision and dependency inventory.

These are design failures, not reasons to narrow tests or add compatibility shims.

## Verification record

The report’s revision and divergence facts were refreshed directly from `upstream/scarlett` on 2026-08-15. Decisions were checked against the current root manifest, database initializer and preflight, additive extension migrations, shared extension schema, renderer fail-closed path, index API, current CI/release contracts, the existing Scarlett synthesis roadmap, and the confirmed operator inventory of zero non-PostgreSQL installations.

No runtime implementation changes are made by this report. Its verification is evidence consistency: every accepted adaptation has prerequisites, observable promotion gates, rollback, and a clean rejection condition; every rejected upstream implementation has a stated superior fork-native target rather than an effort-based dismissal.

## Adaptation program completion record (2026-08-15)

The fork-native adaptation program is implemented through the release-candidate gates:

- architecture boundaries are machine-enforced, transport code no longer reaches the global runtime, TypeScript project references describe the supported surfaces, and the evidence did not justify a multi-manifest cutover;
- PostgreSQL 15–18 is the sole supported database target; retained Wiki.js 2.5.314 upgrades, exact Knex-ledger continuity, bounded migration resources, backup/restore, previous-image rollback, fresh install, multi-instance failover, expired-lease recovery, and rejoin behavior are exercised;
- durable extension rerenders, canonical byte-preserving extension lifecycle behavior, lazy browser modules, bounded page-index queries, measured page-index and runtime budgets, and the native-Vue-over-Lit decision are recorded and enforced;
- exact dependency versions, reproducible production-license inventory, license compatibility policy, OpenAPI v1 compatibility, aggregate release identity, placeholder rejection, responsive keyboard journeys, asynchronous states, and operator continuity are release gates;
- the current threat model records deterministic TFA/recovery and process-death lease proofs. External publication remains blocked by `SEC-EXT-001` until an independent reviewer retests a frozen revision; deployment-specific adapters remain operator-canary obligations under `SEC-ADAPTER-001`.

No Scarlett runtime tree, reset migration history, Quasar/Tailwind/Lit application shell, Drizzle authority, or second content source was imported. The useful upstream behavior was reimplemented against the fork’s existing policy, persistence, editor, Vue/Vuetify, and release contracts.

The frozen release candidate `2acb93b8c565f0d5fd0b5d5a21b38b90190b406a` passed the complete [Build + Publish matrix](https://github.com/PhilosophiMoonbeam/wiki/actions/runs/31916989321) on 2026-08-16: quality and production build gates; page-index benchmarks on PostgreSQL 15–18; retained Wiki.js 2 upgrades on PostgreSQL 15–18; PostgreSQL 15/18 multi-instance recovery; Helm install/upgrade/rollback; browser, accessibility, and runtime-performance journeys on PostgreSQL 15–18; AMD64 and ARM64 image publication; and Linux and Windows bundles. Preview and release publication remained correctly skipped because the revision was not tagged.
