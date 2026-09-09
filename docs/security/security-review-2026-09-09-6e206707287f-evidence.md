# Maintainer source-review evidence — 2026-09-09

## Review identity, freeze, and boundary

This document is the durable evidence for schema-2 source review
`security-review-2026-09-09-6e206707287f`.

- **Source freeze (`S`):** `6e206707287f9f9a9e9d188a78e092a3c15f8c9d`.
- **Base revision:** `b8ce84f21739f1cf3c371d26d1da8251b4e206cc`.
- **Covered security-boundary digest:** `ec982adf890168fd73c33816c3459a100d625fcb7a5d9df68f516633e958f9e0`.
- **Threat-model SHA-256:** `1e373b88b5dcfbd4843961762bf187788594734d684d7b8b74452648668e86ee`, computed from the final bytes of `docs/security/threat-model.md`.
- **Review date:** 2026-09-09.
- **Attribution:** tsEpistle maintainers, with delegated source reviews by `IntegratedRemediationReview`, `ReleaseRemediationReview`, `AuthRemediationReview`, `PageResidualReview`, and `StorageResidualReview`. The delegated reviews were read-only source assessments; their conclusions are not presented as commands they ran.

The reviewed scope is the final source tree at `S`: the authenticated API-principal and federation boundaries, page-parent authorization, persisted asset identity, disk and native-Git import/backup boundaries, process supervision, the corresponding migrations and regression contracts, and the policy/checker/workflow controls that bind those changes. The canonical covered-tree digest binds the source boundary; the threat-model digest binds the normative control register independently.

`S` is the source freeze. The attestation record and this Markdown are inputs to a documentation-only successor `A`: `A` will append/select this record while leaving the source boundary equal to `S`. No future SHA for `A` is invented here, and this evidence does not claim that `A` has already been committed, built, pushed, or deployed.

The observed review environment was Linux kernel `7.0.0-31-generic` on x86_64, Bun `1.4.0`, Git `2.53.0`, GNU tar `1.35`, and gzip `1.14`. These are tool observations for the review environment, not deployment or image metadata. External approvals, detached signatures, arbitrary coverage thresholds, production credentials, maintained-instance state, and live external-provider exercise are outside this review.

## Review-artifact conclusions and attribution

The five retained PASS artifacts are summarized here so the evidence remains useful without an `agent://` dependency. Each delegated artifact was a read-only review and did not itself execute the commands listed later in this document.

### IntegratedRemediationReview — PASS

The common page-parent remediation maps missing, cyclic, incomplete, disappeared, and unauthorized parent states to the same public `403` outcome before collision lookup. REST and GraphQL use the same operation, while transaction locks and revalidate the parent chain before authorization, destination serialization, collision lookup, and insertion. Unrelated infrastructure failures remain classified and propagate rather than being disguised as authorization denials. The review found no release-significant correctness or security blocker.

### ReleaseRemediationReview — PASS

The checker, package policy, workflow wiring, and documentation controls are consistent. Empty or malformed threat-model content fails closed; the model is hashed after a successful read; the production audit remains an exact unconditional `bun audit --production` segment; PR and non-PR quality jobs invoke `bun run ci:static`; schema 2 is the only accepted manifest/record schema; and release mode requires the active source review, zero blocking findings, clean boundary state, and matching digest. No external signature or approval input is required by this policy. This artifact performed no tests, builds, lint, payloads, or network calls; its reported `488/488` result was parent-provided context, not a command run by the reviewer. Its historical active-record observation is superseded for current selection only by this source-freeze successor; the historical records remain registered and unchanged.

### AuthRemediationReview — PASS

The API-key principal is non-human, has no human `id`, has `ownershipUserId: null`, and retains API/group identity. Admission is limited to the exact GraphQL, REST v1, and MCP transports. GraphQL mutation roots reject API principals before resolver execution; REST v1 is read-only; human-attributed page/comment stores retain defense-in-depth rejection; and MCP writes preserve API-key identity in proposal/execution ledgers while requiring a current human approver. Federation initiation persists the initiating browser session. CAS binds a random request ID into the exact service URL and consumes the provider/revision/session-bound record before ticket validation. SAML requires HTTPS, a `__Host-` HttpOnly Secure SameSite=None nonce, strict `InResponseTo`, a ten-minute request lifetime, and one-time durable consumption. OAuth state is hashed and keyed by provider, protocol, session, and configuration revision, consumed before exchange, and rejected for replay, expiry, disabled/deleted providers, missing sessions, or stale revisions. The review found no exploitable release blocker in the assigned auth/API-principal/F0/F1/F2 scope. It was source inspection only.

### PageResidualReview — PASS

The page-parent boundary returns one public forbidden outcome for typed structural and authorization failures before collision lookup, and both REST and GraphQL preserve the same operation-level behavior. The transaction revalidates the parent chain under lock before authorization and insertion. The review found no remaining exploitable page-parent oracle or release blocker and did not execute a suite.

### StorageResidualReview — PASS

Asset transport resolves a complete persisted database identity before cache, local-provider, or `assetData` access; model and provider layers deny internal namespaces. Disk and Git imports use descriptor-confined sources, prune `.git` before inspection/descent, complete a 10,000-entry/256 MiB whole-plan admission before database work, and cap pages/assets. Git preflights streamed NUL trees/diffs against pinned object IDs with one fetch and no refetch. Final supervision handles synchronous and asynchronous spawn failure, signal exit, deadline/output/parser/monitor/abort failure, awaits an active monitor before disposition, and quarantines fail-closed cases. Process-group escalation sends TERM to the detached negative-PID group and KILL after 250 ms while child/stdio closure remains outstanding; the speculative daemonized-descendant issue was not resurrected because no credible attacker-controlled path reaches it through the reachable fixed SSH or Git/libcurl transports. Disk backup streams descriptor reads through tar/gzip and atomically writes under 10,000-entry, 256 MiB raw, and 272 MiB compressed caps, with identity/growth checks, producer closure, temporary cleanup, and preservation of the prior archive on failure. The 100 ms native-pack observation remains a sampled observation, not a hard physical quota. This review executed no payloads, network calls, or suites.

## Main execution record

The following results are attributable to Main, not to the delegated read-only reviewers:

- The parent-provided full isolated result before the final bounded-process/documentation tweak was **489/489 passed**. It is retained as pre-tweak context and is not relabeled as the final source result.
- After the final source tweaks, Main executed `bun run test` and observed **490/490 passed**.
- Main executed `bun run test:security` and observed **21/21 passed**.
- Main executed `bun test server/test/modules/storage.disk.test.js` and observed **56/56 passed**.
- Main executed `bun test server/modules/storage/git/bounded-process.test.ts` and observed **3/3 passed**.
- Main executed `bun audit --production`; the audit was clean with **646** reported audit entries/packages, as recorded in the execution context.
- Before the documentation-only successor existed, `bun run ci:static` passed dependency policy, license inventory, audit, lint, shared/client/server typechecks, OpenAPI, placeholders, and agent-release checks, then failed only at the expected stale active-record/source-digest/dirty-state threat-model check. This is a pre-A partial observation, not a post-A static-gate pass.

A PostgreSQL-dependent test that is skipped by an isolated runner is not called real-PostgreSQL proof here. In particular, the `server/test/repositories/federated-login.postgres.test.ts` path is durable regression evidence for the reviewed durable-state contract, but no skipped isolated case is represented as a live PostgreSQL execution. No final image build, post-A strict release pass, push, maintained deployment, deployment smoke, or production backup/restore is claimed by this pre-A document.

## Current remediations

For every current remediation below, `S` is the source fix revision. The full final Main regression command was `bun run test` (**490/490 passed**); focused Main commands and results are included where they were reported. The final source-review retest is the corresponding delegated read-only PASS conclusion above, not a claim that the reviewer ran the command.

### `AUTH-APIKEY-HUMAN-IMPERSONATION` — High — resolved

**Affected boundary and prior observable failure:** API-key authentication crosses GraphQL, REST v1, MCP, and human-attributed page/comment mutation paths. A key must not become a human principal, acquire private-page ownership, or reach a mutation resolver as though a person had issued the request. The prior failure mode was API-key identity being represented or consumed as a human identity at a write boundary.

**Fix at `S`:** `server/helpers/api-principal.ts` constructs a distinct non-human principal with API/group identity, no human `id`, and `ownershipUserId: null`. `server/core/auth.ts` admits that principal only on the exact allowed transports. `server/graph/api-key-mutations.ts` rejects every GraphQL mutation root before resolver execution. REST v1 remains read-only. Human-attributed page/comment model paths retain fail-closed checks, while MCP proposals and executions preserve API-key identity and require a current human approver rather than synthesizing a user.

**Regression command and result:** Main executed `bun run test:security` (**21/21 passed**) and the final `bun run test` (**490/490 passed**). The focused durable evidence paths are `server/test/core/auth.api-access.test.ts` and `server/test/graph/api-key-mutations.test.ts`, covering non-human construction and pre-resolver mutation denial. `AuthRemediationReview` re-read the complete caller migration and reported PASS without executing tests.

### `AUTH-CALLBACK-INITIATION-BINDING` — High — resolved

**Affected boundary and prior observable failure:** CAS, SAML, and common federated callbacks must be bound to the browser session and the exact provider/configuration instance that initiated them. An unbound, replayed, cross-provider, or cross-session callback could otherwise be accepted before the application has established the initiating browser relationship.

**Fix at `S`:** Initiation persists the browser session and correlation data. CAS places a random request ID in the exact service URL, consumes the provider/revision/session-bound record before ticket validation, and checks the stored service URL. SAML requires HTTPS, a `__Host-` HttpOnly Secure SameSite=None initiation nonce, strict `InResponseTo`, a ten-minute request lifetime, and one-time durable retrieval. The common callback clears the federation cookie on every terminal path; an uncorrelated callback requires exact Origin. The callback strategies therefore fail closed before account linking or exchange when correlation is absent, stale, replayed, or mismatched.

**Regression command and result:** Main executed `bun run test:security` (**21/21 passed**) and the final `bun run test` (**490/490 passed**). The durable focused evidence paths are `server/modules/authentication/cas/cas-strategy.test.ts`, `server/modules/authentication/saml/authentication.test.ts`, and `server/test/controllers/auth.test.js`. `AuthRemediationReview` re-read initiation, callback, cookie, origin, CAS, and SAML paths and reported PASS without executing tests.

### `AUTH-OAUTH-STATE-LIFECYCLE` — High — resolved

**Affected boundary and prior observable failure:** OAuth/OIDC state, PKCE, nonce, and provider strategy dispatch must resist replay, provider-instance confusion, stale configuration, missing sessions, and exchange-after-invalid-callback behavior. Ephemeral or insufficiently keyed state could allow a valid-looking callback to be accepted in the wrong provider/session context.

**Fix at `S`:** Migration `000030` creates durable federation attempts. The database authority hashes state/request IDs, keys attempts by configured provider, protocol, session, and immutable configuration revision, verifies a live session and enabled current provider, rejects expiry at the exact ten-minute boundary, and deletes the attempt before returning a matched terminal outcome. The shared OAuth store carries provider key/revision/protocol plus PKCE/OIDC context into the durable record and consumes it before code exchange. Auth0, Azure, OIDC, OAuth2 adapters, and the Discord compatibility path use the provider-instance keyed contract; runtime activation captures the saved `adminRevision`.

**Regression command and result:** Main executed the final `bun run test` (**490/490 passed**). The focused durable evidence paths are `server/modules/authentication/oauth-state.test.ts` and `server/test/repositories/federated-login.postgres.test.ts`. If an isolated runner skips the PostgreSQL-dependent file, that is not represented as real-PostgreSQL proof. `AuthRemediationReview` re-read all adapter dispatch and durable repository paths and reported PASS without executing tests.

### `STORAGE-ASSET-001` — High — resolved

**Affected boundary and prior observable failure:** Public asset delivery, cache lookup, local-provider reads, and `assetData` access must not trust a path, hash, or partial folder identity supplied by a caller. A forged or incomplete identity could otherwise cross a folder boundary, collide with another asset, or reach internal namespaces before the persisted authority was checked.

**Fix at `S`:** Asset access is DB-first. It resolves and validates the complete persisted identity (`id`, `hash`, `filename`, `folderId`) and the complete folder hierarchy before consulting cache, local storage, or database bytes. Model and provider boundaries reject internal namespaces, including `.git` and reserved roots. The reviewed implementation keeps canonical identity and authorization ahead of all byte reads and transport effects.

**Regression command and result:** Main executed the final `bun run test` (**490/490 passed**). The durable focused evidence path is `server/test/models/assets.test.ts`. `StorageResidualReview` re-read the asset controllers, models, providers, runtime tests, and threat-model control and reported PASS without executing tests.

### `STORAGE-IMPORT-002` — High — resolved

**Affected boundary and prior observable failure:** Local and native-Git import admission, object enumeration, and child-process supervision must not allow path traversal, `.git` exposure, partial admission, unbounded work, refetch drift, or an ambiguous process failure to become accepted content. A prior process failure could also be misclassified when spawn, signal, deadline, output, parser, monitor, or abort handling was incomplete.

**Fix at `S`:** Imports use descriptor-confined sources and prune `.git` before inspection or descent. A complete manifest is admitted before database work, counting directories and zero-byte files under the shared 10,000-entry/256 MiB aggregate budget; pages are capped at 1 MiB and imported assets at `min(configured upload limit, 64 MiB)`. Native Git preflights streamed NUL trees/diffs against pinned object IDs with one fetch and no refetch. The bounded runner caps output, enforces deadlines, supervises the active monitor, quarantines synchronous and asynchronous spawn failures, signal exits, parser/monitor/abort failures, and performs detached process-group escalation fail-closed.

**Regression command and result:** Main executed `bun test server/modules/storage/git/bounded-process.test.ts` (**3/3 passed**) and the final `bun run test` (**490/490 passed**). The durable focused evidence paths are `server/modules/storage/git/admission.test.ts`, `server/modules/storage/git/bounded-process.test.ts`, and `server/modules/storage/git/repository.test.ts`. `StorageResidualReview` re-read the final runner, admission, repository, connection, and storage paths and reported PASS without executing tests. The review explicitly did not revive the rejected speculative daemonized-descendant issue.

### `STORAGE-BACKUP-003` — High — resolved

**Affected boundary and prior observable failure:** Disk backup must be bounded, coherent, atomic, and failure-preserving. An unbounded or non-atomic stream could exhaust resources, capture identity-changing content, leave a partial archive, or destroy the prior known-good archive when a new backup failed.

**Fix at `S`:** Backup inventories are descriptor-confined and budgeted under 10,000 entries and 256 MiB raw bytes. Tar/gzip output is streamed through bounded accounting, with identity and growth checks, producer closure, a 272 MiB compressed cap, temporary-file cleanup, and atomic replacement only after success. A failed attempt preserves the prior archive.

**Regression command and result:** Main executed `bun test server/test/modules/storage.disk.test.js` (**56/56 passed**) and the final `bun run test` (**490/490 passed**). The durable focused evidence path is `server/test/modules/storage.disk.test.js`. `StorageResidualReview` re-read the backup implementation and test contract and reported PASS without executing tests.

## Accepted current residuals

### `SEC-STORAGE-NATIVE-BOUND-001` — Medium — accepted

The native Git pack observation samples at 100 ms and can overshoot; it is not a hard pack-size, disk, or memory quota. Git setup/configuration/remotes performed through `simple-git` remain outside the bounded synchronization runner. Exclusive application ownership and operator OS/filesystem controls are therefore required. A deployment that needs a physical bound must use an OS quota or bounded volume and must prevent concurrent writers. This acceptance is supported by the residual architecture assessment, `StorageResidualReview`, the `PATH-1` control, and `server/modules/storage/git/bounded-process.test.ts`; it is not a waiver of a failed runtime gate. The speculative daemonized-descendant issue was rejected and is not a current finding.

### `SEC-ADAPTER-001` — Medium — accepted

Separately configured external adapters and providers remain operator-trusted integrations. They require deployment-specific canaries, and utility egress can include shared ACL-restricted published content when the configured provider is an operator-approved shared-content processor; retrieval still enforces requester authorization and publication/revision/hash checks. This acceptance does not imply that every external integration was live exercised, nor does it add a provider, permission, or egress configuration. The residual is documented in the threat model and supported by the current source review.

## Deployment-impacting migrations and cutover constraints

Three reviewed migrations affect operational sequencing:

- `000028` revokes human sessions. Existing sessions may require a fresh login after cutover.
- `000029` removes the option to disable generic OAuth2 state, so old and new writers must not overlap while the state contract changes.
- `000030` creates durable federation attempts for provider/session/revision-bound state.

The old application and any external writer must be drained before the final paired database/data backup and before the new image starts. A rollback of the irreversible session/OAuth migrations requires restoring the matching pre-cutover PostgreSQL and `/wiki/data` snapshot with the old image/config; starting old code against a newly migrated database is not an approved rollback. This document makes no claim that those operational steps have occurred.

## Historical records and prior reviews

Existing manifest references and historical bytes remain preserved. The prior records retain their original dates, scopes, and release eligibility:

- `legacy-baseline-55f30709` (2026-09-04) records the legacy maintainer baseline, including its historical `SEC-AUTH-001`, `SEC-OPS-001`, and `SEC-MCP-001`/`SEC-MCP-002` remediations, the old `SEC-ADAPTER-001` and `SEC-DEP-001` acceptances, and the then-open `SEC-EXT-001` blocker.
- `search-foundation-2026-09-07` records the search working-tree audit: graph privacy and stale-receipt findings were resolved in its scope, `SEC-SEARCH-LIMIT-001` remained accepted, and its historical `SEC-EXT-001` entry and release-ineligible status remain historical. Its benchmark and PostgreSQL evidence retain their actual dates and scope.
- `tag-experience-2026-09-08-5de2c037f3e4` records the tag-scoped review. `TAG-ACL-001`, `TAG-ACL-002`, `TAG-DISCLOSURE-003`, `TAG-INPUT-005`, and `TAG-SQL-006` were resolved in that scoped record; its reported execution evidence was 475/475 for the isolated suite, 80/80 for the public/editor matrix, 3/3 for the admin lifecycle flow, and 5/5 for each of the two listed PostgreSQL-focused groups. Its historical `SEC-EXT-001` and `SEC-COVERAGE-001` blockers remain in that record and are not silently rewritten by this successor.
- The chronological narrative in `docs/security/review-history.md` remains an archive of earlier maintainer reviews. Those reviews, their source dates, and their actual execution attribution are not reclassified by this record.

This current record intentionally does **not** carry `SEC-EXT-001` or `SEC-COVERAGE-001` into its findings as blockers, resolved defects, or approvals; the current policy does not require an external approval or an arbitrary coverage percentage. It also does not automatically carry the historical `SEC-DEP-001` advisory acceptance. Historical records remain available through the manifest, while the active record contains only the six current source remediations and the two current accepted residuals listed above.

## Pre-A status and explicit non-claims

This is pre-A evidence. The ordinary checker is expected to validate the documentation-only record while these three documentation paths are dirty; strict release cleanliness applies only after the successor A is committed. No final image build, post-A strict release check, post-A `ci:static`, post-A build, registry push, maintained Compose replacement, live health/login/authorization smoke, production migration, backup, restore, or deployment result is claimed here. Those later steps require their own real command output outside this repository and must not be backfilled into this document by inference.
