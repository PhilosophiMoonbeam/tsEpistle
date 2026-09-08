# tsEpistle security threat model

## Status and review contract

| Field | Value |
| --- | --- |
| Product | tsEpistle |
| Model version | 1 |
| Review owner | tsEpistle maintainers |
| Attestation manifest | `docs/security/review-attestations.json` |

This document defines the normative security architecture, asset boundaries, threat catalog, and security control register for tsEpistle. Update this document whenever an authentication flow, externally reachable route, renderer, extension, worker payload, import/export path, database migration, secret boundary, or deployment topology changes.

**Attestation manifest and review workflow:**
Review coverage, reviewer identity, review dates, finding dispositions, cryptographic signatures, and release eligibility are not declared by free-text assertions in this model. They are governed exclusively by immutable, structured review records declared in the attestation manifest `docs/security/review-attestations.json`.

Every review record under `docs/security/review-attestations/` defines:
- **Repository binding**: every record must declare `repository: "PhilosophiMoonbeam/tsEpistle"`.
- **Review kind**:
  - `source-review` for committed Git revisions. Requires a valid detached Ed25519 signature if claiming independence or release eligibility; unsigned records are valid only for non-independent, release-ineligible reviews.
  - `working-tree-audit` for staged working-tree evidence. Working-tree audits capture transient verification state during development and are strictly constrained: they must have `reviewer.independent: false`, `releaseEligible: false`, no `signature` property (omitted or undefined), and `source.fingerprintAlgorithm: "tsepistle-isolated-preview-v1"`. Working-tree audits can never qualify as release attestations.
- **Model binding**: `policyVersion: 1` and `threatModelDigest` (the 64-character lowercase hexadecimal SHA-256 digest of this canonical specification).
- **Reviewer**: identity string, independence flag (`independent: true` required for release), and review timestamp (`reviewedAt` in exact UTC calendar date format `YYYY-MM-DD`).
- **Release eligibility & external Ed25519 signatures**:
  - Official release attestation strictly requires `releaseEligible: true` and `reviewer.independent: true`.
  - Every `source-review` record claiming `reviewer.independent: true` OR `releaseEligible: true`—whether active or a non-active historical entry in the manifest—strictly requires a structurally valid detached Ed25519 signature verified against an externally trusted key in `THREAT_REVIEW_TRUSTED_KEYS_JSON`. In-repository booleans alone never authorize independence or release eligibility; an unsigned or unverified claim in any source-review record fails verification and blocks the gate.
  - Required signature structure:
    ```json
    "signature": {
      "algorithm": "ed25519",
      "keyId": "external-key-id",
      "value": "<signature>"
    }
    ```
  - Signatures are verified against external trusted keys provisioned through the environment variable `THREAT_REVIEW_TRUSTED_KEYS_JSON`:
    ```json
    {
      "schemaVersion": 1,
      "repository": "PhilosophiMoonbeam/tsEpistle",
      "keys": [
        {
          "id": "external-key-id",
          "identity": "External Reviewer <reviewer@example.org>",
          "algorithm": "ed25519",
          "publicKey": "<public-key>"
        }
      ]
    }
    ```
  - Reviewer `identity` in the review record must strictly match the trusted key `identity`, and key configuration `repository` must equal `"PhilosophiMoonbeam/tsEpistle"`.
  - Trusted public keys are provisioned in CI via the public repository variable `vars.THREAT_REVIEW_TRUSTED_KEYS_JSON` (exported to the gate as the environment variable `THREAT_REVIEW_TRUSTED_KEYS_JSON`), providing PR-safe trust-root availability across PR static checks, quality, and release gates. Trusted signing keys (private keys) must be kept strictly external and never stored in this repository. A missing, untrusted, or invalid signature blocks release.
  - Signed payload: UTF-8 string `tsepistle-threat-review-attestation-v1\0` followed by recursively key-sorted compact JSON of the complete review record with the `signature` field omitted.
- **Covered source & boundary tree digest**:
  - For source reviews: exact `revision` (40-character hex commit SHA), parent `baseRevision`, and canonical `coveredTreeDigest`.
  - For working-tree audits: parent `baseRevision`, content `fingerprint`, and `fingerprintAlgorithm: "tsepistle-isolated-preview-v1"`.
  - **Canonical policy v1 security boundary**:
    - Entire `dev/` prefix (covering all build inputs, Dockerfiles, containers, Helm charts, E2E fixtures, benchmarks, and automation scripts);
    - `server/`, `client/`, `shared/`, `deploy/`, `patches/`, `.github/workflows/`, and files matching `.github/actions/**`;
    - Root release and configuration manifests: `package.json`, `bun.lock`, `bunfig.toml`, `biome.json`, `config.sample.yml`, `license-policy.json`, `playwright.config.ts`, `vite.config.mts`;
    - Root TypeScript configuration files matching `tsconfig*.json`;
    - Root packaging, repository attribute, and legal compliance files: `.dockerignore`, `.gitattributes`, `LICENSE`, `NOTICE`. Inclusion is essential for Docker and distribution archive integrity: `.dockerignore` establishes the container build context boundary (preventing unreviewed files or secrets from entering Docker images), `.gitattributes` governs release archive export filtering (`export-ignore`) and line endings for source distributions and release archives, and `LICENSE`/`NOTICE` establish mandatory licensing terms and attribution for container images and archives.
    - Documentation files (`docs/`, including `docs/security/review-attestations.json`, `docs/security/review-attestations/`, and `docs/security/threat-model.md`) are deliberately excluded from `coveredTreeDigest` to make attestation strictly non-circular.
  - **Boundary tree digest computation**:
    - The `coveredTreeDigest` is a 64-character lowercase hex SHA-256 computed over the prefix `tsepistle-security-boundary-v1\0` followed by every non-tree entry under the security boundary (including gitlinks/submodules and blobs) sorted ascending by path: `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.objectId}\0`.
- **Fail-closed working tree, index, and submodule checks**:
  - Verification fails closed on any uncommitted boundary changes, untracked boundary files, ignored boundary files (`git status --ignored`), index flags (`assume-unchanged` or `skip-worktree`), and configuration-independent submodule dirtiness. Any Git enumeration failure is a fatal gate failure.
  - **Canonical generated-ignored build metadata exception**:
    - The exact path "server/.build-metadata.json" is the sole canonical exception to ignored-boundary drift detection.
    - The exception is allowed only when "server/.build-metadata.json" is a non-symlink regular file, realpath-contained within the repository checkout, containing exact-object JSON with strings for `revision` and `date`, where `revision` equals the current Git `HEAD` commit SHA, and `date` is a valid canonical ISO timestamp in exact JavaScript `Date.toISOString()` canonical form `YYYY-MM-DDTHH:mm:ss.sssZ` (matching the canonical output produced by `server/scripts/generate-build-metadata.ts` during `bun run build`).
    - Any malformed JSON, extra or missing properties, non-regular file or symlink, mismatched revision, invalid date timestamp, or any other ignored file under "server/" or elsewhere within the canonical security boundary fails dirty-state checks and causes gate validation to fail closed.
    - Build metadata at this path is gitignored so build artifacts do not pollute source history, and is separately governed by build provenance and release artifact verification rather than working-tree source control.
    - Tracked content at this path remains covered: the path "server/.build-metadata.json" is not excluded from the canonical security boundary definition. If a file at "server/.build-metadata.json" is ever tracked in Git, it is included in the canonical security boundary and digested into `coveredTreeDigest`.
- **Path containment and parser validation**:
  - Governed manifest, threat-model, record, and evidence paths must be repository-relative and realpath-contained within the checkout.
  - Review record and threat-model files must be regular files, never symlinks.
  - All JSON parses start as `unknown` and undergo complete no-throw schema validation.
  - The normative model version must match supported version 1 exactly.

### Example: source-review record schema
```json
{
  "schemaVersion": 1,
  "id": "security-review-2026-09-08",
  "kind": "source-review",
  "repository": "PhilosophiMoonbeam/tsEpistle",
  "policyVersion": 1,
  "threatModelDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "reviewer": {
    "identity": "External Reviewer <reviewer@example.org>",
    "independent": true,
    "reviewedAt": "2026-09-08"
  },
  "releaseEligible": true,
  "source": {
    "revision": "55f30709cd4b8de0ec1fd498cac7174f1cacd084",
    "baseRevision": "25c17cb74359fea7564c5d59118ff75b9ede6c77",
    "coveredTreeDigest": "571ba91dd7d408c55d1adc831ff0bdc11873bc5f9f517c31fc3015d9c630b260"
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "external-key-id",
    "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "findings": [],
  "evidencePaths": [
    "docs/security/review-history.md",
    "docs/security/threat-model.md"
  ]
}
```

### Example: working-tree-audit record schema
```json
{
  "schemaVersion": 1,
  "id": "search-foundation-2026-09-07",
  "kind": "working-tree-audit",
  "repository": "PhilosophiMoonbeam/tsEpistle",
  "policyVersion": 1,
  "threatModelDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "reviewer": {
    "identity": "tsEpistle maintainers",
    "independent": false,
    "reviewedAt": "2026-09-07"
  },
  "releaseEligible": false,
  "source": {
    "baseRevision": "d3d5a63326c056bb847fdb2552be0a1cf1eb7020",
    "fingerprint": "3adffcba7255a3f88ec490ceffefe6f826e9508a",
    "fingerprintAlgorithm": "tsepistle-isolated-preview-v1"
  },
  "findings": [],
  "evidencePaths": [
    "docs/security/threat-model.md"
  ]
}
```

The chronological review diary covering historical maintainer reviews up to Git revision `55f30709cd4b8de0ec1fd498cac7174f1cacd084` is preserved in `docs/security/review-history.md`.

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

The installed Knex ledger is one append-only schema authority. Wiki.js history is inherited through `2.5.128.js`; legacy fork migrations `2.5.129.js` through `2.5.159.js` and deployed `tsfranki-000001` through `tsfranki-000012` identifiers remain immutable compatibility records from the former tsFranki namespace; new tsEpistle migrations use the `tsepistle-000013+` namespace. Product release versions never determine migration identity, and published names are never renamed or reordered.

`tsfranki-000001-schema-lineage.js` records that boundary in `schemaLineage` under the immutable former `tsfranki` product identity. Preflight accepts a pre-marker legacy ledger only when the private-page schema created by `2.5.129.js` attests its fork lineage. This prevents a future upstream migration with the same filename but different effects from being mistaken for an applied historical `tsfranki` migration.

A Wiki.js source database whose ledger extends beyond `2.5.128.js` is unsupported until a source-specific adoption bridge validates that exact upstream schema and appends an equivalent tsEpistle migration. Upstream migrations are adapted after the immutable deployed `tsfranki-000001` through `tsfranki-000012` prefix under the `tsepistle-000013+` namespace; they are never inserted into, or allowed to reinterpret, the installed prefix.

## Threat and control register

| ID | Threat | Required control | Current implementation and executable evidence | Residual risk / release state |
| --- | --- | --- | --- | --- |
| AUTH-1 | Credential stuffing against HTML and REST login | Shared durable counters, escalating waits, deterministic `429`, `Retry-After`, reset only for the resolved client | `server/helpers/auth-rate-limiter.ts`; `server/controllers/auth.ts`; `server/controllers/api/auth.ts`; `server/test/helpers/auth-rate-limiter.test.js`; `server/test/controllers/auth.test.js`; `server/test/controllers/api.auth.test.js` | Controlled for configured instances. Client separation depends on the one-hop proxy topology in AUTH-2. TFA/recovery browser abuse journeys remain part of the release matrix. |
| AUTH-2 | Forwarded-header spoofing or client coalescing | Express-resolved `req.ip`; forwarding headers never parsed by the limiter; startup, saving replica, and distributed reloads map boolean proxy trust to exactly one direct trusted hop | `server/master.ts`; `server/operations/site.ts`; `server/core/config.ts`; `server/helpers/auth-rate-limiter.ts`; `server/test/core/trust-proxy.test.ts`; `server/test/core/config-reload.test.ts`; `server/test/controllers/api.site.test.js`; `server/test/helpers/auth-rate-limiter.test.js` | Operator must leave proxy trust off for direct deployments. When enabled, one sanitizing reverse proxy must be the only path to a non-public application port. A direct, multi-hop, or variably short path can spoof or coalesce identities. |
| AUTH-3 | Session fixation, stolen JWT, stale privileges, API-key privilege drift, or API-key use at an unintended route | Issuer/audience/signature checks; user/group revalidation; API-key admission allowlisted to exact GraphQL, REST v1, and separately mounted MCP transports; API principal receives assigned group policy and no private-page ownership identity | `shared/api-access.ts`; `server/core/auth.ts`; `server/agents/mcp.ts`; `server/test/core/auth.api-access.test.ts`; `server/test/agents/mcp.test.ts` | Operators must enable and expose API/MCP access deliberately, use TLS, and protect bearer values from logs and clients that do not need them. A stolen key can exercise its live group authority on its admitted transports until revocation; route confinement prevents web-session impersonation. |
| AUTH-4 | TFA, recovery, password-change, registration, or page-unlock brute force; mail scanners consuming recovery actions | Threat-weighted POST rate limits and continuation-token validation; verification and reset landing GETs validate without consuming the token or a rate-limit attempt; only the explicit action POST consumes the token | `server/controllers/auth.ts`; `server/controllers/api/auth.ts`; `server/test/controllers/auth.test.js`; `server/test/controllers/api.auth.test.js`; password-page controller/model tests | Operators must deliver recovery links over TLS and preserve the GET-to-explicit-POST flow. Anyone who obtains a live link can still submit the action, and the non-consuming landing is not itself a brute-force control. |
| AUTH-5 | Third-party OAuth login CSRF or session swapping | An unpredictable OAuth `state` value is bound to the initiating server session and consumed exactly once before token exchange; HTTPS public hosts use Secure, HttpOnly, SameSite=Lax session cookies; live HTTP-to-HTTPS changes rotate and invalidate sessions before route handling | `server/modules/authentication/dropbox/dropbox-strategy.ts`; `server/modules/authentication/dropbox/dropbox-strategy.test.ts`; `server/helpers/session-cookie.ts`; `server/master.ts`; `server/operations/site.ts`; `server/test/core/trust-proxy.test.ts`; `server/test/controllers/api.site.test.js` | The browser session must persist from authorization initiation through callback. HTTP session cookies remain available when the operator explicitly disables HTTPS. |
| AUTH-6 | An unverified federated email claims a pending account, passes a registration domain allowlist, or receives automatic groups | Provider profile validation must reject unverified or malformed email claims before generic account linking and registration | `server/modules/authentication/dropbox/dropbox-strategy.ts`; `server/modules/authentication/dropbox/dropbox-strategy.test.ts`; `server/models/users.ts` | Each federated provider remains responsible for establishing the trustworthiness of identity claims before invoking shared account processing. |
| PAGE-1 | Private page enumeration or read across owner boundary | Single owner/private decision, namespace separation, query scoping, not-found non-disclosure | `server/helpers/page-access.ts`; `server/test/helpers/page-access.test.ts`; `server/test/models/pages.private-errors.test.js`; private SQLite/PostgreSQL integration tests | Route-level matrix must remain green for every derived resource. |
| PAGE-2 | Conflicting group rules create order-dependent privilege escalation | Global permission prerequisite; most-specific rule wins; exact outranks prefix; deny wins ties; invalid regex is non-matching | `server/core/auth.ts`; `server/test/core/auth.page-rules.test.ts` | Policy changes require an administrator-facing compatibility note. No force-allow rule exists. |
| PAGE-3 | Leakage through search, tree, links, history, source, counts, collisions, exports, comments, or assets | Shared page scoping and authorization before resource lookup; the PostgreSQL vector contains only published public pages; password-protected body text is omitted; owner-private search runs only after requester scoping; durable search effects are revision- and source-hash-fenced | `server/operations/pages.ts`; `server/modules/search/postgres/engine.ts`; `server/core/page-mutation-outbox.ts`; `server/test/operations.pages.search.test.js`; `server/test/modules.search.postgres.test.js`; `server/test/models/pages.private-errors.test.js` | Password-protected title, path, description, and tags remain intentionally discoverable to otherwise authorized callers. Protected body and historical versions require password unlock. |
| PAGE-4 | Offline cache or collaboration room reveals stale private content | Authorization on room admission and continuously before updates; canonical save still enforces revision and page access | `server/core/collaboration.ts`; `server/controllers/api/pages.ts`; `server/test/core/collaboration.test.ts`; client collaboration tests | A revoked already-delivered plaintext copy cannot be recalled. Reconnect and mutation are denied after revocation. |
| OKF-1 | Forged OKF authority, trust, restore, or import claims grant undeserved verification or silently downgrade malformed claimed documents to legacy content | Server-owned producer and trust fields; validated actor/timestamp provenance; imports are external evidence and cannot issue local verification; a claimed OKF document that is malformed is rejected rather than parsed as legacy; API/MCP principals are resolved before page actions | `server/okf/format.ts`; `server/modules/storage/page-document.ts`; `server/models/pages.ts`; `server/controllers/api/pages.ts`; `server/agents/mcp.ts`; `server/test/okf-format.test.ts`; `server/test/modules/storage.page-document.test.ts`; `server/test/models/pages.metadata.test.js`; `server/test/controllers/api.pages.test.js` | Storage imports cannot forge local authority, but an administrator with storage access can still write raw content. |
| OKF-2 | YAML parser/resource exhaustion, prototype-key pollution, oversized frontmatter, or deeply nested metadata | JSON-compatible YAML schema with no aliases/merges; 1 MiB document and 64 KiB frontmatter bounds; 20-level and 5,000-value tree limits; dangerous-key rejection; bounded tags, sources, and verification events | `server/okf/format.ts`; `server/modules/storage/page-document.ts`; `server/test/okf-format.test.ts`; `server/test/modules/storage.page-document.test.ts` | Bounds limit parser and document work but do not make arbitrary operator-provided storage content trustworthy. |
| OKF-3 | An authorized principal reads a private or historical OKF resource outside its page scope, or receives a stale resource/projection after authority or source identity changes | MCP requires an API-key resource claim and `use:mcp`/system authority; action authorities are hashed, rechecked against live admission, and fenced before side effects; page reads pass the requester through shared owner/path policy; canonical resource URIs and responses bind page/version/source revision and projection scope | `server/controllers/api/pages.ts`; `server/agents/mcp.ts`; `server/agents/actions/kernel.ts`; `server/agents/actions/page-reads.ts`; `server/operations/pages.ts`; `server/helpers/page-access.ts`; `server/models/pages.ts`; `server/test/controllers/api.pages.test.js` | Principals with authorized access still receive the content they are permitted to read. Historical versions require explicit version authority. |
| OKF-4 | Page or asset path traversal, canonical-name collision, remote object-prefix confusion, or symlink import escapes the configured storage boundary | Markdown uses locale-qualified canonical OKF paths; disk resolves and contains paths under its configured root and skips file/directory symlinks; object-key prefixes discard traversal segments; SFTP and Azure use the same canonical page identity while retaining legacy non-Markdown paths | `server/modules/storage/page-document.ts`; `server/modules/storage/disk/storage.ts`; `server/modules/storage/disk/common.ts`; `server/modules/storage/object-key.ts`; `server/modules/storage/sftp/storage.ts`; `server/modules/storage/azure/storage.ts`; `server/test/modules/storage.disk.test.js`; `server/test/modules/storage.azure.test.ts` | Custom storage drivers must maintain path containment independently. |
| OKF-5 | Authority backfill overwrites a concurrently changed page/history row or mutates a ledger with ambiguous migration identity | Batched backfill updates only rows whose id, source revision, and selected timestamp still match the snapshot; existing claims, including malformed/future extensions, are preserved; immutable legacy order and contiguous namespaced migration identity are enforced | `server/db/migrations/tsfranki-000007-okf-authority-backfill.ts`; `server/db/migration-contract.ts`; `server/test/db/okf-authority-backfill-migration.test.ts`; `server/test/db/migration-contract.test.ts` | CAS prevents this backfill from overwriting a changed row, but unsupported upstream lineage or an operator-restored database remains a release-blocking migration state. |
| OKF-6 | Derived render/link/search/knowledge or utility enrichment publishes a stale, wrong-source, or unauthorized revision | Projection intents are transactional, hash-bound, idempotent, lease-owned, and revision-fenced; deterministic knowledge is written before optional utility calls; utility output fills only declared gaps with provenance; current revision and source hash are rechecked after enrichment and mismatches are superseded | `server/core/page-mutation-outbox.ts`; `server/knowledge/projection.ts`; `server/knowledge/lifecycle.ts`; `server/models/pages.ts`; `server/test/core/page-mutation-outbox.test.ts`; `server/test/core/outbox.test.ts`; `server/test/knowledge-projection.test.ts`; `server/test/knowledge-lifecycle.test.ts`; `server/test/db/knowledge-projections-migration.test.ts` | Delayed workers can leave a projection pending or superseded until replay/maintenance. A previously delivered derived copy cannot be recalled; utility providers remain operator-trusted integrations. |
| CONTENT-1 | Markdown/HTML/SVG/content-extension XSS, renderer escape, or a misleading CSP configuration | Allowlisted renderer contract, DOMPurify, forbidden active SVG/HTML elements and style attributes, upload SVG sanitization; when enabled, CSP emits exactly one configured value that passes HTTP header-value validation and omits invalid values | `server/content-extensions/sanitize.ts`; `server/jobs/sanitize-svg.ts`; `server/middlewares/security.ts`; `server/test/middlewares/security.test.ts`; content-extension renderer and API tests | Operators own the CSP directives and must verify the effective browser policy; the application neither generates a baseline nor rejects a syntactically valid but weak policy. Trusted page-script authority is covered by SCRIPT-1. |
| CONTENT-2 | Malicious links or URL schemes | Explicit protocol allowlist and attribute sanitation | `server/content-extensions/sanitize.ts`; content-extension sanitizer/renderer tests | Other renderer modules remain part of external review scope. |
| LOGO-1 | An unauthorized or malicious managed-logo upload consumes parser/decoder resources, publishes a partial or stale branding bundle, exposes source bytes, creates cache-amplified database work, or causes credentialed/external browser requests | Exact `manage:system` pre-body authorization; one multipart byte-identified file with hard byte/pixel/frame/channel limits; deterministic sRGB processing and contrast/suitability gates; the generator emits 2,000..8,000 particles with eight deterministic reservations per component, while the particle parser caps records at 16,000; active descriptors require integer `pipelineVersion` in `1..5`, v1..4 presentation uses full core factor `1`, v5 uses exact factor `2/3`, and invalid/future versions use ordinary-logo fallback; immutable role/hash objects; transaction, revision, retry-sequence, job, lease, and absolute-deadline fencing; strict protocol pairs `process-site-logo@1`/pipeline v1..3, `process-site-logo@2`/v4, and `process-site-logo@3`/v5, with default `@1`/`@2` no-op terminal replay and nonterminal `PROCESSING_FAILED` before source read, v5 execution, or publication; failed/retried candidates preserve active v4 branding and retry as `@3`/v5; bounded canonical public-object cache; credentialless same-origin particle fetch; static-first renderer with unchanged reduced-motion/mobile gates and synchronous error teardown; desktop motion is GPU-only bounded shader work with idle 3.5..10px, depth 0.82..1.18, six cursor slots, >2px sampling threshold, 20px event cap, 14px aggregate cap, 1.4s impulse lifetime, neighbor force 0.32, bounce 0.22, six explosion slots, 0.35s fade/hold, 2.4s refill, 2.8s absolute expiry, click/primary-touch input only, saturation drop, deterministic commutative overlap, and no CPU per-particle loop or hot allocations; exact native-image processing gates remain source/local evidence only | `server/master.ts`; `server/controllers/api/site-logo.ts`; `server/controllers/site-logo.ts`; `server/operations/site-logo.ts`; `server/core/durable-jobs.ts`; `server/jobs/durable-job-handlers.ts`; `server/jobs/site-logo-process.ts`; `server/helpers/site-logo-processing.ts`; `client/components/login-logo`; `.github/workflows/build.yml`; `server/test/controllers/api.site-logo.test.ts`; `server/test/controllers/site-logo.test.ts`; `server/test/jobs/site-logo-process.test.ts`; `server/test/helpers/site-logo-processing.test.ts`; `dev/e2e/login-logo.e2e.ts`; local evidence only: targeted unit/server/type/build checks, focused Chromium visual-interaction checks, and the retried 16k performance report (p95 frame ~16.8ms, p99 ~17ms, CPU p95 ~0.1ms, explosion peak 4, impulse peak 6, recovery 0) | Pre-compatibility workers must be drained and stopped fleet-wide before capability-fenced processing; every worker may claim only its advertised exact protocol pair. Version-aware web renderers must be deployed and every old renderer drained or inactivated before `@3` processing or v5 activation is enabled, because old clients cannot interpret v5 sizing. Default legacy `@1` and compatibility `@2` remain only for terminal no-op replay and safe failure of paired nonterminal work; rollback stops new v5 enqueue, preserves active v4 branding, and relies on lease, revision, retry-sequence, and absolute-deadline fencing. Image decoder defects remain possible despite bounds and native-image gates. Public derived objects are intentionally anonymous and disclosed by active descriptors; operators must keep the application behind ordinary TLS and edge abuse controls. Browser/device and container reports remain historical or local release evidence, not authorization controls, and no deployment or live-production state is claimed. |
| NET-1 | SSRF and DNS rebinding through webhooks | HTTPS-only, no URL credentials, private/reserved network blocklist, DNS resolution before enqueue/delivery, validated address pinned during TLS request | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js` | Storage, search, authentication, embeds, import, and media adapters are separate operator-trusted integrations and require deployment-specific canaries. |
| NET-2 | Webhook forgery, replay, or secret disclosure | Random secret, AES-256-GCM encrypted storage, HMAC-SHA256 over timestamp and exact body, delivery/event identifiers, bounded response capture and timeout | `server/core/webhooks.ts`; `server/test/core/webhooks.test.js`; webhook job tests | Receivers must enforce timestamp skew and delivery-ID deduplication; tsEpistle cannot enforce receiver behavior. |
| EXT-1 | Extension supply-chain or renderer isolation failure | Versioned shared envelope; disabled-by-default registry; administrator-only toggles; sanitized deterministic renderer output | `shared/content-extensions.ts`; `server/core/extensions.ts`; `server/content-extensions`; extension API, migration, and renderer tests | New extension kinds require sanitizer/CSP/export/print review before enablement. No arbitrary third-party runtime loading is supported. |
| JOB-1 | Job or page-projection payload tampering, duplicate side effects, lease theft, stale revision overwrite, or unbounded retry | Typed handlers validate canonical payload hashes; capability-aware claim filtering permits a worker to claim only an advertised exact protocol pair; transactional claim; dependency-aware render/link/search/knowledge effects; revision, source-hash, retry-sequence, lease, and absolute-deadline fences; owner-bound lease completion/failure; bounded attempts; poison-row quarantine; idempotent outbox delivery; managed-logo protocols are strictly paired as `process-site-logo@1`/v1..3, `@2`/v4, and `@3`/v5; default `@1`/`@2` handlers no-op paired terminal work, fail paired nonterminal work with `PROCESSING_FAILED` before source read, v5 invocation, or publication, preserve active v4, and leave retry to create `@3`/v5 work | `server/core/durable-jobs.ts`; `server/core/outbox.ts`; `server/core/page-mutation-outbox.ts`; `server/knowledge/lifecycle.ts`; `server/jobs/durable-job-handlers.ts`; `server/jobs/site-logo-process.ts`; durable-job, outbox, page-mutation-outbox, and knowledge-lifecycle tests | Capability filtering keeps legacy `@1`/v1..3, compatibility `@2`/v4, and current `@3`/v5 work separate. Version-aware web renderers must replace and drain/inactivate old renderers before `@3` processing or v5 activation is enabled. A failed or retried old candidate remains non-active and the active v4 revision is preserved. Lease expiry is an absolute deadline, expired work is stopped/reclaimed under lease and revision fencing, and terminal tamper evidence is retained for operator investigation rather than silently rewritten. Real process-kill lease recovery remains operational evidence; these statements make no deployment or live-production claim. |
| PATH-1 | Archive, filename, upload, import, or export path traversal | Filename sanitation, canonical data roots, page path segment filtering, allowlisted archive package roots | `server/controllers/upload.ts`; `server/helpers/page.ts`; `server/core/asar.ts`; upload/import/export tests | External review must include every archive extractor and operator-supplied path. |
| DATA-1 | Unknown, partial, newer, locked, unsupported-version, or same-name/different-lineage PostgreSQL state is mutated, or rollback restores mismatched state | Non-mutating migration preflight; immutable legacy manifest through `2.5.159.js`; deployed `tsfranki-000001` through `tsfranki-000012` identifiers remain immutable compatibility records; new migrations use the `tsepistle-000013+` namespace; durable schema-lineage marker rooted at upstream cutoff `2.5.128.js`; structural attestation for pre-marker legacy ledgers; PostgreSQL 15–18 startup guard; pinned source fixture; checksum-verified `pg_dump`/`pg_restore`; paired `/wiki/data` snapshot; old-version boot and authentication after restore | `server/core/db.ts`; `server/db/migration-contract.ts`; `server/test/db/migration-contract.test.ts` | Restoring a database without its corresponding `/wiki/data` storage or secret configuration will prevent startup. |
| DATA-2 | Backup or migration secrets leak through files, logs, examples, or artifacts | File-backed Compose/Helm secrets; documented restrictive permissions; release artifacts exclude runtime data and credentials | `dev/examples/docker-compose.yml`; `dev/helm/templates/postgresql-secret.yaml`; deployment documentation | Operators control dump destinations, encryption, retention, and access. Recovery CI must use synthetic credentials only. |
| ADMIN-1 | Administrative endpoint or terminal crosses permission boundary | REST controllers require explicit `manage:*` permissions and return JSON `403` before model mutation; no arbitrary command terminal is shipped | Controller tests under `server/test/controllers` | Deployment shell and database access remain outside the application boundary. Any future terminal feature requires a separate threat review and is release-blocking by default. |
| SCRIPT-1 | A delegated content author installs same-origin JavaScript and crosses user or administrative boundaries | `write:scripts` is treated as system-equivalent authority when granting, retaining, or assigning group permissions; page script writes still require the permission and applicable page rule | `server/operations/groups.ts`; `server/models/pages.ts`; `server/core/auth.ts`; `server/test/operations.groups.test.ts` | Operators must grant `write:scripts` only to principals trusted like system administrators and review already-published scripts when authority changes. Such code runs on the ordinary origin and can act with each viewer's signed-in application authority; CSP and content sanitation are not a sandbox for it. |
| SUPPLY-1 | Dependency compromise or artifact/source mismatch | Frozen lockfile, policy-checked install, pinned build images/actions, exact revision metadata, corresponding source, SBOM, license inventory, checksums, OCI provenance labels | `package.json`; `bun.lock`; `.github/workflows/build.yml`; `server/scripts/export-build-environment.ts`; `server/scripts/check-threat-model.ts`; product-build tests | Independent provenance verification and external review remain required before the first external release. |

## Executable security gate

Run the dependency and focused security contracts before the broader project gates:

```console
bun run dependencies:check
bun run licenses:check
bun run test:security
bun audit --production
bun run typecheck:server
```

The executable attestation gate is enforced by `server/scripts/check-threat-model.ts` (invoked via `bun run threat-model:check` or directly via `bun server/scripts/check-threat-model.ts`).

The script verifies:
1. Manifest validity: reads `docs/security/review-attestations.json`, ensures regular-file repository containment, and verifies active review record integrity with complete no-throw schema validation.
2. Threat model specification binding: asserts that the SHA-256 digest of this file matches `threatModelDigest` recorded in the active review record, and ensures model version matches version 1 exactly with unique contract sections.
3. Revision ancestry and existence: verifies that the active covered Git revision exists in the local repository and is an ancestor of `HEAD`.
4. Boundary tree hash verification: computes the canonical security-boundary tree digest (`tsepistle-security-boundary-v1`) across all non-tree entries (including gitlinks and full `dev/` prefix coverage) and validates it against `coveredTreeDigest` in the active review record.
5. Repository citations and tooling: confirms all cited paths exist, dependencies are frozen with `bun.lock`, and gate commands match this specification.
6. Release mode (`--release`): enforces zero uncommitted working-tree boundary drift, clean repository status including ignored boundary files (with the sole canonical exception of a non-symlink regular file "server/.build-metadata.json" containing exact canonical JSON whose `revision` matches `HEAD` and whose `date` is a valid canonical ISO timestamp in exact JavaScript `Date.toISOString()` canonical form `YYYY-MM-DDTHH:mm:ss.sssZ`), index `assume-unchanged`/`skip-worktree` flags, and submodule dirtiness; requires `reviewer.independent: true`, `releaseEligible: true`, zero blocking findings, and an exact covered-tree digest match against `HEAD`.
7. External signature verification: requires a valid detached Ed25519 signature verified against external `THREAT_REVIEW_TRUSTED_KEYS_JSON` for every `source-review` record claiming `reviewer.independent: true` or `releaseEligible: true`, whether active or historical; working-tree audits must be non-independent and release-ineligible without signatures.

The full release matrix additionally owns browser non-disclosure, proxy topology, database upgrade/restore, multi-instance, Helm, accessibility, and provenance scenarios. A focused pass does not substitute for those gates.

## Findings governance and external review workflow

Current finding status, dispositions, accepted risks, and release eligibility are exclusively derived from the active structured review record declared in `docs/security/review-attestations.json`. Prose specifications and markdown tables must not duplicate or declare current finding dispositions independently; frozen chronological narrative and historical review diaries live in `docs/security/review-history.md`.

To qualify a release candidate through independent review, the reviewer must supply all of the following for a frozen Git revision:

- reviewer identity or organization and review date (`reviewedAt` in exact UTC calendar date format `YYYY-MM-DD`) matching an externally provisioned key in `THREAT_REVIEW_TRUSTED_KEYS_JSON`;
- a valid detached Ed25519 cryptographic signature over the canonical payload prefix `tsepistle-threat-review-attestation-v1\0` concatenated with compact JSON with recursively sorted keys (omitting `signature`);
- scope, environment, exclusions, and threat-model digest binding;
- finding identifiers, severity, affected boundary, and reproduction evidence;
- fix revision, focused regression proof, reviewer retest, and final structural disposition (`"resolved"` or `"accepted"`);
- explicit written justification for any unresolved accepted risk cited in valid evidence paths.

A maintainer self-review, working-tree audit, automated dependency scan, or passing test suite is supporting evidence, not an independent release attestation.
