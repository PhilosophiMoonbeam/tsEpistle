# Authenticated Offline Reading Handoff

## Current state

The maintained Wiki at `https://wiki.timoneilassociates.com/` is primarily private. Most pages require an authenticated account. Guest-readable content is incidental rather than the main offline-reading use case.

Revision `3702ae8dcacf0e6bb31cc1182a13f69946312905` is committed, pushed, and deployed as `local/tsepistle:0.1.0-alpha.1-3702ae8d`. It fixes a misleading warning introduced when automatic offline saving became enabled by default:

> The server could not create a safe offline copy. Retry, or manage saved pages from your account menu.

An automatic-only eligibility denial now appears as a quiet, disabled **Not available for offline use** state. Explicit manual or followed-tag selections still show an actionable warning. This is a presentation correction, not authenticated offline-reading support.

## Root cause

`server/operations/pages.ts` builds offline page snapshots using the Guest account and its page rules, even when an authenticated user requests the snapshot. This is intentional under the current storage contract. The browser stores page snapshots and offline search projections as plaintext, origin-wide records. They are not bound to an account and can survive logout or an account change. The neutral offline shell can read them without an authenticated server session.

Allowing the endpoint to authorize with `req.user` would therefore copy private content into storage that a later browser user could read. Do not make that change in isolation, and do not grant Guest `read:pages` merely to enable offline reading.

The guest-only rule prevents disclosure, but it makes offline reading largely ineffective for this deployment. It is a safety boundary inherited from the current design, not the desired product policy.

## Desired outcome

Authenticated users should be able to save and search offline copies of every page they are currently authorized to read, subject to normal selection and quota policies. Private offline data must remain inaccessible to guests, logged-out users, and other accounts using the same browser profile. Truly guest-readable pages may continue to use the existing public snapshot path.

## Required security properties

An implementation must satisfy all of the following before the server admits authenticated page content:

- Bind every private snapshot and search record to the canonical site, account ID, authentication version, and offline session generation.
- Encrypt private page content and derived search data at rest. A key stored beside the ciphertext without an independent access boundary is not sufficient.
- Prevent account B, the guest shell, or a logged-out session from decrypting account A's records.
- Revoke or destroy private-content key access during logout, session invalidation, password/security-version changes, and account switches.
- Remove private snapshots, search projections, and obsolete keys when their identity boundary is invalidated. Failure must be closed and observable.
- Keep page authorization authoritative at snapshot creation and refresh time. Revoked page access must remove the corresponding local body and search projection.
- Preserve existing revision fencing, quota accounting, atomic body/search updates, automatic-selection limits, and cross-tab invalidation.
- Never expose private source, rendered HTML, search text, keys, or authorization details through logs, diagnostics, service-worker caches, or unauthenticated endpoints.

## Existing components to study

- `server/operations/pages.ts`: `loadOfflineGuest` and `getOfflineSnapshot` define the current guest-only admission boundary.
- `client/helpers/offline-storage.ts`: owns IndexedDB schema, policy records, snapshots, search projections, accounting, and `markPageIneligible`.
- `client/helpers/offline-sync.ts`: reconciles manual, automatic, and followed-tag selections and handles authoritative denials.
- `client/helpers/offline-session.ts` and `client/store/index.ts`: implement session-generation and logout/account-change boundaries.
- `client/helpers/offline-crypto.ts` and `server/helpers/offline-draft-keys.ts`: provide an existing account-bound encrypted-draft design. Reuse its reviewed primitives and identity concepts where appropriate, but do not assume draft key lifetime and offline-reading key lifetime are identical.
- `client/offline-app.vue` and the service worker: enforce the neutral offline-shell boundary and must not gain implicit access to another account's private corpus.
- `docs/pwa-offline.md`: currently documents guest-readable snapshots and should be updated only after the replacement contract is implemented and verified.

## Recommended implementation sequence

1. Define the private offline threat model and key lifecycle, including browser restart while offline, logout while offline, account switching, server-side authorization revocation, lost devices, and storage copied between profiles.
2. Specify a versioned account-scoped envelope for encrypted snapshots and search documents. Include authenticated metadata as AES-GCM additional authenticated data and retain bounded record sizes.
3. Extend IndexedDB storage and accounting so public and private corpora cannot collide. Provide an explicit migration or safe purge for legacy plaintext records.
4. Add an authenticated snapshot endpoint or an explicit authenticated mode to the existing endpoint. Reauthorize the current user and page within one server-side authority boundary. Keep the existing Guest path for public snapshots.
5. Update synchronization to select the public or private path, encrypt before committing, atomically replace the matching search projection, and delete content on authoritative denial.
6. Update logout, authentication invalidation, and account-switch handling to retire keys and purge or render unreadable every private record before the new identity becomes usable.
7. Update the offline reader and search worker so they open only the active account corpus and fail closed when identity or key state is unavailable.
8. Replace the temporary **Not available for offline use** state with normal saved/pending/error behavior for eligible authenticated pages. Retain a clear state for genuine policy or authorization denial.

Consult the repository planner before fixing the storage, key, server-authority, or logout contract. This work crosses persistent-state and trust boundaries and may require migration deployment safeguards under `AGENTS.md` and `docs/agents-deployment.md`.

## Acceptance criteria

- A signed-in user can manually save a private page, disconnect, reload the offline reader, and read it under the intended offline-authentication/key-lifetime policy.
- Automatic saving and followed tags can retain authorized private pages without page-wide warnings.
- Offline search returns only documents belonging to the active account and site.
- Logging out makes private snapshots and search data unavailable before guest UI becomes usable.
- Switching from account A to account B never exposes account A's offline content, titles, snippets, or search terms.
- Removing page access or receiving an authoritative denial deletes the private body and search projection.
- Guest-readable pages continue to work without weakening Guest permissions.
- Tampered ciphertext, metadata, identity claims, revisions, and session generations fail closed.
- Browser-backed tests cover manual, automatic, followed-tag, logout, account-switch, cross-tab, quota, migration, and offline-restart paths.
- Server tests prove that public requests use Guest authority and private requests use only the current authenticated authority.
- Applicable typechecks, focused security tests, a production build, and a deployed authenticated offline-reading smoke test pass without recreating PostgreSQL or unrelated services.

## Verification already completed for the temporary fix

- Offline presentation, browser storage/synchronization, and server snapshot-authorization tests passed.
- Client typechecking and the production build passed, including bundle budgets.
- The app-only deployment preserved PostgreSQL and unrelated containers.
- The live app is healthy, and its deployed client artifact contains the neutral automatic-ineligibility presentation.
- The unauthenticated snapshot request still returns `404 OFFLINE_PAGE_INELIGIBLE`, confirming that the temporary fix did not weaken the existing boundary.
