# PWA Offline Corrections

## Status and decision

This record covers `docs/pwa-offline.md` and every commit after `2dc5e7f267c4fa374ede3c87461b6d7a48402179` through the audited HEAD `b5e3bfdfc3dafd0ff675fd002f8efa261fa8259f`.

The thesis is sound. Keep:

- IndexedDB through `idb` for the bounded local corpus; do not add Turso, libSQL, replication, or a second authority.
- PostgreSQL, current page rules, publication/protection state, `sourceRevision` CAS, and collaboration generation as server authority.
- Explicitly downloaded, sanitized, independently guest-admitted snapshots only.
- Owner-bound AES-GCM drafts with memory-only server-released keys.
- Explicit foreground publication with no worker replay or automatic reconnect mutation.
- A neutral root-scope custom service worker and independent offline application entry.
- The field-notebook visual direction.

The execution at the audited HEAD is not complete or stable enough to accept. Source inspection found data-loss blockers in draft restore/publication, missing rendered-source provenance, an ephemeral key domain, unsafe storage accounting and concurrency, volatile update consensus, incomplete retirement, stale capability projections, inconsistent server-only gates, and significant accessibility/interaction gaps. Existing unit tests and the prior guest smoke do not prove the required browser matrix.

The corrections below are mandatory before this work can be described as a high-performance, intuitive, durable PWA. They deliberately preserve the architecture while repairing its contracts.

This record supersedes conflicting implementation, identity-recovery, and retirement wording in `docs/pwa-offline.md`. The original plan remains governing for unchanged architecture and non-goals. Before implementation completion, reconcile the exact clauses listed below; do not leave two competing contracts.
## Evidence reviewed

- Plan and all 53 files changed since the baseline.
- Post-baseline commits: `71b42c05`, `cde03e5f`, `ca38acec`, `0c399410`, `80e7f73f`, `b5e3bfdf`.
- Twelve parallel architecture, security, lifecycle, frontend, performance, asset, and test audits; three independent synthesis reviews.
- Current `idb` and `vite-plugin-pwa` documentation, RFC 5869, PostgreSQL repeatable-read semantics, and relevant browser platform documentation.
- Baseline focused tests and shared/client/server typechecks: passing before corrections.
- Deployed guest reader, PWA status, desktop offline library, and mobile offline library at `b5e3bfdf`: exercised. Authenticated draft/reconciliation, multi-tab updates, and actual tombstone retirement were not previously exercised.

Verified strengths include the neutral entry isolation, exact generated shell CSP, fixed `/sw.js` artifact path, classic worker output, no runtime API/SSR response caching, guest-principal page checks in one repeatable-read transaction, exhaustive snapshot construction, current-account draft-key admission, RFC 5869-compatible derivation, AES-GCM AAD coverage, atomic snapshot/search replacement, and explicit no-replay draft coordination.

## Governing invariants

1. Browser state is never authorization. A health probe, remembered permission, worker vote, account ID, or local generation cannot authorize a server operation.
2. A snapshot is readable only when its sanitized render is proven to come from the exact admitted `sourceRevision`.
3. One submitted mutation body, one immutable receipt, and one acknowledged result describe the same captured editor version.
4. A restored fork retains its original base until explicit comparison with coherent authoritative content and revision establishes a new base.
5. Logout/account switch immediately fences all asynchronous work and clears plaintext. A transient verification outage preserves durable drafts and does not impersonate logout.
6. Every IndexedDB mutation validates persisted generation in the committing transaction. BroadcastChannel is notification only.
7. Snapshot count and managed-byte limits include snapshots, derived search documents, and encrypted drafts using bounded binary-aware accounting.
8. Updates and retirement may never discard unsaved source, metadata, merge state, later edits, or unresolved receipts.
9. Retry performs reads only. No reconnection path replays a mutation.
10. The neutral shell stays independent of authenticated app, Vuetify, editor, Agent, account, and personalized theme dependencies.

## Required corrections

### A. Server authority and projection

#### A1 — Render-source provenance — blocker

Add nullable `pages.renderedSourceRevision` with a conventional non-destructive migration. Existing rows begin unknown; never backfill by copying `sourceRevision` onto an unverified render.

Only a successful source-revision-guarded render write may atomically set `render`, `toc`, and `renderedSourceRevision`. Any source-affecting change must leave existing provenance unequal or unknown until rerender succeeds. Nonpipeline render rewrites, including `rewriteLinkedPageRenders` and `reconnectLinks`, must invalidate `renderedSourceRevision` and schedule affected page IDs through the existing rerender mechanism; they must not certify newly rewritten output. Apply the nullable migration before marker-dependent readers/writers. Render/provenance-only writes must not advance `sourceRevision`.

`getOfflineSnapshot` must require a positive exact equality between `renderedSourceRevision` and `sourceRevision`. Pending, failed, stale, or unknown renders fail closed. Existing pages become offline-eligible only after real rerender.

Owners: next migration, `server/models/pages.ts`, `server/jobs/render-page.ts`, `server/operations/pages.ts`, `server/helpers/offline-page.ts`.

Acceptance: pause rendering after a source update and deny download; complete the guarded render and return exact new content/revision; reject failed render followed by private-to-public transition; reject an old render racing a newer source; deny pre-migration unknown provenance until rerendered.

#### A2 — Uniform anonymous denial and canonical URL projection — high

Return HTTP 404 with the same public `OFFLINE_PAGE_INELIGIBLE` code and bounded payload for absent, protected, rule-denied, nonpublic, unpublished, unsupported, or unsafe snapshot candidates. Keep malformed IDs as 400 and generic infrastructure failure as 5xx. Do not reveal which authority state failed.

Pass the configured canonical origin and admitted canonical page route into offline link projection. Resolve relative URLs against the real page URL; canonicalize safe links; apply reserved same-origin path rejection equally to absolute and relative forms; retain scheme, credential, protocol-relative, backslash, and control-character rejection. Do not widen the sanitizer or restore arbitrary IDs.

Owners: `server/helpers/offline-page.ts`, `server/operations/pages.ts`, `server/controllers/api/pages.ts`.

Acceptance: all ineligible authority states have indistinguishable public responses; relative sibling/parent/query/fragment links round-trip correctly; real-origin reserved paths are rejected in absolute, relative, encoded, and normalized forms; external HTTP(S)/mailto remain deliberate navigation only; no automatic subresource request occurs.

#### A3 — Draft-key privacy and stable site identity — blocker

Apply `private, no-store` and append `Vary: Cookie` before authentication, Origin, Fetch-Metadata, parsing, or handler errors can exit the real mounted draft-key boundary.

Separate the offline draft site identity from process/replica `INSTANCE_ID`. Persist a dedicated installation value. Fresh installs may seed it from the canonical origin. Existing deployment must be seeded with the current recoverable key domain before replacement or must migrate/export recoverable drafts while the live old key is available. Never silently rotate the domain or repurpose `INSTANCE_ID`, which remains the event/worker identity.

Before any application restart or replacement, including a tombstone-mode restart, preserve the live legacy derivation domain. The current authenticated TSODK1 response carries the authoritative non-secret `canonicalOrigin` and `siteId`; a properly authorized current-account request can recover that context while the old process remains alive. Persist the exact recovered `siteId` as the dedicated installation identity and preserve canonical origin and session secret; never log or persist returned key bytes. Inventory/export any accessible recoverable legacy drafts not covered by that domain. The observed empty guest profile proves absence only in that profile; other browser stores and already-lost domains remain unknown. If continuity cannot be established, deployment remains blocked pending explicit operator acceptance of the stated irreversible or unknown legacy-draft loss; evidence alone is not consent. Never delete legacy ciphertext.

Owners: installation config, `server/core/config.ts`, `server/helpers/offline-draft-keys.ts`, `server/controllers/api/offline.ts`, early mounted middleware in `server/master.ts` if required.

Acceptance: same account/authVersion/session secret and installation site identity produce the same domain after restart and across replicas; all success/denial/error responses retain privacy headers; exact frame/HKDF known-answer vectors pass; guest, API-key, stale, inactive, foreign/missing-Origin, and foreign Fetch-Metadata requests receive no key bytes.

### B. IndexedDB, crypto, and identity

#### B1 — Preserving physical schema v2 and atomic metadata — blocker

Decouple physical IndexedDB version from snapshot/envelope/AAD schema version. Upgrade to a preserving physical version that initializes authoritative metadata in the upgrade transaction, rebuilds disposable accounting, and never rewrites encrypted envelope bytes.
Keep the `tsepistle-offline` database name and existing four stores. Set physical `OFFLINE_DB_VERSION` to 2 independently of `OFFLINE_SCHEMA_VERSION = 1`; encrypted envelope, payload, AAD, and sanitizer versions remain unchanged. Preserve every raw private record, including malformed or unknown rows, byte-for-byte. Creation-time metadata initialization is permitted only for a new empty database. A populated database with missing or invalid authoritative metadata must not be initialized to zero. Unknown physical or metadata schemas refuse every write, including clear.

Metadata records own safe `sessionGeneration`, aggregate managed bytes, snapshot count, and monotonic `corpusRevision`. Missing metadata in a populated database is recovery-required, not generation zero. Initialization/recovery is one transactional read-if-absent; it cannot rewind another tab's generation. Validate safe-integer increments.

Use `openDB` blocking/versionchange/terminated hooks; close late successful opens after a timed-out/blocked attempt and let callers intentionally reopen a terminated connection. Unknown future physical schemas remain preserved and unwritable.

Owners: `shared/offline.ts`, `client/helpers/offline-storage.ts`.

Acceptance: two-tab initialization cannot reset generation; v1-to-v2 keeps ciphertext byte-for-byte; unknown versions are untouched; blocked and terminated connections recover without leaked blockers.

#### B2 — Bounded accounting and transaction completion — high

Define a binary-aware logical size: encoded bounded clear metadata plus raw nonce/ciphertext bytes. Count snapshots, search documents, and encrypted drafts. Update totals/counts/corpus revision atomically with content changes. Existing over-limit data remains readable/deletable; growth is refused until explicit cleanup. Drafts are never silently evicted.
If an opaque private value cannot be safely measured, mark accounting incomplete and refuse growth while preserving supported recovery, read, and delete operations. Do not invent a small size or discard the row. Over-limit legacy data permits shrink and deletion as well as reads. Keep persistence grant or denial separate from success or failure while recording that result.

Observe every `tx.done` on success and failure. Abort active transactions, await/catch completion, then propagate the original typed error. Request `durability: 'strict'` for draft writes, receipt rewrap, generation changes, and destructive identity/device transactions; keep disposable snapshot/search work at default durability.

Acceptance: exact limit edges include derived search bytes; totals conserve across insert/replace/remove/clear; autosave does not clone/stringify the corpus; quota/CAS failure emits one handled error and preserves prior records.

#### B3 — Strict draft CAS, immutable receipts, and corrupt-row recovery — blocker

Mutable replacement requires explicit stored-selector CAS, strictly increasing revision, and unchanged record, owner, auth, and key identity. Receipts are insert-only except for fully byte-identical idempotence. Dedicated receipt rewrap requires exact old-envelope equality; unchanged record, account, auth, key, draft revision, and submission ID; and a strictly older-to-current session generation. It is the sole in-place receipt re-encryption path. Explicit same-account/current-authVersion recovery of a preserved older-generation ordinary fork uses exact old-envelope CAS into a new current-generation mutable record; it does not weaken normal generation checks.

Remove mutable receipt outcome rewrites. Runtime may classify a result; every retained receipt recovered after restart is outcome-unknown.

Malformed/unknown private rows remain opaque and do not poison valid listing, accounting, deletion, or unrelated writes. Permit explicit unconditional deletion by raw record key and a separately confirmed whole-device clear that atomically advances generation and clears raw stores without parsing. Conditional receipt deletion still requires exact valid selectors. Disposable corrupt snapshot/search rows may be rebuilt or removed.
Storage owns atomic publication finalization. Crypto and network work prepare encrypted replacements before opening IndexedDB. One strict-durability, generation/CAS-checked transaction installs or rebases the surviving newer fork, conditionally retires the exact frozen receipt and obsolete source record, and updates accounting. Abort preserves the original records. The coordinator consumes this API; independent `putDraft`/`deleteDraft` calls are not atomic finalization. Tightened receipt writes and removal of `persistSubmissionState` outcome rewrites land together.

Acceptance: revision regression, selector changes, and changed receipt bytes are rejected; same bytes are idempotent; one malformed envelope cannot block valid recovery or explicit deletion; stale writers cannot recreate data after clear; unmeasurable opaque rows preserve recoverable data without allowing undercounted growth; failed multi-record finalization leaves receipt and fork recoverable; valid explicit old-generation recovery commits before editor application; changed rewrap selectors or old-envelope bytes fail.

#### B4 — Read-only corpus and invalidation stream — high

`listSnapshots` is readonly. Only a successfully committed explicit reader open calls `markSnapshotOpened`. Snapshot/search mutations atomically increment `corpusRevision` and notify local tabs; consumers re-read authoritative IDB state rather than trusting the notification payload.

Expiry and known eligibility changes invalidate reader/search projections. Protection success immediately removes the local snapshot/search pair or reports deletion failure without claiming removal. Reader open and async digest/render application recheck selection, generation, corpus revision, record existence, and expiry after every await.
Return a readonly consistent corpus view containing committed `sessionGeneration` and `corpusRevision`. Use one content-free postcommit notification path, not a second channel or local authority. Actual-open recency writes do not increment `corpusRevision`. Visibility/focus and next-expiry checks recover from missed notifications. Protection enable or credential rotation removes all locale variants of the immutable page; protection removal requires fresh snapshot admission before eligibility returns.

Acceptance: listing/search does not rewrite snapshots or alter `lastOpenedAt`; only actual open updates one record; expiry/removal/clear/protection in another tab removes visible stale results; old async work cannot replace the selected article.

#### B5 — Key acquisition and secret handling — high

Use one shared current key acquisition per verified owner/generation. Concurrent callers receive a stable handle rather than invalidating each other. Check abort, owner, epoch, generation, and registry currentness after every await and before publishing a key or plaintext.

Bound key-frame streaming before full buffering and eliminate avoidable untracked key copies. Keep zeroing claims explicitly best-effort; imported `CryptoKey` remains nonextractable.
A caller cancellation cancels only that caller's wait; it must not invalidate another legitimate same-owner consumer. Session invalidation aborts shared acquisition for every consumer. Check caller cancellation and registry currentness after import and before returning or publishing the handle. Remove avoidable server frame/key copies as well as client copies.

Acceptance: concurrent same-owner acquisition keeps both consumers usable; cancellation/invalidation during import cannot publish a handle; oversize frames are canceled without unbounded buffering; owner/auth/AAD tamper remains opaque.

#### B6 — Identity boundary semantics — blocker

One session owner performs global invalidation and broadcast. Coordinator lock is local, idempotent, clears references/timers before callbacks, and never recursively invalidates. Capture one actor/epoch for protected workflows and check it before dispatch, after each await, before rendering, and before follow-up mutation.

Explicit logout start and confirmed account switch synchronously lock, abort, and clear local plaintext, then atomically advance persisted generation and purge only positively validated ordinary account drafts, retaining receipts and opaque rows. Network logout failure does not unlock the local account.

A 401, key-release failure, or verified inactive/revoked identity locks protected UI, drops current key references, and fences pending work; it does not establish a different owner or justify purging recovery records. Advance the persisted invalidation fence for that boundary. Same-account/current-authVersion recovery of preserved older-generation ordinary text is explicit: authenticate through the recovery-decrypt boundary, commit an exact-CAS current-generation replacement through B3, then apply a detached review fork. Wrong-owner, wrong-authVersion, or undecryptable rows remain opaque and delete-only.

A transport, server, or unparseable `whoami` failure is verification unavailable, not anonymous. Do not purge or advance persisted generation. Preserve the prior verified actor and existing warm key solely for already-authorized local text capture; protected online operations remain unavailable until real verification succeeds. Cold startup never manufactures this actor or key, and same-account revalidation after a transient outage is not a new login or automatic restore.

Acceptance: one invalidation does not recurse; a committed draft and subsequent warm local capture survive transient verification failure; cold offline startup exposes only generic locked counts; 401 recovery is explicit and commits the new-generation fork before rendering; logout/switch and late decrypt, save, search, or Agent results cannot restore prior-account plaintext or dispatch follow-up mutations.

### C. Editor recovery and foreground publication

#### C1 — Canonical editor adapter and detached recovery — blocker

The real editor document, not Pinia alone, owns capture/replacement/clear. Define one adapter for every supported editor. Restore must detach/destroy collaboration before replacing visible content; a recovered fork cannot enter Yjs or pending collaboration updates implicitly. Account invalidation clears document, undo/history, preview, merge state, and transport.

Preserve the restored fork's original base revision independently from current bootstrap/store values. Existing-page receipts match immutable page ID, not mutable path/locale. Present all differing branches with verified useful context; do not compare independent record revisions as a global clock.

Bound or compact the in-memory collaboration update backlog and bind its lifetime to the captured account/session generation.

Acceptance: recovered text appears in the real editor and survives the next keystroke; no collaboration update is emitted by restore; logout clears every plaintext projection; uninterrupted same-owner live collaboration still reconnects with a bounded backlog.

#### C2 — One serialized per-draft transition stream — blocker

Serialize capture, reconnect, restore, migration, discard, publish preparation, and finalization per draft. `captureThrough(editVersion)` resolves only when that exact or a newer relevant state is durably committed. Discard drains/cancels queued capture and honors deletion results. CAS collision preserves a branch and exposes review rather than repeatedly retrying stale revision.

Track unsaved memory, saving locally, committed current text, needs review, and unresolved submission distinctly. Storage failure never claims saved state. Optional offline storage failure may disable durable-recovery publication, but it must not make ordinary online editing unavailable without a truthful warning.
When optional key or IndexedDB support is unavailable, an explicitly online-only ordinary save remains available through the existing current-session, authorization, and CAS path, with a truthful warning that durable recovery and a local submission receipt are unavailable. Recovered or durable publication remains receipt-gated. Keyboard and touch save behavior follow the same distinction; no ordinary online save is falsely described as durable.

Acceptance: delayed capture/reconnect/discard cannot resurrect or lose a fork; current-text saved status follows the exact committed edit version; online editing remains usable when optional storage cannot open.

#### C3 — Exact immutable foreground submission — blocker

For durable-recovery publication, at Save synchronously capture one full request body, eligible draft payload, actor/epoch, edit version, identity, and base. Commit an immutable receipt for exactly that snapshot, then send the request body derived from the same snapshot. Never reread live editor state to define the submission.

Later edits remain a distinct mutable version. Known success finalizes only the frozen submission and atomically migrates/rebases a surviving newer fork to the returned page ID/revision before navigation. Create success does not redirect until later edits are durably recoverable.
Create or move success must not navigate while newer eligible text or nonpersisted editor state would be lost. Text can be preserved through B3's atomic finalization; unsupported metadata or merge memory remains a navigation veto rather than silently entering the durable payload.

Classify stages separately: authoritative no-commit rejection, transport/outcome ambiguity after dispatch, known write success, and optional post-write failure. A failed visibility mutation or refresh cannot rewrite a known successful page write as unknown. Preserve HTTP status even when its response body is malformed.

Acceptance: type B while A publishes—server and receipt contain A and B survives durably; create migration retains B under returned identity/revision; successful write plus follow-up failure remains known success; no reconnect/reload path replays the mutation.

#### C4 — Coherent review, merge, and receipt resolution — high

Retain `sourceRevision` already present in the existing conflict-latest server result through `client/helpers/pages-api.ts` and the merge consumer. A restored base mismatch enters explicit authoritative comparison. Only accepted merge establishes the new base.

HTTP 409 returns to actionable conflict review and retires the rejected receipt from ambiguous-outcome handling. HTTP 401 locks identity; 403/404 mark resource unavailable while preserving permitted local export/delete policy. An unresolved receipt recovered after restart is outcome-unknown; Continue explicitly applies its selected payload as a detached review fork after comparison.
Continue retains the unresolved receipt until explicit resolution and durable replacement succeed. A failed replacement or deletion cannot clear the receipt or local recovery branch merely because the UI attempted resolution.

Acceptance: revision-5 fork over revision 6 cannot publish without review; accepted merge updates base and next save succeeds; 401/403/404 before and after receipt have distinct truthful states; Continue visibly applies the chosen content.

#### C5 — Complete reload-safety facts — blocker

Reload safety includes exact current eligible-text commit, dirty metadata, route/identity, merge editor memory, collaboration backlog, unresolved receipts, capture/finalization transitions, storage errors, and actor epoch. Text equality alone cannot authorize reload. Notify the worker coordinator whenever any fact changes.

Best-effort eligible-text flush on `visibilitychange`/`pagehide`; attach `beforeunload` only while needed. Unsupported metadata remains outside durable payload scope and therefore vetoes reload.
New editors report unsafe until their adapter and coordinator are ready. Every caller notifies lifecycle coordination when commit version, dirty metadata, merge state, actor epoch, receipt state, or a transition changes; notification is not limited to provider replacement.

Acceptance: committed text plus dirty tags/CSS/publication/merge state blocks update; unresolved receipt blocks update; capture failure never reports safe; mobile background behavior is truthful and no stronger durability claim is made.

### D. Service worker, routing, update, and retirement

#### D1 — Exact navigation policy — high

Parse `Accept` quality values correctly: `text/html;q=0` is not accepted. Maintain one explicit network-only table covering all API, auth, setup, verification/reset token, user/profile, admin, Agent, GraphQL, WebSocket, asset/private, and mutation routes including nested forms. Cross-origin, non-GET, non-navigation, extension/static, and received HTTP errors never receive shell fallback.
The reserved-family table is case-insensitive to match server routing and includes `/_api`, `/api`, `/graphql`, `/mcp`; `/login`, `/logout`, `/register`, `/auth`, `/session`, `/unlock`, `/_unlock`, `/verify`, `/login-reset`; `/u`, `/upload`, `/uploads`, `/setup`, `/admin`, `/a`, `/p`, `/_admin`, `/_private`, `/_userav`; `/d`, `/e`, `/h`, `/s`, `/i`, `/t`; and worker, tombstone, health, metrics, robots, manifest, and unlisted asset paths. Reserved families include nested forms. Preserve method-first and cross-origin bypass. Only the exact generated finite hashed-asset set is eligible for owned-cache lookup; prefix-wide asset caching is prohibited. `/_offline` is the explicit neutral entry, not permission to fall back on reserved routes.

Owners: `client/helpers/pwa-route-policy.ts`, `client/service-worker.ts`.

Acceptance: exhaustive route families and encoded, normalized, query, and hash forms pass; actual offline `/verify/token`, `/login-reset/token`, `/u`, `/_unlock`, and mixed-case `/LOGIN` never return neutral HTML; received 401/403/404/500 remain authoritative; healthy unrelated assets bypass optional cache work; sensitive request or response data never appears in owned Cache Storage.

#### D2 — Transactional worker install and bounded caches — high

Use an isolated build cache and make it eligible for serving only after its exact release-bound closure has been completely fetched and validated and installation succeeds. Do not copy or rename caches under an atomic-promotion assumption, and do not modify or delete an already-serving complete cache. Catchable install failures delete only the incomplete candidate. Abrupt termination may leave a nonservable orphan; the next install or activation removes owned incomplete orphans. Activation retires owned obsolete caches only after the new serving cache is complete and never deletes unrelated caches.

Bind the shell manifest and CSP extraction to the same generated release closure. Use the existing Vite production build as the documented prerequisite that provisions compiled PWA artifacts before the normal parallel development server/client launch. Keep ordinary application HMR; offline-source changes require rebuilding and restarting that compiled neutral surface. Do not add a relaxed-CSP HMR shell, second development worker, or fallback to stale artifacts. Missing required artifacts return explicit no-store 503 responses.

Network navigation runs before optional cache work. Cache Storage open or match failure disables offline support, not healthy online navigation or unrelated assets. Installation validates that the stable `/_offline` response belongs to the installing worker's release and that every required import/style is in that release closure, including worker-only changes with an unchanged shell manifest.

Acceptance: injected fetch or put failure preserves the prior active cache and leaves no eligible partial cache; simulated termination leaves at most an ignored orphan removed by the next lifecycle; release-A worker with release-B shell rejects readiness; Cache Storage denial still permits online navigation; a clean documented build provisions `assets/client/offline.html`, `assets/service-worker.js`, `assets/sw-tombstone.js`, and their closure before claiming readiness.

#### D3 — Restartable, race-safe update preparation — blocker

Replace volatile votes with one bounded preparation round identified by worker, release, round nonce, and client safety revision. The waiting worker alone owns round selection; coalesce or reject competing initiators and remove the second BroadcastChannel vote mechanism. Message handlers use `event.waitUntil`. Require a fresh affirmative revision-bound vote from every enumerated current client, suppress obsolete async safety samples, and defer on missing or false votes. Worker restart or deadline expiry discards consent and returns an actionable deferred state.

Before `skipWaiting()` is requested, a changed safety revision or client roster cancels the round. `skipWaiting()` is irreversible. After that boundary activation may proceed, but each client independently rechecks its current actor/epoch and complete safety revision immediately before its once-per-activated-epoch reload. A client that changed, never acknowledged, or became unsafe keeps its document and defers reload until current facts are safe. Recheck again after every final await before navigation.

Acceptance: two/three-tab tests cover safe, dirty, changing-safety, closed/new tab, delayed/missing vote, competing initiators, worker restart, expired rounds, duplicate messages, and one reload per tab. Also change safety or add a tab after the final roster check and after `skipWaiting()`; activation may complete but unsafe documents and later edits remain in place.

#### D4 — Safe retirement/tombstone — blocker

When retirement mode is configured, server bootstrap suppresses registration. The tombstone immediately retires owned worker caches and unregisters itself. It may replace/navigate only clients proven reload-safe; unsafe tabs retain their document and visible retirement notice until they become safe or the user deliberately navigates. Never navigate before unregistering; never force destructive emergency reload.

Preserve IndexedDB snapshots/drafts and unrelated caches. Restoring feature mode re-enables registration with a fresh worker.
Derive tombstone selection and registration suppression from one authoritative process-controlled mode exposed as neutral non-secret metadata in both ordinary and offline bootstraps without inline script or CSP relaxation. Restrict replacement to relevant controlled windows; never navigate arbitrary `includeUncontrolled` windows. Attempt unregister even when owned-cache cleanup fails or navigation stalls. No permanent browser retirement flag may prevent a later feature deployment.

Acceptance: actual corrected-image feature→tombstone→feature deployment proves unregister even when cleanup fails, exact owned-cache cleanup, unrelated-window protection, unsafe-tab preservation, every IndexedDB store retained, no re-registration loop or permanent retirement flag, and restored worker operation.

#### D5 — Install and manifest delivery truth — medium

Serve the existing `/_assets/manifest-tsepistle.json` before generic static middleware with `application/manifest+json`, `public, max-age=0, must-revalidate`, and existing GET/HEAD/ETag/Last-Modified behavior. Do not create a second manifest or change other asset policies. Consume an install prompt synchronously and invoke it single-flight; an older invocation cannot clear a newer offered event. Prompt acceptance, observed `appinstalled`, and current standalone display are separate facts. Dismissal permits later offers. Shell and ordinary status use one capability/guidance policy for Chromium, Firefox, iOS/iPadOS Home Screen, and macOS Safari Dock; unavailable native APIs are neither errors nor promises.

Acceptance: manifest metadata refreshes without seven-day staleness; accepted, dismissed, unsupported, installed-normal-tab, standalone, and later display-mode changes produce accurate labels; concurrent install clicks invoke one prompt and do not consume a later offer.

#### D6 — Registration, verified offline readiness, and bounded probes — high

Deduplicate only in-flight registration. Explicit Retry after failure can register again; observe failures of the first install as well as updates. Mark offline-ready only after the expected feature worker acknowledges its complete current shell cache. An active controller/registration, tombstone, or evicted shell is insufficient.

Bound health probes with `AbortController` and a deadline. Capture a connection epoch; older responses cannot overwrite newer offline/probe state. Every probe settles its own pending state. Reachability remains separate from identity and domain authorization. While a new check is pending, Checking takes precedence over a previous successful result.

Owners: lifecycle owner of `client/helpers/pwa.ts` and `client/service-worker.ts`; shell and status consume the shared policy.

Acceptance: failed initial registration recovers by explicit Retry; tombstone or evicted cache never advertises offline-ready; a hung probe settles and can be retried; late success cannot override newer loss.

### E. Reader, search, server-only surfaces, and design

#### E1 — Search correctness and bounded work — high

Use a corpus-revision-consistent lightweight view. Normalize each admitted document once per corpus revision. Ranking is deterministic, cancelable, chunked, and bounded by input records/characters/time; very large duplicate input cannot bypass traversal bounds. Return `hasMore` from actual matching results, not corpus size.
Inspect at most the first 100 input candidates before validation or deduplication, preserving the first valid identity within that bound; candidate 101 cannot be admitted merely because duplicates reduced the unique count. Return at most 50 results. Normalize and reuse deterministic scoring/tie fields once per corpus revision. Do not add an arbitrary timing ceiling or worker in place of bounded chunked correction.

Separate retry lifecycle from query request IDs. Retry works with an empty query and always settles its own pending state; only result application is fenced by query ID. Typed transport failure may mark domain unavailable; 401/403/validation errors do not.

Acceptance: rapid maximum-corpus queries remain responsive and latest-only, perform no snapshot writes, and abort deterministically; retry plus concurrent typing cannot latch; a matching candidate at index 101 remains absent when the first 100 are duplicate or invalid; zero, one, or exactly 50 matches do not claim truncation, while 51 matches do.

#### E2 — Shared online-only capability contract — high

Every Agent/history/MCP/memory/comment/editor/page-watch/protection/admin action requires verified transport plus fresh domain authorization/resource state. A health probe is not authorization. Preserve an already-open Agent workspace and unsent component text through transient transport loss; destroy it on verified identity invalidation.

Initialization/retry creates a fresh authority read rather than reusing a fulfilled promise. Async results are fenced by actor, resource, operation generation, and component lifetime. Mutations remain disabled until fresh read success; retries never replay a prior mutation. Nested context pickers and already-open subpanels use the same gate.
**Agent parent/store and nested surfaces.** Ship parent retention and child readiness together. Separate entering a new workspace from retaining an open one. Retry reads the existing thread before reconnecting its stream; it never creates a conversation or sends text. Initialization deduplicates only an in-flight current-identity/resource read. Store refresh reports whether a fresh current result was accepted, not merely absence of an exception. Reject disposed workspaces at action entry. Cover history pagination/open, context search/hydration, personal skills, goals, stop/approval controls, keyboard handlers, reader/header navigation, watch, and protection. Retry remains reachable inside the active modal.

**History.** Capture owner/workspace/component workflow identity before every follow-on request. A folder creation completing after close, switch, or disposal cannot issue the subsequent move. Keep partial commit distinct from refresh failure. Reconcile uncertain create, move, or clear by reads before another explicit destructive choice.

**MCP.** Refresh start/failure invalidates decision readiness. One predicate includes current proposal identity/status, approval status, expiry, and accepted fresh-read success. Retain a successful decision independently of follow-up refresh; failed refresh cannot re-enable the old pending proposal. Transport-unknown decisions require read reconciliation before another explicit choice.

**Memory.** Refresh preserves unsaved text and reconciles selected-entry existence/version. Adopting a new base or destructive confirmation requires explicit review. An uncertain create triggers a read and truthful unresolved-outcome explanation before explicit repeat.

**Comments.** Invalidate posting/management readiness on transport loss, page/owner change, and authority errors; only fresh current page/discussion authority restores it. Preserve typed HTTP status and distinguish auth, permission/not-found, validation/conflict, server, and transport-unknown outcomes. Fence mentions, edit reads, notifications, and final updates by owner/page/component generation, including A→B→A. Clear submitted composer/edit text only if its captured local revision still matches; an old completion cannot erase newer input. Uncertain create is reconciled by reads and never reposted automatically. Preserve accessible mention-combobox behavior, ignore composing IME keys, and honor reduced motion in imperative scrolling.

Owners: touched Agent components, comments, `client/components/common/search-results.vue`, `client/components/common/nav-header.vue`, reader actions, shared identity/session boundary.

Acceptance: disconnect during every touched surface; controls stay visible with one clear reason/retry, no mutation dispatches, stale responses cannot re-enable actions, open Agent state survives transport loss, and recovery follows fresh domain reads. Hold folder creation across close/switch and observe no move; approve MCP then fail refresh and observe no second pending decision; preserve memory unsaved text across conflicting refresh; type B while comment A posts and preserve B; retrying an Agent creates no conversation and reconnects no stream before a fresh thread read.

#### E3 — Compact library-first offline shell — high

Keep the warm paper/dark evergreen field-notebook identity, separate entry, system fonts, and neutral dependency closure. Make downloaded-page discovery the first viewport task. Reduce the promotional hero. Group storage/install/update details as secondary notebook-margin content or disclosures.

Opening a page replaces the list with a reader in the same primary region. Preserve query, result/list position, and opener identity. Each row has separate noninteractive metadata, exactly one named open control, and a contextual remove control. Clear old body immediately on selection, show loading, and disable copy/share until the selected record's fenced integrity/render commit completes. Retain the immutable selector URL while selected; native history makes refresh and Back meaningful without a router. Successful open focuses the heading; Back restores opener or search. Removing the focused row selects next, then previous, then search, even when it was not the open reader. Actions wrap without ancestor clipping.

Use plain-language labels: Saved pages, Locked drafts, Checking the server, Saved on this device, App update. Keep security guarantees in supporting copy, not protocol jargon.

Acceptance: desktop, tablet, narrow mobile, and mobile landscape show search/results immediately; slow A then B cannot mix body, heading, copy/share bytes, or focus; selected deep links survive refresh; Back restores query/library; deleting the final focused row restores search; one row has one open stop; no control clips or horizontal page overflow.

#### E4 — Reader styling, accessibility, and async integrity — blocker

Use reader-root-constrained Vue scoped `:deep(:where(...))` styles for descendants inserted by `renderOfflineHtmlFragment`; retain that helper as the only audited HTML parsing/insertion boundary. Restore clear `:focus-visible` outlines; do not let scoped `outline: 0` suppress shell focus. Preserve 44px touch targets, semantic controls, ordered headings/regions, status/live announcements, forced colors, reduced motion, RTL, safe areas, and dark contrast.

Keep table and header semantics. Put genuinely wide tables and code in named keyboard-operable local overflow regions using fixed trusted renderer output and classes, not copied source attributes or inline styles. Essential metadata is at least `.75rem`, reading text approximately `1rem`, and reading measure 65–75ch. Normal text meets 4.5:1 on its actual surface; large text and essential control/focus boundaries meet 3:1. Assess light, dark, and forced-colors separately. Bind valid article language, use `dir=auto` for saved text, and bidi-isolate route/revision runs.

Treat digest mismatch, expiry, removal, or context change as terminal for the selected generation. Retry updates status only and never navigates, even after success. A successful relevant expected response enables a separate Return to wiki action; an HTTP error or reachability alone does not. Preserve the current reader until the user chooses that action.

Acceptance: inserted headings, links, code, and tables receive intended styles and semantics; keyboard focus is visible; screen readers receive selection/loading/error/removal semantics; delayed selection cannot mix content; 320px CSS reflow and 200% text sizing retain controls; at default text size a 390×844 viewport exposes search without promotional scrolling; page scroll width is at most viewport width +1px; wide content scrolls locally by keyboard; successful and unsuccessful Retry both leave the reader in place.

#### E5 — Truthful ordinary reader/share/status wording — medium

Provide a real `aria-describedby` target for offline status. Distinguish eligible to save, saving, committed available, expiring, stale/update available, removal failure, and unavailable. Durable errors remain visible with retry rather than tooltip-only.

In `client/components/common/social-sharing.vue`, rename the metadata-only ordinary reader action to Copy page summary with matching success feedback. This does not replace the neutral saved reader's full-text action. Keep Copy URL and native sharing independent.

Acceptance: assistive technology resolves every description; a failed commit never announces availability; title, description, and body fixtures prove the ordinary summary payload matches its label.

#### E5a — Neutral-shell operation status and device clearing — medium

Distinguish uninspected/loading, ready-empty/results, searching, search-empty/error, storage-error, and reader-error. Unknown count is not zero and failed search is not No matches. Each operation owns one visible durable status and one announcement. Separate capacity estimates from persistence and clear results. Describe captured revision as a saved version, not current server freshness without revalidation. Disclose that browser storage is not a backup and disconnected public copies cannot be remotely recalled. Locked records expose generic counts only.

Keep Remove downloaded pages separate from Clear offline data on this device. The latter requires explicit confirmation naming downloaded pages, locked drafts, and unresolved submission recovery, and states that server data is not deleted. Cancel changes neither data nor generation. Consume `clearDeviceData({ expectedSessionGeneration })`: synchronous local key/projection invalidation precedes one atomic generation increment/raw-store clear, followed by committed notification. Never parse records to decide deletion, reset the database, or bypass unknown-schema preservation.

Acceptance: delayed inspection does not flash zero; search error differs from empty success; persistence/clear outcomes remain visible independently of estimates and announce once; cancel preserves data/generation; confirmed clear removes opaque rows and receipts atomically; failure does not claim success; newer schemas remain untouched; another tab cannot resurrect cleared state.

#### E5b — Neutral-reader full text and sharing — medium

Copy page text copies complete validated passive reading text, not the bounded description/search excerpt. Derive it lazily from the ready current passive tree through the existing renderer boundary; add no parser, sink, fetch, or persisted projection. Clipboard failure exposes complete selectable read-only text under the existing CSP. Disable copy/share until the current verified render commits.

Native Share remains optional excerpt-plus-local-link behavior. Its label, payload, and visible feedback never claim to transfer a saved copy. Explain that a local link opens only where that download exists; native-share cancellation is silent. Keep Copy URL, full text, and native sharing distinct. Canonical links consume A2.

Acceptance: a body longer than 320 characters copies through its last text; clipboard denial exposes full selectable text; a changed selection cannot copy unverified content; native cancellation is silent; local-link recipient limitation is visible.

#### E6 — Canonical install assets and palette — medium

Convert legacy JPEG-encoded `.png` paths to real PNGs: 192 Android, Apple touch, Windows tile, 16px, and 32px favicons. Keep the verified 512 any-purpose and maskable safe-zone assets. Align `browserconfig.xml`, setup theme/mask metadata, manifest/master, and shipped icon palette to one canonical product palette.
Retain the shipped blue/purple artwork and select `#4f46e5` for static install-chrome accent in manifest, master, setup, and browserconfig metadata. Keep manifest background `#F7F7F5` and the neutral notebook palette intentionally distinct. Re-encode the existing paths at 192, 180, 150, 16, and 32 square pixels. Preserve valid 512 any/maskable assets and central 80% maskable safe zone. Do not change configured site-logo resolution or edit generated copies.

Acceptance: every declared MIME matches decoded bytes and dimensions; maskable foreground remains safe; decoded asset/MIME/palette checks pass in available engines. Native iOS/macOS/Windows installed chrome remains separate environment-specific evidence and cannot be claimed from Linux emulation.

#### E7 — Bundle discipline — medium

Restore the 12,288 KiB all-JavaScript aggregate budget unless a new measured current build demonstrates a justified exception with provenance. The 128 KiB increase at `b5e3bfdf` has no recorded need; historical build had about 790 KiB headroom and the new offline-specific generated closure is about 67 KiB raw excluding shared existing chunks.

Do not add a search worker, router, UI framework, design-system package, or authenticated entry dependency without measured need.
Leave existing app, setup, largest-chunk, and login budgets unchanged. Record neutral closure membership plus raw and gzip sizes through existing measurement. The closure contains no authenticated app/store/router/editor/Agent/Vuetify/personalized theme/external-font input, and neutral reading makes no account bootstrap or draft-key request. Exceeding an established budget requires a separate measured decision.

Acceptance: current production build passes the restored budget; initial, largest, aggregate, and offline closure numbers are recorded by the existing checker output.

## Implementation ownership and order

Shared files have one owner. Do not run concurrent whole-file edits. Main first freezes these interfaces: actor/account/authVersion/generation/local epoch/cancellation; readonly corpus view with committed generation and corpus revision; actual-open touch; `clearDeviceData`; exact-envelope recovery/rewrap; pre-encrypted atomic finalization; `captureThrough(editVersion)` and frozen submission; editor capture/detached-replace/clear/nonpersisted facts; accepted-current domain refresh; release-bound complete shell and feature/retirement mode; bounded safety preparation/release.

1. **Parallel roots**
   - Server authority owner: next migration, `server/models/pages.ts`, `server/jobs/render-page.ts`, `server/operations/pages.ts`, `server/helpers/offline-page.ts`, `server/controllers/api/pages.ts`, `server/core/config.ts`, `server/helpers/offline-draft-keys.ts`, `server/controllers/api/offline.ts`.
   - Storage owner: `shared/offline.ts`, `client/helpers/offline-storage.ts`; sole owner of B1–B4 mechanics, strict CAS, atomic finalization/clear, and accounting.
   - Session/crypto/store owner: `client/helpers/offline-session.ts`, `client/helpers/offline-crypto.ts`, `client/store/index.ts`; sole global identity, actor, key, and invalidation owner.
   - Delivery/build owner: `vite.config.mts`, `server/controllers/pwa.ts`, `server/master.ts`, `server/helpers/vite-assets.ts`, `package.json`, `client/offline.html`, `server/views/master.pug`; owns compiled development provisioning, HTTP delivery, feature/retirement mode, and release closure.
   - Lifecycle owner: `client/helpers/pwa.ts`, `client/helpers/pwa-route-policy.ts`, `client/service-worker.ts`, `client/client-app.ts`, `client/index-offline.ts`; owns registration/probe/install, routing, complete-cache protocol, updates, and retirement consumption.
   - Static assets/budget owner: manifest, corrected favicon sources, static palette references, and `server/scripts/check-bundle-budgets.ts`; submits server-view metadata to the delivery owner and never edits generated copies.
2. **State machines**
   - Coordinator owner: `client/helpers/offline-editor-drafts.ts`; consumes storage atomic transitions and owns C2. Receipt immutability enforcement and removal of outcome-rewrite callers land as one cutover.
   - Editor integration owner: `client/components/editor.vue`, conflict modal, `client/helpers/pages-api.ts`, editor key/conflict events, supported editor implementations, and collaboration. Final integration waits for storage/session/coordinator contracts and supplies complete safety facts before lifecycle activation integration.
3. **Consumers**
   - Reader/search owner: `client/themes/default/components/page.vue`, `client/components/common/nav-header.vue`, `client/components/common/search-results.vue`, `client/helpers/offline-search.ts`, `client/helpers/offline-renderer.ts`; owns corpus projections and Agent-parent retention hunks.
   - Agent integration/store owner: Agent store, inline chat, context picker, personal skills, thread, goal, and composer; parent retention and child readiness ship together.
   - Exclusive domain owners: history panel; memory manager; MCP approval; comments plus comments API. Each consumes the common actor, readiness, and accepted-refresh contract.
   - Neutral/status/share owner: `client/offline-app.vue`, `client/components/pwa/offline-library.vue`, `client/components/pwa/pwa-status.vue`, `client/components/common/social-sharing.vue`; consumes frozen storage, renderer, and lifecycle interfaces.
4. **Evidence**
   - Main owns both plan documents, Playwright project inclusion, and integrated browser fixtures.
   - Update meaningful behavior tests only. Remove assertions that pin mock echoes, source text, call counts that merely pin plumbing, key-usage order, or undocumented tie ordering; retain observable exactly-once, no-replay, and single-flight checks.
   - Prove root contracts before consumers, actual integrated flows after cutover, and run project gates once after all owners land.

## Required regression evidence

Permanent tests are justified only for plausible contract regressions:

- Render-provenance pending/failed/race and uniform anonymous denial.
- Cross-side known-answer KDF/frame vector and mounted draft-key privacy boundary.
- Real IndexedDB physical upgrade, generation race, exact accounting, corrupt-row recovery, immutable receipt, transaction failure, readonly list, and two-connection lifecycle.
- Draft restore/base, exact save snapshot with edits during publish, serialized discard/reconnect, create migration, 409 accepted revision, status-preserving malformed denial, actor invalidation, transient auth outage, and no replay.
- Route `q=0`, complete sensitive route families, encoded/normalized paths, worker cache/install/update/retirement behavior.
- Search duplicate/input bounds, corpus invalidation, retry ownership, and actual-match truncation.
- Exact snapshot DTO keys at the operation boundary; do not overclaim an exhaustive ordinary page DTO through `objectContaining` controller mocks.
- Mounted production PWA delivery, CSP/ETag/HEAD/error/tombstone, manifest cache/MIME, and clean-development behavior.
- Independent fixed wire/AAD interoperability vectors include null and non-null submission IDs; same-code round trips are insufficient.
- Production adapter tests cover corrupt-row isolation, incomplete accounting, clear cancel/confirm, atomic multi-record finalization failure, unknown-schema preservation, and explicit old-generation recovery. A fake implementing CAS is not adapter proof.
- Coordinator assertions recover state through a fresh verified consumer. No replay is proved at the editor/network mutation boundary, not by ciphertext inequality or key-fetch counts.
- Projection tests use realistic source with sentinel private, permission, and protected metadata at the real projection boundary. Controller mock echo does not prove exhaustive admission.
- `dev/e2e/offline.e2e.ts` is explicitly selected in existing Chromium desktop/mobile, Firefox desktop, and WebKit desktop/mobile/landscape project matches; no new browser projects are required solely for this feature.

## Browser and deployment acceptance matrix

For each matrix row, record observed, unrun, or blocked; actual engine, OS, and device; scenario; and observation. Existing Playwright projects provide configurations, not PWA evidence. Linux Playwright WebKit/iPhone emulation does not prove branded Safari, native iOS installation, physical safe-area/background termination, Windows install chrome, or spoken assistive-technology output. Native iOS/macOS/Windows installation and real screen-reader checks remain separately pending when unavailable; they require actual runtime evidence or an explicit user-approved scope waiver, never emulation-based PASS.
Exercise the built and deployed service, not only helper tests:

1. First-ever visit, warmed worker, first-ever offline failure, and warmed neutral-shell fallback.
2. Download/reload/search/open/expiry/revalidate/remove/clear, including another-tab invalidation and IDB/Cache inspection.
3. Private, protected, unpublished, rule-denied, custom-active, stale-render, and unsafe-link candidates leave no readable residue.
4. Authenticated editor crash/reload restore, detached recovery, stale-base review, 409 merge, edits during save, create migration, and outcome-unknown inspection with no replay.
5. 401/403/404/transport/post-success failure paths and storage-unavailable online editing.
6. Logout, transient auth outage, account switch, key acquisition races, and late async responses across tabs.
7. Agent, comments, history, MCP, memory, watch, protection, and other server-only gates during outage/recovery.
8. Multi-tab update with safe, dirty metadata, merge memory, unresolved receipt, changing safety, missing vote, closed/new tab, competing initiator, worker restart, and once-only reload.
9. Desktop Chromium/Firefox/WebKit; mobile Chromium/WebKit; mobile landscape; keyboard; screen reader semantics; dark; forced colors; reduced motion; RTL; safe areas; install/share/clipboard denial.
10. Maximum corpus rapid search responsiveness and bundle-budget output.
11. Actual feature-worker to tombstone to restored-feature deployment, preserving PostgreSQL, configuration, secrets, volumes, IndexedDB, drafts, snapshots, unrelated caches, ports, and service identity.
Concrete cells also include failed first registration/retry, evicted shell readiness, timed-out/obsolete probes, mixed-release install, unavailable Cache Storage with healthy online navigation, history/MCP/memory partial or unknown outcomes, comments newer-input/ABA preservation, selector refresh/Back/delete focus, full-body clipboard-denial fallback, whole-device-clear cancel/confirm/newer-schema refusal, successful Retry without navigation, and real inserted wide-table/code keyboard scrolling and light-theme contrast/reflow. Inspect Cache Storage and IndexedDB after sensitive transitions. Browser reload proves committed recovery, not power-loss durability.

Before any application restart, complete A3 live-domain preservation, then take the risk-selected paired server recovery point required by `docs/agents-deployment.md`. A1, A3, and physical IndexedDB v2 are material persistent-state, key, and writer-compatibility changes. Server backups do not back up browser storage or a discarded process-memory key domain. Default rollback is retirement on the corrected schema-aware image and fix-forward, retaining the provenance column, physical v2, installation identity, and ciphertext. A prior image is eligible only after proving server writer/provenance compatibility, safe physical-v2 handling, and exact key-domain continuity; its tag alone proves none. Do not down-migrate or reset PostgreSQL/IndexedDB, and do not describe restoration that rewinds intervening writes as no-loss rollback. Re-render eligible pages after migration; never certify old renders by marker backfill.

## Explicit non-goals and rejected fixes

- No Turso/libSQL/ElectricSQL, OPFS SQL, replication, or second database abstraction.
- No persistent browser draft keys, offline authorization cache, private snapshots, background sync, or mutation queue.
- No raw-source fallback, sanitizer widening, or anonymous render-on-download side effect.
- No forced reload/navigation of unsafe tabs, even during retirement.
- No global unhandled-rejection suppression, database reset, corrupt-draft auto-delete, or silent draft eviction.
- No full app/Vuetify/theme import into the neutral shell.
- No new search worker or virtualization until bounded main-thread fixes are measured and shown insufficient.
- No broad release/attestation ceremony; this remains Development Sprint work.

## Completion record

This document is the implementation contract. Completion requires every blocker/high correction, every directly supporting medium correction, changed-path verification, a committed corrected revision, affected-service build/deployment, and focused tailnet smoke. Every browser-matrix cell must be truthfully observed, blocked, or unrun. Required native-platform or assistive-technology rows cannot be claimed complete while pending; narrowing them requires explicit user approval. Any intentionally rejected implementation item requires evidence recorded here; silence is not completion.

### Completed implementation and verification — 2026-09-15

- Audited `docs/pwa-offline.md` and every changed file in every commit after `2dc5e7e10aaaf315c6b5f352a44fe90a3a4dcf67`. The implementation cutover is recorded by `11e9a6ce`, `2438933d`, `0d727a71`, `6a006317`, `a661e6f9`, `101bba16`, `3fdf8435`, and `c149e1b8`; obsolete paths were removed rather than retained as compatibility shims.
- Final static and repository gates passed: client and server typechecks, Biome lint, focused offline/schema/search checks, and 518 of 518 isolated Bun test files.
- The production Docker build for product revision `3fdf8435bd469827745773074c1f6c012947ba50` passed every bundle budget. The neutral offline closure measured 381,787 raw bytes and 122,526 gzip bytes; all JavaScript chunks measured 12,251.6 KiB against the 12,288.0 KiB limit.
- The isolated browser matrix ran 48 cases against the built image with deliberately seeded public pages: 42 passed and 6 were explicitly skipped. Chromium 151.0.7922.34 covered desktop 1440×900 and Pixel 7 emulation; Firefox 153.0 covered desktop; WebKit 26.5 covered desktop and iPhone 13 portrait/landscape emulation.
- Four skips are the deterministic clipboard-denial case on non-Chromium engines, where Playwright cannot control clipboard rejection. Two Firefox skips are network-offline cases: Playwright Firefox `setOffline` returned while requests still reached the server, including authenticated endpoints, so Firefox offline-fallback and offline-expiry behavior is blocked rather than falsely marked observed. Firefox's remaining six cases passed. Direct Cache Storage inspection remained cross-engine independent.
- Native Safari on macOS/iOS, physical iOS safe-area and background-termination behavior, Windows installation chrome, and spoken screen-reader output were unavailable on the Linux workstation. They remain blocked/unrun under the user-approved scope waiver; Playwright WebKit and device emulation are not represented as native evidence.
- Maintained-profile storage inspection after update activation found one active `/sw.js` registration, no waiting worker, one owned precache, and only `/_offline` plus hashed `/_assets/js/` and `/_assets/assets/` entries. IndexedDB `tsepistle-offline` remained physical version 2 with `drafts`, `meta`, `searchDocuments`, and `snapshots`; the final counts were 0, 1, 0, and 0 respectively. No sensitive route appeared in Cache Storage.
- The maintained browser exercised safe feature-worker update activation and a real offline navigation fallback to the neutral shell. An earlier feature → tombstone → restored-feature deployment exercise removed the worker and owned cache while preserving IndexedDB v2, then restored one feature worker without deleting retained offline records.
- Before the final application replacement, active agent-run/goal writer states were absent and `/wiki/data` was preserved at `/home/bbferko/.local/state/wiki-recovery/20260915T124304Z/data`; the validated PostgreSQL recovery point remains `/home/bbferko/.local/state/wiki-recovery/20260915T113549Z`.
- The affected `wiki-tailnet` service was recreated alone from `local/tsepistle:pwa-3fdf8435`; PostgreSQL and unrelated services were not recreated. Local and tailnet health returned `{"ok":true}`, startup identified revision `3fdf8435bd469827745773074c1f6c012947ba50` without the prior strict-schema warning, and the authenticated Chromium smoke rendered the maintained wiki, activated the feature update, inspected storage, exercised offline fallback, and returned online.
- Maintained database counts after deployment were 16 pages, 49 page-history rows, 2 assets, 4 users, and 3 groups. The temporary runtime fixture page was removed; its create/delete audit retained one additional page-history row, which is the only intentional database delta from the 48-row baseline.
