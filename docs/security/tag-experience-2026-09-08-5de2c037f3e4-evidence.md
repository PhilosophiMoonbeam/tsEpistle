# Tag experience scoped security evidence — 2026-09-08

## Status and boundary

- **Frozen source revision:** `5de2c037f3e40b486b9c239ba9b8189fafc35131` (short form `5de2c037f3e4`). **Base:** `6629be442d5e917e823a7377f05146aaa850de94`.
- This record covers only the tag-experience change boundary: public tag browsing, editor tag assignment, admin tag lifecycle UX and its existing service/API controls, and the associated focused browser, model, operation, controller, and helper evidence.
- This is repository-local supporting evidence for an internal review, not an attestation record or release approval. The review is explicitly **independent: false** and **releaseEligible: false**. No external reviewer, signature, production deployment, maintained-instance change, or live-database claim is made.
- Broader changes in the frozen `HEAD` outside this boundary remain unreviewed. The inherited boundary gap remains a blocker as **`SEC-COVERAGE-001`**; the inherited external-review blocker **`SEC-EXT-001`** also remains open and blocking.

- The seven inherited legacy entries are carried historical context and were not newly retested by this scoped review. Any canonical full-tree/security-boundary digest used by the governing attestation machinery is an integrity binding for the declared boundary, not evidence of repo-wide review.

## Scoped control evidence

### Public tag browsing

- The pages tag-list and tag-search controllers require the existing page-read/manage authorization boundary and return only the allowlisted tag fields.
- Tag-list and tag-search responses are marked `Cache-Control: private, no-store` and `Vary: Cookie`, preserving isolation between principals and preventing a shared cache from becoming a disclosure channel.
- Browse and suggestion queries correlate the complete page-tag/tag relation, then apply the requesting principal's page-read check. Multi-tag filtering is AND semantics; suggestions are ACL-filtered, ordered, and limited after correlation rather than inferred from an unscoped tag index.
- The public `/t` experience uses canonical/alias-aware tag navigation and preserves loading, retry, empty, selection, and responsive disclosure behavior without introducing per-tag usage-count or taxonomy-wide existence claims.

### Editor tag assignment
- The page-creation path performs the authenticated principal's server-side `write:pages` precheck with proposed tags, then rechecks `write:pages` against canonical associated tags inside the page transaction before projections/outbox. This canonical associated-tag write check prevents a client-side suggestion or stale draft from bypassing authorization.
- The tag association path (`associateTags`) validates normalized tag identities, enforces the 100-name maximum, resolves aliases, rejects archived names atomically, and performs the relation update in its existing transaction; it is not a substitute for caller authorization.
- The editor's unmatched candidate is draft state; it does not mutate taxonomy or call the admin taxonomy API.
- Editor draft rollback, retry, keyboard retry, and late-response/disposal fences were exercised as interaction safeguards; they are not treated as authorization controls.

### Admin lifecycle and review preservation

- Admin taxonomy service operations retain the existing `manage:system` authorization boundary, preview/fingerprint flow, access acknowledgement for access-changing plans, changed-page locking, and in-transaction recheck before lifecycle writes.
- Rename/merge/archive/restore and alias/lifecycle review state are preserved through the existing history, assignment, cache/event, and conflict paths. The admin component is workflow/presentation only; it does not create a new security boundary or replace service authorization.
- The admin UX result below is therefore an interaction/accessibility outcome, **not** a security or release attestation.

## Original finding provenance and scoped resolution

The five findings from the original internal tag security review are mapped below to the controls and separately observed runtime evidence. The final source assessment (`TagFinalSecurityReview`) was read-only and did not execute tests, builds, or linters; runtime evidence comes separately from the observed isolated suite, PostgreSQL, and browser results recorded below. Resolution is scoped to this final source re-review plus the separately observed runtime retest evidence only; this provenance map does not replace or duplicate the governing current-disposition register.

| Finding | Original title | Scoped remediation evidenced |
| --- | --- | --- |
| `TAG-ACL-001` — **High** | Joined-row pagination can remove deny tags before ACL evaluation | Paginate root page rows rather than joined tag rows; load complete tag relations before ACL and exact AND evaluation. |
| `TAG-ACL-002` — **High** | Direct REST page creation bypasses tag-based write rules | The create path rechecks `write:pages` against canonical associated tags inside the page transaction before projections/outbox; association validates identities, lifecycle, and transaction integrity. |
| `TAG-DISCLOSURE-003` — **Medium** | Personalized page and tag GET responses are cacheable across principals | Apply `Cache-Control: private, no-store` and `Vary: Cookie` to principal-dependent page/tag responses. |
| `TAG-INPUT-005` — **Medium** | Page saves can persist tag names forbidden by taxonomy validation | Normalize and validate bounded tag identities at the authoritative model/association boundary, rejecting invalid lists before insertion while preserving atomicity. |
| `TAG-SQL-006` — **Low** | Tag join makes documented page sort columns ambiguous | Qualify page sort columns in the joined-query sort mapping. |

## Internal review outcomes

These are internal maintainer outcomes for the scoped change only:

| Review dimension | Outcome | Boundary |
| --- | --- | --- |
| Security | **PASS** | Public browse ACL/correlation/cache isolation; server-side editor assignment controls; existing admin service authorization and review fence |
| Correctness | **PASS** | Normalization, aliases/lifecycle, AND filtering, transactional association, fingerprints, conflict/retry behavior |
| Interaction | **PASS** | Public/editor/admin keyboard, responsive, loading/retry, disclosure, rollback, and late-response behavior |

These outcomes are not independent review, do not close `SEC-EXT-001` or `SEC-COVERAGE-001`, and do not make this record release-eligible.

## Execution record

- Full isolated suite: **475/475 passed**.
- Public/editor matrix: **80/80 passed**.
- The collapsed responsive branch covered all eight configured projects: `responsive-chromium-desktop`, `responsive-firefox-desktop`, `responsive-webkit-desktop`, `responsive-chromium-wide`, `responsive-chromium-tablet`, `responsive-chromium-mobile`, `responsive-webkit-mobile`, and `responsive-webkit-mobile-landscape`. One transient initial-load failure occurred; the identical case with the same project/browser/viewport and parameters was rerun and passed. This is recorded as a retry, not as a reduced or substituted matrix.
- Admin lifecycle flow: **3/3 passed**.
- PostgreSQL browse operation evidence: **5/5 passed**. PostgreSQL tag-model evidence: **5/5 passed**.
- The focused evidence covers `dev/e2e/tags.e2e.ts`, `dev/e2e/editor-panels.e2e.ts`, `dev/e2e/responsive.e2e.ts`, `server/test/controllers/api.pages.test.js`, `server/test/controllers/api.taxonomy.test.ts`, `server/test/operations.pages.tags.postgres.test.ts`, `server/test/models/tags.test.ts`, `server/test/helpers/taxonomy-plan.test.ts`, and `server/test/operations/taxonomy.postgres.test.ts`.

## Gate record and unresolved blockers

Before this evidence record existed, `bun run ci:static` passed dependency policy, the license check with **800 license records**, Biome lint (with two pre-existing informational one-word Vue notices), shared/client/server typechecks, OpenAPI, placeholders, and agent-release checks. It failed only at the final `threat-model:check`, which reported a stale active digest and a dirty boundary before the source commit. Accordingly, this record **does not call `bun run ci:static` a full pass**. The ordinary post-record threat-model checker remains pending; no checker pass is claimed here.

The unresolved inherited review boundary and lack of independent external review remain blocking (`SEC-COVERAGE-001`, `SEC-EXT-001`). No source or historical security record was changed by this evidence entry, and no attestation manifest was created or updated.

## Withdrawn proposal and exclusions

- **`TAG-DISCLOSURE-004` is a withdrawn proposal only.** It is not a governing defect, current finding, or disposition for this scoped review.
- This evidence does not broaden the public disclosure contract, add taxonomy-wide existence/count claims, grant editor taxonomy mutation, or treat admin UX behavior as security authorization.
- Production deployment, live verification, backup/rollback, external review, attestation signature, and release approval are outside this record.

## Threat-model relationship

`docs/security/threat-model.md` was inspected and intentionally left unchanged. Its existing `PAGE-1`, `PAGE-3`, `PAGE-4`, and `ADMIN-1` control statements already cover the authorization, disclosure, cache/collaboration, and admin permission boundaries exercised here. This file adds scoped execution evidence without duplicating finding dispositions; the manifest remains the governing source for such dispositions.
