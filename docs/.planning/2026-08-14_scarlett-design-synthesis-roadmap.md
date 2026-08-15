# Wiki.ts completion and Scarlett design-synthesis roadmap

Status: authoritative product roadmap

Last assessed: 2026-08-15T16:41:53Z

Assessed revisions:

- Wiki.ts code baseline: `1c6a8b9b3f316c3b469194dd4fad6e66082e8189`
- fork checkpoint `origin/scarlett`: `249758e3f923a77e1b62d26a47e142c312642a5f`
- upstream reference: `requarks/wiki:scarlett`
- upstream commit: `d0c5a8bfa90acee73a2f4c71033978bea1925468`
- upstream commit subject: `feat: add unlock aspect ratio option to block-gallery`
- upstream commit authored and committed: `2026-08-14T23:36:09-04:00`
- upstream fetch verification: `2026-08-15T16:41:53Z`; the remote still resolved to the recorded commit with zero commits of divergence
- common ancestor of the Wiki.ts code baseline and upstream Scarlett: `b5b4b0880ae26f4b137242267b6674b51af8688c` from 2022-04-03

This is a living plan. Update the revision ledger and candidate dispositions whenever upstream Scarlett moves. Never silently replace a disposition: record the new evidence and reason.

## Mission

Complete Wiki.ts as the strongest continuity path from Wiki.js 2: modern, secure, typed, operationally predictable, and safe for existing installations. Harvest worthwhile ideas from upstream Scarlett, finish useful upstream WIP, and improve the designs where Wiki.ts has stronger constraints or better foundations.

“Superior” is not measured by commit count or feature count. It means Wiki.ts provides:

1. a supported, tested upgrade path for real Wiki.js 2 data;
2. no known authorization bypasses or silent content-loss paths;
3. stable external APIs and explicit compatibility contracts;
4. PostgreSQL, MySQL/MariaDB, MSSQL, and SQLite support unless a feature is deliberately capability-gated;
5. a coherent Vue 3, Vuetify 4, Pinia, CKEditor, Vite, Express, TypeScript architecture;
6. end-to-end complete features rather than visible WIP;
7. observable background work, deterministic recovery, and safe multi-instance operation;
8. accessible, responsive authoring and administration;
9. release artifacts that can be reproduced, upgraded, rolled back, and operated without repository knowledge.

## Executive decision

Do not merge, rebase, or broadly cherry-pick Scarlett into Wiki.ts `main`.

The 73 commits between the fork checkpoint and assessed upstream Scarlett modify 521 files with 96,069 insertions and 27,147 deletions. Only seven of those paths exist on Wiki.ts `main`. A merge simulation reports conflicts throughout the server, client, database migrations, editors, build system, and deployment files.

Scarlett is a design mine and comparative implementation, not an integration branch.

Every harvest follows this sequence:

```text
upstream behavior and rationale
  -> Wiki.ts product contract
  -> current implementation and compatibility audit
  -> fork-native design
  -> focused behavioral tests
  -> implementation
  -> runtime smoke and migration proof
  -> documented upstream disposition
```

A source commit may inspire a change, but it never overrides Wiki.ts invariants.

## Product invariants

These are release-blocking constraints, not preferences.

### Data continuity

- Existing Wiki.js 2 installations must receive an explicit, tested upgrade path.
- No release may reset migration history or require a fresh database without an export/import migration tool that preserves all supported data.
- Upgrade tests must use representative pre-upgrade databases, not only schemas assembled by test fixtures.
- Destructive schema changes require a reversible migration or a documented backup/restore boundary tested in CI.
- Private-page ownership, page history ownership, assets, navigation, permissions, and editor metadata must survive upgrades.

Scarlett commits `6db53d4f` and `99ccdc13` deliberately reset migrations and reject Wiki.js 2 databases. Their protective detection idea is useful, but their product decision is incompatible with Wiki.ts.

### Authorization

- Authorization lives in centralized policy/domain code, never only in UI visibility or transport handlers.
- Page, source, history, asset, search, tree, navigation, watch, collaboration, export, and render access must share the same effective-page policy.
- Unauthorized callers must not infer private resource existence through status, timing, count, owner label, search result, path collision, or asset response differences.
- `manage:system` bypass behavior must be explicit and tested.
- Every externally reachable mutation has a named permission contract and negative tests.

### Canonical content

- Each page has one canonical source representation.
- Visual Markdown stores Markdown and renders through the server Markdown pipeline.
- Visual HTML stores HTML. Source editors keep their current canonical formats.
- Editor switching never creates an untracked second source of truth.
- Unsupported syntax is blocked before lossy editor conversion; it is not silently normalized away.
- Extension content has a versioned, documented serialization that remains editable when a renderer is disabled or unavailable.

### Database portability

- Core features use Knex/Objection-compatible primitives across supported databases.
- PostgreSQL-specific optimizations may exist behind a capability interface with a correct portable implementation.
- A feature cannot claim completion while silently disabling itself on a supported database.
- Migrations and integration tests cover dialect differences in constraints, JSON storage, transactions, locking, indexes, and timestamp behavior.

### API stability

- Domain operations are transport-independent.
- REST is the preferred external API. Remaining GraphQL compatibility surfaces call the same domain operations until deliberately removed.
- Routes have machine-readable schemas, consistent errors, authorization metadata, pagination conventions, and idempotency rules where applicable.
- Internal UI calls and external API-key calls share behavior but may use separate authentication adapters.
- Public API removal requires a versioned migration path, not an unannounced route deletion.

### Complete features only

A feature is not complete when its page renders. It is complete when authorization, persistence, migrations, failure recovery, accessibility, responsive behavior, observability, tests, documentation, and upgrade behavior all meet the feature contract.

No `WIP`, placeholder response, fake fallback, disabled save action, or unimplemented control ships in a release build.

## Architecture synthesis

Retain Wiki.ts foundations and incorporate Scarlett’s best separation ideas without changing frameworks merely for novelty.

```text
Vue 3 + Vuetify 4 + Pinia + CKEditor / source editors
                         |
                  typed REST clients
                         |
Express transport -> schema validation -> domain operations -> policy engine
  GraphQL compatibility -----------^             |
                                                   +-> Knex/Objection repositories
                                                   +-> durable job scheduler
                                                   +-> transactional event/outbox
                                                   +-> storage/search/auth modules
```

### Transport layer

Use `server/controllers/api/` for REST transport. Handlers perform authentication adaptation, schema validation, HTTP serialization, and nothing else. Continue removing duplicated GraphQL business logic by routing both transports through `server/operations/`.

Harvest from Scarlett:

- domain-grouped schemas and routes from `6f492f00`;
- route-local permission and rate-limit metadata;
- consistent OpenAPI generation;
- centralized structured API errors.

Improve on Scarlett:

- preserve a versioned external contract;
- generate or validate the client types consumed by the Vue application;
- keep one domain implementation across REST and GraphQL compatibility;
- add contract tests and API-key parity tests.

Do not port Fastify merely to obtain schemas. Express can expose the same contract with less migration risk.

### Domain operations

`server/operations/` is the stable seam for pages, users, groups, auth, system, navigation, storage, and future workflows. Operations:

- accept typed values and an explicit principal/context;
- enforce policy before repository work;
- own transaction boundaries;
- return domain results or typed application errors;
- do not depend on Express request/response objects;
- emit durable domain events only after the write can commit.

This layer allows Scarlett ideas to be reimplemented once and exposed safely through current and future transports.

### Policy engine

Extract page-rule evaluation and resource access into pure, typed functions with exhaustive tests. Keep global permission checks and page-scoped rule resolution distinct. Private-page ownership is an additional visibility constraint, not another group rule.

Scarlett commits `db99e3d6` and `1105cf4b` supply useful policy clarity: deny-by-default page rules, deterministic specificity, explicit tag matching, and a single effective policy passed through page bootstrap. Wiki.ts must first characterize its installed semantics before choosing changes such as `TAGALL` or force-allow.

Target design:

```ts
type PolicyDecision = {
  allowed: boolean
  reason: string
  decidingRuleId?: string
}

resolveGlobalPermission(principal, permission): PolicyDecision
resolvePagePermission(principal, permission, pageRef): PolicyDecision
canDiscoverPage(principal, pageRef): PolicyDecision
canReadPage(principal, pageRef): PolicyDecision
canWritePage(principal, pageRef): PolicyDecision
```

Production responses expose no sensitive reason. Tests and optional administrator diagnostics may use it.

### Persistence and migrations

Keep Knex/Objection while repositories are gradually typed. Do not adopt Drizzle as a prerequisite for product features. If a later ORM decision is justified, prove it through one bounded repository and migration compatibility study.

Add a migration verifier that:

- recognizes the source Wiki.js/Wiki.ts schema version;
- refuses unknown or newer schemas before writing;
- checks backup prerequisites for destructive migrations;
- records migration application and product build identity;
- detects partial prior migrations;
- validates post-migration invariants;
- produces actionable recovery output.

This keeps Scarlett’s “never mutate an unknown legacy database” safety insight while delivering the upgrade path Scarlett lacks.

### Durable jobs and events

Adapt Scarlett scheduler work from `c1d7eef3` and `23dbb272`, but design for all supported databases.

Required primitives:

- durable job row with type, versioned payload, state, attempts, next-run time, lease owner, lease expiry, and last error;
- short database leases rather than long-held connections;
- idempotent handlers;
- bounded retry with explicit terminal failure;
- graceful drain on shutdown;
- administrator visibility and retry/cancel controls;
- transactional outbox for events caused by committed writes;
- multi-instance claiming without duplicate execution.

Initial worker candidates: webhook dispatch, page watching notifications, page rendering, search indexing, storage sync, exports, and cleanup.

### Editor and extension model

Keep CKEditor Visual Markdown, Visual HTML, and source editors. Use Scarlett’s MDC/block work as a catalog of capabilities, not as a serialization dependency.

Define a Wiki.ts content-extension contract before adding PDF, YouTube, gallery, index, map, QR, tabs, or diagram blocks:

- stable extension key and schema version;
- canonical Markdown or HTML representation;
- editor form schema;
- server renderer;
- sanitization policy;
- CSP/network policy;
- print/export fallback;
- disabled-extension behavior that preserves source;
- migration hook for schema evolution;
- accessible static fallback.

Prefer standard Markdown/HTML when it round-trips cleanly. Use a fenced, versioned directive only when no interoperable representation exists.

## Upstream candidate disposition

The disposition is against assessed upstream Scarlett. Re-evaluate when source behavior changes.

| Scarlett source | Idea | Wiki.ts disposition | Dependency / reason |
| --- | --- | --- | --- |
| `6f492f00` | split API schemas | Adapt early | Fits typed REST/OpenAPI program; do not copy Fastify registration |
| `ee7a15fb` | backend TypeScript migration | Already directionally achieved | Continue strict typing incrementally; no directory/framework rewrite |
| `937cecea` | custom Tailwind UI library | Reject architecture | Wiki.ts has Vue 3/Vuetify 4; use only UX observations; source is WIP |
| `064e378b`, `cffa39c1`, `4677a7c5`, `9de9b84b` | UI and dark-mode fixes | Compare behavior | Port only reproducible defects against Vuetify surfaces |
| `c10e988c` | password-protected pages | Redesign and implement | Must compose with owner-private pages, assets, history, search, API, and sessions |
| `9408accc` | link/code/table/emoji dialogs | Adapt selectively | CKEditor/source-editor-native dialogs; preserve canonical Markdown |
| `3d13e50b`, `072e1dcc` | prebuilt/MDC blocks | Replace with Wiki.ts extension contract | Scarlett serialization is editor/renderer-specific |
| `957efebe`, `c36eab67` | profile auth, approvals, inbox | Finish natively | Upstream WIP; depends on policy, jobs/events, notification model |
| `c9bd96a5`, `4ec69a75` | page-history overlay | Adapt | Reuse current history operations; include private ownership and mobile behavior |
| `db99e3d6`, `1105cf4b` | permission hardening | Security workstream | Characterize current semantics first; centralize and test every resource projection |
| `17d7b810` | Yjs live collaboration | Implement after policy/jobs/editor gates | Requires room auth, persistence, recovery, history integration, and multi-instance transport |
| `14e1efae` | page watching | Finish natively | Upstream WIP; depends on outbox/jobs and visibility rules |
| `14e1efae` | endpoint rate limiting | Adapt immediately in bounded slices | Existing limiter remains; correct `429`, `Retry-After`, proxy identity, route coverage |
| `ff4a5bc6` | OAuth modules | Compare provider-by-provider | Preserve broad current provider support; share auth contracts and tests |
| `1c6e71ee` | render-pages job | Adapt to durable jobs | Do not expose an unbounded render queue |
| `c1d7eef3`, `23dbb272` | scheduler connections and webhook jobs | Adapt architecture | Build portable leasing/outbox, not Scarlett’s implementation |
| `c00b7007` | disabled block stripping/warning | Improve design | Never strip canonical source; disable rendering with visible editor/admin diagnostics |
| `5021b31a`, `29d81640`, `1aefb34d`, `9a1ca3b1`, `c182d2c9` | blocks and media | Implement after extension contract | Deliver PDF/YouTube/gallery/index as independent complete extensions |
| `7f53b60d`, `21fac3a9`, `6bffff10`, `5a3be5c1`, `817302d6`, `ce530a40`, `ad861ae3` | Markdown editing improvements | Adapt by observable contract | Round-trip and unsupported-syntax safety precede toolbar breadth |
| `45d2287a` | asset rendering | Compare security and behavior | Must use central asset/page policy and storage abstraction |
| `81fc8db4` | dashboard and group permission fixes | Split | Permission correctness first; dashboard behavior later |
| `8e6a35de` | page redirection | Mostly existing | Audit redirect loops, authorization, private targets, status choice, and editor parity |
| `6db53d4f` | migration reset | Reject | Violates data continuity |
| `4c6d5c40` | parser-limit format | Verify current configuration | Port only if a current reproduction exists |
| `1cdbaf83` | serve compiled SPA from backend | Already architectural direction | Retain production build smoke and immutable asset caching checks |
| `99ccdc13` | legacy DB guard | Synthesize | Detect unknown/legacy state safely, then run a supported migration instead of exiting permanently |
| `57cda516`, `527b8e9f` | mobile layouts | Compare and exceed | Use browser matrix and WCAG criteria against current responsive redesign |
| `2acd026c`, `634f4b05` | navigation parent controls | Adapt | Bounded Vue/API feature after navigation contract tests |
| `5fa9bf3f` | page at folder path | Already appears correct | Current exact page-path collision differs from virtual folders; add regression proof |
| `09e9166b` | utilities and JWK removal | Split | Adapt useful utilities; retain versioned JWK endpoints until external contract migration exists |
| `0c62c97e` | page-content shadow classes | Do not port as feature | Styling token only if required by a Wiki.ts design system |
| `0376d788`, `8b0a5e37`, `dd37744e` | Docker/CI fixes | Compare outputs, not patches | Runtimes/build contexts differ; keep reproducible multi-arch release gates |
| dependency updates | package modernization | Compare package-by-package | Wiki.ts is already newer in several areas; never downgrade to match Scarlett |

## Ordered action program

Ordering is dependency-driven. Later waves may be designed in parallel, but they cannot ship before their gates.

### Wave 0 — product ledger and upstream intake

Purpose: make synthesis repeatable rather than a one-time archaeology exercise.

Actions:

1. Add a machine-readable upstream ledger derived from this document or a tracked issue set with source branch, source hash, category, disposition, target contract, and last review date.
2. Add a periodic comparison command or CI report that fetches `upstream/scarlett`, records new commits, changed top-level areas, dependency deltas, migrations, WIP markers, and test additions/removals.
3. Establish labels or milestones for `security`, `data-continuity`, `api-contract`, `operations`, `workflow`, `editor`, `extension`, `ux`, and `release`.
4. Promote a candidate to implementation only after the target behavior, non-goals, migration impact, and verification are written.
5. Keep `origin/scarlett` as a historical fork checkpoint. Never force-update it to imply compatibility.

Exit gate:

- a new upstream commit can be triaged without rereading branch history;
- every accepted candidate maps to one Wiki.ts workstream and owner-visible acceptance contract;
- rejected/deferred candidates retain their rationale.

### Wave 1 — security and correctness convergence

This is the first implementation wave.

#### 1A. Permission policy contract

Targets:

- `server/core/auth.ts`
- `server/helpers/page-access.ts`
- `server/operations/pages.ts`
- resource controllers and operations for assets, search, navigation, history, source, tree, and exports
- focused tests under `server/test/core/`, `server/test/helpers/`, and operation/controller suites

Actions:

1. Characterize existing global and page-rule precedence, including all group combinations.
2. Add a resource-access matrix for public pages, owner-private pages, administrator-owned private pages, anonymous users, API principals, and users with overlapping groups.
3. Make invalid regex rules non-fatal and non-matching; expose an administrator validation error when saving them.
4. Decide and document whether deeper rules override broader denies and whether force-allow is a supported concept.
5. Extract a pure deterministic evaluator only after tests pin intended compatibility.
6. Route every page-derived resource through shared decisions.
7. Add non-disclosure tests for private paths, counts, collisions, search, tree, assets, and history.

Exit gate:

- the policy matrix is executable;
- no controller invents its own private-page or group-rule interpretation;
- every deny path is tested with an authenticated but unauthorized principal;
- compatibility changes, if any, include migration/admin communication.

#### 1B. Authentication and expensive-endpoint rate limits

Actions:

1. Change limited responses from `401` to `429` and include standards-compliant `Retry-After`.
2. Define trusted-proxy configuration and test client identity behind zero, one, and multiple proxies.
3. Inventory login, TFA, recovery, password change, registration, page unlock, API token, render, export, search rebuild, and upload endpoints.
4. Apply limits according to threat/cost rather than uniformly.
5. Retain durable counters across instances; add bounded cleanup and administrator observability.
6. Decide whether HTML and API login attempts share a counter; document the anti-bypass result.
7. Ensure successful authentication reset behavior cannot be abused to erase another principal’s counter.

Exit gate:

- protected routes return deterministic `429` responses;
- proxy behavior is configuration-tested;
- two application instances observe the same limits;
- legitimate lockout recovery is documented and operable.

#### 1C. Path and migration invariants

Actions:

- prove page creation at a virtual folder path;
- prove public/private namespaces and owner namespaces handle collisions correctly;
- prove move, locale change, ownership transfer, history, search, links, and navigation update atomically;
- add preflight migration source detection and partial-migration checks;
- retain representative database artifacts for upgrade tests.

Exit gate: collision and upgrade failures occur before destructive writes and report actionable errors.

### Wave 2 — operational core and API finish

#### 2A. Versioned REST/OpenAPI contract

Actions:

1. Inventory every UI REST call and remaining GraphQL operation.
2. Define shared pagination, filtering, sorting, error, and date/time representations.
3. Add route schemas and generated OpenAPI for the supported external subset.
4. Validate response payloads in development/tests, not only request bodies.
5. Add API-key and browser-session parity tests where both are supported.
6. Complete operation consolidation before removing each GraphQL path.
7. Publish compatibility and deprecation policy before the first stable release.

Exit gate:

- OpenAPI describes every supported external route;
- generated examples pass contract tests;
- internal clients compile against the same schemas;
- there is no duplicated mutation logic between transports.

#### 2B. Durable scheduler, workers, and outbox

Implementation order:

1. characterize current scheduler and webhook behavior;
2. introduce portable job schema and lease algorithm;
3. implement one idempotent cleanup job as proof;
4. move webhooks with delivery idempotency and signed request tests;
5. move page rendering and search/storage fan-out;
6. add transactional outbox for page/user/group events;
7. expose administrator job state, retry, cancel, and dead-letter details;
8. exercise multi-instance claims and shutdown drain.

Exit gate:

- killing a worker at each transition loses no committed work and causes no duplicate external effect;
- leases recover after process death;
- webhook attempts are observable and safely retryable;
- the database pool returns to baseline after job bursts.

#### 2C. Administrative completion

Finish system utilities, dashboard summaries, connected-instance visibility, update checks, migrations, export/import, cache, auth, content, search, storage, telemetry, and terminal surfaces through the shared operations layer.

The administrator terminal must be command allowlist/RPC based; never expose an arbitrary host shell through the browser.

Exit gate: every visible action has permission checks, progress, cancellation semantics where possible, final state, and a failure recovery path.

### Wave 3 — workflow and protected-content features

#### 3A. Page watching and notifications

Contract:

- users may watch only pages they can discover and read;
- a watch does not preserve access after permission loss;
- private watches are visible only to the owner and authorized administrators;
- create/update/move/rename/delete/restore/ownership changes have defined notification behavior;
- deduplication groups rapid edits without dropping the final state;
- notification delivery is asynchronous and idempotent;
- email and in-app channels are independently configurable;
- deletion and account removal clean watches portably.

Use transactional page events and durable jobs. Do not send email inside the page transaction.

Exit gate: page changes, permission loss, move, delete, retry, and multi-instance delivery scenarios pass.

Completion evidence (2026-08-15):

- page watches are self-scoped, read-authorized, and removed when delivery detects lost access;
- create events have no page-watch recipients because a page cannot be watched before it exists; update, restore, move, visibility, ownership, and delete mutations write transactional page events;
- two-minute update windows retain the latest event and current page state while producing one durable notification job;
- email and in-app channels are independently configurable per watch, with a page toolbar inbox and unread state;
- delete fan-out snapshots channel choices before removing subscriptions, while user deletion cascades watches, deliveries, and inbox rows;
- focused SQLite contracts cover transactional fan-out, aggregation, idempotent delivery, channel independence, permission loss, migration, and existing page-mutation behavior; browser smoke covers watch, settings, and inbox rendering.

#### 3B. Approvals and inbox

Finish Scarlett’s WIP as a native workflow state machine:

```text
draft -> submitted -> approved -> published
                   -> changes-requested -> draft
                   -> rejected
                   -> cancelled
```

Define role/rule eligibility, immutable review history, stale-revision handling, comments, notification events, reassignment, administrator override, and page-history integration. Approval decisions must bind to a specific content revision; approving an older revision never publishes newer unreviewed content.

Exit gate: every transition is authorized, atomic, audited, recoverable, and accessible from desktop/mobile inbox views.

Completion evidence (2026-08-15):

- requests bind to immutable page-history revision IDs and the page update timestamp captured at submission or resubmission;
- role/rule-aware reviewers, optional assignment, administrator override, reassignment, submitter cancellation, required decision comments, and immutable transition rows authorize and audit every state change;
- stale submitted or approved revisions return a conflict and cannot be approved or published; publication changes the page and records its approval transition and page event in one transaction;
- active participant/reviewer inbox queries and a responsive page dialog expose submission, decisions, comments, history, reassignment, and terminal recovery on desktop and mobile;
- focused SQLite contracts cover every transition family, assignment boundaries, stale revisions, exact publication, outbox events, search refresh, and migration integrity; browser smoke completed submit, approve, publish, inbox cleanup, and full-screen mobile rendering.

#### 3C. Password-protected pages

Design password protection as an access layer for otherwise discoverable pages, separate from owner-private visibility.

Required decisions:

- password hash parameters and rotation;
- session-scoped unlock grants with expiry and revocation;
- whether group-authorized readers bypass the password;
- source/history/assets/download/API/search/tree behavior;
- rate limiting and non-disclosure;
- cache keys and CDN behavior;
- administrator recovery;
- export/import representation.

Never store page passwords reversibly. Never place unlock grants in URLs. Never render protected content into a shared cache entry.

Decisions (2026-08-15):

- store bcrypt cost-12 hashes only; every replacement increments a password version and atomically revokes every older grant;
- grant unlocks for 12 hours to the exact server-side session and authenticated identity (or anonymous identity), never to a URL or browser-readable token;
- ordinary group-authorized readers still require the password; `manage:system` administrators bypass it for recovery, while owner-private authorization runs before the password layer;
- keep titles, descriptions, navigation, and tree placement discoverable; omit protected body matches and suggestions from search, and gate current content, source, history, revision restore, downloads, linked assets, REST operations, and GraphQL page reads/mutations;
- use the durable database-backed authentication limiter with generic failures and progressive retry delays; incorrect, missing, and unauthorized-private unlock attempts return the same denial;
- send `Cache-Control: private, no-store`, `Pragma: no-cache`, and `Vary: Cookie` on locked/unlocked protected HTML responses; linked assets return a non-disclosing 404 until the same session is unlocked;
- exclude passwords, hashes, and grants from export/import. Content exports remain content-only, and imported pages start unprotected until an authorized writer sets a new password.

Completion evidence (2026-08-15):

- migration `2.5.134` adds password, expiring grant, and protected-asset linkage tables with cascading deletion and SQLite restart coverage;
- focused contracts verify cost, rotation/revocation, session and identity isolation, expiry, administrator recovery, owner-private non-disclosure, asset gating, search redaction, and restoration of indexing after removal;
- browser smoke enabled protection from the page toolbar, rendered the anonymous unlock surface with `private, no-store`, rejected a wrong password without creating a cookie, persisted a correct anonymous unlock in `connect.sid`, restored the page, and removed protection through the management dialog;
- server and client typechecks pass; the protection, search, migration-preflight, GraphQL parity/schema, page metadata, private-page, and Visual Markdown regression contracts pass.

Exit gate: direct asset/source/API requests cannot bypass unlock; rotation revokes prior grants; brute-force limits and private-page composition pass.

#### 3D. Page history experience

Adapt Scarlett’s completed overlay concepts to current history operations. Include diff, restore, source download, revision metadata, owner-private authorization, optimistic conflict behavior, keyboard navigation, and narrow-screen usability.

Exit gate: viewing and restoring a revision preserves canonical content/editor metadata and creates the expected new history entry.

Decisions (2026-08-15):

- keep history fork-native and REST-backed; retain the existing vertical timeline and diff engine while adding Scarlett’s revision metadata, source/download/restore/branch action model, responsive controls, and pointer/keyboard selection;
- treat a revision as immutable canonical content: history snapshots now bind content, content type, editor key, title, description, locale/path/visibility metadata, and the page’s tag relation at snapshot time;
- restore only canonical authoring content and metadata (`content`, `contentType`, `title`, `description`, `editor`, and `tags`); preserve the page’s current path, locale, visibility, ownership, and publication boundary;
- require the page timestamp observed when history opens and enforce it again in the page update transaction; stale restores return HTTP 409 before mutation, while a race at the compare-and-swap patch rolls back the snapshot and tag changes.

Completion evidence (2026-08-15):

- history REST and model contracts cover complete revision payload validation, immutable tag snapshots, private-revision scoping, canonical restore fields, controller timestamp validation, and both early and transactional stale-write guards (116 focused assertions);
- server/client typechecks and targeted lint pass across the history UI, REST boundary, operations, page/history models, and tests;
- browser smoke selected revisions by pointer and keyboard, rendered an adjacent revision diff with editor/content-type metadata, exposed source/download/restore/branch actions, restored revision 6 from Markdown to Visual Markdown, and observed the new `restored` history row;
- a second browser request replayed the pre-restore timestamp, received HTTP 409, and confirmed that the restored editor and update timestamp were unchanged; the smoke database and credential state were restored afterward.

### Wave 4 — authoring and extension platform

#### 4A. Visual Markdown depth

Build on the existing Visual Markdown contract in `docs/.planning/2026-08-14_visual-markdown-ckeditor-plan.md`.

Ordered additions:

1. table-cell/row/column editing with round-trip fixtures;
2. custom admonition titles with a canonical syntax;
3. icon and emoji insertion without remote runtime dependencies;
4. footnotes, math, diagrams, and tabs only after each has a lossless representation;
5. an explicit source fallback for unsupported constructs;
6. document capability reporting so the UI explains why a page cannot open visually.

No toolbar button lands before its parse/edit/serialize/render/history cycle is tested.

Decisions (2026-08-15):

- keep CKEditor’s built-in table model limited to rectangular GFM tables: expose row/column operations, omit merge and split commands, and prove Markdown round-trips after structural edits;
- represent titled admonitions as blockquotes whose first paragraph is `**TYPE: title**`; accept `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and `CAUTION`, map them onto the existing callout classes, and remove only the structural marker before rendering;
- ship a small local Unicode glyph palette instead of remote icon lookup or runtime dependencies;
- inspect every Visual Markdown document before CKEditor starts; report every unsupported construct and open the existing source editor with the original bytes intact when any are present.

Completion evidence (2026-08-15):

- shared capability inspection and source-fallback contracts cover all three existing unsupported constructs plus fenced-code suppression and multiple-issue reporting;
- CKEditor contracts cover row and column editing, merge-command exclusion, titled-admonition insert/reopen/render, and local glyph insertion (25 focused assertions across the shared inspector, CKEditor, and page model);
- server and client typechecks and targeted lint pass;
- browser smoke inserted a titled admonition, a local rocket glyph, and a 2×2 editable table, saved them, and rendered the expected styled callout, local glyph image, and GFM table;
- browser fallback smoke opened Markdown source without mutation for a page containing math and a footnote and displayed the first line-specific diagnostic plus the additional-issue count; the smoke page and credential were restored afterward.


#### 4B. Extension SDK

Deliver the extension contract, registry, schema validation, editor dialog host, server renderer host, sanitizer boundary, and compatibility/version diagnostics before the first rich block.

First extensions, in increasing risk:

1. QR code — deterministic, no remote network;
2. PDF viewer — asset policy and accessible download fallback;
3. YouTube/media — CSP, privacy-enhanced mode, consent, and print fallback;
4. gallery — asset authorization, responsive images, captions, keyboard navigation;
5. index — policy-filtered tree/query behavior;
6. tabs/spoiler/infobox — accessible static HTML and Markdown/source preservation;
7. diagrams/maps/external embeds — explicit egress and sanitization policies.

Exit gate for each extension: edit, save, reopen, render, disable, re-enable, history, export, print, unauthorized asset, and migration scenarios pass.

Decisions (2026-08-15):

- version the host and every extension independently; persist extension state as `key`, `isEnabled`, `version`, `updatedAt`, and `updatedBy`, with new extensions disabled until a `manage:system` administrator enables them;
- preserve extensions as canonical single-line JSON in a fenced `wiki-extension` block so source, Visual Markdown, history, export, and print share one durable representation;
- reject unknown envelope and property fields at the shared boundary; render only canonical, enabled, compatible, exact-version envelopes and leave all malformed, disabled, incompatible, unknown, or failed extensions as escaped source;
- rerender and invalidate every page containing a toggled extension only after the registry update commits; report compatibility and disable diagnostics through the internal REST API and editor dialog;
- treat renderer output as hostile even for bundled extensions: sanitize locally with an explicit element/attribute/protocol boundary and prohibit scripts, event handlers, style, remote SVG references, and active foreign content;
- ship QR as the proof extension using local deterministic generation only, an accessible SVG title/label, and a safe text-or-link fallback. It has no asset authorization or external egress surface.
- adapt Scarlett gallery and index concepts only through the shared fork-native contract: gallery accepts bounded same-origin image assets and keeps direct links as no-script/print fallbacks; index resolves at request time through the existing page policy engine rather than storing or rendering a stale privileged page list;
- treat responsive and accessibility behavior as part of the extension contract: gallery preserves natural aspect ratios when requested, exposes captions and keyboard lightbox navigation, and restores focus; index collapses columns at narrow widths, has deterministic empty/failure states, and never renders server values through `innerHTML`.

Completion evidence (2026-08-15):

- migration `2.5.135` creates the audited, disabled-by-default registry across primary and SQLite migration paths and passes fresh/idempotent migration contracts;
- shared schema, canonical serialization, compatibility, API boundary, authorization, toggle/rerender, sanitizer, QR renderer, Markdown fallback, source insertion, Visual Markdown insertion/reopen, and migration-preflight contracts pass (64 focused assertions);
- server and client typechecks pass, and targeted lint covers the shared contract, both editor hosts, API, registry, migrations, renderer, and tests;
- browser smoke showed the disabled diagnostic, rejected an anonymous toggle with 403, enabled QR as an administrator, inserted the exact canonical fence, saved and rendered a local accessible QR SVG, then disabled it and observed immediate escaped-source fallback after page rerender;
- migration `2.5.137` adds the disabled-by-default `gallery` and `index` registry rows without rewriting the original registry migration and rolls back only those additions;
- the shared discriminated envelope now validates bounded gallery assets/captions/layout and bounded index path/locale/depth/order/limit controls; renderer tests cover responsive gallery HTML, escaped values, dynamic index placeholders, and fail-closed fallback;
- the internal index endpoint parses only canonical bounded controls, applies database path/depth/locale constraints before its 5,001-row overfetch ceiling, then applies visibility, ownership, tags, and page-rule policy before ordering and the caller-visible limit; anonymous, owner, system-manager, and over-limit contracts pass;
- browser hydration uses text/attribute DOM construction only, preserves gallery links without JavaScript, adds keyboard/native-dialog navigation when available, uses private no-store index responses, and aborts in-flight work during page replacement;
- the editor host now configures all three bundled extensions through type-specific fields and emits the same canonical fence format; the release E2E suite covers admin enablement, authored gallery insertion, render, dynamic index hydration, lightbox navigation, and focus restoration.
- PostgreSQL first-run setup restores the bundled registry rows after its intentional user/group `TRUNCATE ... CASCADE`; the complete PostgreSQL setup and post-install browser workflow passes (24/24).
- the smoke page, administrator credential, and disabled registry state were restored after verification.

#### 4C. Live collaboration

Use Yjs only after policy, durable jobs/events, and editor canonical-content boundaries are stable.

Design requirements:

- room identity includes page identity and canonical format;
- room admission rechecks current page write permission;
- permission/ownership changes evict unauthorized participants;
- updates persist durably and compact safely;
- final page saves create coherent history revisions;
- offline edits and reconnect conflicts have explicit UX;
- multi-instance WebSocket routing works without sticky-session correctness dependence;
- awareness data is ephemeral and privacy-bounded;
- collaboration can be disabled without making pages uneditable;
- protocol and persisted update versions have migrations.

Start with Markdown source collaboration or one proven editor binding, not every editor simultaneously.

Exit gate: two users, reconnect, concurrent edit, process loss, permission revocation, page move, history restore, and multi-instance scenarios pass without data loss.

Completion evidence (2026-08-15):

- protocol/update version `1` and migration `2.5.136` persist page-id/Markdown rooms with optimistic revisions, bounded updates, safe compaction, and cascade cleanup across primary and SQLite migration paths;
- the REST bootstrap issues five-minute RS256 room tokens only after current write-policy evaluation; the same-origin WebSocket admission and every update recheck the current page, user, format, feature flag, and canonical base revision;
- the Markdown source editor now exposes participant, connecting, offline, and stopped states; local Yjs updates remain queued until server acknowledgement, replay after process loss, and remain editable after a permission, page, format, move, restore, or protocol conflict;
- focused protocol, independent-store CAS, cross-instance durable fanout, reconnect acknowledgement, REST, lifecycle, deletion-transaction, and editor tests pass (90 assertions), together with server/client typechecks and targeted lint;
- browser smoke proved two authenticated users converging concurrent edits, a coherent save followed by continued peer editing, server loss/reconnect with the complete offline edit replayed to the peer, live permission revocation with local text preserved, and immediate stopped states for format change, page deletion, page move, and history restore;
- the multi-instance test writes through an independent room store, emits the production database-bridge inbound event, and observes the connected instance receive the durable state without session affinity; the smoke database, page path/format/content, credentials, and processes were restored after verification.


### Wave 5 — navigation, responsive UX, and accessibility

Actions:

- add expand-parent-by-default and edit-parent-from-child navigation controls;
- complete mobile/tablet admin and editor layouts using the fork’s Vuetify system;
- standardize loading, empty, error, destructive-confirmation, and unsaved-change states;
- audit dark mode and forced-colors behavior;
- make editor dialogs, history, inbox, file manager, tables, and navigation keyboard-complete;
- establish WCAG 2.2 AA checks for core journeys;
- measure layout shift and interaction latency on representative content/admin pages;
- retain screenshots or browser assertions for critical responsive breakpoints.

Core browser journeys:

1. setup and first administrator;
2. login/TFA/recovery;
3. browse/search/navigation;
4. create/edit/preview/save/conflict/history/restore;
5. private and password-protected access;
6. assets and file manager;
7. users/groups/permissions;
8. storage/search/auth module configuration;
9. watching/inbox/approval;
10. mobile authoring and administration.

Exit gate: journeys pass at narrow phone, tablet, standard desktop, and wide desktop sizes with keyboard-only operation for primary actions.

### Wave 6 — release completion

#### Alpha completion

- Wave 1 security contracts complete;
- no known private-resource disclosure;
- upgrade canary and rollback procedure proven on supported databases;
- current editor and admin critical journeys pass;
- API errors and product identity are stable enough for field testing.

#### Beta entry

- durable jobs/outbox operational;
- REST/OpenAPI supported surface documented;
- watching, approvals, password protection, or collaboration ship only if their full gates pass;
- extension platform ships before rich block breadth;
- installation, upgrade, backup, restore, and external API documentation are current;
- accessibility audit has no critical blockers.

#### Release candidate

- no tracked WIP or placeholder production behavior;
- all supported database upgrade matrices pass from the declared minimum source versions;
- clean-install, upgrade, backup/restore, multi-instance, worker recovery, and Docker/Helm smoke pass;
- dependency and license inventory is reproducible;
- threat model and external security review findings are resolved or explicitly release-blocking;
- performance budgets pass on representative datasets;
- translations fall back safely with no raw keys in core journeys.

#### Wiki.ts 1.0

1. Upgrade continuity is documented and verified.
2. Stable API and deprecation policies are published.
3. Security, data integrity, accessibility, and operational gates are green.
4. Every advertised feature has an end-to-end contract and recovery path.
5. Release source, containers, checksums/provenance, migration notes, and rollback instructions correspond to the same revision.
6. Preview branding changes only through an explicit product release decision.

## Cross-cutting verification standard

Use the narrowest proof that exercises the changed behavior, then run the applicable project gates.

| Change class | Required focused proof | Broader gate |
| --- | --- | --- |
| authorization | positive, negative, non-disclosure, overlapping-policy tests | server typecheck, relevant integration suites |
| migration | real before/after database artifact and invariant query | each supported dialect; backup/restore smoke |
| REST/API | request/response schema, auth modes, error, pagination tests | OpenAPI validation, server typecheck |
| job/event | idempotency, process-death, retry, lease-expiry scenario | multi-instance smoke and pool observation |
| editor | parse/edit/serialize/render/history round trip | client typecheck, build, browser journey |
| UI | actual browser interaction at target breakpoints | accessibility and console/network checks |
| extension | edit-through-render plus disabled/migration behavior | CSP/sanitizer and export/print checks |
| dependency | direct usage behavior and clean install | typechecks, lint, tests, build as affected |
| release | clean install, upgrade, runtime journey | container/Helm and provenance checks |

A source-text assertion is not behavioral proof. A build is not runtime proof. A happy-path UI screenshot is not authorization proof.

## Performance and reliability budgets

Establish measured baselines before setting final numeric thresholds. Once recorded, regressions require an explicit decision.

Track at minimum:

- server start and readiness time;
- page browse response percentiles for cached and uncached pages;
- search response percentiles on representative indexes;
- editor initial load and save latency;
- database pool usage at idle and under job/API bursts;
- job queue age, attempts, terminal failures, and recovery time;
- client bundle sizes by entry point;
- Core Web Vitals for browse, editor, and admin dashboard;
- memory after repeated browse/edit/upload/job cycles;
- migration duration and disk amplification on representative databases.

Performance improvements must preserve authorization and canonical-content behavior. Never trade correctness for a benchmark shortcut.

## Security program

Maintain a living threat model covering:

- credential stuffing, recovery and TFA abuse;
- session fixation, token theft, API keys, JWK compatibility, and OAuth callback handling;
- private/protected page enumeration and cache leakage;
- asset and source authorization;
- HTML/Markdown/SVG sanitization and CSP;
- SSRF through embeds, storage, search, webhooks, imports, and media metadata;
- webhook signing/replay;
- extension supply chain and renderer isolation;
- collaboration room admission and update poisoning;
- job payload tampering and administrative retry controls;
- archive/path traversal in import/export/upload;
- migration and backup secret exposure;
- administrator terminal boundaries.

Security fixes receive regression tests at the lowest shared layer and at one externally reachable route.

## Decision rules for future Scarlett changes

Classify each new upstream commit:

### Adopt behavior now

Use when the behavior fixes a demonstrated security, data-loss, standards, or operational problem and maps cleanly to Wiki.ts invariants. Reimplement with focused proof.

### Adapt after a prerequisite

Use when the idea is valuable but depends on policy, jobs/events, extension serialization, editor compatibility, or migration infrastructure. Record the dependency explicitly.

### Compare only

Use for UI polish, dependency changes, and framework-specific optimizations. Reproduce the behavior/problem on Wiki.ts before changing code.

### Reject

Use when the change removes upgrade continuity, database portability, supported integrations, external compatibility, canonical source preservation, or testability without a superior replacement.

### Superseded

Use when Wiki.ts already delivers the behavior through a stronger contract. Add or retain a regression test proving the claim.

## Work-item template

Every implementation slice promoted from this roadmap should state:

```text
Source evidence:
  upstream commit(s), files, observed behavior, and limitations

Wiki.ts contract:
  user-visible result, authorization, canonical data, errors, recovery

Compatibility:
  existing data/API/editor/provider/database behavior that must remain

Targets:
  exact domain operations, policy, repositories, routes, UI, migrations

Non-goals:
  adjacent work intentionally excluded

Verification:
  reproduction, focused contract tests, runtime smoke, broader gates

Stop conditions:
  evidence that invalidates the design rather than inviting a workaround

Completion:
  observable end-to-end criteria, docs, migration, operations, commit/push
```

Keep slices independently reviewable. Never expose a selector, route, setting, or migration before its underlying behavior is complete.

## Immediate execution queue

Start in this order:

1. **Permission policy characterization and resource-access matrix** — highest security leverage and prerequisite for every protected workflow.
2. **Rate-limit HTTP/proxy correctness** — bounded improvement derived from Scarlett with an existing Wiki.ts implementation.
3. **Page path and migration preflight regression suite** — protects continuity before new schema work.
4. **REST/OpenAPI contract inventory** — stabilizes the external surface and exposes duplicated domain logic.
5. **Scheduler/job connection-lifetime characterization** — evidence before durable worker changes.
6. **Portable durable-job proof with one cleanup handler** — validates leases, retries, shutdown, and database dialects.
7. **Transactional outbox and webhook worker** — foundation for watching and approvals.
8. **Page watching end to end** — first completed Scarlett WIP synthesis.
9. **Approval state machine and inbox** — second completed WIP synthesis.
10. **Password-protected page design and implementation** — after shared policy and limits.
11. **Wiki.ts extension contract and QR proof extension** — foundation before media/block breadth.
12. **Visual Markdown table/admonition improvements** — only with round-trip fixtures.
13. **Page history overlay and navigation improvements** — bounded UX completion.
14. **Live collaboration design proof** — only after policy, events, and canonical editor gates.
15. **Release-candidate matrix and external review** — turns feature completion into product completion.

Do not start by migrating frameworks, copying Scarlett directories, or adding the most visible block. The immediate queue deliberately builds the shared correctness layers that let later features be superior rather than merely present.

## Maintenance ledger

When this roadmap changes, append an entry here.

| Date | Assessed upstream | Wiki.ts base | Decision |
| --- | --- | --- | --- |
| 2026-08-14 | `c182d2c9` | `f474de3b` | Established fork-native synthesis architecture, dispositions, dependency-ordered waves, and Wiki.ts 1.0 completion gates |
| 2026-08-14T23:59:10Z | `c182d2c9` (`feat: block-gallery`) | `f474de3b` | Re-fetched `requarks/wiki:scarlett`; no commits existed beyond the recorded tip, so the gallery candidate and all latest upstream work were already included |
| 2026-08-15 | `14e1efae` page-watching WIP | `f474de3b` plus Waves 1–2 | Completed Wave 3A natively with transactional page events, aggregated durable delivery, permission-aware cleanup, independent email/in-app channels, and responsive page controls |
| 2026-08-15 | `957efebe` / `c36eab67` approval WIP | `e4c8d246` | Completed Wave 3B as a fork-native revision-bound approval state machine with immutable audit history, authorization, stale-revision protection, transactional publication, and responsive inbox/workflow UI |
| 2026-08-15 | Scarlett page-history overlay concepts | `97a452e1` plus Wave 4 authoring work | Completed Wave 3D with immutable revision metadata/tag snapshots, REST-backed responsive diff/actions, canonical content/editor restore, and transactional optimistic concurrency |
| 2026-08-15 | `17d7b810` Yjs collaboration concept | Wave 4 policy, events, and Markdown editor foundation | Completed Wave 4C as authenticated Markdown collaboration with durable versioned rooms, acknowledged offline replay, cross-instance database fanout, continuous authorization, mutation conflicts, and explicit local-preservation UX |
| 2026-08-15 | `aa27932c` block-index and `d0c5a8bf` block-gallery refinements | `64abdc57` plus Wave 4B expansion | Adapted the useful behavior without upstream runtime code: native typed gallery/index envelopes, disabled migrations, sanitized server renderers, policy-filtered dynamic index API, accessible browser hydration, editor configuration, responsive layout, and regression/E2E coverage; retained neither Scarlett’s Lit/Tailwind components nor unbounded/stale index rendering |
| 2026-08-15T16:41:53Z | `d0c5a8bf` (`feat: add unlock aspect ratio option to block-gallery`) | `1c6a8b9b` | Reassessed every previously non-inherited architecture choice on merit in [the architectural adaptation plan](./2026-08-15_scarlett-architectural-adaptation-plan.md): accepted package boundaries, verified schema bridges, bounded projections, and conditional isolated runtimes; retained upgrade continuity, five-database core behavior, one UI/ORM/source authority, and the immediate remaining-block implementation handoff |
