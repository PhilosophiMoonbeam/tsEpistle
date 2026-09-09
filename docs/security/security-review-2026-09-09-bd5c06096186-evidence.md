# Maintainer source-review evidence — 2026-09-09

## Review identity, freeze, and boundary

This document is the durable evidence for schema-2 source review
`security-review-2026-09-09-bd5c06096186`.

- **Source freeze (`S`):** `bd5c0609618605f9181220958e07a42ce63a991a`.
- **Base revision:** `70a2d2f8b14e0d31bb43008d79809b120f27fbbf`.
- **Covered security-boundary digest:** `7d86c2830ae0957403723b99624c89c8c6cff87e569740e244e75bba9e21ce26`.
- **Threat-model SHA-256:** `2cc7db424ec5826924f31d5f0fb0917ef21f5e5823a03547ca028c9d9bb1c364`, computed from the final bytes of `docs/security/threat-model.md`.
- **Review date:** 2026-09-09.
- **Attribution:** Main owns the execution record. `UpdatedDateSecurityReview` performed a read-only source security review and concluded **PASS** with no surviving product-security finding or code deploy blocker. `FinalUpdatedDateReview` performed a read-only source/UI review and concluded **PASS**. The delegated reviews did not execute validation commands; the command and browser results below are Main-reported observations.

The reviewed source change is the reader updated-date rendering correction at `S`, together with its exact candidate browser contract in `dev/e2e/responsive.e2e.ts`. The client template now disables i18next's interpolation pre-escaping for the localized date string so a slash remains a slash in visible date text. The change does not alter authentication, authorization, storage, cache, server, or threat-model controls. The documentation-only record and manifest select this frozen source without changing the covered source boundary.

The selected predecessor record and evidence remain immutable. This successor carries its findings and dispositions unchanged, adds no finding for the reader rendering diff, and retains the predecessor evidence paths for those findings.

## Reviewer-observed source review — PASS

`UpdatedDateSecurityReview` inspected the source range
`70a2d2f8b14e0d31bb43008d79809b120f27fbbf..bd5c0609618605f9181220958e07a42ce63a991a` and the changed reader/browser contract by source inspection and sink analysis. The review found no new security finding.

`FinalUpdatedDateReview` confirmed by source inspection that the per-call `escapeValue: false` option added by this diff is used only at the updated-date Vue moustache text sink; the separately rendered author remains a Vue moustache text node. The browser contract patches the real initial and SPA reader payloads, checks both dispatch paths, and asserts that literal author markup does not become child elements. The review found no source blocker or actionable informational residual.

### Why `escapeValue: false` remains safe

- `formattedUpdatedAt` is a localized date string produced from the page timestamp. The changed `$t('common:page.updatedAt', ...)` call is the child of a `<time>` element through Vue/Pug moustache interpolation. `escapeValue: false` stops i18next from pre-encoding the date (including the slash entity encoding that caused the display regression); it does not turn the Vue moustache into an HTML sink. Vue writes the result as a text node, so markup-like characters in a translation or value remain literal text.
- The `:datetime="updatedAt"` and `:title="accessibleUpdatedAt"` bindings are separate Vue attribute bindings. They receive timestamp-derived strings and are assigned as attribute values by Vue; neither binding parses a string as HTML, and neither consumes the i18next interpolation result as markup.
- `authorName` is rendered independently in the `bdi.page-provenance-author` Vue moustache text node. The fixture uses `<strong data-e2e-author-markup="true">Ada</strong> & "quoted"` so the contract can distinguish literal text from DOM creation; the source assertion requires zero descendant elements.
- This diff does not add or route data through `v-html`, `innerHTML`, raw HTML, or template compilation. Existing content-renderer controls remain covered by `CONTENT-1` in the unchanged threat model. A future move of this value to a raw HTML sink would require explicit encoding/sanitization and a new security review.

The existing `escapeValue: false` calls in the footer likewise terminate in Vue text interpolation. They do not establish a general permission to use unescaped values at raw HTML sinks.

## Main-reported execution record

The following observations are attributable to Main, not to either delegated reviewer:

- Lint was clean apart from the preexisting Vue single-word informational message.
- Client typecheck passed.
- The full unit run passed **490/490**.
- Exact candidate browser verification passed on desktop and mobile, **2/2 for initial and SPA loads**. The candidate exercised the deterministic updated-date text, `datetime` and `title` attributes, literal author rendering, and both initial and `X-Wiki-Navigation: 1` reader paths.

These reports are not a post-deployment or production-operation claim, and no reviewer execution is implied by their inclusion here.

## Inherited findings and dispositions — unchanged

The immediately selected predecessor is
`security-review-2026-09-09-54949bf6d081`. Its nine finding entries are carried into this successor with the same identifiers, severities, dispositions, and evidence paths. No finding is added for this diff:

- `AUTH-APIKEY-HUMAN-IMPERSONATION` — High — resolved.
- `AUTH-CALLBACK-INITIATION-BINDING` — High — resolved.
- `AUTH-OAUTH-STATE-LIFECYCLE` — High — resolved.
- `STORAGE-ASSET-001` — High — resolved.
- `STORAGE-IMPORT-002` — High — resolved.
- `STORAGE-BACKUP-003` — High — resolved.
- `SEC-STORAGE-NATIVE-BOUND-001` — Medium — accepted.
- `SEC-ADAPTER-001` — Medium — accepted.
- `SEC-CACHE-001` — Medium — resolved.

The detailed remediation and residual evidence remains in the immutable predecessor documents `docs/security/security-review-2026-09-09-54949bf6d081-evidence.md` and `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`. Historical blockers are not revived by this successor, and the accepted Medium residuals remain accepted exactly as recorded previously.

## Explicit limitations and residual boundary

- Locale translations may change the wording or date convention shown to a reader, but at the Vue text sink they cannot create DOM elements. Browser wording assertions must therefore remain locale-aware when translations change.
- A future use of this value in `v-html`, `innerHTML`, raw HTML insertion, or template compilation is outside this review and requires an encoding/security review before adoption.
- Main-reported lint, typecheck, unit, and browser observations are not delegated-review execution, a strict release-command result, a build, a deployment, a live external-provider exercise, or production evidence.
- `docs/security/threat-model.md` bytes are unchanged and remain bound by the exact digest recorded above.
