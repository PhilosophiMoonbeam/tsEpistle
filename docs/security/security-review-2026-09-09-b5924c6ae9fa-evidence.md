# Maintainer source-review evidence — 2026-09-09

## Review identity, freeze, and boundary

This document is the durable evidence for schema-2 source review
`security-review-2026-09-09-b5924c6ae9fa`.

- **Source freeze (`S`):** `b5924c6ae9fa165040d042e73c381e31b70d8ac7`.
- **Base revision:** `5ef73daca6bb1f12a69d08c6dec7447f86a85fdd`.
- **Covered security-boundary digest:** `29c31d32c7c34bab785ed7627c8435210c0187d6add5b32711e8fcd238371805`.
- **Threat-model SHA-256:** `2b10981ea03277494b04c140eb989e411e90a369559656faec50f03d701d566e`, computed from the current bytes of `docs/security/threat-model.md` after the PAGE-3 edit.
- **Review date:** 2026-09-09.
- **Attribution:** `HistorySourceSecurityReview` performed a read-only source security review and concluded **PASS** with confidence **0.98**. Main owns the candidate execution record below. The delegated reviewer did not execute the commands or browser/database operations reported by Main.

The reviewed source delta is the canonical history authorization lookup repair at `S`. The current PAGE-3 threat-model edit is bound independently by the exact threat-model digest above; this successor does not modify that file. The documentation-only record and manifest select the frozen source without changing the covered source boundary.

The selected predecessor record and evidence remain immutable. This successor carries every predecessor finding object, severity, disposition, and finding evidence path unchanged, adds no finding for the history repair, and adds this evidence artifact to the active record's top-level evidence paths.

## Security review verdict and scope — PASS

`HistorySourceSecurityReview` reviewed the exact source delta
`5ef73daca6bb1f12a69d08c6dec7447f86a85fdd..b5924c6ae9fa165040d042e73c381e31b70d8ac7` and the surrounding authorization, model, transport, and regression paths. The review found no new security finding and no source or deployment blocker in this narrow repair.

The reviewed implementation scope is:

- `server/operations/pages.ts`, including `getHistory`, `checkConflict`, `authorizeMutation`, and `restore`;
- the canonical page loader in `server/models/pages.ts`;
- history scoping and version access in `server/models/pageHistory.ts`;
- page authorization and protection in `server/helpers/page-access.ts` and `server/operations/page-protection.ts`;
- unchanged REST and GraphQL transports in `server/controllers/api/pages.ts` and `server/graph/resolvers/page.ts`;
- regression contracts in `server/test/operations.pages.history-visibility.test.js` and `server/test/controllers/api.pages.test.js`;
- the predecessor manifest/record and the PAGE-3 threat-model entry.

The repair does not change authentication, authorization policy, storage, cache, database schema, transport shapes, operation error mapping, response projections, threat-policy version, or unlock posture. It does not remove or reorder an unlock call.

## Root cause and repaired lookup invariant

Before `S`, `getHistory`, `checkConflict`, and `restore` used projections that omitted `id` and/or `tags`. The removed `completePageForAuthorization` helper observed missing tags and attempted `getPageFromDb(page.id)`. Because the projection also omitted `id`, it passed `undefined`. `Page.getPageFromDb` treats a non-number as a path lookup and dereferences `opts.path`, producing an authenticated history `500` before authorization and history delivery.

`authorizeMutation` previously used a full-row query that normally retained `id`; the repair gives it the same complete-current-page invariant as the other three call sites instead of relying on that incidental projection shape.

At `S`, each affected operation retrieves the validated numeric page ID directly through the canonical `wiki.models.pages.getPageFromDb(id/pageId)`. The canonical loader returns current `id`, `path`, `localeCode`, `visibility`, `ownerId`, `sourceRevision`, and `updatedAt`, and joins the current tags. The removed helper has no remaining references.

## Authorization and mutation fences retained at `S`

The repair changes the source of the complete current-page authority object; it does not weaken or reorder the surrounding fences:

- Validated positive IDs precede the canonical lookup.
- Private-page failures remain masked as `PageNotFound`.
- Public history evaluates `read:history` with the current path, locale, and tags and calls `assertUnlocked` before `pageHistory.getHistory`.
- `checkConflict` evaluates `canWritePage` against the current page before conflict work.
- `authorizeMutation` evaluates current-page authority, then unlock, then the proposed update/restore tags or move destination.
- `restore` evaluates current-page write authority, compares the mandatory expected source revision before historical lookup, scopes the selected history version to the requester, evaluates historical tags as the proposed authorization context, and forwards both `expectedUpdatedAt` and the current `sourceRevision` into `updatePage` as the race fence.

A hidden private history row therefore remains unavailable after publication, another owner's private current page remains indistinguishable from absence, and no history lookup or mutation occurs across those denials. No newly loaded content, owner, or contact metadata reaches a response: `getHistory` returns only the scoped history trail, `checkConflict` returns only a boolean, `authorizeMutation` returns no value, and `restore` returns no value. REST history/restore transport and GraphQL resolvers are unchanged.

## Regression evidence for the repair

`server/test/operations.pages.history-visibility.test.js` covers the repaired history boundary and related fences:

- a tagged public page returns the exact successful history trail and passes canonical path, locale, and current tags to `read:history`; its mock preserves the former projection's omission of `id` and `tags`, so the baseline implementation fails while `S` succeeds;
- absent/private masking prohibits history access;
- a now-public page cannot expose a hidden private revision;
- stale restore rejects before `getVersion` or `updatePage`;
- current-page and destination-rule reauthorization remain enforced.

`server/test/controllers/api.pages.test.js` preserves successful REST restore behavior, mandatory canonical revision input, forwarded source revision, and the response contract while using the canonical page shape. The exact source replacement and these denial/stale-restore contracts provide focused evidence for this narrow repair; no broader assertion is inferred.

## Main-reported candidate execution record

The following observations are attributable to Main and are candidate evidence for source `S`, not delegated-review execution:

- Candidate image digest: `sha256:7168f8eebaa9241fba32a078913a4afae729f4f00e6ad16142f47b16f907f72b`, with source `S` embedded. This is not a claim that an image for documentation successor `A` was published or deployed.
- An isolated restored/quarantined PostgreSQL clone was used for the candidate exercise.
- An authenticated uncached `GET /_api/pages/1/history?offsetPage=0&offsetSize=25` returned `200`, with total `5` versions: `[23,22,20,14,11]`.
- `GET /_api/pages/1/history/23` returned `200` for path `home` with nonempty content.
- Selecting revision `22` returned a `200` version endpoint and a rendered diff.
- Return Live navigated to `/en/home`.
- Reader View history navigated to `/h/en/home`.
- The screenshot visually showed the five-revision timeline and the initial diff without an error.
- The full unit run passed **490/490**.
- The focused two-file history/controller suite passed.
- `bun run docker:build` passed at `S`.
- The initial `ci:static` run was expectedly blocked only by stale predecessor-attestation/build metadata before this documentation-only successor existed; all preceding subgates passed. This is a pre-attestation observation, not a post-successor `ci:static` or strict release result.

## Inherited findings and dispositions — unchanged

The immediately selected predecessor is
`security-review-2026-09-09-bd5c06096186`. Its nine finding entries are carried into this successor with the same identifiers, severities, dispositions, and evidence paths. No finding is added for this history authorization lookup repair:

- `AUTH-APIKEY-HUMAN-IMPERSONATION` — High — resolved.
- `AUTH-CALLBACK-INITIATION-BINDING` — High — resolved.
- `AUTH-OAUTH-STATE-LIFECYCLE` — High — resolved.
- `STORAGE-ASSET-001` — High — resolved.
- `STORAGE-IMPORT-002` — High — resolved.
- `STORAGE-BACKUP-003` — High — resolved.
- `SEC-STORAGE-NATIVE-BOUND-001` — Medium — accepted.
- `SEC-ADAPTER-001` — Medium — accepted.
- `SEC-CACHE-001` — Medium — resolved.

The detailed remediation and residual evidence remain in the immutable predecessor documents `docs/security/security-review-2026-09-09-bd5c06096186-evidence.md`, `docs/security/security-review-2026-09-09-54949bf6d081-evidence.md`, and `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`. Historical blockers are not revived by this successor, and the accepted Medium residuals remain accepted exactly as recorded previously.

## Pre-attestation status and explicit non-claims

This is pre-attestation evidence for documentation successor `A`. The source review and candidate evidence are bound to `S`; the later attestation commit must remain outside the canonical covered source boundary. The expected stale-predecessor `ci:static` state above is not a final gate result for `A`.

This document does not claim a final `A` release gate, post-attestation strict release pass, post-attestation `ci:static` pass, final image build, registry push, maintained Compose or Helm replacement, maintained deployment, live health/login/authorization smoke, production migration, production backup, restore, or deployment result. Candidate image, browser, and PostgreSQL observations do not establish any of those later states. The current threat-model bytes remain bound by the exact digest recorded above.
