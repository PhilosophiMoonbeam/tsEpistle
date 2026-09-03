# tsEpistle Dropbox Integration Implementation Plan
**Status:** Refined planning baseline; implementation is blocked until Decisions D1–D9 are closed  
**Verified:** 2026-09-03  
**Target:** tsEpistle `0.1.0-alpha.1`, based on Wiki.js `2.5.314`

## 1. Purpose and release boundary
This plan adds an optional, user-owned Dropbox file connection without changing Dropbox login.
The first product increment provides:
- An entitled-only connection and recovery card on `/p/profile`, delivered before any file-data UI and limited to status plus Connect/Reconnect/Disconnect.
- An explicit editor workflow, **Import to wiki assets and insert**, as the first enabled file-facing surface.
- A following “Connected archive” personal workspace at `/p/files`.
- Indexed search, metadata resolution, and attachment-only user-initiated download/export across the completed increment.
- No Dropbox write, sharing, webhook, live-sync, or provider-backed page-reference capability.
Full Dropbox is selected because the required workflow includes pre-existing personal content. It does not exceed the connected member’s Dropbox permissions. App Folder remains the lower-risk target for a later export/backup application. Access type is selected in the Dropbox App Console and cannot be upgraded with OAuth scopes.
Use a separate Full Dropbox connector registration from the existing App Folder identity-login registration. This cleanly preserves identity login compatibility and consent. A later App Folder export/backup registration remains separate from both.
This is a tsEpistle implementation plan, not a reusable file-manager PRD.

## 2. Non-negotiable invariants
1. Current Dropbox login is identity-only and MUST remain unchanged.
2. `/login/:strategy` and `/login/:strategy/callback` MUST NOT become file-consent routes.
3. Dropbox sign-in MUST NOT grant file access or reveal a Dropbox file affordance.
4. Delegated file authorization MUST use a separate authenticated connection flow and data model.
5. Each file-data operation MUST require, in order: active internal user, `use:dropbox`, deployment capability, owned active connection, returned Dropbox scope, and operation-specific wiki permission.
6. `manage:system` MUST NOT bypass `use:dropbox` or permit access to another user’s Dropbox.
7. No cached metadata may be read, token decrypted/refreshed, or Dropbox call made before the applicable lifecycle or file-data guard passes.
8. Unknown, unentitled, unlinked, revoked, and insufficient-scope states MUST disclose no names, paths, counts, thumbnails, cached rows, activity, or commands.
9. Only an entitled disconnected user MAY see Connect.
10. Browser application code MUST NOT receive Dropbox access/refresh tokens, app secrets, or temporary links; an authorization code may appear only in the callback navigation covered by invariant 11.
11. An OAuth authorization code MAY appear only in the callback query, MUST be consumed exactly once immediately, and MUST then be removed by a clean local redirect. It and all secrets or temporary links MUST be redacted from callback/request logging and MUST NOT enter JWTs, Express sessions, jobs, any other URL, logs, analytics, page source, or client storage.
12. Client selectors MUST NOT serve as account or connection authority.
13. Browse, selection, metadata, and later preview MUST NOT copy a file.
14. A wiki copy MUST occur only after explicit **Import to wiki assets and insert** confirmation.
15. Durable page markup MUST contain a stable same-origin managed asset path, never a Dropbox temporary/shared link.
16. Existing same-origin media validators MUST NOT be relaxed for Dropbox URLs.
17. Authorization, policy, entitlement, cancellation, or lease loss MUST fence response-byte delivery and managed-asset visibility across instances; local abort or a pre-commit check alone is insufficient.
18. Provider calls MUST occur after authorization, never as permission discovery.

## 3. Audited repository baseline
### 3.1 Runtime and client
| Item | Audited value | Source |
|---|---:|---|
| tsEpistle | `0.1.0-alpha.1` | `package.json` |
| Wiki.js upstream | `2.5.314` | `package.json` |
| Bun | `1.4.0`; engine `>=1.4.0 <2` | `package.json` |
| Vue | `3.5.41` | `package.json` |
| Vuetify | `4.1.9` | `package.json` |
| Vite | `8.2.1` | `package.json` |
| TypeScript | `6.0.2` | `package.json` |
| Vue Router | `5.2.0` | `package.json` |
| Pinia | `4.0.3` | `package.json` |
| vue-filepond | `8.0.0` | `package.json` |
`package.json` remains authoritative. No Dropbox SDK is installed. Vuetify `4.1.9` is installed; there is no stale “target version” or migration caveat.

### 3.2 Current Dropbox login
- `server/modules/authentication/dropbox/definition.yml` instructs operators to create an App Folder app with only `account_info.read`.
- `server/modules/authentication/dropbox/dropbox-strategy.ts` implements the login authorization-code/profile flow.
- `server/modules/authentication/dropbox/authentication.ts` receives access and refresh token arguments but discards both.
- The callback persists only identity linkage through `users.providerKey/providerId`.
- `authentication.config` is global login-strategy configuration, not per-user secret storage.
- Existing Dropbox-login users have no reusable file grant and MUST explicitly connect.
The plan MUST NOT claim the login grant can be reused. File connection MUST NOT call `processProfile` or mutate `users.providerKey/providerId`. Eligible local, LDAP, OIDC, and other users may connect Dropbox without changing login provider.

### 3.3 Current host conventions
- Browser session APIs use `/_api`, not generic `/api/files`.
- Controllers authorize the session/JWT principal and delegate work to operations/models.
- Client facades use injected fetch, `sameOriginJsonFetch`, and runtime response validation.
- `/_api` has no universal CSRF guard; connector mutations need explicit server enforcement.
- Existing state-changing helpers use `x-wiki-csrf` where supported.
- Durable jobs are versioned, leased, bounded, cancellable, and at-least-once.
- Exhausted durable jobs end as `failed`; there is no dead-letter state.
- At-least-once jobs and local deduplication do not make Dropbox writes exactly-once.

### 3.4 Current client/wiki seams
- `client/router.ts` owns `profileRoutes()`; its `/p` history base maps route `/files` to `/p/files`.
- `client/components/profile.vue` owns the profile navigation and shell; `client/components/profile/profile.vue` is the existing `/p/profile` page and the seam for an early connection-only card.
- `client/components/profile/pages.vue` is the nearest route-page pattern.
- Shared REST facades live in `client/helpers`; complex cross-surface state may use `client/store`.
- `client/components/editor/editor-modal-media.vue` browses local assets and rejects stale loads using `AbortController` plus request generations.
- `client/helpers/assets-api.ts` is the local asset REST facade.
- `client/helpers/editor-insert-events.ts` inserts stable local `IMAGE`/`BINARY` paths.
- Local assets are site-wide/path-authorized, not owned by the importing user.
- Private pages currently prohibit uploading new site-wide assets.
- `server/models/assets.ts`, `server/operations/assets.ts`, and `server/controllers/upload.ts` form the managed-asset destination.
- `shared/content-extensions.ts` enforces safe same-origin media paths.
The repository has no user Dropbox connection, encrypted delegated-token store, file adapter, file API, workspace, editor source, import provenance, webhook, or Dropbox job handler.

## 4. Settled capability boundary
### 4.1 First increment
The first increment MUST include:
- One active file connection per tsEpistle user.
- Separate Full Dropbox app registration.
- `account_info.read`, `files.metadata.read`, and `files.content.read` only.
- Explicit Dropbox-to-managed-asset import in the editor as the first enabled file-facing surface.
- An entitled-only connection/recovery card on `/p/profile` before the editor source; it exposes no browsing, filename, download, or export capability.
- Deployment policy under Storage and `use:dropbox` registration and group assignment.
- Capability-gated editor Dropbox source, followed by the standalone `/p/files` archive and general download/export UI.
- Offline refresh for persistent interactive connections; unattended background Dropbox use remains prohibited.
### 4.2 Later capabilities
The first increment MUST NOT imply:
- Dropbox upload, folder creation, rename, move, copy, or delete.
- Shared-link reading/publication.
- Provider-backed private references or Dropbox-hosted durable media.
- Rich preview, thumbnail caching, or Range support.
- Webhooks, live sync, or offline reconciliation.
- Page/asset export, site backup, or restore.
- Dropbox Business administration, member selection, or impersonation.
- Multiple Dropbox accounts per tsEpistle user.
Each later capability requires a distinct permission, scope, threat review, rollout control, and gate. Export/backup SHOULD use a separate App Folder registration.

## 5. Authorization and state model
### 5.1 Ordered guards
For every file-data operation, execute exactly this order:
1. Authenticate an active internal user; reject guests and API keys.
2. Require `use:dropbox`; there is no `manage:system` bypass.
3. Require deployment policy to expose the requested capability.
4. Load the connection by both internal `userId` and internal connection identity; require `active`.
5. Require the authoritative scope returned by Dropbox.
6. Require operation-specific page/asset/wiki permission.
7. Only now may code read cached metadata, decrypt/refresh a token, or call Dropbox.
Lifecycle routes use narrower explicit guards. Status/bootstrap and connect require an active internal user, `use:dropbox`, and enabled deployment policy. Disconnect requires those checks plus owned-connection resolution, but it may close an inactive or revoked connection without read scope. No lifecycle route may access cache, token material, or Dropbox before its applicable guard passes; disconnect marks local authority unusable before any best-effort provider revoke. Client-supplied `userId`, account ID, strategy key, or foreign connection ID MUST be ignored or rejected.

### 5.2 Server-authoritative state matrix
| State | Response/surface | Provider behavior |
|---|---|---|
| Guest, API key, inactive user | Generic authentication denial; no Dropbox UI/copy | No cache/token/provider access |
| Active user without `use:dropbox` | Generic unavailable/forbidden; no nav/source/connect | No cache/token/provider access |
| Entitled, policy disabled | Data-free `unavailable`; generic direct-route state | No cache/token/provider access |
| Entitled, disconnected | `disconnected`, `canConnect=true`; connection-only `/p/profile` card with Connect/Back | File endpoints stop locally |
| Connection needs reauthorization | Connection-only `/p/profile` card with Reconnect/Disconnect; clear prior data | File endpoints stop locally |
| Connected, insufficient scope | Connection-only scope recovery action; no stale data | Unsupported call stops locally |
| Connected with read scopes | Safe connection status; explicit server capabilities expose the context-bound editor source/archive only in their phases | Only granted calls run |
| Authorization changes in flight | Shared invalidation plus local abort, generation increment, clear, and recovery | Late result and subsequent stream bytes are fenced |
The status/bootstrap route is the only integration request allowed while state is unknown. Denied responses contain no account name, ID, path, item count, token detail, or usable CSRF token. Only an active entitled user may receive a session-bound Dropbox CSRF token, and only when at least one mutation is allowed.

### 5.3 Permission mapping
- `use:dropbox`: connect, own-connection status, browse, search, and download.
- Existing `read:assets`: observe eligible destination/result under current path rules.
- Existing `write:assets`: create the managed import.
- Existing `manage:assets`: replace an existing asset.
- Existing page edit authorization: open editor import and insert the resulting asset.
The server issues `canImport` only for the current page/editor context after all page and asset checks. It is false for editor key `common`, private pages while assets are site-wide, unsupported CKEditor, and any context unable to complete import and insertion. Implementation MUST reuse exact existing page/asset permission vocabulary. The client consumes server capabilities; it does not infer them from JWT permissions or OAuth scopes.

## 6. Scope and endpoint matrix
The [Dropbox HTTP API reference](https://www.dropbox.com/developers/documentation/http/documentation) is authoritative.
| Capability | Dropbox endpoint/host | Scope | Wiki/product gate | Increment |
|---|---|---|---|---|
| Account/root | `/2/users/get_current_account`, API host | `account_info.read` | owned connection | First |
| Browse | `/2/files/list_folder`, API host | `files.metadata.read` | `use:dropbox` | First |
| Continue browse | `/2/files/list_folder/continue`, API host | `files.metadata.read` | bound cursor/generation | First |
| Search | `/2/files/search_v2`, API host | `files.metadata.read` | `use:dropbox` | First |
| Continue search | `/2/files/search/continue_v2`, API host | `files.metadata.read` | bound query/generation | First |
| Resolve entry/revision | `/2/files/get_metadata`, API host | `files.metadata.read` | owner-bound reference | First |
| Download | `/2/files/download`, content host | `files.content.read` | attachment-only response policy | First |
| Export cloud file | `/2/files/export`, content host | `files.content.read` | attachment-only allowlisted format | First |
| Revoke | `/2/auth/token/revoke`, API host | authenticated token | lifecycle guard + owned connection | First |
| Import | metadata + download/export | metadata/content read | context `canImport` + `write:assets`; `manage:assets` to replace | First |
| Preview/thumbnail | `/2/files/get_preview` or thumbnail routes | `files.content.read` | preview policy | Later |
| File mutations | corresponding `/2/files/*` write routes | `files.content.write` | separate write permission | Later |
| Read shared links | `/2/sharing/list_shared_links` | `sharing.read` | sharing policy | Later |
| Publish/change/revoke link | corresponding `/2/sharing/*` routes | `sharing.write` | disclosure permission | Later |
| Webhook drain | webhook + list continuation | metadata read + usable offline grant | sync policy | Later |
Do not request `files.metadata.write`, `files.content.write`, or sharing scopes in the baseline.

## 7. OAuth and connection lifecycle
### 7.1 Separate confidential-client flow
1. An active entitled user invokes `POST /_api/integrations/dropbox/connect` with explicit mutation protection.
2. Store high-entropy, expiring, single-use state bound to Express session, internal `userId`, intent, return path, requested scopes, and optional PKCE verifier.
3. Redirect to the separate Full Dropbox connector registration.
4. Send explicit desired `scope`; scope upgrade sends `include_granted_scopes=user`.
5. Persistent interactive connections require `token_access_type=offline` and a refresh token. The baseline MUST NOT use that grant for unattended background Dropbox activity.
6. Require the same active internal user, `use:dropbox`, and enabled deployment policy at callback.
7. Atomically consume state before code exchange.
8. Use exact registered redirect URI and server-side app-secret authentication.
9. Treat callback-returned scopes as authoritative.
10. Call `get_current_account`, verify account/root, encrypt approved tokens, then atomically create/replace the connection.
11. Failure leaves an older valid connection unchanged unless definitive revocation occurred.
12. Redirect only to a prevalidated local path.
The callback is a cross-site OAuth return: it relies on single-use bound state, not an `x-wiki-csrf` header. S256 PKCE is optional defense in depth for this confidential server client and mandatory for any future public client. It never substitutes for state, exact redirect, user binding, or client authentication.

### 7.2 Mutation protection
For same-origin connector mutations, implement and test server-side:
- Origin validation and Fetch Metadata policy where supported.
- A session-bound Dropbox CSRF token delivered by status/bootstrap only to an active entitled user and only for allowed mutations.
- Explicit token handoff to the client helper and same-origin credentials; the server consumes and validates the token/header with Origin and Fetch Metadata.
- Rotation on authentication, session, privilege, and connection transitions.
Do not assume `/_api` supplies a general guard. Connect, disconnect, import, and every later mutation require this enforcement. Denied bootstrap responses return no usable token. The cross-site OAuth callback uses its one-time bound state instead of CSRF.

### 7.3 Token policy
- Access tokens SHOULD remain memory-only unless encrypted caching is justified.
- Persistent interactive connections require an encrypted refresh token. A durable job may use it only for an explicit user-initiated operation under live CAS guards; periodic, sync, and other unattended use require separate approval and are absent from the baseline.
- Token envelopes contain key ID, algorithm/version, nonce, ciphertext, auth tag, and AAD binding connection/user/purpose.
- Encryption keys are independent of session secret, JWT key, Dropbox app secret, and database password. Decision D2 closes the key provider and cadence before schema or secret work.
- Only the Dropbox token service may decrypt. Missing key material or an unknown key ID fails the integration closed without deleting recoverable ciphertext.
- Key-ring rotation is staged: deploy readers for old and current keys, switch writes, rewrap, verify backup/restore, then retire the old key. Compromise fencing disables affected epochs and credentials before replacement.
- Refresh is single-flight per connection and persisted with compare-and-swap.
- `expired_access_token` permits one safe refresh/retry when a usable refresh grant exists.
- Invalid token, missing scope, suspension, account switch, or refresh failure closes capability and requires the appropriate recovery.
- User disable immediately fences use; user deletion cascades and destroys token material.

### 7.4 Disconnect/reconnect
Disconnect MUST first, in one authority-changing transaction, increment and fence `authorizationEpoch`, mark local capability unusable, cancel affected operations, and invalidate shared records for every running direct transfer before any best-effort `/2/auth/token/revoke`. Cross-instance invalidation MUST cause each owning instance to abort both the provider request and downstream response immediately and emit no further bytes; a process-local `AbortController` or request registry is not sufficient. Destroy encrypted tokens even on provider failure, clear cursor/location/client state, and retain only approved sanitized audit/provenance. Local deletion is not confirmed remote revocation when the provider call fails. Reconnect, credential replacement, and account switch are atomic, increment the epoch, and require explicit user confirmation; they cannot silently retarget old references. Imported local assets remain valid.

## 8. Data architecture
### 8.1 `dropboxConnections`
Add a user-owned aggregate:
- `id` internal UUID; `userId` FK to `users` with delete cascade.
- `dropboxAccountId` opaque provider account identifier.
- Connector-registration provenance; `accessType` (`full` or `app_folder`).
- Canonical sorted `grantedScopes`.
- `status`: `active`, `needs_reauthorization`, or `revoked`; non-reusable `authorizationEpoch`.
- `rootMode` and `rootNamespaceId` when applicable.
- Versioned encrypted refresh fields for persistent interactive connections; optional encrypted access token/expiry only if justified.
- `connectedAt`, `refreshedAt`, `revokedAt`, `updatedAt`, and optimistic version.
Constraints: one active connection per internal user; every query includes `userId`; no delegated secret in `users` or `authentication.config`; reconnect replaces atomically. Increment and fence `authorizationEpoch` on user, entitlement, or deployment-capability disable; disconnect; scope loss; credential replacement; or account switch. Duplicate active linkage of one Dropbox account across site users is rejected by default, subject to Decision D3.

### 8.2 Entry/location references and DTO
The client receives normalized data, never raw Dropbox objects. `DropboxEntryDto` contains only:
- Owner-bound opaque `entryRef`; folder `locationRef`.
- Display name and `file|folder` kind.
- Modified time and size when supplied for files.
- Safe server-derived capabilities.
- Revision only when needed for exact import.
- `isDownloadable` and allowlisted export formats when known.
Raw account/connection IDs are absent. Display paths authorize nothing. The server resolves references under the current owned connection/root. A user-A reference resolves as non-existent for user B before provider access. Entry references, cursors, operations, and jobs bind internal user, connection, `authorizationEpoch`, root mode/namespace, request intent, and generation as applicable. Browser local/session storage holds none of these values.

### 8.3 Import provenance
Commit provenance only with a successful managed asset:
- Provider `dropbox`; non-secret internal connection provenance.
- Opaque entry ID, selected revision, and content hash when available.
- Sanitized source name, importing user, destination asset ID/path, timestamp, correlation ID.
Provenance creates no runtime Dropbox dependency, follows approved retention, and exposes no account identity to page readers. Failure or accepted cancellation leaves no asset row, visible canonical path, blob reachable through that path, cache entry, storage event, or provenance; unreachable operation-owned staging is compensating cleanup, not a managed asset.

### 8.4 Durable import operations and jobs
Every import uses a durable operation and versioned job with `pending -> transferring -> validated -> committing -> succeeded|failed|cancelled`. Bytes remain in an inaccessible, operation-owned staging namespace until the serialized completion fence. Finalization begins a database transaction that locks and rechecks the current authority epoch, active-user entitlement and deployment policy, owned connection/status/scope, operation state, and job lease. That same boundary conditionally performs `committing -> succeeded` together with the asset row, canonical path/result, provenance, and outbox event; cancellation and completion serialize on the same operation lock. A check immediately before this boundary is only call admission, not the visibility fence.

For external storage, promotion uses only an operation-owned staged object whose storage key is neither public nor a canonical asset path. While the database locks are held, promote it to an operation-owned immutable object, then atomically create the database-backed canonical visibility and successful result. If any locked predicate or conditional transition loses, roll back every database row and compensate the staged/promoted object; restart reconciliation removes any unreachable object left by a crash or failed compensation. A losing worker never gains an asset row, visible canonical path, event, provenance, or reachable blob.

Payloads contain only schema version, `operationId`, internal `userId` and `connectionId`, `authorizationEpoch`, and sanitized immutable parameters—never token, URL, raw content, display path, or account ID. Before every provider call, the handler CAS-checks active user, entitlement, deployment policy, owned active connection/status/epoch/scope, operation state, and job lease. Disable, disconnect, scope loss, credential replacement, account switch, cancellation, or lease loss fences the operation; only the serialized completion transaction may make a result visible.

The durable-job handler/failure contract accepts one validated absolute `retryAt` or bounded `retryAfterMs` directive. The forms are mutually exclusive; invalid directives fail validation. Persist `nextRunAt` as the later of bounded local backoff and the provider-directed time, never earlier than valid Dropbox `Retry-After`, and never sleep while holding a lease. Every permanent import error terminates the operation as `failed`; an invalid/revoked credential, missing scope, suspension, or comparable connection failure independently transitions the connection to `needs_reauthorization` or `revoked` when applicable. Idempotency keys and unique operation results prevent retry or crash from creating duplicate assets. Browser insertion begins only after `succeeded` and is outside the storage transaction; insertion failure preserves exactly one complete asset and offers idempotent insertion retry without another Dropbox transfer.

## 9. Project architecture and exact file map
```text
Authenticated user
  -> entitled-only connection/recovery status on /p/profile before file-data UI
  -> editor media picker as the first file-facing surface; /p/files archive in Phase 4
  -> client/helpers/dropbox-files-api.ts
  -> client/store/dropbox-files.ts for later /p/files navigation and archive state
  -> /_api/integrations/dropbox/*
  -> lifecycle or file-data guards
  -> dropboxConnections + import operations + durable jobs
  -> token service + Dropbox adapter (API/content hosts)
  -> existing managed-asset boundary for explicit import
  -> stable local path via client/helpers/editor-insert-events.ts
```
The browser never imports a Dropbox SDK. The server MAY use the official JS SDK only after a Bun/TypeScript/error/abort/streaming spike; otherwise use a narrow typed HTTP adapter. Do not introduce a provider-neutral abstraction before a second provider exists.

### 9.1 Existing files to change
- `server/controllers/api/index.ts` — mount the integrations/Dropbox router.
- `client/components/profile/profile.vue` — add the entitled-only `/p/profile` connection/recovery card in Phase 1; status and Connect/Reconnect/Disconnect only, with no browse/download/export.
- `client/router.ts`, `client/components/profile.vue` — add the Phase 4 lazy `/files` profile route and capability-gated archive navigation; the `/p` base yields `/p/files`.
- `client/components/editor/editor-modal-media.vue` — expose only a context-authorized `canImport` source and complete through the existing local-asset insertion seam.
- `client/helpers/assets-api.ts`, `server/models/assets.ts`, `server/operations/assets.ts`, `server/controllers/upload.ts` — reuse path authorization and provide an atomic, stream-safe destination without silent conflict upsert.
- `server/controllers/api/storage.ts`, `server/operations/storage.ts`, `client/components/admin/admin-storage.vue` — deployment policy and Full Dropbox connector configuration only.
- `client/components/admin/admin-groups-edit-permissions.vue`, `client/components/admin/admin-groups-edit.vue`, `client/helpers/groups-api.ts`, `server/controllers/api/groups.ts`, `server/operations/groups.ts` — register, display, submit, validate, and persist `use:dropbox` through the existing group-permission path, separately from Storage configuration.
- `server/modules/authentication/dropbox/authentication.ts`, `server/modules/authentication/dropbox/dropbox-strategy.ts`, and `server/modules/authentication/dropbox/definition.yml` — preserve login-only behavior; update copy only to clarify the separate connector.
- `server/core/durable-jobs.ts`, `server/jobs/durable-job-handlers.ts` — add the validated provider-directed retry contract and the versioned import handler.
- `docs/security/threat-model.md` — add the Dropbox boundaries, controls, evidence, findings, and frozen `Covered source`.

### 9.2 New first-increment files
- `server/models/dropboxConnections.ts` — owned connection and authorization-epoch lifecycle.
- `server/models/dropboxTransfers.ts` — shared binding and cross-instance invalidation state for direct download/export streams.
- `server/models/dropboxImportOperations.ts` — durable state, staging/result identity, and cancellation.
- `server/operations/dropbox.ts` — lifecycle/file-data guard ordering and browse/download/import orchestration.
- `server/helpers/dropbox-api.ts` — token-aware typed provider transport.
- `server/controllers/api/dropbox.ts` — mounted integration routes.
- `server/db/migrations/<next>.ts` — schema, constraints, permission registration, and preflight.
- `client/helpers/dropbox-files-api.ts` — typed injected-fetch facade, schemas, explicit CSRF handoff, abort, and stable errors.
- `client/store/dropbox-files.ts` — sole owner of the Phase 4 `/p/files` navigation capability and archive file state.
- `client/components/profile/dropbox-files.vue` — connected archive.
- `client/components/editor/dropbox-file-picker.vue` — lazy picker/import confirmation with isolated local state using the same server capability contract.

### 9.3 Test seams
Use nearest naming convention, initially targeting:
- `server/test/controllers/dropbox.test.ts`
- `server/test/operations/dropbox.test.ts`
- `server/test/models/dropboxConnections.test.ts`
- `server/test/models/dropboxImportOperations.test.ts`
- `server/test/models/dropboxTransfers.test.ts`
- `server/test/core/durable-jobs.test.ts`
- `client/helpers/dropbox-files-api.test.ts`
- `client/components/profile/profile.dropbox-connection.interaction.test.ts`
- `client/components/profile/dropbox-files.interaction.test.ts`
- `client/components/editor/dropbox-file-picker.interaction.test.ts`
- `client/components/admin/admin-groups-edit-permissions.interaction.test.ts`
- Existing `client/router.test.ts`, `client/helpers/groups-api.test.js`, `client/components/admin/admin-groups-edit.update-rest-facade.test.js`, `server/test/controllers/api.groups.test.js`, `server/test/operations.groups.test.ts`, `server/test/operations.assets.test.js`, and `server/test/scripts/check-threat-model.test.ts`.

## 10. Browser API contract
### 10.1 Routes
| Method and route | Purpose | Success contract |
|---|---|---|
| `GET /_api/integrations/dropbox/status` | eligibility/connection/context capabilities | data-free denial; eligible mutations may receive a session CSRF token |
| `POST /_api/integrations/dropbox/connect` | start bound OAuth transaction | validated local redirect/authorization result |
| `GET /_api/integrations/dropbox/callback` | consume OAuth result | one-time code consumption; clean validated local redirect |
| `POST /_api/integrations/dropbox/disconnect` | close/revoke owned grant | idempotent local closure |
| `GET /_api/integrations/dropbox/entries` | list opaque location | normalized entries, cursor, `hasMore` |
| `GET /_api/integrations/dropbox/entries/continue` | continue listing | same location/root/epoch/generation |
| `GET /_api/integrations/dropbox/search` | indexed search | normalized matches, cursor, qualified copy |
| `GET /_api/integrations/dropbox/search/continue` | continue query | same query/root/epoch/generation |
| `GET /_api/integrations/dropbox/entries/:entryRef/download` | stream download/export | private, attachment-only byte response |
| `POST /_api/integrations/dropbox/imports` | start managed-asset import | owned operation DTO |
| `GET /_api/integrations/dropbox/imports/:operationId` | observe import | owned state and canonical local asset only after success |
| `POST /_api/integrations/dropbox/imports/:operationId/cancel` | cancel import | fenced owned operation |
The helper passes `credentials:'same-origin'`, `AbortSignal`, accept headers, and the explicitly supplied bootstrap CSRF token on mutations; it uses `sameOriginJsonFetch` and strict runtime schemas. Query values/references are encoded. Malformed success fails closed.

### 10.2 DTO/status model
`status` returns only `state`, `canConnect`, and explicit capabilities for denied/disconnected users; denial includes no usable CSRF token. For an active entitled user it MAY return a session-bound CSRF token limited to currently allowed mutations. A connected response MAY include a safe display label. The server derives `canImport` from submitted current page/editor context and binds it to that context and epoch; it is never a client inference. Entry/list/search DTOs contain only §8.2 fields plus an opaque cursor and `hasMore`. Import accepts an owner-bound `entryRef`, expected revision, existing asset destination selector, explicit `cancel|rename|replace`, chosen export format, and the bound page/editor context. It never accepts token, account ID, connection owner, temporary/shared URL, or authoritative raw path.

### 10.3 Stable errors
Use a small application-owned union:
- `AUTH_REQUIRED`, `DROPBOX_UNAVAILABLE`, `DROPBOX_NOT_CONNECTED`.
- `DROPBOX_REAUTHORIZATION_REQUIRED`, `DROPBOX_SCOPE_REQUIRED`.
- `DROPBOX_REFERENCE_NOT_FOUND`, `DROPBOX_CURSOR_RESET`.
- `DROPBOX_RATE_LIMITED`, `DROPBOX_PROVIDER_UNAVAILABLE`.
- `DROPBOX_EXPORT_FORMAT_REQUIRED`, `ASSET_PERMISSION_DENIED`, `ASSET_CONFLICT`.
- `CONTENT_TOO_LARGE`, `CONTENT_TYPE_REJECTED`, `IMPORT_FAILED`.
Errors include correlation ID and MAY include retryability/bounded retry delay. They exclude upstream bodies, `error_summary`, account IDs, paths, tokens, and URLs. Use `401` for missing user, data-free `403` for current-user denial, `404` for foreign/unknown references, `409` for declared connection recovery/conflict state, `413` for bounds, `429` with bounded guidance, and sanitized `502/503` for provider failure. Every permanent import error produces terminal operation state `failed`; where the cause invalidates connection authority, the connection independently becomes `needs_reauthorization` or `revoked`. The direct-route `403` versus `404` choice is Decision D9.

## 11. Dropbox protocol mechanics
### 11.1 Listing/search
- Continue every `has_more=true`; do not treat page one as complete.
- Bind cursors to user, connection, `authorizationEpoch`, root, location/query, and generation.
- On `reset`, discard old listing/cursor and restart without duplicate append.
- Abort/generation and epoch checks prevent stale responses restoring an old location or denied data.
- Search is indexed, possibly delayed/non-exhaustive, and may overlap pages; say so and deduplicate by stable entry identity.

### 11.2 IDs, revisions, and roots
- Use Dropbox IDs as provider identity where supported; they survive rename/move.
- Bind import to ID plus expected revision for exact bytes.
- Display paths are labels only.
- Include root mode/namespace in cursor/cache identity.
- A Full Dropbox token defaults to member home.
- Team-space access uses `Dropbox-API-Path-Root` from current-account root information.
- `invalid_root` updates root state and rebuilds locations/cursors.
- Never send `Dropbox-API-Select-User` or `Dropbox-API-Select-Admin`.

### 11.3 Content transport
- JSON RPC uses `api.dropboxapi.com`.
- Download/export uses `content.dropboxapi.com` and `Dropbox-API-Arg`; parse provider metadata headers separately from bytes and never forward provider headers verbatim.
- Before every provider call, CAS-check active user, entitlement, deployment policy, owned active connection/status/epoch/scope, operation state when present, and job lease when present; this does not replace the import visibility transaction.
- Bind every direct download/export transfer in shared state to user, connection, epoch, entitlement, and policy. Authority-changing transactions invalidate matching transfers and publish cross-instance invalidation; each owner aborts upstream and downstream immediately. Until notification is proven lossless, bounded periodic shared-state revalidation, including before response headers and each downstream flush, MUST prevent any byte from being emitted after loss. Local `AbortController` alone is insufficient.
- Stream with backpressure, timeout, abort, header-declared limit, and actual-byte limit.
- Every browser download/export on the wiki origin is attachment-only with `private, no-store`, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, a sanitized quoted filename, and an RFC 8187-encoded `filename*`. Never render Dropbox bytes inline.
- Reject active content. Reject unknown types under the configured allowlist or emit `application/octet-stream`; never trust a provider content type.
- Enforce lower tsEpistle size/type rules before and during transfer.
- Dropbox-native files use `/files/export` only after explicit allowlisted format choice.
- Never use `/files/get_temporary_link` for baseline delivery.

### 11.4 Errors/rate limits
Dropbox publishes no fixed general rate number. Parse valid `Retry-After` into one absolute `retryAt` or bounded `retryAfterMs`; reject conflicting or invalid forms. Persist durable `nextRunAt` as the later of bounded local backoff and the provider-directed time, never earlier than valid Dropbox `Retry-After`, and never sleep under a lease. Bounded jitter may extend retryable reads. Every permanent import error ends the operation as `failed`; invalid/revoked credentials, missing scope, suspension, and other connection-invalidating causes independently set `needs_reauthorization` or `revoked` as applicable. Refresh only `expired_access_token` when allowed. Switch on structured error tags, not exact `error_summary`. Record `X-Dropbox-Request-Id` with local correlation ID. A later ambiguous write must be reconciled before retry.

### 11.5 Release-time rechecks
These baseline facts MUST be checked immediately before release:
- Endpoint paths, returned scopes, structured error tags, SDK/HTTP names, and deprecations for the exact baseline calls in §6.
- Personal/team root behavior, path-root header modes, and `invalid_root`.
- Search caps/completeness, supported export formats, and baseline download/export/import content-transfer limits.
- The exact enabled read/import surfaces, access type, requested scopes, attachment headers, stream behavior, and lower exact-byte tsEpistle limits; no later-capability endpoint may be enabled.
Provider ceilings are ceilings, not product limits. Enforce the lower exact-byte tsEpistle configuration verified for the release.

## 12. Profile connection and connected archive UX
### 12.1 Surfaces and visual contract
- Deployment policy/configuration stays under the existing Storage surface; `use:dropbox` assignment stays in group permissions.
- Phase 1 adds an entitled-only connection/recovery card to `/p/profile`. It may show safe connection state and Connect/Reconnect/Disconnect only; it MUST NOT browse, name, download, or export files.
- The Phase 3 editor picker/import is the first file-facing surface. Personal browsing at `/p/files` and its general download/export UI follow in Phase 4.
- Connect and account recovery remain in the profile workspace, never inside the editor modal. Admins cannot browse personal Dropbox files from Storage.
- Use existing Luminous Archive `--wiki-*` spacing, surface, radius, shadow, motion, and focus tokens.
- Use one working surface, editorial filename hierarchy, a small official Dropbox mark, and restrained local accent.
- Do not add a generic blue gradient, dashboard metric cards, or global theme overrides.

### 12.2 Responsive contract
- `>=1145px`: semantic table; name, type, modified, size, action menu.
- `840–1144.98px`: table; remove low-value columns before size/modified.
- `600–839.98px`: semantic compact list/two-column cards; action trigger per item; sticky selection/import actions.
- `<600px`: one-column `<ul>/<li>`, two-line names, combined type/size, full-screen dialog, 44px targets.
Breadcrumbs alone may horizontally scroll. Crossing breakpoints preserves location, query, loaded pages, and valid selection. WCAG Reflow passes at a 320 CSS px viewport or equivalent zoom with no page-level horizontal overflow; 200% text zoom is an additional Resize Text check.

### 12.3 Accessibility/interaction
- Native table on desktop and list on mobile; no ARIA grid without its full keyboard contract.
- Filename is a real button/link; do not make the entire row a competing composite control.
- Space toggles a focused checkbox; Enter opens; Escape clears selection, closes menu/dialog, then exits.
- Keyboard access covers browse, search, select, download, import, conflict resolution, and exit.
- Controls have localized labels and visible focus; selection is not color-only.
- Close restores focus to activator; folder navigation focuses heading/breadcrumb target; refresh never steals focus.
- Regions use `aria-busy`; polite live regions announce summaries/transitions; terminal errors use alerts without duplicate toast announcements.
- Reduced motion removes transform movement/indefinite shimmer; forced colors retain borders, focus, and selection.
- Entitlement/connection transitions show no metadata flash.

### 12.4 Fail-closed client state
`client/store/dropbox-files.ts` solely owns the Phase 4 `/p/files` navigation capability and archive file state:
- `unknown`: status/bootstrap only; no Dropbox file action.
- `unauthorized`: clear and unmount.
- `disconnected`: no file request; the separate `/p/profile` card may show Connect only when `canConnect=true`.
- `needs_reauthorization`: clear; the separate `/p/profile` card may show Reconnect/Disconnect only.
- `connected`: request only explicit server capabilities.
The Phase 1 `/p/profile` card consumes only connection/status and mutation capabilities through the helper and retains no listing state. The editor picker keeps isolated local state but consumes the same server capability contract. Any `401/403`, disable, disconnect, account switch, credential replacement, or scope loss aborts local requests, increments generations, clears state, rotates CSRF authority, and renders recovery; server-side shared invalidation remains authoritative for cross-instance streams. Late requests cannot repopulate. Baseline write/sharing controls are absent, not disabled.

## 13. Explicit wiki asset import
### 13.1 User journey
1. Open the existing media modal; “Wiki assets” remains default.
2. Show “Dropbox” only when the server returns `canImport` for this exact page/editor context. Hide it for `common`, private pages, unsupported CKEditor, or any context that cannot complete import and insertion.
3. If disconnected, leave the source hidden; the earlier connection-only `/p/profile` card owns Connect/recovery.
4. Browse/search and select one file; no copy occurs.
5. Choose authorized local destination, export format if needed, and explicit conflict behavior.
6. Confirm **Import to wiki assets and insert**.
7. Observe the owned durable operation. After it succeeds, receive the canonical local asset.
8. Emit the existing `IMAGE`/`BINARY` insertion with the local path.
Browse, select, metadata, cancel, source switching, and close create no asset/provenance.

### 13.2 Durable server transaction
The import operation MUST:
1. Re-run the complete file-data guard and verify the context-bound `canImport`.
2. Resolve the epoch-bound `entryRef` and expected revision.
3. Check destination `read:assets`/`write:assets`, page edit policy, and `manage:assets` for replacement.
4. Reject private-page import while managed assets remain site-wide.
5. Transfer with backpressure/timeouts into operation-ID staging and enforce header-declared and actual-byte limits.
6. Validate sanitized filename, detected MIME, extension, active-content policy, export choice, and Dropbox content hash when available.
7. Require `cancel`, `rename`, or separately authorized `replace`; default never overwrites.
8. Use CAS checks for provider-call admission, then enter `committing`; do not treat a final pre-commit CAS as the visibility fence.
9. Begin the completion transaction and lock/recheck current authority epoch, active-user entitlement and deployment policy, owned connection/status/scope, operation state `committing`, and job lease. Serialize cancellation on the same operation lock.
10. While those locks remain held, promote only the operation-owned inaccessible staged object, then conditionally create the asset row, canonical path/result, provenance, and outbox together with `committing -> succeeded`.
11. On predicate loss or rollback, create none of those records or visibility; compensate any external staged/promoted object and reconcile unreachable leftovers after restart.
Current silent path-hash upsert MUST NOT define conflict behavior. Insertion follows successful storage commit and is not part of it; insertion failure retains exactly one complete asset and offers idempotent insertion retry without re-downloading.

### 13.3 Audience/durability
Imported files become site-managed assets under existing asset/page rules. A private Dropbox source does not make the result private. Because assets are currently site-wide, private-page imports remain denied; public/group pages may use only an explicitly imported managed asset. First release has no private provider reference. Dropbox rename/move/delete/revision/revocation/disconnect cannot break imported content. Local asset lifecycle remains independent; page history stores only the local path.
Later provider references require per-reader authorization and an unavailable-state model. Later shared-link publication is an explicit external hyperlink with sharing scope/policy/disclosure, never canonical embedded media. Later export/backup is a different direction, permission domain, App Folder registration, and job model.

## 14. Security, privacy, and operations
Required controls:
- Exact redirect; HTTPS outside localhost; single-use session/user/intent-bound state; immediate code consumption and callback/query redaction.
- Atomic callback/reconnect; confidential-client authentication; interactive-only offline grant.
- Independent versioned encryption with fail-closed key lookup, staged key-ring rotation, restore, and compromise fencing.
- Single-flight refresh/compare-and-swap; authorization-epoch fencing; shared transfer binding and cross-instance invalidation that aborts upstream/downstream with no subsequent bytes.
- Same-origin credentials plus explicit Origin/Fetch Metadata/session-CSRF on mutations.
- Applicable lifecycle/file-data authorization before cache/token/provider access; strict input/provider/response schemas.
- Provider-call CAS plus a locked database visibility fence that serializes epoch, entitlement/policy, operation state, cancellation, job lease, asset rows/path, provenance, outbox, result, and `committing -> succeeded`; operation-owned external staging has compensation/reconciliation.
- Attachment-only delivery with sanitized content type/disposition, `no-store`, `nosniff`, and sandbox CSP.
- Redaction before serialization; local correlation with Dropbox request ID.
Audit sanitized connect/scope-upgrade/refresh/disconnect/import/denial/cursor-root/rate-limit outcomes. Include internal actor/connection/epoch/capability/outcome/correlation/time. Omit content, credentials, provider bodies, temporary URLs, and filenames/paths unless separately approved with retention/access controls. Before release, update `docs/security/threat-model.md` at a frozen source revision and complete Gate G5.

## 15. Rollout, gates, and rollback
Every capability is default-off and independently disableable. Disabling fails closed and clears client state; it never exposes cached data. Dropbox Development mode user limits and Production approval are deployment dependencies, not post-release tasks.

### Phase 0 — decisions, schema, keys, permissions, and connector prerequisites
Close Decisions D1–D9 before implementation. Then deliver connection/import schema and preflight; independent key provision, staged rotation, compromise fencing, and restore runbook; `use:dropbox` registration through group permissions; separate Storage deployment configuration; separate Full Dropbox registration; exact-byte product limits; and synthetic personal/team accounts.
Gate `G0`:
- Identity login remains App Folder + `account_info.read` only and stores no token; the Full Dropbox connector is separate.
- Decision D2 names the key provider/cadence before schema or secret work; missing/unknown key IDs fail closed.
- Migration preflight/rollback and staged key-ring restore succeed on supported databases.
- Development users are authorized; Production approval has an owner.
Rollback: migrations/configuration remain unused; no file capability is exposed.

### Phase 1 — OAuth, token, and provider compatibility
Deliver the confidential-client flow; SDK-versus-HTTP Bun spike; token envelope; persistent-interactive refresh/revoke/account-switch lifecycle; provider adapter for account/list/stream; and the connection-only card in `client/components/profile/profile.vue`. The card exposes safe status and entitled Connect/recovery actions on `/p/profile`, but no file name, browse, download, export, or general file capability.
Gate `G1`:
- Adapter lists and streams personal/team fixtures under Bun with abort, backpressure, typed errors, and path-root handling.
- Wrong-user, expired, replayed, missing-session, and account-switch callbacks create no connection; codes are consumed once, redacted, and removed by clean redirect.
- Returned scopes drive capabilities; refresh is single-flight; unattended jobs cannot use the grant.
- Rotation/restore/compromise fencing works; database, jobs, logs, JWT, session, API, and page source contain no plaintext credential.
- `/p/profile` shows the connection-only card only to an entitled user in a declared connection state; DOM and network assertions prove it cannot browse, download, export, or reveal file metadata.
Rollback: disable connector policy; the card and connections remain inaccessible.

### Phase 2 — guarded APIs and durable import foundations
Deliver router mount; lifecycle and file-data guards; context capability/bootstrap CSRF; list/search/content transport; root/cursor/epoch handling; stable DTO/errors; durable import operations/jobs; provider-directed retry; and managed-asset commit. Expose no end-user Dropbox source yet.
Gate `G2`:
- Zero-call denial covers guest, API key, inactive, unentitled, policy-disabled, unlinked, revoked, insufficient scope, foreign reference, and stale epoch.
- Status/connect/disconnect guards, CSRF issue/rotation/validation, two-user isolation, and provider-call CAS fences pass every route.
- The locked completion transaction serializes authority epoch, entitlement/policy, operation state, cancellation, and lease with `committing -> succeeded` and asset visibility. Deterministic loss injected after the final pre-commit check—disconnect, policy loss, entitlement loss, cancellation, or lease loss—creates no managed asset, canonical path, reachable blob, event, provenance, or result.
- Direct transfer loss injected after the final pre-call check, including cross-instance disconnect/policy/entitlement loss, aborts provider and downstream and emits no subsequent response bytes.
- Durable transitions, restart reconciliation, operation-owned staging compensation/reap, idempotent commit, permanent-error `failed` closure, declared connection recovery, and validated retry scheduling pass without duplicate/partial state.
- Listing/root/cursor cases and attachment-only content limits, RFC 8187 disposition/type/CSP, abort, `Retry-After`, and redaction pass.
Rollback: disable server capabilities; routes return data-free denial and workers cancel/fence operations.

### Phase 3 — editor picker and managed-asset import
As the first enabled file-facing surface, deliver the lazy editor source, explicit import confirmation, durable operation progress, managed local result, and insertion/retry. The earlier `/p/profile` connection-only card remains incapable of file access.
Gate `G3`:
- The source exists only for server-issued `canImport` bound to the current supported public/group page/editor context; `common`, private, CKEditor, disconnected, and changed/denied contexts have no source or request.
- Selection/cancel creates nothing; success creates exactly one complete local asset/path.
- Exact revision, size, MIME/active content, audience, conflict, crash, storage, epoch, and context-change cases pass; disconnect, policy/entitlement loss, cancellation, and lease loss after the final pre-commit check lose the serialized visibility fence and expose no managed result.
- Insertion failure preserves that asset and idempotent retry inserts without another provider transfer; supported Markdown, AsciiDoc, HTML/code, and Tiptap paths work.
Rollback: hide the editor source and cancel/fence active operations; imported assets remain valid.

### Phase 4 — standalone connected archive and general download/export
Deliver the dedicated profile store, lazy `/p/files` route/navigation, connected archive, attachment download/export UI, fail-closed state transitions, and responsive/accessibility behavior.
Gate `G4`:
- No denied navigation, Connect, file request, command, or metadata flash; Connect/recovery remains on the connection-only `/p/profile` surface.
- Browser verification passes at repository breakpoints and 320 CSS px or equivalent Reflow zoom; 200% text zoom separately passes Resize Text.
- Keyboard, focus restoration, live regions, touch targets, short landscape, dark/light, reduced motion, and forced colors pass.
- Every download/export is attachment-only with sanitized quoted/RFC 8187 disposition, safe type, sandbox CSP, and no provider-header forwarding.
- Cross-instance disconnect or policy/entitlement loss injected after the final pre-call check invalidates the shared transfer, aborts provider and downstream, and emits no subsequent bytes.
Rollback: hide route/navigation and general download/export UI while retaining connection records, server denial, and imported assets.

### Phase 5 — frozen security review and baseline release
Freeze the candidate and update `docs/security/threat-model.md`.
Gate `G5`:
- The model covers Dropbox OAuth/CSRF, grant/token/key lifecycle, authorization epoch and zero-call denial, shared cross-instance transfer invalidation with no post-loss bytes, transport/team roots, attachment delivery, the serialized import visibility transaction and external-storage compensation, durable jobs/retry, and managed-asset audience.
- Deployment adapter canaries pass for the selected connector/key/storage topology.
- An independent reviewer records findings against the frozen revision; fixes receive focused regression proof and reviewer retest.
- `Covered source` names the final reviewed revision and the executable release gate accepts it.
Rollback: release remains blocked; disable all Dropbox capabilities without invalidating imported local assets.

### Separately approved later capabilities
Preview, Dropbox writes, private references, sharing, webhooks, and App Folder export/backup each require a new design, gate, flag, and threat-model update. Only if its capability is separately approved, recheck the applicable upload and upload-session request threshold (currently **150 MB, provider-stated unit**), upload-session ceiling (currently **2,199,019,061,248 bytes**) and lifetime (currently **seven days**), batch-write cardinalities and sync/async launch variants, temporary-link lifetime (currently **four hours**), webhook retry/disable timing, and Business/sharing rules. Webhooks, if approved, use only the canonical [Dropbox Webhooks Guide](https://www.dropbox.com/developers/reference/webhooks). Later failure disables only that capability.

## 16. Test matrix
### Identity, lifecycle, and authorization
- Identity login is unchanged; a non-Dropbox-login user connects without provider-link mutation or login grant reuse.
- Lifecycle-route guards follow §5.1; disconnect may close an owned inactive/revoked/no-read-scope connection.
- File-data guards make zero cache/token/provider calls for every denied state; user B cannot infer or use user A references.
- `manage:system` does not bypass entitlement/ownership; epoch changes cancel operations and invalidate shared transfers. Cross-instance disconnect or policy/entitlement loss after the final pre-call check emits no subsequent stream bytes.

### OAuth, CSRF, token, and keys
- State entropy, expiry, one-time session/user/intent binding; callback code appears only in the callback query, is consumed once, redacted everywhere, and removed by clean redirect.
- Status issues no usable CSRF token to denied users; allowed tokens are session/mutation-bound, explicitly handed to the helper, validated with Origin/Fetch Metadata, and rotated on authentication/session/privilege/connection transitions.
- Authoritative scopes; cancelled upgrade preserves the old grant; persistent interactive refresh is single-flight and unavailable to unattended work.
- Envelope/AAD, missing/unknown key failure, staged key-ring rotation/rewrap/retirement, backup/restore, compromise fencing, and invalid/revoked grant.

### Listing, content, and retry
- Empty/one-page/multipage, deletion-between-pages, overlapping search, reset, stale epoch/response, personal/team root, and `invalid_root`.
- Attachment download/export header/body split; sanitized quoted and RFC 8187 disposition; no forwarded provider headers; `private,no-store`, `nosniff`, sandbox CSP, and never inline.
- Active and unknown content handling; abort, timeout, malformed metadata, declared/actual oversize, and partial stream. Shared transfer binding and cross-instance invalidation/revalidation inject disconnect and policy/entitlement loss after the final pre-call check and assert no subsequent bytes.
- Provider retry directive absolute/relative validation, invalid input, bounds, precedence, `nextRunAt` no earlier than `Retry-After`, and no lease sleep. Every permanent import error ends as `failed`; applicable invalid credential/scope/suspension cases independently set `needs_reauthorization` or `revoked`; request IDs remain redacted.

### Durable import, audience, and insertion
- Selection never imports; exact revision/hash, destination/page permissions, context-bound `canImport`, and context/epoch change during work.
- `cancel`, `rename`, `manage:assets` replacement, and default no overwrite; private-page denial and public/group managed-copy requirement.
- Every state transition and terminal state; restart reconciliation/staging reap; crash, duplicate, timeout, and outbox/storage/blob failure atomicity.
- Inject disconnect, policy loss, entitlement loss, cancellation, and lease loss after the final pre-commit check. The locked transaction must reject `committing -> succeeded` and expose no asset row, canonical path, reachable blob, event, provenance, or result; external operation-owned promotion is compensated or reconciled.
- Idempotent finalize yields one asset/provenance/result; provider changes after success cannot alter bytes.
- Insertion follows commit; failure preserves one asset and idempotent retry does not download again.

### Leakage, client, accessibility, and release
- Search database rows, sessions, jobs, JWTs, cookies, logs, analytics, API bodies, callback logs/URLs, page HTML, and browser storage for credential/code/temporary-URL fixtures across success, provider errors, cancellation, retry, restart, and disconnect.
- Unknown makes only the status call; loss aborts/clears; late results cannot restore. The entitled-only `/p/profile` card exposes only declared connection/recovery actions and no file metadata or file operation. Disallowed editor sources/actions and modal Connect are absent from DOM and shortcuts, including `common`, private, CKEditor, and changed contexts.
- The Phase 4 archive route uses direct lazy import and the dedicated store; keyboard/focus/native-semantics/live-region behavior passes.
- Repository breakpoints, 320 CSS px Reflow, separate 200% Resize Text, touch, short landscape, forced colors, reduced motion, and light/dark pass.
- Frozen threat-model scope, adapter canaries, independent findings/fixes/retest, and final `Covered source` pass Gate G5.

## 17. Decision register
All identifiers are decisions, not rollout gates, and each MUST close before implementation.
| ID | Decision | Recommended default | Blocks |
|---|---|---|---|
| D1 | Persistent connection refresh | Require offline refresh only for persistent interactive connections; prohibit unattended use | Phase 1 OAuth |
| D2 | Encryption key provider/cadence | Independent versioned deployment key with staged key-ring rotation, restore drill, and compromise fence | Phase 0 schema |
| D3 | Same Dropbox account linked by two users | Reject duplicate active linkage within one site | Phase 0 migration |
| D4 | Import maximum/timeout | Conservative exact-byte limit below verified provider and existing asset/storage ceilings | Phase 2 transfer |
| D5 | MIME/export/SVG policy | Conservative downloadable image/binary allowlist; reject active content | Phase 2 validation |
| D6 | Conflict/replace permission | Default `cancel`; offer rename; require `manage:assets` for replace | Phases 2–3 API/UI |
| D7 | Import provenance retention | Minimal audit retention; never reader-visible account data | Phase 2 schema |
| D8 | CKEditor insertion | Unsupported and `canImport=false` until a listener is verified/implemented | Phase 3 gate |
| D9 | Unentitled direct-route status | Generic `404` to minimize feature disclosure | Phase 4 route |
Later write/sharing/reference/preview/webhook/backup decisions do not block this read-only baseline.

## 18. Official sources
Verified 2026-09-03; volatile contracts are release-time rechecks.
- [Dropbox OAuth Guide](https://developers.dropbox.com/oauth-guide) — access types, scopes, code/PKCE context, tokens.
- [OAuth authorize endpoint](https://www.dropbox.com/developers/documentation/http/documentation#oauth2-authorize) — scope, incremental grant, redirect, offline parameters.
- [Dropbox HTTP API reference](https://www.dropbox.com/developers/documentation/http/documentation) — endpoint scopes/shapes, hosts, limits, errors.
- [Dropbox File Access Guide](https://developers.dropbox.com/dbx-file-access-guide) — IDs, revisions, paths, cursors, download/export.
- [Dropbox Error Handling Guide](https://developers.dropbox.com/error-handling-guide) — tags, request IDs, retry.
- [Dropbox Performance Guide](https://developers.dropbox.com/dbx-performance-guide) — baseline rate-limit guidance; batches and upload sessions are rechecked only for a separately approved write capability.
- [Dropbox Team Files Guide](https://developers.dropbox.com/dbx-team-files-guide) and [Path Root Header Modes](https://www.dropbox.com/developers/reference/path-root-header-modes) — baseline team roots and `invalid_root`.
- [Dropbox Webhooks Guide](https://www.dropbox.com/developers/reference/webhooks) — canonical reference, rechecked only if webhooks are separately approved.
- [Dropbox Sharing Guide](https://developers.dropbox.com/dbx-sharing-guide) — external-link policy and facts rechecked only if sharing is separately approved.
- [Dropbox JavaScript SDK](https://github.com/dropbox/dropbox-sdk-js) — candidate server adapter only after spike.
- [Vue Router lazy loading](https://router.vuejs.org/guide/advanced/lazy-loading.html) and [Vue async components](https://vuejs.org/guide/components/async).
- [Vuetify data tables](https://vuetifyjs.com/en/components/data-tables/basics/) and [Vuetify accessibility](https://vuetifyjs.com/en/features/accessibility/).
- [WAI-ARIA Grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) — required only if a future grid is chosen.
- [WCAG 2.2 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html), and [Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html).
- [Content-Disposition in HTTP (RFC 6266)](https://www.rfc-editor.org/rfc/rfc6266) and [RFC 8187 encoding](https://www.rfc-editor.org/rfc/rfc8187) — attachment filenames; RFC 8187 replaces its obsolete predecessor.
