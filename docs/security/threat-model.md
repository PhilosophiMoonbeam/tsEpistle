# Wiki.ts security threat model

## Status and review contract

| Field | Value |
| --- | --- |
| Product | Wiki.ts Preview |
| Model version | 1 |
| Last reviewed | 2026-08-15 |
| Review owner | Wiki.ts maintainers |
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

1. **Browser or API client → reverse proxy → Express.** Forwarded identity is trusted only when `securityTrustProxy` enables Express trust-proxy handling. Limiters consume `req.ip`, never forwarding headers directly.
2. **Express → domain operations → database.** Controllers authenticate and normalize input; shared operations and page-access helpers own policy and transaction boundaries.
3. **Application instance → shared database.** Rate limits, durable jobs, collaboration fanout, outbox state, and revision metadata must remain coherent across processes.
4. **Application → external systems.** Authentication providers, storage/search adapters, mail, webhooks, embeds, imports, and extension renderers cross into separately operated systems.
5. **Untrusted authored/uploaded content → renderer/browser.** Markdown, HTML, SVG, content extensions, media metadata, and filenames are attacker-controlled.
6. **Operator → deployment and backups.** Environment variables, mounted secret files, database dumps, persistent volumes, Helm values, and release artifacts are operator-controlled but may be exposed by incorrect permissions or logs.
7. **Build system → registry/release consumer.** GitHub Actions, package registries, container registries, and artifact attestations are supply-chain boundaries.

## Threat and control register

| ID | Threat | Required control | Current implementation and executable evidence | Residual risk / release state |
| --- | --- | --- | --- | --- |
| AUTH-1 | Credential stuffing against HTML and REST login | Shared durable counters, escalating waits, deterministic `429`, `Retry-After`, reset only for the resolved client | `server/helpers/auth-rate-limiter.ts`; `server/controllers/auth.ts`; `server/controllers/api/auth.ts`; `server/test/helpers/auth-rate-limiter.test.js`; `server/test/controllers/auth.test.js`; `server/test/controllers/api.auth.test.js` | Controlled for configured instances. Operator must configure trusted proxies correctly. TFA/recovery browser abuse journeys remain part of the release matrix. |
| AUTH-2 | Forwarded-header spoofing or client coalescing | Express-resolved `req.ip`; forwarding headers never parsed by limiter; trust-proxy setting is explicit | `server/helpers/auth-rate-limiter.ts`; `server/controllers/api/site.ts`; `server/test/helpers/auth-rate-limiter.test.js`; `server/test/core/trust-proxy.test.ts`; `server/test/controllers/api.site.test.js` | Zero, one, and multiple trusted-proxy hops are integration-tested. When trust proxy is enabled, the application port must not be directly reachable around the trusted proxy. |
| AUTH-3 | Session fixation, stolen JWT, stale privileges, API-key privilege drift | Issuer/audience/signature checks; browser and bearer extraction; user/group revalidation; API principal receives assigned group policy | `server/core/auth.ts`; `server/helpers/security.ts`; `server/test/core/auth.api-access.test.ts`; `server/test/controllers/api.auth.test.js` | Token theft cannot be fully mitigated in application code. TLS, cookie security, key rotation, and incident revocation remain operator/maintainer controls. |
| AUTH-4 | TFA, recovery, password-change, registration, or page-unlock brute force | Threat-weighted rate limits and continuation-token validation; no secret values in responses | Authentication controllers and operations; `server/test/controllers/api.auth.test.js`; password-page controller/model tests | Browser end-to-end TFA and recovery proof remains required. |
| PAGE-1 | Private page enumeration or read across owner boundary | Single owner/private decision, namespace separation, query scoping, not-found non-disclosure | `server/helpers/page-access.ts`; `server/test/helpers/page-access.test.ts`; `server/test/models/pages.private-errors.test.js`; private SQLite/PostgreSQL integration tests | Route-level matrix must remain green for every derived resource. |
| PAGE-2 | Conflicting group rules create order-dependent privilege escalation | Global permission prerequisite; most-specific rule wins; exact outranks prefix; deny wins ties; invalid regex is non-matching | `server/core/auth.ts`; `server/test/core/auth.page-rules.test.ts` | Policy changes require an administrator-facing compatibility note. No force-allow rule exists. |
| PAGE-3 | Leakage through search, tree, links, history, source, counts, collisions, exports, comments, or assets | Shared page scoping and authorization before resource lookup; private failures normalized to non-disclosing errors | Page operations/controllers and focused tests under `server/test/controllers`, `server/test/models`, and `server/test/operations.pages.history-visibility.test.js` | The executable resource matrix is a release gate and must be extended with each new derived route. |
| PAGE-4 | Offline cache or collaboration room reveals stale private content | Authorization on room admission and continuously before updates; canonical save still enforces revision and page access | `server/core/collaboration.ts`; `server/controllers/api/pages.ts`; `server/test/core/collaboration.test.ts`; client collaboration tests | A revoked already-delivered plaintext copy cannot be recalled. Reconnect and mutation are denied after revocation. |
| CONTENT-1 | Markdown/HTML/SVG/content-extension XSS or renderer escape | Allowlisted renderer contract, DOMPurify, forbidden active SVG/HTML elements and style attributes, upload SVG sanitization, CSP/security headers | `server/content-extensions/sanitize.ts`; `server/jobs/sanitize-svg.ts`; `server/middlewares/security.ts`; content-extension renderer and API tests | Custom administrator-authored HTML/theme injection is privileged code execution by design and must be limited to trusted administrators. |
| CONTENT-2 | Malicious links or URL schemes | Explicit protocol allowlist and attribute sanitation | `server/content-extensions/sanitize.ts`; content-extension sanitizer/renderer tests | Other renderer modules remain part of external review scope. |
| NET-1 | SSRF and DNS rebinding through webhooks | HTTPS-only, no URL credentials, private/reserved network blocklist, DNS resolution before enqueue/delivery, validated address pinned during TLS request | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js` | Storage, search, authentication, embeds, import, and media adapters are separate operator-trusted integrations and require deployment-specific canaries. |
| NET-2 | Webhook forgery, replay, or secret disclosure | Random secret, AES-256-GCM encrypted storage, HMAC-SHA256 over timestamp and exact body, delivery/event identifiers, bounded response capture and timeout | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js`; webhook job tests | Receivers must enforce timestamp skew and delivery-ID deduplication; Wiki.ts cannot enforce receiver behavior. |
| EXT-1 | Extension supply-chain or renderer isolation failure | Versioned shared envelope; disabled-by-default registry; administrator-only toggles; sanitized deterministic renderer output | `shared/content-extensions.ts`; `server/core/extensions.ts`; `server/content-extensions`; extension API, migration, and renderer tests | New extension kinds require sanitizer/CSP/export/print review before enablement. No arbitrary third-party runtime loading is supported. |
| JOB-1 | Job payload tampering, duplicate side effects, lease theft, or unbounded retry | Typed handlers validate payload; transactional claim; owner-bound lease completion/failure; bounded attempts; terminal state; idempotent outbox delivery | `server/core/durable-jobs.ts`; `server/core/outbox.ts`; durable-job/outbox/job tests | Real process-kill lease recovery remains an operational release gate. |
| PATH-1 | Archive, filename, upload, import, or export path traversal | Filename sanitation, canonical data roots, page path segment filtering, allowlisted archive package roots | `server/controllers/upload.ts`; `server/helpers/page.ts`; `server/core/asar.ts`; upload/import/export tests | External review must include every archive extractor and operator-supplied path. |
| DATA-1 | Unknown, partial, newer, locked, or unsupported-version PostgreSQL state is mutated, or rollback restores mismatched state | Non-mutating migration preflight; PostgreSQL 15–18 startup guard; pinned source fixture; checksum-verified `pg_dump`/`pg_restore`; paired `/wiki/data` snapshot; old-version boot and authentication after restore | `server/core/db.ts`; `server/db/postgres-version.ts`; `server/db/migration-preflight.ts`; database tests; `dev/e2e/upgrade-smoke.sh`; `.github/workflows/build.yml` | The release matrix covers synthetic PostgreSQL 15–18 state. Operators must canary a restored copy of production data and preserve both snapshots as one recovery point. |
| DATA-2 | Backup or migration secrets leak through files, logs, examples, or artifacts | File-backed Compose/Helm secrets; documented restrictive permissions; release artifacts exclude runtime data and credentials | `dev/examples/docker-compose.yml`; `dev/helm/templates/postgresql-secret.yaml`; deployment documentation | Operators control dump destinations, encryption, retention, and access. Recovery CI must use synthetic credentials only. |
| ADMIN-1 | Administrative endpoint or terminal crosses permission boundary | REST controllers require explicit `manage:*` permissions and return JSON `403` before model mutation; no arbitrary command terminal is shipped | Controller tests under `server/test/controllers/api.*.test.*` | Deployment shell and database access remain outside the application boundary. Any future terminal feature requires a separate threat review and is release-blocking by default. |
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
| SEC-AUTH-001 — TFA and recovery browser journeys incomplete | High | Maintainers | Add deterministic browser journeys and run them in CI. |
| SEC-OPS-001 — real worker process-death lease recovery not yet exercised | Medium | Maintainers | Kill a claimed worker, await lease expiry, prove exactly-once recovery and bounded pool use. |
| SEC-ADAPTER-001 — deployment-specific identity/storage/search/mail integrations are not covered by the generic release matrix | Medium | Operator | Complete an operator canary for every enabled integration. |

## External review record

The first external release remains blocked until an independent reviewer supplies all of the following for a frozen Git revision:

- reviewer identity or organization and review dates;
- scope, environment, exclusions, and threat-model version;
- finding ID, severity, affected boundary, and reproduction evidence;
- fix revision, focused regression proof, reviewer retest, and final disposition;
- explicit statement for unresolved accepted risk.

A maintainer self-review, automated dependency scan, or passing test suite is supporting evidence, not an independent review.
