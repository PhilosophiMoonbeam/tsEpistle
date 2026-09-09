# Maintainer source-review evidence — 2026-09-09

## Review identity, freeze, and boundary

This document is the durable evidence for schema-2 source review
`security-review-2026-09-09-54949bf6d081`.

- **Source freeze (`S`):** `54949bf6d081bcd58244db2b07eb7a9fc70455b7`.
- **Base revision:** `ed71dec57050f1bc60edc8bfdb73e47d6bc41181`.
- **Covered security-boundary digest:** `8bfdd6a60b5f6511a2718fafe2155d36fee364f88d78c20631ed908c60b5d7db`.
- **Threat-model SHA-256:** `2cc7db424ec5826924f31d5f0fb0917ef21f5e5823a03547ca028c9d9bb1c364`, computed from the final bytes of `docs/security/threat-model.md`.
- **Review date:** 2026-09-09.
- **Attribution:** Main owns the execution record. `FinalRegressionReview` corrected its verdict to **PASS** after runtime-cascade evidence. `FinalRegressionSecurityReview` concluded **PASS** (source review; no surviving product-security blocker). The security review is source-inspection evidence and does not reclassify delegated source inspection as command execution or live HTTP proof.

The reviewed source is the final source tree at `S`, including the reader/navigation successor and the requester-specific REST page-tree cache-isolation fix. The canonical covered-tree digest binds the source boundary, while the threat-model digest independently binds the normative control register. The documentation-only successor record and manifest select this review without changing the source boundary.

The previous source-review record and evidence remain immutable. Its resolved remediations and accepted residuals are carried forward by disposition, with the new cache-isolation finding recorded below. No external approval, detached signature, production credential, maintained-instance deployment, image publication, or post-successor strict release result is claimed here.

## Review-artifact conclusions and attribution

### FinalRegressionReview — PASS

The final runtime-cascade review corrected its verdict to PASS after the runtime evidence was reconciled. Main retains ownership of all execution results below; this attribution does not claim that the reviewer ran those commands.

### FinalRegressionSecurityReview — PASS

The source review found no surviving product-security blocker in the final source. The medium REST tree cache-isolation finding (`SEC-CACHE-001`, CWE-524) was resolved in the reviewed source by setting `Cache-Control: private, no-store` and `Vary: Cookie` on requester-specific `/_api/pages/tree` responses. The reviewer did not attest post-fix tests or live HTTP; Main's independent execution observations are recorded separately.

## Main execution record

The following results are attributable to Main, not to the delegated reviewers:

- Lint was clean.
- Shared, client, and server typechecks passed.
- The full unit run passed **490/490 unit files**.
- The native PostgreSQL run met the **8/8/30 expectations** for static authority compatibility. This is static authority compatibility evidence, **not concurrency evidence**.
- The targeted responsive run passed **16/16**. This was targeted responsive verification, **not the full E2E suite**.
- For requester-specific `GET /_api/pages/tree`, guest `200`, invalid-input `400`, and authenticated `200` paths all returned `Cache-Control: private, no-store` and `Vary: Cookie`. The guest tree had `canEdit: false`; the authenticated tree had `canEdit: true`.
- Missing or wrong `Origin` requests returned `403`.
- The exact login response reported `authenticated: true` and did not include a JWT in JSON.
- Local HTTP cookie verification observed a JWT cookie with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure=false`; `document.cookie` remained empty.
- A fresh browser context was anonymous.
- Shared `page.request` appearance verification passed.
- Private-page create and delete passed.
- Extension, page-protection, and taxonomy paths were exercised.

The source-level cache control is also covered by `server/controllers/api/pages.ts` and the focused controller contract in `server/test/controllers/api.pages.test.js`. The static PostgreSQL authority contract is covered by `server/test/operations/pages-tree.postgres.test.ts`, and targeted responsive evidence is covered by `dev/e2e/responsive.e2e.ts`.

## SEC-CACHE-001 — Medium — resolved (CWE-524)

**Affected boundary and prior observable failure:** The REST `/_api/pages/tree` route returns requester-specific page and folder visibility, including edit capability. Without an explicit cache policy, a shared intermediary could reuse one principal's tree response for another principal, disclosing private structure or capability metadata. This is the cache-of-sensitive-information class described by CWE-524.

**Fix at `S`:** `server/controllers/api/pages.ts` sets `Cache-Control: private, no-store` and varies the response on `Cookie` before validation, authorization, or tree execution. The policy therefore covers successful responses and invalid or failed tree requests, while the existing requester-scoped operation continues to determine returned rows and `canEdit` values. The corresponding focused controller contract asserts both headers on normal, invalid-input, and operation-failure paths.

**Regression command and result:** Main observed guest `200`, invalid `400`, and authenticated `200` tree responses with `private, no-store` and `Vary: Cookie`; guest `canEdit` was false and authenticated `canEdit` was true. Main also observed missing/wrong-Origin `403`, and the focused controller contract passed within the final **490/490** unit-file run. `FinalRegressionSecurityReview` re-read the final route and reported PASS by source inspection; it did not execute post-fix tests or live HTTP.

## Inherited current remediations and residuals

The following dispositions are unchanged from the immediately prior source review and remain supported by its immutable evidence at `docs/security/security-review-2026-09-09-6e206707287f-evidence.md`:

- `AUTH-APIKEY-HUMAN-IMPERSONATION` — High — resolved.
- `AUTH-CALLBACK-INITIATION-BINDING` — High — resolved.
- `AUTH-OAUTH-STATE-LIFECYCLE` — High — resolved.
- `STORAGE-ASSET-001` — High — resolved.
- `STORAGE-IMPORT-002` — High — resolved.
- `STORAGE-BACKUP-003` — High — resolved.
- `SEC-STORAGE-NATIVE-BOUND-001` — Medium — accepted.
- `SEC-ADAPTER-001` — Medium — accepted.

The successor review does not revive historical `SEC-EXT-001`, `SEC-COVERAGE-001`, or any other historical blocker, and it does not turn static authority compatibility into a concurrency guarantee.

## Explicit limitations and deferred observations

- The account logout **POST** and UI relogin reached Home, but the obsolete prior-title assertion failed afterward. That assertion failure is recorded as an observed compatibility issue, not silently converted into a PASS.
- TFA enrollment and challenge were unexercised because legacy policy setup returned `400`.
- Unrelated redesigned setup assertions remain deferred.
- The targeted responsive result is not a full E2E result. The native PostgreSQL result is not a concurrency result. The source-review PASS is not a post-successor strict checker, build, deployment, or production-operation result.
