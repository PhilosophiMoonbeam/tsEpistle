# Frozen-source successor evidence — 2026-09-10

## Review identity, freeze, and binding

This document is the immutable evidence for schema-2 source-review record
`security-review-871003fab75a1e2f55d5ec768d74e9643ead862e`.

- **Exact reviewed range:** `b5924c6ae9fa165040d042e73c381e31b70d8ac7..871003fab75a1e2f55d5ec768d74e9643ead862e`.
- **Source freeze (`S`):** `871003fab75a1e2f55d5ec768d74e9643ead862e`.
- **Review base (`REVIEW_BASE`):** `b5924c6ae9fa165040d042e73c381e31b70d8ac7`.
- **Covered security-boundary digest:** `86f73a39b1585028aec3054246896212078a505af24bfc469f8c590385a97c45`.
- **Final threat-model SHA-256:** `2b2baa8c523bbbb2b3ffa89e2cad954ba63e3af372529dc76e931291bbd3b748`, computed from the final bytes of `docs/security/threat-model.md` with `bun server/scripts/check-threat-model.ts --digest 871003fab75a1e2f55d5ec768d74e9643ead862e`.
- **Review date:** `2026-09-10`.
- **Reviewer:** `FrozenSourceSecurityReview` performed the delegated read-only source security review. The attestation record attributes the successor to `tsEpistle maintainers (Main; FrozenSourceSecurityReview)`.
- **Source ancestry context:** the checked-out source ref was `S`; the recorded linear boundary was `b5924c6a -> 4a87c827 -> 95cf8efa -> 871003fa`.

The documentation-only successor is outside the covered source boundary. The source review binds the exact revision, base ancestry, boundary digest, and final threat-model digest; it does not claim that the literal source revision is the documentation successor's `HEAD`.

## Verdict, method, and proof classification

The full review supplied by `agent://FrozenSourceSecurityReview` reviewed the exact range above and the surrounding authorization, process-lifecycle, UI, test-integrity, dependency, and provenance paths. The verdict is **PASS**: no new blocking or non-blocking security finding and no source blocker was identified within this review's source scope; deployment was excluded. The nine predecessor finding objects remain unchanged, and no finding was invented for the reviewed source changes or this documentation-only successor.

The delegated review proof is **static, read-only source and diff inspection**. Scheduler lifecycle behavior not directly exercised by this reviewer is an inference from the event and timer control flow together with the cited tests. `FrozenSourceSecurityReview` did not execute tests, builds, formatters, validators, payloads, or network operations, and did not recompute the final post-edit threat-model digest. The digest above is the separately generated binding for the final model bytes.

## Assessed areas

### Scheduled-worker process lifecycle — PASS

`server/core/scheduler.ts:27-31` validates kebab-case job names and defines the 65,536-byte stderr bound and one `\n[truncated]` marker. At `:121-180`, forked workers remove only standalone `--watch` and `--hot` from inherited `execArgv`, preserve all other entries, continuously drain stderr, retain only the prefix, materialize that bounded stderr for both successful and failed settlement, exclude raw stderr and payloads from observations, and keep `error` as failure context. At `:182-192`, `exit` records termination and cancels only KILL escalation, not the 5-second completion-confirmation bound, while `close` is still required before output materialization and settlement. At `:221-270`, overlapping stops share one promise, `SIGTERM` is immediate, `SIGKILL` follows after 1 second only when the child remains live, and the 5-second confirmation bound distinguishes `SCHEDULER_WORKER_TERMINATION_UNCONFIRMED` from `SCHEDULER_WORKER_COMPLETION_UNCONFIRMED`. At `:213-218`, a stopped repeat is not rescheduled. At `:351-370`, global `started` remains set when shutdown is unconfirmed because it is cleared only after all jobs settle successfully.

`server/test/core/scheduler.test.js:86-278` covers bounded success and failure output, close-after-exit, distinct unconfirmed outcomes, retained tracking and late cleanup, concurrent and overlapping stops, error/exit races, and repeat cancellation. `server/test/core/scheduler-worker-lifecycle.test.ts:141-233` exercises real fork success/failure, exact reload-flag filtering with preload preservation, stubborn TERM/KILL behavior and reaping, and chunked stderr overflow. `README.md:97-109` documents the same operational contract. The review did not establish a request-controlled path that directly selects a job module; names are validated and production registration is through finite configured jobs or fixed internal callsites.

### Page authorization and privacy — PASS

The inherited history repair remains intact at `server/operations/pages.ts:1001-1026`, `:1867-1880`, `:1995-2054`, and `:2090-2135`: numeric IDs use the canonical page loader, private denial is masked as not-found, public history uses current path, locale, and tags, unlock checks precede delivery, historical rows remain requester-scoped, and stale restore is rejected before historical lookup or mutation. `server/models/pageHistory.ts:181-257` scopes version/history queries by requester, and `server/helpers/page-access.ts:116-168` preserves owner/system and page-rule decisions. `server/test/operations.pages.history-visibility.test.js:74-181` covers absent/private equivalence, tagged public history, hidden private revisions, stale restore, and live-rule reauthorization.

The final mass-assignment hardening at `server/operations/pages.ts:312-328` strips `skipStorage` from untrusted input, while shared create/update/convert/move adapters use that helper at `:1889-1993`. `server/test/models/pages.private-errors.test.js:839-904` demonstrates that an untrusted operation cannot suppress `storage.pageEvent`; trusted direct storage importers intentionally retain suppression at `server/modules/storage/disk/common.ts:300-343` and `server/modules/storage/git/storage.ts:620-649`. No authorization, history, source, owner, or private-route regression was found.

### Frontend route and accessibility boundaries — PASS

The 95cf8efa Vue/Vuetify modernization and the S correction set alter presentation, reactivity, component slot APIs, keyboard behavior, and tests, not server authorization. Private view/edit/history/source routing remains namespace-aware at `client/components/common/nav-header.vue:624-641`; page-action visibility remains based on effective server-projected permissions at `:462-490`. The shortcut implementation at `:547-617` restores stable mounted-listener identity, ignores repeated/composing/default-prevented events, and leaves an unauthorized agent shortcut unconsumed. Status indicators beside visible text are decorative at `client/components/admin/admin-pages.vue:18`, `client/components/agents/agent-composer.vue:220-234`, and `client/components/agents/agent-thread.vue:27-69`; heading semantics are restored at `client/components/tags.vue:92-123`; reduced-motion and forced-colors behavior remain explicit in `client/scss/components/v-btn.scss:123-160` and `client/components/common/status-indicator.vue:72-91`. No raw-HTML sink, credential exposure, permission elevation, or route widening was identified.

### E2E and test-evidence integrity — PASS

`dev/e2e/tags.e2e.ts:79-118` confines interception to GET on exact `/_api/pages` and `/_api/pages/tags`, forwards non-GET traffic, and overrides only the fixture language value; it is layout/interaction evidence rather than privacy evidence. `dev/e2e/setup.e2e.ts:915-973` uses real authenticated create/browse/delete paths and a separate anonymous context to assert that a private URL returns 404 without content. `dev/e2e/quality.e2e.ts:230-249` behaviorally asserts that a denied agent shortcut is not consumed. The Home creation flow at `dev/e2e/setup.e2e.ts:230-275` installs its response wait before clicking, validates the real POST status, navigation, content, and reload, and does not consume or mock the response body. The final tag and visual-editor tests retain consumer-visible state, focus, and geometry assertions. Two implementation-pinning tests were deleted rather than repinned: `client/components/common/nav-header.assets-dead-method.test.js` and `client/components/editor/editor-markdown.layout.test.ts`. The retained history watcher regression uses actual Vue reactivity and invalidation at `client/components/history.load-version-root-ui-facade.test.js:1-311`. Passing test counts are supporting evidence, not the basis of the authorization conclusion.

### Dependency, tooling, and provenance — PASS

Exact direct pins appear in both manifest and lock: `@vue/language-server` and `@vue/language-plugin-pug` 2.2.12 at `package.json:289-290` and `bun.lock:220-221`; production `@vue/language-core` and `vue-tsc` remain 3.3.9, Vue remains 3.5.41, TypeScript remains 6.0.2, and typescript-language-server remains 5.3.0 at `package.json:288-317` and `bun.lock:219-248`. Resolved packages carry integrity hashes at `bun.lock:1145-1149` and `:2425-2429`. `.omp/lsp.json:2-16` assigns `.vue` to standalone Vue LS with hybrid mode off and a pinned TypeScript SDK. `client/tsconfig.json`, `server/tsconfig.json`, and `shared/tsconfig.json` are editor-discovery wrappers while package typecheck commands target the authoritative root configs. `third-party-licenses.json:1-13` binds license evidence to the lock hash. The tooling dependencies are development-only and do not create a runtime request sink.

## Exact reviewed scope

The full review assessed the following paths and deleted paths at `S`:

- `.git/logs/HEAD`
- `.git/refs/heads/main`
- `.omp/lsp.json`
- `README.md`
- `bun.lock`
- `client/client-app.ts`
- `client/client-setup.ts`
- `client/components/admin/admin-logging-console.vue`
- `client/components/admin/admin-pages.vue`
- `client/components/admin/admin-utilities.vue`
- `client/components/admin/logging-secret-field.vue`
- `client/components/admin/mail-secret-field.vue`
- `client/components/admin/theme-code-editor.vue`
- `client/components/agents/agent-admin.vue`
- `client/components/agents/agent-composer.vue`
- `client/components/agents/agent-thread.vue`
- `client/components/agents/skill-admin.vue`
- `client/components/common/nav-header.assets-dead-method.test.js` (deleted in `S`)
- `client/components/common/nav-header.vue`
- `client/components/common/page-branding-mark.vue`
- `client/components/common/status-indicator.vue`
- `client/components/common/v-card-info.vue`
- `client/components/editor/editor-markdown.layout.test.ts` (deleted in `S`)
- `client/components/editor/editor-markdown.vue`
- `client/components/editor/editor-modal-blocks.vue`
- `client/components/editor/editor-modal-conflict.vue`
- `client/components/editor/editor-modal-media.vue`
- `client/components/editor/markdown/help.vue`
- `client/components/history.load-version-root-ui-facade.test.js`
- `client/components/history.vue`
- `client/components/profile/profile.vue`
- `client/components/register.vue`
- `client/components/tags.vue`
- `client/scss/components/v-btn.scss`
- `client/themes/default/components/page.vue`
- `client/tsconfig.json`
- `dev/e2e/quality.e2e.ts`
- `dev/e2e/setup.e2e.ts`
- `dev/e2e/tags.e2e.ts`
- `docs/security/review-attestations.json`
- `docs/security/review-attestations/security-review-2026-09-09-b5924c6ae9fa.json`
- `docs/security/security-review-2026-09-09-b5924c6ae9fa-evidence.md`
- `docs/security/security-review-2026-09-09-bd5c06096186-evidence.md`
- `docs/security/security-review-2026-09-09-54949bf6d081-evidence.md`
- `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`
- `docs/security/threat-model.md`
- `package.json`
- `server/controllers/api/pages.ts`
- `server/core/scheduler.ts`
- `server/core/worker.ts`
- `server/helpers/page-access.ts`
- `server/models/pageHistory.ts`
- `server/models/pages.ts`
- `server/modules/storage/disk/common.ts`
- `server/modules/storage/git/storage.ts`
- `server/operations/pages.ts`
- `server/operations/system.ts`
- `server/test/core/scheduler-worker-lifecycle.test.ts`
- `server/test/core/scheduler.test.js`
- `server/test/models/pages.private-errors.test.js`
- `server/test/operations.pages.history-visibility.test.js`
- `server/tsconfig.json`
- `shared/tsconfig.json`
- `third-party-licenses.json`

## Main-attributed execution evidence

The following is supplied execution evidence from Main and other earlier reviewers; it is not execution by `FrozenSourceSecurityReview` or by this documentation owner:

- The full unit run reported **489/489 tests passed**.
- Scheduler security and LSP integration re-reviews passed; earlier frontend, E2E, and server reviews passed.
- Main reported passing dependency checks, license checks, production audit, lint, typechecks, OpenAPI checks, placeholder checks, Agent checks, build, and bundle.
- `ci:static` passed every preceding gate and then stopped at the expected stale threat-model/attestation binding failure. This is not a final `ci:static` pass for the successor and is not strict release proof.

These observations are supporting evidence only. They do not claim that this docs agent ran those commands, that strict release cleanliness passed, or that an artifact was deployed.

## Inherited findings and dispositions — unchanged

The selected predecessor was `security-review-2026-09-09-b5924c6ae9fa`. Its nine finding objects are copied into the successor record with their identifiers, severities, dispositions, and evidence paths unchanged:

1. `AUTH-APIKEY-HUMAN-IMPERSONATION` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/test/core/auth.api-access.test.ts`, `server/test/graph/api-key-mutations.test.ts`.
2. `AUTH-CALLBACK-INITIATION-BINDING` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/modules/authentication/cas/cas-strategy.test.ts`, `server/modules/authentication/saml/authentication.test.ts`, `server/test/controllers/auth.test.js`.
3. `AUTH-OAUTH-STATE-LIFECYCLE` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/modules/authentication/oauth-state.test.ts`, `server/test/repositories/federated-login.postgres.test.ts`.
4. `STORAGE-ASSET-001` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/test/models/assets.test.ts`.
5. `STORAGE-IMPORT-002` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/modules/storage/git/admission.test.ts`, `server/modules/storage/git/bounded-process.test.ts`, `server/modules/storage/git/repository.test.ts`.
6. `STORAGE-BACKUP-003` — **High**, `resolved`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `server/test/modules/storage.disk.test.js`.
7. `SEC-STORAGE-NATIVE-BOUND-001` — **Medium**, `accepted`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `docs/security/threat-model.md`, `server/modules/storage/git/bounded-process.test.ts`.
8. `SEC-ADAPTER-001` — **Medium**, `accepted`; evidence: `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`, `docs/security/threat-model.md`.
9. `SEC-CACHE-001` — **Medium**, `resolved`; evidence: `docs/security/security-review-2026-09-09-54949bf6d081-evidence.md`, `docs/security/threat-model.md`, `server/controllers/api/pages.ts`, `server/test/controllers/api.pages.test.js`, `server/test/operations/pages-tree.postgres.test.ts`.

No historical blocker is revived. No new finding or blocker was added for the frozen source review, the scheduler lifecycle assessment, or the documentation-only successor. The accepted Medium residuals remain accepted exactly as recorded by the predecessor.

## Explicit exclusions and non-claims

This review excludes deployment and live production process behavior, OS-level kill guarantees, external-provider canaries, registry publication, post-successor strict cleanliness, and strict release/deployment proof. It does not claim universal worker admission or backpressure, a universal execution deadline, universally bounded shutdown, or proof that a delivered signal caused OS termination. In-process jobs remain cooperatively unbounded, and selected system operations retain their existing 120-second policy. The worker controls bound parent-side retained stderr and stop-confirmation state; they do not bound arbitrary job work, aggregate concurrent children, host resources, or every shutdown path.

The record's `releaseEligible: true` is the maintainer source-review attestation for the exact frozen source and zero-blocker finding state. This evidence does not claim a post-successor strict gate pass, a successful final `ci:static`, a final image build, registry push, maintained Compose or Helm replacement, live health/login/authorization smoke, production migration, production backup, restore, or deployment result.
