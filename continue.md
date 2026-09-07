# Administration overhaul — final release handoff

Prepared 7 September 2026. The Administration overhaul is **complete**: all **27 of 27** milestones are deployed and verified, and the final cross-area review is complete. The released source is commit `13001f7ce21074083820449ef51603a1e1c8c584` on `main`; the maintained image is `tsepistle:13001f7c`. A documentation-only commit may follow this record and is **not** a new application revision.

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

## Released source and isolated-proof record

The final source gates passed: full suite **468/468**; shared/client/server type checks, lint, dependency and license checks (808 dependencies), placeholder checks, Vite and bundle budgets. Seven real-PostgreSQL suites passed **46 cases / 220 assertions**, including API availability/current-authority repair. Migration 26 was first exercised only on an isolated restored preview.

The local Sentry fixture delivered exactly two envelopes (warning/error), then none after disablement; no external Sentry was contacted. The final preview passed **114 views** with zero scoped aXe findings, overflow, page errors, external requests or unexpected writes; native Flags keyboard/pointer checks passed. Recovery UI protected Sentry/import drafts without actual fixture mutations; bounded trail evidence retained 500 escaped records and four populated-trail audits passed with zero findings.

The corrected portable export passed with 14 exact public IDs, excluded private page 3 and used directory/file modes 0700/0600. The isolated API/global-state and signing-rotation workflow passed scoped-key enable/disable/restore, receipt reauthentication, revoked-key recording and unchanged encryption-root hash. No production signing rotation occurred. Actual-disk content import passed for page 37: source bytes remained unchanged, Storage configuration/runtime were exactly restored and the fixture was deleted. The corrected import has public identity/revision, default executor and full phase fencing.

Ignored non-secret reports/screenshots may remain under `.playwright-cli/admin-review`; old failed Utility export/busy-state artifacts remain historical only and must not be represented as final evidence.

## Current maintained deployment and final live proof

- Live URL: **https://agents8c48g.tail41a24a.ts.net:10443**.
- Service: `wiki-tailnet`, compose `/home/bbferko/.local/state/wiki-tailnet/compose.yml`, wiki-only deployment at `2026-09-07T09:07Z`.
- Image/revision: `tsepistle:13001f7c`, exact released revision `13001f7ce21074083820449ef51603a1e1c8c584`.
- Health: `http://127.0.0.1:3014/healthz` returned HTTP 200 with `{"ok":true}` after cleanup.
- Database: PostgreSQL 17 service `wiki-postgres`, database/user `wiki`; migration `tsepistle-000026-utilities-operations.js` is applied in `migrations`. Never print credentials or raw settings.
- Final backup: `/home/bbferko/.local/state/wiki-tailnet/backups/before-administration-operations-20260907T090608Z.dump`, 2,907,757 bytes, mode 0600, 660 validated `pg_restore --list` lines.
- Rollback compose: `/home/bbferko/.local/state/wiki-tailnet/compose.before-13001f7c.yml`, retaining SSL image `26d38739`. Inspect migration-26 compatibility before downgrade; database restoration is destructive and requires explicit authorization. The existing compose-volume warning remains; no volumes were recreated.

Final live detailed verification passed 114 views with zero scoped aXe findings, overflow, page errors, external requests or writes. The final cross-area review recorded 591 unique area/view/width/theme observations across all 26 `/a` destinations plus Dashboard at 1440/900/390 in light/dark; all navigation sections were keyboard-activated. GraphQL separately passed six aXe/overflow views and six native typed-query retention checks. The Mail audit does not claim aXe coverage inside its intentionally sandboxed preview iframe: aXe encountered a cross-origin `SecurityError`; host chrome/navigation and screenshots were verified. The earlier 126 nested-preview source observations remain separate historical proof.

Live workflow checks saved/applied Logging JSON, then restored `info`/`default`; Flags were staged true without enabling, then restored false, with SQL logging never enabled; utility cache receipt `534b4133-c21b-4ebb-8f3f-13f32b9addfe` succeeded. Dialog/aXe checks were clean. Baseline comparison confirmed original live pages, source revisions, visibility, owners, Storage, loggers and flags unchanged. Console keys originally absent/inherited are now explicitly `info`/`default`; retained administration history and the utility receipt are intentional. Locale catalog contents are unchanged; `observedAt` refreshed at startup.

No live signing rotation, guest reset, import/export, external Sentry/email/ACME/storage effect was exercised. Those dangerous effects were proved only in clone/loopback environments.

## Verification lessons and ongoing limits

Use actual assets/API transport for native workflows. When host network-change churn requires read-transport isolation for a visual matrix, separately prove native paths. Use real mobile viewport metadata. For GraphiQL, wait for DOM readiness rather than `networkidle`. Use fixture-only data; restore changed state and remove fixtures, browser auth copies, temporary credentials and disposable infrastructure.

Cleanup is complete: the preview hub stopped; disposable PostgreSQL 17 container/databases, temporary PostgreSQL environment, preview config/data/dump, private live-before snapshot, browser-auth copies and throwaway drivers were removed. Maintained backup/rollback artifacts and ignored non-secret reports remain.

SSL remains an operating limitation: Bun does not provide `https.Server.setSecureContext`, so certificate replacement needs an explicitly acknowledged listener restart; issuance saves material and is reviewed/applied separately; renewal is startup-only with a five-day threshold, not a periodic scheduler.

There is no remaining Administration implementation or release gate. For future changes, follow the operating standard and release procedure above, preserve the final live baseline, and add only observed evidence to this handoff and the ledger.
