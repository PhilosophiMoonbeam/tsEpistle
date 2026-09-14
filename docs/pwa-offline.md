# Progressive Web App and offline architecture

Status: approved implementation plan for Development Sprint work

## 1. Purpose

tsEpistle will become an installable Progressive Web App with a deliberately bounded offline knowledge library. The application will provide:

- an authentication-neutral offline shell;
- explicit download and removal of eligible pages;
- bounded local search over downloaded pages;
- durable recovery of eligible editor text drafts;
- explicit, revision-safe foreground publishing after reconnection;
- truthful connectivity, persistence, update, and capability states;
- graceful handling of Agent, comments, administration, authentication, and other server-only features;
- progressive install and outbound-share enhancements where the platform supports them.

The server, PostgreSQL, page-rule authorization, publication state, page protection, source revisions, collaboration generations, and Agent action kernel remain authoritative. Browser state never grants authorization and is never a second source of truth.

This plan is complete for the requested feature. Push notifications, Background Sync, Periodic Background Sync, inbound share targets, private-page offline access, and database replication are explicit non-goals because they are not required for correct offline behavior and are not consistently available across target platforms.

## 2. Repository facts and constraints

- `vite.config.mts` emits two hashed entrypoints under `/_assets/`; there is no generic Vite-generated SPA document.
- `server/views/master.pug` renders personalized HTML and boot configuration. Ordinary wiki routes remain server-owned.
- `client/client-app.ts` currently refreshes authentication before mounting.
- `server/helpers/page-access.ts` proves that `visibility === 'public'` does not mean anonymous-readable. Page rules, tags, publication state, and protection still apply.
- `server/models/pages.ts` already enforces `sourceRevision` and update-time conflicts transactionally.
- `client/components/editor/collaboration.ts` has an in-memory collaboration reconnect queue, not a durable local draft store.
- Page, search, authentication, and Agent APIs are requester-sensitive and generally `private, no-store`. Their HTTP responses must not become offline cache entries.
- The existing manifest at `client/static/manifest-tsepistle.json` is replaced in place; no second competing manifest is introduced.

Root deployment is the supported scope. Subpath hosting is not introduced by this change.

## 3. Architecture decisions

### 3.1 Storage choice

Use IndexedDB through the small `idb` package. Cache Storage is reserved for the neutral shell and explicitly safe build assets. IndexedDB stores application-owned, versioned DTOs.

Turso/libSQL is not selected. Turso has browser-capable WASM and remote clients, but it does not bridge tsEpistle's PostgreSQL authority, page-rule ACLs, publication model, or source-revision compare-and-swap contract. Its sync semantics would add another database protocol, credentials, runtime weight, migrations, and conflict model without eliminating the application-specific admission and reconciliation logic. ElectricSQL and similar replication systems have the same ownership problem and additionally require replication infrastructure. A typed IndexedDB adapter is smaller, auditable, and aligned with the required data volume.

### 3.2 Service worker

Use `vite-plugin-pwa` in `injectManifest` mode with a custom `client/service-worker.ts`. The worker is emitted and served at `/sw.js`, with application scope `/`. The Vite asset base `/_assets/` does not determine worker scope. Freeze `VitePWA({ strategies: 'injectManifest', manifest: false, injectRegister: false })`: the existing static manifest is the only manifest, and `client/helpers/pwa.ts` owns the only registration.

The worker MUST:

1. precache only the neutral offline document and its explicit build dependency closure;
2. use content-hashed static assets safely;
3. treat authentication, session, page/search API, draft-key, Agent/MCP, GraphQL, setup/admin operations, uploads, unlock, logout, and every non-GET request as network-only;
4. never store SSR reader documents, API responses, redirects, errors, cookies, tokens, permission data, protected content, draft keys, or mutation requests;
5. return the neutral offline document only for failed, same-origin, allowlisted navigation GETs that accept HTML;
6. never substitute offline HTML for API/module/asset requests or for server 401/403/404 responses;
7. activate naturally after existing clients close unless every active client explicitly reports reload-safe state;
8. avoid unconditional `skipWaiting`, generic request queues, blanket cache deletion, and background mutation replay.

Installability and offline operation are separate: browser install UI is an enhancement, not a prerequisite.

### 3.3 Neutral shell

`/_offline` is a server route available before authentication and personalization. It serves a fixed, non-user-specific document with no page body, account data, permissions, CSRF token, Agent state, analytics payload, or custom site scripts. It boots a separate `client/index-offline.ts` entry and `client/offline-app.vue` surface.

The server serves `/sw.js`, `/_offline`, and the manifest with correct MIME types, explicit revalidation headers, and stable URLs. The offline document may use safe site-neutral product branding only. `/_offline` MUST send a strict generated CSP whose `default-src` is `'none'`, whose `script-src` and `style-src` list only the exact hashed offline application script/style URLs for that build (no wildcard, `unsafe-inline`, or generic same-origin source), whose `connect-src` is only `'self'`, and whose `img-src`, `font-src`, `media-src`, `object-src`, `base-uri`, `frame-src`, `form-action`, and `child-src` are respectively `'none'`, `'none'`, `'none'`, `'none'`, `'none'`, `'none'`, `'none'`, and `'none'`; `worker-src` and `manifest-src` are only `'self'`. The generated header is also applied to the cached offline document. Ordinary reader, editor, `/a`, `/p`, setup, login, and private routes remain unchanged and server-owned.

## 4. Capability model

| Capability | Offline | Reconnected behavior |
| --- | --- | --- |
| Neutral shell | Available after one successful warm-up | Refreshes safely when update accepted |
| Explicitly downloaded page | Readable until local/known publication expiry | Revalidate eligibility and revision |
| Downloaded-page search | Local, bounded, visibly partial | Server search remains authoritative online |
| Eligible editor text draft | Durable local recovery | Explicit foreground review/publish |
| Page create/update/move/delete | Unavailable | Existing revision-safe server operation |
| Agent/Ask/Wiki Agent | Unavailable with explanation | Existing authenticated initialization and send |
| Comments/watch/approval/protection/history | Unavailable | Existing authenticated APIs |
| Login/logout/TFA/password change | Network required | Existing POST/no-store flows |
| Admin/profile operations | Network required | Existing routes and APIs |
| Live collaboration | No new durable replay | Existing fresh-session/generation reconnect |
| Outbound share | Copy/export fallback | `navigator.share` when supported and user-initiated |
| Install prompt | Platform-specific guidance | Native prompt when exposed |

`navigator.onLine` is a hint only. A capability becomes available after its actual request succeeds. UI wording MUST distinguish **Available offline**, **Saved on this device**, **Waiting for connection**, **Needs review**, **Publishing**, **Published**, **Update ready**, and **Server unavailable**.

## 5. Server admission contract

Add `GET /_api/pages/:id/offline-snapshot` as the only page-download admission boundary. It is not a generic page cache endpoint.

The operation MUST evaluate the real database-backed guest principal and freshly loaded page-rule authority independently of the requesting account. It MUST require, from one coherent authoritative state:

- public visibility;
- publication currently active and in-window;
- current guest read access with complete locale/path/tag context;
- no page protection or unlock requirement;
- supported, safe content projection;
- current positive `sourceRevision`.

A privileged caller, writer permission, password-unlock session, or success from ordinary `get()` MUST NOT make a page eligible. Unknown authority, incomplete context, inconsistent revision, unsupported active content, or projection failure fails closed.

Successful responses use an exhaustive versioned DTO; they never spread `PageDetails`, SSR locals, editor bootstrap objects, or mutation responses:

```ts
interface OfflineHtmlFragmentV1 {
  representation: 'sanitized-html-fragment'
  sanitizerVersion: 'offline-html-allowlist-v1'
  html: string
}

interface OfflinePageSnapshotV1 {
  schemaVersion: 1
  pageId: number
  locale: string
  path: string
  canonicalPath: string
  title: string
  description: string
  sourceRevision: string
  capturedAt: string
  expiresAt: string | null
  content: OfflineHtmlFragmentV1
  searchText: string
  contentType: 'sanitized-html-fragment'
  integrity: string
}
```

The server renders eligible source into `OfflineHtmlFragmentV1` and then applies the named `offline-html-allowlist-v1` sanitizer. Its only allowed elements are passive formatting and table/text elements (`p`, `br`, `h1`–`h6`, `ul`, `ol`, `li`, `blockquote`, `pre`, `code`, `strong`, `em`, `del`, `s`, `mark`, `hr`, `dl`, `dt`, `dd`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, and `a`); its only allowed attribute is `href` on `a`. It rejects or strips every other element and attribute, including SVG, MathML, forms, inputs, embeds, objects, frames, media, canvas, `src`, `srcset`, `poster`, `background`, `cite`, `action`, `formaction`, `xlink:href`, `srcdoc`, `style`, event-handler attributes, and DOM-clobbering names such as `id`, `name`, `slot`, and `form`. Anchor URLs are limited to relative same-origin links and `https:`, `http:`, or `mailto:`; `javascript:`, `data:`, `blob:`, `file:`, protocol-relative, and other schemes fail closed. No rendered node may cause an automatic subresource request.

The persisted value is never editor/source markup. Unknown constructs, sanitizer-version mismatches, unsafe URLs, or projection failures return a bounded ineligible result rather than raw content. On the client, only the audited `renderOfflineHtmlFragment` helper may parse and insert the fragment; it validates the schema, integrity, and sanitizer version, repeats the allowlist check defensively, and uses the sole controlled DOM HTML sink. All titles, descriptions, search results, status, and other metadata are inserted as text nodes (`textContent`), never as HTML. Rendering performs no fetch; links navigate only after an explicit user action.

The endpoint itself is `Cache-Control: private, no-store` with `Vary: Cookie`; only the validated DTO is persisted by application code. Harden ordinary `GET /_api/pages/:id` responses to `private, no-store` and `Vary: Cookie` regardless of visibility because projections can be requester-dependent.

Account-owned draft keys come from a separate same-origin `POST /_api/offline/draft-key`, never from the snapshot endpoint. The request is CSRF-protected, uses the current human session and database-backed `whoami`/`authVersion`, ignores any claimed owner, returns `private, no-store` with `Vary: Cookie`, and is always bypassed by the service worker. The server derives the versioned key as specified in §6.2 and releases it only after online same-account verification.

`content` is a passive offline reader projection. It excludes contacts, permissions, ownership, custom scripts/styles, executable embeds, authenticated asset URLs, Agent material, comments, hidden metadata, page passwords, and protected transclusions. Unsupported pages return a bounded ineligible result rather than raw content.

Downloaded public information cannot be remotely recalled while disconnected. The UI states this limitation. Known publication expiry is honored locally. On authoritative denial or ineligibility, remove the snapshot and derived search index immediately; associated user drafts become locked for explicit copy/export or deletion and are never rendered as newly authorized server content.

## 6. IndexedDB contract

Create `shared/offline.ts` for schemas and `client/helpers/offline-storage.ts` for the only database adapter. Database schema versions are integers. Stores:

- `meta`: schema/version, persisted `sessionGeneration`, last cleanup, storage estimates;
- `snapshots`: guest-readable `OfflinePageSnapshotV1` records keyed by `[siteId, immutable pageId, locale]`; mutable `path` and `canonicalPath` are fields, never identity;
- `drafts`: account-owned encrypted `OfflineDraftEnvelopeV1` records keyed only by opaque random `recordId`; IndexedDB's origin partition supplies site selection, and the clear envelope retains only `accountId`, `authVersion`, fixed `keyVersion`, `sessionGeneration`, `draftRevision`, and opaque `submissionId`; editor/page identity, route, locale, base state, timestamps, and workflow state are encrypted payload fields.
- `searchDocuments`: disposable normalized records derived only from current snapshots, keyed by the same site/page/locale identity.

Limits are fixed: at most 100 snapshots, 20 MiB total managed data, and 1 MiB per snapshot or encrypted draft envelope. Least-recently-opened snapshots may be evicted after warning; dirty drafts and immutable publishing/outcome records are never silently evicted. Use `navigator.storage.persist()`, `persisted()`, and `estimate()` when supported. Denial is normal degradation, not an error promise.

Every transaction reports success only after transaction completion. Open, quota, serialization, blocked upgrade, version-change, and commit failures remain visible; the UI MUST NOT say Saved if commit did not complete. A newer unknown schema refuses writes and preserves data. `versionchange` closes old connections. Disposable snapshot/search formats can rebuild independently from irreplaceable draft migrations.

Snapshot download and revalidation use one readwrite transaction: for the site and immutable `pageId` (and its locale variants), delete every prior snapshot and derived search document, then insert the new snapshot and search record before commit. A moved route or corrected canonical path therefore atomically replaces old route/search data and cannot leave a stale searchable alias. Denial/deletion uses the same transaction.

### 6.1 Ownership, generation, and confidentiality

Snapshots are guest-readable and contain only guest-admitted content. Draft keys contain a minimal stable server-derived account ID for selection and race checks; remembered UI state, cookies, local permissions, and tokens do not establish ownership. `accountId`, `sessionGeneration`, and draft revisions are selection/race controls, not confidentiality controls: IndexedDB is origin-wide, so adapter filtering alone is never a security boundary.

A persisted monotonically changing `sessionGeneration` fences logout, account switch, explicit clear-data, and identity invalidation. Every asynchronous read, write, search, download, and publish captures owner plus session generation and rechecks both before commit or render. BroadcastChannel coordinates tabs, but generation checks are authoritative against late resurrection.

On logout start—before waiting for network logout—the client locks account-owned UI, advances `sessionGeneration`, aborts requests, broadcasts invalidation, clears in-memory projections and the draft key, and purges ordinary account drafts. It MUST retain any immutable `publishing` or `outcome-unknown` submission whose request may have committed, but marks it locked and opaque; it remains non-renderable and non-exportable until the same account is verified online and reconciliation completes, or until the user explicitly deletes it. Account switch uses the same boundary. A failed network logout is reported separately and does not unlock local account content.

Cold offline startup never reconstructs an authenticated session and never obtains a draft key. Locked records reveal only a generic count; no record metadata is rendered until the current online same-account `authVersion` verification releases the matching key. A wrong-owner record, unavailable current key, authentication/tag failure, malformed envelope, or undecryptable ciphertext is opaque and delete-only: it may not be rendered, searched, exported, reconciled, or used to recover server content.

### 6.2 Draft key lifecycle

`POST /_api/offline/draft-key` verifies the current human session against the database, derives the trusted canonical origin and site ID from server configuration, and derives the current positive-safe-integer account ID and `authVersion` itself; client-supplied origin, site, account, or auth version is ignored. `keyVersion` is the fixed literal `'session-secret-v1'`. Define `LP_UTF8(v)` as `U32_BE(byteLength(UTF8(v))) || UTF8(v)`, with no implicit separators. The exact HKDF-SHA-256 construction is `salt = SHA256(ASCII("tsepistle/offline-draft-key/v1"))`; `PRK = HKDF-Extract(salt, currentConfiguredServerSessionSecret)`; `info = LP_UTF8("tsepistle/offline-draft-key/v1") || LP_UTF8(canonicalOrigin) || LP_UTF8(siteId) || U64_BE(accountId) || U64_BE(currentAuthVersion) || LP_UTF8("session-secret-v1")`; `OKM = HKDF-Expand(PRK, info, 32)`. The server derives every context value, and no arbitrary client-selected version enters derivation. A stored envelope whose integer `authVersion` is not the currently verified database `authVersion` is never released a key and remains locked/delete-only.

The successful `application/octet-stream` response is one exact frame: ASCII magic `TSODK1`, then `LP_UTF8(canonicalOrigin)`, `LP_UTF8(siteId)`, `U64_BE(accountId)`, `U64_BE(currentAuthVersion)`, `LP_UTF8("session-secret-v1")`, and exactly 32 raw key bytes with no trailing bytes. The client MUST parse and bounds-check this frame and use its server-authoritative context for the envelope, KDF context checks, and AAD; it MUST NOT source those values from remembered `whoami` or client input. The response is `private, no-store`, `Vary: Cookie`, same-origin, CSRF-protected, and never cached or intercepted by the service worker.

The client immediately imports the framed key bytes as a non-extractable `CryptoKey`, drops the raw response/frame buffer with best-effort zeroing, keeps only the key and non-secret server context in memory, and never stores key bytes in IndexedDB, Cache Storage, localStorage, URLs, logs, or service-worker state. Logout, account switch, tab/session invalidation, and key release failure drop all references. Each encryption uses a fresh random 96-bit AES-GCM nonce and a 128-bit authentication tag stored with ciphertext. Canonical AAD is encoded in this exact order: `U32_BE(schemaVersion)`, `LP_UTF8(recordId)`, `U64_BE(accountId)`, `U64_BE(authVersion)`, `LP_UTF8("session-secret-v1")`, `U64_BE(sessionGeneration)`, `U64_BE(draftRevision)`, `0x00` for null or `0x01 || LP_UTF8(submissionId)` for non-null, then `LP_BYTES(nonce)` where `LP_BYTES` is `U32_BE(byteLength(bytes)) || bytes`. The AAD includes the nonce and excludes ciphertext; AES-GCM authenticates the ciphertext itself. Editor/page identity, locale/path, base revision, timestamps, state, title, description, and source content exist only inside the authenticated ciphertext.

Auth-version advance or server-session-secret rotation prevents future release of old envelopes; they remain locked/delete-only. Logout/account switch drops local key references and blocks release while the same account is unverified; a later online verification of the same account may release the matching current-account/current-authVersion key so retained `publishing` or `outcome-unknown` submissions can reconcile. Logout cannot remotely erase a `CryptoKey` already held by a live compromised context. New writes use current values. No revocation status is inferred beyond the current server auth/session checks.

## 7. Draft and reconciliation state machine

`OfflineDraftEnvelopeV1` persists only opaque selectors and ciphertext:

```ts
interface OfflineDraftEnvelopeV1 {
  schemaVersion: 1
  recordId: string
  accountId: number
  authVersion: number
  keyVersion: 'session-secret-v1'
  sessionGeneration: number
  draftRevision: number
  submissionId: string | null
  nonce: Uint8Array
  ciphertext: Uint8Array
}

interface OfflineDraftPayloadV1 {
  editorKey: PageEditorKey
  pageId: number | null
  createIdentity: string | null
  locale: string
  path: string
  baseSourceRevision: string | null
  baseUpdatedAt: string | null
  updatedAt: string
  state: 'local' | 'needs-review' | 'publishing' | 'conflict' | 'locked' | 'outcome-unknown'
  title: string
  description: string
  content: string
}
```

`recordId` is a random opaque identifier. The clear envelope has no editor, page, route, locale, revision, timestamp, title, description, source, or state information beyond the minimum selectors needed for ownership selection and race control; locked records therefore reveal only a generic count in the UI. `OfflineDraftPayloadV1` and any future draft payload fields are encrypted; the schema rejects unknown clear fields.

`sessionGeneration` is persisted in `meta` and copied into each envelope. `draftRevision` is a separate monotonically increasing per-draft commit number and advances on every successful local edit commit. An explicit publish creates an immutable opaque `submissionId`; the frozen encrypted submission record is written atomically before any network mutation. Subsequent edits use a newer `draftRevision` and never mutate that submission record.

Capture and restore are wired explicitly through `client/components/editor.vue`, `client/helpers/editor-key.ts`, `client/components/editor/editor-markdown.vue`, `client/components/editor/editor-visual-markdown.vue`, `client/components/editor/editor-ckeditor.vue`, `client/components/editor/editor-asciidoc.vue`, and `client/components/editor/editor-code.vue`; each implementation maps only its canonical `PageEditorKey` and returns the eligible text payload.

Transitions:

1. An already-open, online-authorized eligible editor records a base revision and obtains the in-memory key only after same-account verification.
2. Dirty source is debounced, assigned the next `draftRevision`, encrypted with fresh nonce/AAD, and committed through a per-draft compare-and-swap transaction. The UI reports **Saved on this device** only after commit.
3. UI reports **Saved on this device**, never **Published**.
4. Reconnect changes the draft to **Needs review**; it does not submit automatically.
5. User explicitly chooses publish. The app atomically freezes the immutable encrypted submission snapshot with captured `sessionGeneration`, `draftRevision`, and `submissionId`, confirms current session/account/write authority, decrypts only in memory, fetches a consistent latest revision/content, and submits through the existing `expectedSourceRevision` and collaboration-generation contract.
6. Success marks the exact submission Published and removes it only if the current record still matches all three captured values (`sessionGeneration`, `draftRevision`, and `submissionId`); newer edits remain.
7. HTTP 409 enters the existing conflict/merge surface with local and current remote content.
8. HTTP 401 locks the draft pending verified login. HTTP 403/404 marks it unavailable and prohibits server-content recovery. Wrong-owner or undecryptable records remain delete-only.
9. Transport loss, crash, or tab termination after submission enters **Outcome unknown**. The app MUST NOT replay automatically; the immutable record survives logout locked/opaque, then same-account online verification fetches authoritative state and asks the user to resolve, or explicit deletion removes it.

The advisory timestamp conflict endpoint is not a write guard. `sourceRevision` compare-and-swap remains authoritative. Live Yjs collaboration keeps its existing freshly authorized generation-fenced reconnect path; a recovered local fork is never injected automatically into a shared session.

Before service-worker update reload, every active client reports whether it has uncommitted editor memory, a committed draft, or an in-flight/unknown publish. Missing acknowledgement defers reload.

## 8. Offline library and search UX

The visual direction is a **resilient field notebook**: a quiet, editorial extension of the current reader chrome, not a dashboard replacement. Reuse theme surface, glass, typography, focus, and motion tokens.

The page tools surface gains **Save for offline** only when the server snapshot endpoint admits the page. States: downloading, available offline, update available, expiring, unavailable, remove. The control includes text and accessible status, not icon-only color semantics.

The neutral shell includes:

- clear offline/server-unavailable status;
- downloaded-page library with title, locale, last captured time, revision freshness, size, and expiry;
- local search field labeled **Downloaded pages**;
- locked-draft count without revealing titles until identity verification;
- retry connection action;
- install help when relevant;
- storage usage and clear-device-data controls.

Local search normalizes title, description, and safe plain `searchText`; it is bounded to the downloaded corpus, cancelable, deterministic, and may run in a worker. Ranking prioritizes exact title, title prefix/token, description, then body term frequency. Results state **Searching N downloaded pages** and never imply parity with server lexical/semantic/Agent search. Structured server-query syntax may be treated as plain text or explain that advanced search requires connection.

The existing search overlay switches explicitly between online wiki search and downloaded search. Ask/Agent, server preview, comments, watch, approvals, protection, history, administration, and mutations remain visible when contextually useful but disabled with concise explanations and a Retry action. Hiding them without explanation is prohibited; enabling them from cached permission state is prohibited.

## 9. Install, update, sharing, and platform behavior

Manifest requirements: stable `id`, root `start_url` and `scope`, standalone display, correct theme/background colors, 192 and 512 PNG icons, a maskable 512 icon, and existing Apple touch icon. Shortcuts point only to safe existing root-scope destinations and are omitted where no safe route exists.

- Chromium desktop/Android: use `beforeinstallprompt` and `appinstalled` when exposed; never promise prompt availability.
- iOS/iPadOS: provide manual Add to Home Screen guidance; do not claim support for `beforeinstallprompt`, Background Sync, manifest shortcuts, or share targets.
- macOS Safari: support Dock installation behavior available in current Safari and manifest shortcuts where available.
- Firefox: offline APIs remain baseline; install guidance must reflect platform/browser capability rather than claiming universal Chromium install APIs.

Outbound share uses `navigator.share`/`canShare` from a user gesture and handles cancellation silently. Copy link and export/copy-text fallbacks remain available. Offline sharing of a downloaded page shares a truthful title/text excerpt or local route, not a claim that recipients can access unavailable or restricted content.

Registration is single-instance and exposes explicit callbacks for ready, offline-ready, update-ready, reload-needed, and registration error. Updates are prompted. The app does not rely on a stale library helper argument to suppress reload; it owns `onNeedReload` behavior. Reduced-motion users receive no decorative transition; forced-colors, keyboard focus, screen-reader live regions, 44px touch targets, RTL, dark mode, safe-area insets, compact mobile layout, and landscape are acceptance requirements.

## 10. Implementation phases and ownership

### Phase A — contracts and admission

1. `shared/offline.ts`, `client/helpers/offline-storage.ts`, `package.json`, `bun.lock`: shared DTOs, `PageEditorKey` usage, encrypted-envelope validation, IndexedDB schema, limits, session-generation fencing, draft-revision/submission CAS, and `idb` dependency.
2. `server/operations/pages.ts`, `server/controllers/api/pages.ts`, `server/helpers/offline-page.ts`, `client/helpers/pages-api.ts`: guest admission, server-rendered sanitized fragment, exhaustive snapshot projection, response headers, and client validation.
3. `server/controllers/api/offline.ts` and `server/helpers/offline-draft-keys.ts` (owned by the existing authentication/session boundary): CSRF-protected draft-key endpoint, server-authoritative canonical origin/site/account/current authVersion inputs, fixed `session-secret-v1` key version, exact HKDF/AAD encodings, no-store headers, and service-worker bypass.
4. `vite.config.mts`, `client/service-worker.ts`, `client/offline.html`, `client/index-offline.ts`, `client/offline-app.vue`, and audited `client/helpers/offline-renderer.ts`: `injectManifest` build with `manifest: false` and `injectRegister: false`, neutral entry, strict `/_offline` CSP, inert fragment sink, route allowlist, and update lifecycle primitives.
5. `client/static/manifest-tsepistle.json`, icon assets, `server/views/master.pug`: one canonical manifest and install metadata.

Freeze shared DTOs, key/envelope semantics, CSP/sanitizer allowlists, and endpoint ownership before consuming work begins.

### Phase B — delivery, identity, and library

1. `server/master.ts` and a small PWA controller: stable `/sw.js` and `/_offline` delivery before personalization.
2. `client/store/index.ts`, `client/helpers/offline-session.ts`, `client/helpers/pwa.ts`, `client/client-app.ts`: shell-first bootstrap, auth/generation transitions, one registration, update/install state.
3. `client/components/pwa/offline-library.vue`, `client/helpers/offline-search.ts`, optional search worker: library, storage status, bounded local search.

### Phase C — integrated product behavior

1. `client/themes/default/components/page.vue`, `client/components/common/nav-header.vue`, `client/components/common/search-results.vue`: save/remove affordance, status, downloaded-search mode, server-only explanations.
2. `client/components/editor.vue`, `client/components/editor/editor-markdown.vue`, `client/components/editor/editor-visual-markdown.vue`, `client/components/editor/editor-ckeditor.vue`, `client/components/editor/editor-asciidoc.vue`, `client/components/editor/editor-code.vue`, and `client/components/editor/editor-modal-conflict.vue`: durable encrypted text capture, restore, foreground publish, conflict and outcome-unknown flow.
3. `client/components/editor/collaboration.ts`, editor implementations, `client/components/agents/inline-agent-chat.vue`: identity-gated reconnect and explicit online-only capability states.

Owners MUST coordinate on shared files; no parallel agent edits may collide. Every phase updates affected behavior tests before the next dependency phase.

## 11. Verification contract

### Static and behavior gates

- dependency policy and lockfile consistency;
- client/shared/server typechecks;
- focused tests for DTO validation, guest admission, unsafe projection rejection, response headers, IDB migrations/generation fencing/quota failure, draft CAS, conflict/outcome-unknown transitions, search ranking/bounds, service-worker route classification, registration/update state, and auth/logout cleanup;
- production build and bundle budgets.

### Browser matrix

Exercise Chromium desktop/mobile, Firefox desktop, and WebKit desktop/mobile using the existing responsive Playwright projects. Required scenarios:

1. first online visit installs worker; first-ever offline visit without warm-up fails honestly;
2. warmed neutral shell launches offline;
3. eligible page downloads, survives reload, searches locally, expires, revalidates, and removes;
4. protected/private/unpublished/rule-restricted/custom-active-content pages cannot download and leave no Cache Storage/IDB residue;
5. logout/account switch during download/search/draft/publish cannot resurrect stale data in another tab;
6. eligible editor text survives crash/offline reload and is labeled local, not published;
7. reconnect requires review; 409 opens merge; 401 locks; 403/404 invalidates; ambiguous transport outcome never replays;
8. Agent/comments/admin/write controls explain network requirement and recover after successful requests;
9. update waits while any tab has unsafe state and proceeds after all acknowledge;
10. install guidance, outbound share/copy fallback, reduced motion, keyboard focus, screen reader labels, dark mode, RTL, safe areas, and mobile landscape behave correctly.
11. explicit rollback deploys the `/sw.js` tombstone, proves the installed worker unregisters, exact PWA caches disappear, controlled clients return to network documents, and IndexedDB drafts remain intact.

Inspect Cache Storage and IndexedDB after sensitive browsing, logout, account switch, rejection, and deletion. No protected response, credential, permission projection, Agent content, or mutation request may remain.
### Deployment

In Development Sprint, build and deploy only the affected wiki service to the maintained local tailnet. Preserve PostgreSQL, volumes, configuration, secrets, ports, networks, identities, and writable-layer data. Verify health, ordinary data continuity, manifest/installability, `/sw.js` scope, warmed offline launch, one download/search flow, one draft/reconnect flow, one server-only gate, update behavior, and the independent tombstone rollback procedure. A health endpoint alone is not proof.

## 12. Rollback and residual risk

Rollback MUST account for browser-owned service-worker state. Retain a separately deployable JavaScript tombstone artifact at the exact `/sw.js` URL and root scope, served with `Content-Type: application/javascript` and no-cache update headers. On explicit rollback, deploy the tombstone before selecting the prior image (or as the rollback artifact), and make it the one justified exception to normal update policy: it activates with `skipWaiting` and `clients.claim`, deletes only exact tsEpistle PWA cache namespaces, unregisters its own registration, and forces controlled clients back to a network document. It MUST NOT delete or migrate IndexedDB, including encrypted drafts. Once retirement is observed, the prior image may be selected; it must ignore unknown newer IndexedDB schemas rather than delete drafts.

Browser proof for rollback installs the feature worker and warms its caches, deploys the tombstone at `/sw.js`, reloads controlled clients, observes unregistration and network-document control, inspects that only exact PWA caches were removed, and verifies snapshots/search data may be gone while every draft envelope remains in IndexedDB. No rollback may rely on returning 404, removing the route, blanket cache deletion, or unregistering only from application code.

Residual risks are explicit:

- downloaded public data can remain on a disconnected device after remote policy changes;
- browser storage can be evicted and is not a backup;
- platform install and background capabilities vary and can be withheld;
- a network loss after submission can make write outcome unknown;
- encrypted drafts protect durable account payloads from wrong-account adapter access, but an actively compromised origin while a verified key is in memory remains outside this browser-storage boundary;
- safe offline projection intentionally rejects content that cannot be represented without active or authenticated dependencies.

These risks are mitigated by guest-only snapshot admission, bounded retention, local expiry, online revalidation, explicit states, no mutation replay, revision CAS, authenticated encryption with memory-only keys, export/delete controls, tombstone retirement, and truthful UI. Private or protected offline page snapshots remain disabled; encrypted account drafts are not server authorization and never become readable without same-account online key release.
