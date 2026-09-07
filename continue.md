# Administration overhaul — final release handoff

Updated after independent validation on 7 September 2026. The broad **27-area Administration scope is complete**, with the independent review's corrections now deployed. Current application release: **`4d14659364f619c772f335d07190d9d3e73ce2c8`**, image **`tsepistle:4d146593`**. Documentation-only commits may follow. Read [`docs/administration-independent-review.md`](docs/administration-independent-review.md) alongside this handoff: the successor's original completion claim missed real redaction, recovery and usability gaps.

The user explicitly confirmed **PostgreSQL + OKF** as the architecture. The MongoDB user importer, its UI/API execution path, driver dependency and unused BSON patch have been removed. Do not reintroduce MongoDB. Old operation receipts/migration history remain readable; new `import-v1-users` requests return 400 without a receipt. Git/local-folder content import remains.

The independent review also strengthened live-log redaction and Utilities terminal-write recovery/heartbeats, prioritized supported logging providers, made Content maintenance the Utilities default, restored mobile text visibility, fixed two phone contrast defects and delayed import validation errors until interaction. Independent evidence includes 48 real-PostgreSQL cases/224 assertions, 68 corrected preview views, 68 deployed detailed views, all administration landing routes and four GraphQL checks. All current targeted checks pass; see the review for the exact full-suite provenance and one transient native section-load observation.

Authoritative long-form history: [`docs/administration-overhaul-ledger.md`](docs/administration-overhaul-ledger.md). This document is the current operational handoff.

## Operating standard

1. Follow every administrator job from UI through transport, current authorization, persistence, process effect and recovery. Do not add inert controls.
2. Keep **draft**, **saved policy**, **running process** and **observed evidence** distinct. A configured destination or allocated transport is not delivery evidence.
3. Privileged writes require a meaningful reason, fingerprint/revision protection and current human/API authority. Recheck authority immediately before effects; attribute API-key actions to the key, never a synthetic administrator.
4. Commit persistence before publishing process state. Report saved-but-not-applied outcomes honestly; preserve unrelated settings and secrets; use explicit credential keep/replace/clear behavior.
5. Record consequential work before side effects. Use request IDs, concurrent-operation exclusion, phases and durable receipts. Refresh/recovery reads an existing receipt and must never replay an unconfirmed mutation.
6. Provide loading, empty, validation, conflict, dirty-navigation, error, recovery and keyboard/focus states. Reject duplicate submissions and stale async responses.
7. Keep nested sections addressable with stable query URLs. Admin router paths are relative to `/a`; use `router.replace({ query: ... })` for same-area navigation.
8. Use real PostgreSQL for transactions, locks, concurrency and persistence faults; use local fixtures for transport effects. Never contact SMTP, ACME, Sentry or other external services merely to test.
9. Verify desktop/mobile, theme, dialog and recovery behavior; audit scoped accessibility, overflow, errors and external requests/writes. Transport-isolated visual evidence does not replace native live workflow evidence.
10. For future releases: commit reviewed source, take a fresh mode-0600 validated backup and preserve rollback compose; replace only the wiki image; then prove health, revision, migration and reversible live workflows.

## Four-area architecture and authority map

All workspace routes are under `/_api`, return no-store responses, require `manage:system`, and use current-authority operations and existing shared/client contracts.

| Area | UI / client transport | Shared / server authority | API and behavior boundary |
| --- | --- | --- | --- |
| Logging | `client/components/admin/admin-logging.vue`, `admin-logging-console.vue`, `logging-workspace.scss`; `client/helpers/logging-workspace-api.ts` | `shared/logging-workspace.ts`; `server/operations/logging.ts`, `logging-live-trail.ts`; `server/controllers/api/logging.ts` | `GET/PUT /_api/logging/workspace`, `POST /workspace/apply`, bounded SSE `GET /live`. Save/apply are separate. The live trail rechecks authority, caps connections/events, redacts output, and is operational evidence—not a durable archive or delivery claim. |
| Extensions | `client/components/admin/admin-extensions.vue`, `extensions-workspace.scss`; `client/helpers/extensions-workspace-api.ts` | `shared/extensions-workspace.ts`; `server/operations/extensions-workspace.ts`; `server/controllers/api/extensions.ts` | Read-only `GET /_api/extensions/workspace` reports deployment-owned installed-image, capability and dependency observations. It does not install/remove/mutate extensions or infer runtime health. Content-extension enablement remains separately owned by `/_api/content-extensions`. |
| Utilities | `client/components/admin/admin-utilities.vue` plus import/export/content/cache/auth/telemetry/review components; `client/helpers/utilities-workspace-api.ts` | `shared/utilities-workspace.ts`; `server/operations/utilities-workspace.ts`; migration `server/db/migrations/tsepistle-000026-utilities-operations.ts`; `server/controllers/api/utilities.ts` | `GET /_api/utilities/workspace`, `POST /operations`, `GET /operations/:id`. Durable receipts include actor/request identity, acknowledgement and crypto-fenced recovery. Portable exports are bounded/paginated and never expose credentials, private paths, raw secrets or unrestricted data. |
| Developer flags | `client/components/admin/admin-dev-flags.vue`, `developer-flags-workspace.scss`; `client/helpers/developer-flags-api.ts` | `shared/developer-flags.ts`; `server/operations/developer-flags.ts`; `server/controllers/api/developer-flags.ts` | `GET/PUT /_api/developer-flags/workspace`, `POST /workspace/apply`. Only grounded diagnostics are supported. A saved policy is **staged** until separately applied/promoted; the process report shows whether it is applied/current. Legacy System flag writes are retired. |

## Successor release proof — historical evidence

The final source gates passed: full suite **468/468**; shared/client/server type checks, lint, dependency and license checks (808 dependencies), placeholder checks, Vite and bundle budgets. Seven real-PostgreSQL suites passed **46 cases / 220 assertions**, including API availability/current-authority repair. Migration 26 was first exercised only on an isolated restored preview.

The local Sentry fixture delivered exactly two envelopes (warning/error), then none after disablement; no external Sentry was contacted. The final preview passed **114 views** with zero scoped aXe findings, overflow, page errors, external requests or unexpected writes; native Flags keyboard/pointer checks passed. Recovery UI protected Sentry/import drafts without actual fixture mutations; bounded trail evidence retained 500 escaped records and four populated-trail audits passed with zero findings.

The corrected portable export passed with 14 exact public IDs, excluded private page 3 and used directory/file modes 0700/0600. The isolated API/global-state and signing-rotation workflow passed scoped-key enable/disable/restore, receipt reauthentication, revoked-key recording and unchanged encryption-root hash. No production signing rotation occurred. Actual-disk content import passed for page 37: source bytes remained unchanged, Storage configuration/runtime were exactly restored and the fixture was deleted. The corrected import has public identity/revision, default executor and full phase fencing.

Ignored non-secret reports/screenshots may remain under `.playwright-cli/admin-review`; old failed Utility export/busy-state artifacts remain historical only and must not be represented as final evidence.

## Current maintained deployment and verification history

- Live URL: **https://agents8c48g.tail41a24a.ts.net:10443**.
- Service: `wiki-tailnet`, compose `/home/bbferko/.local/state/wiki-tailnet/compose.yml`, wiki-only correction deployment at `2026-09-07T09:49Z`.
- Image/revision: `tsepistle:4d146593`, exact released revision `4d14659364f619c772f335d07190d9d3e73ce2c8`.
- Health: `http://127.0.0.1:3014/healthz` returned HTTP 200 with `{"ok":true}` after cleanup.
- Database: PostgreSQL 17 service `wiki-postgres`, database/user `wiki`; migration `tsepistle-000026-utilities-operations.js` is applied in `migrations`. Never print credentials or raw settings.
- Final backup: `/home/bbferko/.local/state/wiki-tailnet/backups/before-independent-administration-review-20260907T094808Z.dump`, 2,912,470 bytes, mode 0600, 665 validated `pg_restore --list` lines.
- Rollback compose: `/home/bbferko/.local/state/wiki-tailnet/compose.before-4d146593.yml`, retaining successor image `13001f7c` on the same migration-26 schema. Inspect compatibility before downgrade; database restoration is destructive and requires explicit authorization. The existing compose-volume warning remains; no volumes were recreated.

The successor release’s historical live detailed verification passed 114 views with zero scoped aXe findings, overflow, page errors, external requests or writes. The final cross-area review recorded 591 unique area/view/width/theme observations across all 26 `/a` destinations plus Dashboard at 1440/900/390 in light/dark; all navigation sections were keyboard-activated. GraphQL separately passed six aXe/overflow views and six native typed-query retention checks. The Mail audit does not claim aXe coverage inside its intentionally sandboxed preview iframe: aXe encountered a cross-origin `SecurityError`; host chrome/navigation and screenshots were verified. The earlier 126 nested-preview source observations remain separate historical proof.

Live workflow checks saved/applied Logging JSON, then restored `info`/`default`; Flags were staged true without enabling, then restored false, with SQL logging never enabled; utility cache receipt `534b4133-c21b-4ebb-8f3f-13f32b9addfe` succeeded. Dialog/aXe checks were clean. Baseline comparison confirmed original live pages, source revisions, visibility, owners, Storage, loggers and flags unchanged. Console keys originally absent/inherited are now explicitly `info`/`default`; retained administration history and the utility receipt are intentional. Locale catalog contents are unchanged; `observedAt` refreshed at startup.

The latest independent correction release passed 68 detailed native-transport views with zero scoped accessibility/overflow/page-error findings or external requests/writes. Separate native checks verified the retired importer rejection, keyboard/default workflows and current Logging/Flags state. Exact selected-policy and logger configuration comparisons passed; no receipt was created by the rejected importer request. Temporary independent-review database infrastructure, credentials, auth export and baseline snapshots were removed.

No live signing rotation, guest reset, import/export, external Sentry/email/ACME/storage effect was exercised. Those dangerous effects were proved only in clone/loopback environments.

## Verification lessons and ongoing limits

Use actual assets/API transport for native workflows. When host network-change churn requires read-transport isolation for a visual matrix, separately prove native paths. Use real mobile viewport metadata. For GraphiQL, wait for DOM readiness rather than `networkidle`. Use fixture-only data; restore changed state and remove fixtures, browser auth copies, temporary credentials and disposable infrastructure.

Cleanup is complete: the preview hub stopped; disposable PostgreSQL 17 container/databases, temporary PostgreSQL environment, preview config/data/dump, private live-before snapshot, browser-auth copies and throwaway drivers were removed. Maintained backup/rollback artifacts and ignored non-secret reports remain.

SSL remains an operating limitation: Bun does not provide `https.Server.setSecureContext`, so certificate replacement needs an explicitly acknowledged listener restart; issuance saves material and is reviewed/applied separately; renewal is startup-only with a five-day threshold, not a periodic scheduler.

No identified Administration correction or release gate remains outstanding. The independent review records the limits of that acceptance; it is not a claim that the product can contain no further defects. For future changes, follow the operating standard and release procedure above, preserve the final live baseline, and add only observed evidence to this handoff and the ledger.
