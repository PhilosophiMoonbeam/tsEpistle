# Administration overhaul — agent handoff

Prepared 7 September 2026 after the SSL milestone. **Stop/resume boundary: the user explicitly asked to complete and verify SSL, update tracking, write this document, then pause. SSL is complete. Do not begin another area until the user resumes the work. The full goal is not complete.** The goal tool currently reports the broader goal as paused; do not mark it complete.

## What we are building

This repository is tsEpistle, a substantially modernized Wiki.js fork intended as a next-generation wiki for humans and agent memory, with search, an internal Wiki Agent and MCP access for third-party agents. The user wants an end-to-end Administration overhaul, not another dashboard/header pass. Every destination, its nested sections, dialogs and operational workflows should be thoughtfully redesigned, with useful missing capabilities implemented where justified. They gave creative control and prefer an aesthetically pleasing ideal form.

The shared visual direction is an editorial workspace: quiet surfaces, generous but useful spacing, serif display headings, strong task hierarchy, readable records and progressive disclosure. Tailor each section to its administrator jobs. Avoid a generic wall of cards, decorative diagnostics, unsupported controls, fabricated health, or merely wrapping the old form in a new hero.

Authoritative tracking: [`docs/administration-overhaul-ledger.md`](docs/administration-overhaul-ledger.md). It contains the area inventory, capability decisions, implementation and deployment evidence, and historical limitations. Read its current status and the latest milestone entries first; earlier “next steps” are historical, not current blockers.

## Completed and remaining targets

**23 of 27 areas have completed their recorded implementation milestones.** This does not substitute for the final cross-area review.

| Area | Route | Current status |
| --- | --- | --- |
| Pages | `/a/pages` | Milestone implemented and verified |
| Tags | `/a/tags` | Milestone implemented and verified |
| Editors | `/a/editor` | Milestone implemented and verified |
| Rendering | `/a/rendering` | Milestone implemented and verified |
| Comments | `/a/comments` | Milestone implemented and verified |
| Users | `/a/users` | Milestone implemented and verified |
| Groups | `/a/groups` | Milestone implemented and verified |
| Authentication | `/a/auth` | Deployed and verified |
| Security | `/a/security` | Deployed and verified |
| Wiki Agent | `/a/agents` | Milestone implemented and verified |
| Search | `/a/search` | Milestone implemented and verified |
| API | `/a/api` | Milestone implemented and verified |
| Webhooks | `/a/webhooks` | Milestone implemented and verified |
| General | `/a/general` | Deployed and verified |
| Theme | `/a/theme` | Deployed and verified |
| Navigation | `/a/navigation` | Deployed and verified |
| Locale | `/a/locale` | Deployed and verified |
| Analytics | `/a/analytics` | Deployed and verified |
| System | `/a/system` | Deployed and verified |
| Storage | `/a/storage` | Deployed and verified |
| Mail | `/a/mail` | Deployed and verified |
| HTTPS & certificates (SSL) | `/a/ssl` | **Latest milestone: deployed and verified** |
| Logging | `/a/logging` | **Remaining** |
| Extensions | `/a/extensions` | **Remaining** |
| Utilities | `/a/utilities` | **Remaining** |
| Developer flags | `/a/dev-flags` | **Remaining** |
| GraphQL explorer | `/graphql` | Milestone implemented and verified |

When resumed, the intended next area is Logging. Inspect its real code, APIs, data and live UI before selecting an implementation. Remaining broad scope:

- **Logging:** destinations, configuration, useful troubleshooting/operational evidence, understandable levels and formats, sensitive-data handling, validation and recovery. Distinguish configured destinations from evidence of actual delivery; do not fabricate a log viewer if no source exists.
- **Extensions:** availability versus installation, discovery, configuration, dependencies, capability constraints and clear recovery. Respect the deployment's actual installation boundaries.
- **Utilities:** import/export and maintenance jobs, reviewed destructive actions, progress, durable receipts, failures and recovery. Avoid automatic retry of operations with uncertain effects.
- **Developer flags:** purpose, dependencies, constraints, deployment versus saved/process state, reviewed activation, effects and reversibility.
- **Final cross-area review:** revisit all 27 destinations, dashboard links and Workspace controls; verify cohesion, nested flows, keyboard/mobile/theme behavior, permission boundaries, regressions and documented limitations. Do not infer overall completion just from this count.

## Operating standards established during this work

1. Follow a complete job from UI through API, persistence and process effects. Inspect the actual system before designing. Implement justified missing functionality with real backend behavior; do not add inert controls.
2. Distinguish **draft**, **saved settings**, **running process**, and **observed evidence**. A saved provider, allocated transport, or listening socket is not proof of successful delivery or public health. Label point-in-time observations accurately.
3. Use reviewed writes with a meaningful reason, fingerprint/revision checks, and current authority. Recheck human activity, authentication version, group membership and permissions, or API-key revocation/expiry and request-bound identity. Cached access checks alone are insufficient for privileged changes.
4. Commit persistence before publishing process state. Report saved-but-not-applied outcomes honestly and provide a guarded application/reconciliation flow. Preserve unrelated settings and secrets. Use explicit keep/replace/clear semantics for credentials; never put private values or server paths into public projections, receipts or exports.
5. Record consequential operations before side effects. Use request IDs, concurrent-operation exclusion, operation phases, completion receipts and uncertainty after interrupted/lost outcomes. Refresh/recovery reads existing receipts; it must not replay mutations. Recheck authority/configuration immediately before effects.
6. Include loading, empty, error, validation, save/reset, conflict, dirty-navigation, progress and recovery states. Preserve drafts on a conflict; make a refreshed review explicit. Avoid duplicate submissions and stale async responses. Background modal content should be inert, with usable focus and keyboard behavior.
7. Give meaningful nested sections stable query URLs. Admin router base is `/a`: use router paths such as `/ssl`, not `/a/ssl`. Same-section navigation uses `router.replace({ query: ... })`. Preserve relevant queries and support receipt/detail links.
8. Verify actual behavior with focused tests. Use real PostgreSQL for transactions, locks, concurrency and persistence faults. Use local protocol fixtures for transport behavior. Mock external services and never send real mail or request a real certificate merely to test. Do not add source-string tests that lock in a component's incidental implementation.
9. Browser-check desktop/tablet/phone (1440/900/390 pixels) in light and dark, including relevant dialogs and failure workflows. Run WCAG A/AA scans, inspect screenshots, check overflow and browser errors, and verify no unexpected writes or external requests. Preview interception is not live verification: separately exercise the deployed app without interception.
10. Run applicable shared/client/server type checks, lint, targeted regressions, production build and bundle budgets. Broaden checks when changes or failures justify it; do not endlessly repeat passing suites. Update the ledger with exact evidence and limitations.
11. Commit and push **the current `main` branch**. User explicitly requires this; no PR unless requested. Do not create another worktree/branch unnecessarily. No subagents unless the user or applicable instructions explicitly request delegation.
12. Deploy each complete area to the maintained container with a clean source revision, a fresh validated database backup, and a preserved rollback compose. Confirm health, migration and image revision, then exercise reversible live workflows and restoration. Do not touch unrelated containers or send messages to others.

Use the listed frontend-design, Vue, Vuetify and Playwright skills when relevant. Vue/Vuetify skill metadata can be ahead of installed versions; verify installed APIs. User AGENTS instructions require Context7 for library/API-specific questions: resolve with `npx ctx7@latest library ...` before `docs`, at most three commands per question. Ordinary refactoring is exempt. Do not silently substitute memory after quota errors. Current environment grants unrestricted filesystem/network access and never accepts sandbox permission flags.

## Current source and deployment

- Repository: `/home/bbferko/repos/tsEpistle`; branch **main**, changes committed and pushed.
- Live URL: **https://agents8c48g.tail41a24a.ts.net:10443**.
- Container: **wiki-tailnet**; image **tsepistle:26d38739**.
- Deployed application revision: **26d387395992fc66e3452be65617261481591d06**. Documentation-only handoff commits follow this revision; that does not mean the application image is stale.
- Compose: `/home/bbferko/.local/state/wiki-tailnet/compose.yml`, service `wiki`.
- Local health: `http://127.0.0.1:3014/healthz`; response `{"ok":true}`. Container is healthy.
- Database: container **wiki-postgres**, database/user `wiki`; PostgreSQL 17. Do not print credentials or raw settings.
- Latest applied migration: **tsepistle-000025-tls-operations.js**. Migration ledger table is **migrations**, not `knex_migrations`.
- Runtime/toolchain: Bun **1.4.0**, Vue **3.5.41**, Vuetify **4.1.9**, Vite **8.2.1**.
- Fresh pre-SSL backup: `/home/bbferko/.local/state/wiki-tailnet/backups/before-ssl-workspace-20260907T015019Z.dump` — **2,903,850 bytes**, mode **0600**, **655** archive-list lines validated.
- Rollback compose: `/home/bbferko/.local/state/wiki-tailnet/compose.before-26d38739.yml`, preserving the prior verified Mail image **a75d4111**. Do not blindly downgrade an image against newer schema: migration preflight can reject unknown migrations. Inspect compatibility; full database restoration is destructive and is not authorized just by this handoff. Migration 25 refuses to drop recorded TLS operations; prefer a forward fix.
- Compose reports an existing repository-volume project-label mismatch; it reuses the intended volume and deploys successfully. Do not delete or recreate that volume to silence the warning.

Release procedure: commit/push clean inputs → `bun run docker:build tsepistle:<sha>` → fresh mode-0600 `pg_dump -Fc` and validated `pg_restore --list` → save prior compose → change only wiki image → `docker compose -f <compose> up -d --no-deps wiki` → health/revision/migration and live verification. Do not rebuild solely for a documentation-only commit.

## SSL architecture and completed behavior

Main files:

- `client/components/admin/admin-ssl.vue`, `tls-workspace.scss`: four-section interface.
- `client/helpers/tls-workspace-api.ts`: same-origin transport, response/receipt validation and recovery.
- `shared/tls-workspace.ts`: public certificate, listener, policy and receipt contracts.
- `server/controllers/api/tls.ts`, mounted under `/_api/tls`: workspace GET/PUT, saved-policy application, operation POST and receipt GET. No-store and manage:system access.
- `server/operations/tls-configuration.ts`: reviewed settings, fingerprints, configuration history, current authority and saved/process state.
- `server/operations/tls-workspace.ts`: guarded policy publication and durable operations. Kinds: public-check, native-check, validate-material, apply-certificate, renew-certificate.
- `server/helpers/system-authority.ts`: current human/API authorization; API actions attributed to API keys, not synthetic human user 1.
- `server/repositories/tls-material.ts`, `tls-preflight.ts`, `tls-probe.ts`: bounded PEM/PFX material validation, public metadata and handshake-only diagnostics. Private paths, passphrases and key material never leave these boundaries.
- `server/core/servers.ts`: prepare/apply native certificate material, runtime evidence, restoration and lifecycle guards.
- `server/core/letsencrypt.ts`, `server/repositories/acme-state.ts`: staged ACME keys/account/certificate persistence, advisory-lock exclusion, current deployment/authority fences and ephemeral challenges.
- `server/controllers/ssl.ts`: redirect policy works with native HTTPS or a trusted proxy, skips already-secure requests and uses only the configured HTTPS origin.
- `server/db/migrations/tsepistle-000025-tls-operations.ts`: durable operation table and SSL administration seed.

Important details for future maintenance:

- **Bun 1.4.0 does not implement `https.Server.setSecureContext` despite the Node typings.** Capability detection is deliberate. Bun replacement requires an explicitly acknowledged listener restart and interrupts active HTTPS connections. The old validated material is retained for restoration if replacement fails. Node's context-reload path is capability-gated.
- Certificate issuance **saves only**. Validate current material, review replacement, then apply it separately. Material identity includes actual file contents and must match the validation receipt. Internal material hashes/HMACs are not public API fields.
- Native and public checks observe different endpoints. Probes perform TLS handshakes without an HTTP/page request, record trust and hostname separately, bound time/chain size, and are not a claim about every client network path.
- Redirect enablement requires current configuration and a successful public check no older than 15 minutes with trust, hostname and current certificate validity. Disabling remains possible for repair. Saved public-address/proxy dependencies must match the process before enabling is applied.
- A separate effect fingerprint allows an ACME operation's own staged persistence while still fencing unrelated policy, deployment, access and listener changes. A full review fingerprint is used for review/initial execution.
- ACME coordination uses a pinned PostgreSQL session advisory lock without an open transaction across CA calls. Lost ownership or uncertain unlock destroys the raw connection using installed Knex's `client.destroyRawConnection`, not a nonexistent `destroyConnection` method.
- Runtime challenges expire after ten minutes, are not persisted, and disappear on incompatible deployment/offline changes. CA errors are redacted; never echo provider error text that may contain sensitive data.
- Heartbeats are 15 seconds; abandoned operation evidence becomes uncertain after 120 seconds. Uncertain certificate effects are never automatically replayed; another mutation requires acknowledgment of the latest uncertain receipt.
- Renewal is currently checked at **startup**, with a five-day threshold. There is **no periodic renewal scheduler**. The UI explains this limitation. Do not claim recurring renewal is implemented.
- Legacy `/_api/system/ssl`, `/ssl/redirection`, `/ssl/renew` return 410 after authorization. Their hardcoded status and unsafe mutations, obsolete client functions and implementation-specific component tests were removed.

## Verification at this handoff

Backend/local evidence:

- Nine isolated test files covering TLS material, endpoint probes, real-socket HTTPS replacement/rollback, mocked ACME service, TLS/System controllers, redirect behavior and migration contract/preflight pass.
- Real PostgreSQL: **15 operation tests / 65 assertions**, **12 configuration tests / 39 assertions**, **10 ACME persistence tests / 26 assertions**. Fault coverage includes stale/current authority, atomic rollback, lock loss, concurrent operations, uncertain completion and no replay.
- ACME service: **15 tests / 61 assertions**, using temporary certificates and a mocked CA. Native TLS socket tests verify actual certificate replacement and recovery, including Bun interruption behavior and PFX.
- Existing System client and navigation tests pass after legacy SSL cleanup. Shared/client/server type checks, repository lint, production build and bundle budgets pass.
- Preview browser matrix: **30 views** (four sections plus issuance review × three widths × two themes), no audited accessibility violations/overflow. Workflow tests cover material validation, explicit replacement acknowledgment, lost operation/save responses, read-only recovery, stale drafts, keyboard dismissal and read errors.

Live evidence:

- Healthy deployed revision and migration 25 confirmed. Initial deployment preserved the original selected settings exactly.
- Native browser, **without interception**, verified one public-check operation, reviewed redirect enablement, safe redirect destination despite an untrusted Host header, public reload without a proxy loop, reviewed restoration and history. Legacy endpoint returns 410.
- Public endpoint: **TLS 1.3**, certificate trusted, hostname matched, expires **2026-10-21T14:28:04.000Z**. This is a recorded observation, not a future guarantee.
- Native HTTPS remains disabled; application serves HTTP 3000 behind the trusted reverse proxy.
- Redirect is restored **disabled**. Every pre-existing selected setting is unchanged. There was no persisted `server` setting before verification; the only new runtime-policy setting is `{"sslRedir":false}`, matching the original effective behavior. Two attributed policy-history entries and one public-check receipt remain.
- **24 deployed views** (four sections × three widths × two themes) pass WCAG A/AA/overflow/browser checks using actual container assets and API responses with read-transport isolation. This matrix is separate from the unintercepted native workflow above.
- No real certificate issuance, production certificate replacement, email or third-party message was sent during verification.

Ignored local evidence is in `.playwright-cli/admin-review`: `ssl-next.ts`, `ssl-next-audit.json`, `ssl-native.ts`, `ssl-native-verification.json`, `ssl-live.ts`, `ssl-live-audit.json`, screenshots `ssl-next-*` and `ssl-live-*`. Earlier Mail/Storage/etc. harnesses are also useful patterns. These ignored artifacts are local, not shipped with git; the ledger records their results. Temporary browser authentication export and raw settings snapshots have been deleted. The owned `wiki-ssl-test-20260907` PostgreSQL fixture and both temporary credential env files have been removed. Do not assume they still exist.

## Useful verification and tooling details

Use `bun run test <file...>` for the repository's isolated test runner. For a real PostgreSQL suite, create a new isolated, loopback-only disposable database with the suite's required name suffix and temporary mode-0600 credentials, then export the environment and invoke **`bun test <file>`**. `bun --env-file ... test` can resolve the package script instead and is not proof the real-database suite ran. The SSL suites share tables; run them sequentially. Never point them at the live database.

Typical checks:

```sh
bun run typecheck:shared
bun run typecheck:client
bun run typecheck:server
bun run lint
bun run test server/test/helpers/tls-material.test.ts server/test/helpers/tls-probe.test.ts server/test/core/servers.tls.test.js server/test/core/letsencrypt.test.ts server/test/controllers/api.tls.test.js server/test/controllers/ssl.test.js
bun --bun vite build
bun run bundle:check
```

Shared type checking comes first after shared-contract changes. `bun run build` generates revision metadata and requires clean git; use direct Vite for an uncommitted preview. Biome ignores Vue/SCSS, so use installed Prettier for those files:

```sh
bun --bun prettier --write --single-quote --no-semi --trailing-comma none --print-width 150 --html-whitespace-sensitivity ignore <files>
```

Use named Vue handlers. Multiple semicolon-separated statements in event attributes can become invalid after this formatter removes semicolons; Vite previously caught this.

Persistent Playwright CLI session: `wiki-design`, authenticated to the maintained site. Reinspect its current page before using selectors. If another harness needs auth state, `playwright-cli -s=wiki-design state-save .playwright-cli/admin-review/state.json`, chmod 0600, and remove it afterward. Never print token/cookie values. For Vuetify selects, focus the combobox, ArrowDown, then choose the exact role-option. A dialog's text can appear before entry animation/focus settles; focus a dialog control before testing Escape.

The host has occasionally produced browser network-change churn. Read-only routed transport can stabilize a visual matrix; it must not replace a separate native deployed workflow check. Mail preview iframes also caused AxeBuilder traversal stalls; scan the admin document and actual rendered templates separately when needed rather than claiming an opaque iframe was checked.

When testing callbacks whose errors are intentionally caught/redacted, do not place the only assertions inside the callback. Capture observations or a completion flag and assert outside; otherwise a swallowed assertion can falsely pass.

Proceed with Logging only after resumption. Preserve this handoff boundary, use the ledger, and finish each remaining area through deployment and verification before marking its milestone complete.
