# tsFranki security threat model

## Status and review contract

| Field | Value |
| --- | --- |
| Product | tsFranki |
| Model version | 1 |
| Last reviewed | 2026-08-30 |
| Review owner | tsFranki maintainers |
| External reviewer | Unassigned — blocks the first external release |
| Covered source | `main` at or after `d2548d8a` |

This is a living release artifact. Update it whenever an authentication flow, externally reachable route, renderer, extension, worker payload, import/export path, database migration, secret boundary, or deployment topology changes. Every release candidate must resolve each open finding below, record an explicit risk acceptance, or remain blocked.

## Security objectives

1. An unauthenticated or unauthorized principal cannot enumerate or read private or password-protected pages, derived assets, source, history, search results, tree entries, collisions, links, or counts.
2. Authentication, recovery, TFA, page-unlock, render, upload, and administrative endpoints resist inexpensive abuse and identify clients according to an explicit proxy configuration.
3. Untrusted content cannot execute script, escape its renderer, traverse storage paths, or cause server-side requests to private networks.
4. API keys, sessions, collaboration rooms, jobs, outbox events, and webhook deliveries preserve the same authorization decision as the originating request.
5. Migration, backup, restore, and release artifacts fail before destructive ambiguity and do not expose credentials or claim unverifiable provenance.

## Assets and trust boundaries

### Assets

- page content, immutable history, private ownership metadata, password-verifier state, assets, comments, navigation, search indexes, and collaboration updates;
- administrator credentials, sessions, API keys, OAuth/OIDC tokens, TFA and recovery material, webhook secrets, database credentials, TLS private keys, and backup archives;
- authorization policy, group membership, page rules, publication state, approval history, durable jobs, and outbox events;
- source revision, release archives, container images, Helm chart, SBOM, dependency inventory, and checksums.

### Boundaries

1. **Browser or API client → direct peer → Express.** With `securityTrustProxy` disabled, Express ignores forwarded client addresses. Enabling the boolean configures `trust proxy` as exactly one hop: the socket peer is the sole trusted reverse proxy and the nearest forwarded address is the client. The application port must therefore be reachable only through that one proxy, which must replace or sanitize forwarded headers; direct access, multiple proxy hops, or alternate shorter paths make client identity and per-IP controls unreliable.
2. **API-key bearer → declared transport.** API-key principals are admitted only on exact `/graphql`, the `/api/v1` namespace, and the separately mounted exact `/mcp` route. Browser and internal `/_api` routes require a user session. MCP additionally enforces its resource claim and `use:mcp` or system authority.
3. **Express → domain operations → database.** Controllers authenticate and normalize input; shared operations and page-access helpers own policy and transaction boundaries.
4. **Application instance → shared database.** Rate limits, durable jobs, collaboration fanout, outbox state, and revision metadata must remain coherent across processes.
5. **Application → external systems.** Authentication providers, storage/search adapters, mail, webhooks, embeds, imports, and extension renderers cross into separately operated systems.
6. **Untrusted authored/uploaded content → renderer/browser.** Markdown, HTML, SVG, content extensions, media metadata, and filenames are attacker-controlled. When CSP is enabled, the middleware emits the exact configured value only if it is a valid HTTP header value; it does not synthesize or assess the strength of a policy.
7. **Trusted page-script author → same-origin browser session.** `write:scripts` permits JavaScript that runs as trusted code on the ordinary Wiki origin and can act with the signed-in user's application authority. It is a system-equivalent grant, not a sandboxed content-authoring permission.
8. **Operator → deployment and backups.** Environment variables, mounted secret files, database dumps, persistent volumes, Helm values, and release artifacts are operator-controlled but may be exposed by incorrect permissions or logs.
9. **Build system → registry/release consumer.** GitHub Actions, package registries, container registries, and artifact attestations are supply-chain boundaries.

### Database migration lineage

The installed Knex ledger is one append-only schema authority. Wiki.js history is inherited through `2.5.128.js`; already-published tsFranki migrations `2.5.129.js` through `2.5.159.js` remain immutable compatibility records; every later migration uses `tsfranki-NNNNNN-description.js`. Product release versions never determine migration identity, and published names are never renamed or reordered.

`tsfranki-000001-schema-lineage.js` records that boundary in `schemaLineage`. Preflight accepts a pre-marker legacy tsFranki ledger only when the private-page schema created by `2.5.129.js` attests its fork lineage. This prevents a future upstream migration with the same filename but different effects from being mistaken for an applied tsFranki migration.

A Wiki.js source database whose ledger extends beyond `2.5.128.js` is unsupported until a source-specific adoption bridge validates that exact upstream schema and appends an equivalent tsFranki migration. Upstream migrations are adapted at the end of tsFranki history; they are never inserted into, or allowed to reinterpret, the installed prefix.

## Threat and control register

| ID | Threat | Required control | Current implementation and executable evidence | Residual risk / release state |
| --- | --- | --- | --- | --- |
| AUTH-1 | Credential stuffing against HTML and REST login | Shared durable counters, escalating waits, deterministic `429`, `Retry-After`, reset only for the resolved client | `server/helpers/auth-rate-limiter.ts`; `server/controllers/auth.ts`; `server/controllers/api/auth.ts`; `server/test/helpers/auth-rate-limiter.test.js`; `server/test/controllers/auth.test.js`; `server/test/controllers/api.auth.test.js` | Controlled for configured instances. Client separation depends on the one-hop proxy topology in AUTH-2. TFA/recovery browser abuse journeys remain part of the release matrix. |
| AUTH-2 | Forwarded-header spoofing or client coalescing | Express-resolved `req.ip`; forwarding headers never parsed by the limiter; boolean proxy trust maps to exactly one direct trusted hop | `server/master.ts`; `server/helpers/auth-rate-limiter.ts`; `server/test/core/trust-proxy.test.ts`; `server/test/helpers/auth-rate-limiter.test.js` | Operator must leave proxy trust off for direct deployments. When enabled, one sanitizing reverse proxy must be the only path to a non-public application port. A direct, multi-hop, or variably short path can spoof or coalesce identities; those topologies are not represented by the boolean setting. |
| AUTH-3 | Session fixation, stolen JWT, stale privileges, API-key privilege drift, or API-key use at an unintended route | Issuer/audience/signature checks; user/group revalidation; API-key admission allowlisted to exact GraphQL, REST v1, and separately mounted MCP transports; API principal receives assigned group policy and no private-page ownership identity | `shared/api-access.ts`; `server/core/auth.ts`; `server/agents/mcp.ts`; `server/test/core/auth.api-access.test.ts`; `server/test/agents/mcp.test.ts` | Operators must enable and expose API/MCP access deliberately, use TLS, and protect bearer values from logs and clients that do not need them. A stolen key can exercise its live group authority on its admitted transports until revocation; route confinement does not reduce that authority. |
| AUTH-4 | TFA, recovery, password-change, registration, or page-unlock brute force; mail scanners consuming recovery actions | Threat-weighted POST rate limits and continuation-token validation; verification and reset landing GETs validate without consuming the token or a rate-limit attempt; only the explicit action POST consumes the token | `server/controllers/auth.ts`; `server/controllers/api/auth.ts`; `server/test/controllers/auth.test.js`; `server/test/controllers/api.auth.test.js`; password-page controller/model tests | Operators must deliver recovery links over TLS and preserve the GET-to-explicit-POST flow. Anyone who obtains a live link can still submit the action, and the non-consuming landing is not itself a brute-force control. |
| PAGE-1 | Private page enumeration or read across owner boundary | Single owner/private decision, namespace separation, query scoping, not-found non-disclosure | `server/helpers/page-access.ts`; `server/test/helpers/page-access.test.ts`; `server/test/models/pages.private-errors.test.js`; private SQLite/PostgreSQL integration tests | Route-level matrix must remain green for every derived resource. |
| PAGE-2 | Conflicting group rules create order-dependent privilege escalation | Global permission prerequisite; most-specific rule wins; exact outranks prefix; deny wins ties; invalid regex is non-matching | `server/core/auth.ts`; `server/test/core/auth.page-rules.test.ts` | Policy changes require an administrator-facing compatibility note. No force-allow rule exists. |
| PAGE-3 | Leakage through search, tree, links, history, source, counts, collisions, exports, comments, or assets | Shared page scoping and authorization before resource lookup; private failures normalized to non-disclosing errors | Page operations/controllers and focused tests under `server/test/controllers`, `server/test/models`, and `server/test/operations.pages.history-visibility.test.js` | The executable resource matrix is a release gate and must be extended with each new derived route. |
| PAGE-4 | Offline cache or collaboration room reveals stale private content | Authorization on room admission and continuously before updates; canonical save still enforces revision and page access | `server/core/collaboration.ts`; `server/controllers/api/pages.ts`; `server/test/core/collaboration.test.ts`; client collaboration tests | A revoked already-delivered plaintext copy cannot be recalled. Reconnect and mutation are denied after revocation. |
| CONTENT-1 | Markdown/HTML/SVG/content-extension XSS, renderer escape, or a misleading CSP configuration | Allowlisted renderer contract, DOMPurify, forbidden active SVG/HTML elements and style attributes, upload SVG sanitization; when enabled, CSP emits exactly one configured value that passes HTTP header-value validation and omits invalid values | `server/content-extensions/sanitize.ts`; `server/jobs/sanitize-svg.ts`; `server/middlewares/security.ts`; `server/test/middlewares/security.test.ts`; content-extension renderer and API tests | Operators own the CSP directives and must verify the effective browser policy; the application neither generates a baseline nor rejects a syntactically valid but weak policy. Trusted page-script authority is covered by SCRIPT-1 and is not untrusted content. |
| CONTENT-2 | Malicious links or URL schemes | Explicit protocol allowlist and attribute sanitation | `server/content-extensions/sanitize.ts`; content-extension sanitizer/renderer tests | Other renderer modules remain part of external review scope. |
| NET-1 | SSRF and DNS rebinding through webhooks | HTTPS-only, no URL credentials, private/reserved network blocklist, DNS resolution before enqueue/delivery, validated address pinned during TLS request | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js` | Storage, search, authentication, embeds, import, and media adapters are separate operator-trusted integrations and require deployment-specific canaries. |
| NET-2 | Webhook forgery, replay, or secret disclosure | Random secret, AES-256-GCM encrypted storage, HMAC-SHA256 over timestamp and exact body, delivery/event identifiers, bounded response capture and timeout | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js`; webhook job tests | Receivers must enforce timestamp skew and delivery-ID deduplication; tsFranki cannot enforce receiver behavior. |
| EXT-1 | Extension supply-chain or renderer isolation failure | Versioned shared envelope; disabled-by-default registry; administrator-only toggles; sanitized deterministic renderer output | `shared/content-extensions.ts`; `server/core/extensions.ts`; `server/content-extensions`; extension API, migration, and renderer tests | New extension kinds require sanitizer/CSP/export/print review before enablement. No arbitrary third-party runtime loading is supported. |
| JOB-1 | Job payload tampering, duplicate side effects, lease theft, or unbounded retry | Typed handlers validate payload; transactional claim; owner-bound lease completion/failure; bounded attempts; terminal state; idempotent outbox delivery | `server/core/durable-jobs.ts`; `server/core/outbox.ts`; durable-job/outbox/job tests | Real process-kill lease recovery remains an operational release gate. |
| PATH-1 | Archive, filename, upload, import, or export path traversal | Filename sanitation, canonical data roots, page path segment filtering, allowlisted archive package roots | `server/controllers/upload.ts`; `server/helpers/page.ts`; `server/core/asar.ts`; upload/import/export tests | External review must include every archive extractor and operator-supplied path. |
| DATA-1 | Unknown, partial, newer, locked, unsupported-version, or same-name/different-lineage PostgreSQL state is mutated, or rollback restores mismatched state | Non-mutating migration preflight; immutable legacy manifest through `2.5.159.js`; fork-owned `tsfranki-NNNNNN-description` namespace; durable schema-lineage marker rooted at upstream cutoff `2.5.128.js`; structural attestation for pre-marker tsFranki ledgers; PostgreSQL 15–18 startup guard; pinned source fixture; checksum-verified `pg_dump`/`pg_restore`; paired `/wiki/data` snapshot; old-version boot and authentication after restore | `server/core/db.ts`; `server/db/migration-contract.ts`; `server/db/migration-preflight.ts`; `server/db/migrations/tsfranki-000001-schema-lineage.ts`; database tests; `dev/e2e/upgrade-smoke.sh`; `.github/workflows/build.yml` | The release matrix covers Wiki.js 2.5.314 through upstream migration `2.5.128.js` and synthetic PostgreSQL 15–18 state. A future upstream ledger beyond that cutoff requires an explicit, source-specific adoption bridge; matching migration names are never treated as proof of matching schema lineage. Operators must canary a restored copy of production data and preserve both snapshots as one recovery point. |
| DATA-2 | Backup or migration secrets leak through files, logs, examples, or artifacts | File-backed Compose/Helm secrets; documented restrictive permissions; release artifacts exclude runtime data and credentials | `dev/examples/docker-compose.yml`; `dev/helm/templates/postgresql-secret.yaml`; deployment documentation | Operators control dump destinations, encryption, retention, and access. Recovery CI must use synthetic credentials only. |
| ADMIN-1 | Administrative endpoint or terminal crosses permission boundary | REST controllers require explicit `manage:*` permissions and return JSON `403` before model mutation; no arbitrary command terminal is shipped | Controller tests under `server/test/controllers/api.*.test.*` | Deployment shell and database access remain outside the application boundary. Any future terminal feature requires a separate threat review and is release-blocking by default. |
| SCRIPT-1 | A delegated content author installs same-origin JavaScript and crosses user or administrative boundaries | `write:scripts` is treated as system-equivalent authority when granting, retaining, or assigning group permissions; page script writes still require the permission and applicable page rule | `server/operations/groups.ts`; `server/models/pages.ts`; `server/core/auth.ts`; `server/test/operations.groups.test.ts` | Operators must grant `write:scripts` only to principals trusted like system administrators and review already-published scripts when authority changes. Such code runs on the ordinary origin and can act with each viewer's signed-in application authority; CSP and content sanitation are not a sandbox for it. |
| SUPPLY-1 | Dependency compromise or artifact/source mismatch | Frozen lockfile, policy-checked install, pinned build images/actions, exact revision metadata, corresponding source, SBOM, license inventory, checksums, OCI provenance labels | `package.json`; `pnpm-lock.yaml`; `.github/workflows/build.yml`; `server/scripts/export-build-environment.ts`; product-build tests | Independent provenance verification and external review remain required before the first external release. |

## Executable security gate

Run the focused security contract before the broader project gates:

```console
pnpm test:security
pnpm audit --prod
pnpm typecheck:server
```

The full release matrix additionally owns browser non-disclosure, proxy topology, database upgrade/restore, multi-instance, Helm, accessibility, and provenance scenarios. A focused pass does not substitute for those gates.

## Open findings and accepted limitations

| Finding | Severity | Owner | Required disposition |
| --- | --- | --- | --- |
| SEC-EXT-001 — independent security review not yet performed | Release blocker | Maintainers | Freeze revision, record reviewer/scope, resolve findings, retain retest evidence. |
| SEC-ADAPTER-001 — deployment-specific identity/storage/search/mail integrations are not covered by the generic release matrix | Medium | Operator | Complete an operator canary for every enabled integration. |

## Resolved findings

| Finding | Resolution evidence |
| --- | --- |
| SEC-AUTH-001 — TFA and recovery browser journeys incomplete | Resolved 2026-08-15. `dev/e2e/setup.e2e.ts` exercises setup, required TFA, invalid-code rejection, recovery-code login, and single-use recovery codes; the Chromium release journey passes. |
| SEC-OPS-001 — real worker process-death lease recovery not yet exercised | Resolved 2026-08-15. `dev/e2e/multi-instance-smoke.sh` gives each process a distinct lease identity, stops the lease owner, waits beyond expiry, requires the survivor to complete the job at attempt 2 with no owner, then verifies the stopped instance can rejoin. `server/test/core/durable-jobs.test.ts` additionally bounds connection-pool use. |

## External review record

The first external release remains blocked until an independent reviewer supplies all of the following for a frozen Git revision:

- reviewer identity or organization and review dates;
- scope, environment, exclusions, and threat-model version;
- finding ID, severity, affected boundary, and reproduction evidence;
- fix revision, focused regression proof, reviewer retest, and final disposition;
- explicit statement for unresolved accepted risk.

A maintainer self-review, automated dependency scan, or passing test suite is supporting evidence, not an independent review.
