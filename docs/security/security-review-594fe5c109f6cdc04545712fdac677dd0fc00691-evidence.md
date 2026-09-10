# Corrected frontend successor source-review evidence — 2026-09-10

## Review identity and immutable binding

This document is the evidence for schema-2 source-review record
`security-review-594fe5c109f6cdc04545712fdac677dd0fc00691`.

- **Verified source revision S:** `594fe5c109f6cdc04545712fdac677dd0fc00691`.
  Git resolves this exact 40-character commit; its parent is
  `f34e61afca930a0718b773d721e87d04769511eb`.
- **Reviewed base B:** `dd783e3aad6d8ecc6800797ad76dcc63d2ed1156`.
- **Canonical covered-tree digest:**
  `7610b06cd39f413c30c4e56f1b527a930ac7f5400d236be03b100e45b75ed1aa`.
- **Threat-model SHA-256:**
  `2b2baa8c523bbbb2b3ffa89e2cad954ba63e3af372529dc76e931291bbd3b748`.
  The frontend correction does not change the security architecture, schema,
  route, renderer, secret, migration, or deployment-topology contracts in
  `docs/security/threat-model.md`.
- **Review date:** 2026-09-10.

The retained history is `B -> c9d3f17d0fbedfb73f21861fef2c965fddd05aa3 ->
076aff498ec3739c8f9e4e225613c4ccf8ac8175 ->
3c934b7b20a376f3a3ea51d547c23b7abd0cd70a ->
f34e61afca930a0718b773d721e87d04769511eb -> S`. The c9d3f17d commit is the
prior documentation attestation and prior deployed revision; the three
`polish_pass_*` commits remain in history. S is the corrective frontend commit
whose parent is the full f34e61af revision, not a rewritten or selectively
replayed polish history.

The new record, this evidence, and the manifest entry are the exact three
files intended for the documentation-only successor A. A is expected to be a
child of S with no source-boundary change. This evidence deliberately does not
invent A's future commit SHA and does not claim that A has already passed any
later gate.

## Scope: net source delta versus corrective delta

The net B..S result is the source that is actually bound by the covered-tree
digest. It contains only the client-side paths whose final bytes differ from B,
plus the predecessor c9d3f17d attestation documentation. The net source change
has no server, shared, dependency, build, migration, or deployment-topology
change. The c9d3f17d documentation is historical evidence, not a runtime or
security-boundary source change.

The corrective f34e61af..S commit is intentionally broader than that net
result: it is the 30-path frontend correction recorded by the planner. It
removes decorative duplicate admin/system/agent/reader components and their
source-text fidelity contracts, removes the fabricated security-posture UI,
and corrects the retained admin, agent, common, editor, theme, and reader
paths. Several atlas, navigation-header, and reader corrections occur in this
corrective commit but restore the prior deployed source, so they appear in the
corrective delta while not appearing as a net B..S boundary change. The final
review is of the complete S tree, not of an isolated patch hunk.

Retained behavior in the net source includes the existing AnimatedNumber
rendering/lifecycle proof; actual forwarding of dashboard request cancellation;
`shallowRef` handling in System; required Agent controls and timer cleanup;
success-only, race-fenced clipboard feedback; corrected raw-string tag slots;
and bounded theme-based presentation. The source correction removes misleading
security posture claims and decorative components without removing backend
authorization, storage enforcement, or consumer-observable security coverage.

## Delegated read-only security review

`DeploySecurityReview` performed the substantive read-only source review of the
B-through-S tracked source and the inherited evidence. The reviewer made no
edits and ran no commands, tests, builds, formatters, validators, Docker
operations, deployment actions, or network operations. The reviewer returned
**PASS**: no new deploy-blocking finding and no other surviving security
finding was identified in the requested frontend delta.

The reviewer’s source conclusions are:

1. Administration data remains protected by server-side authorization rather
   than client visibility. Analytics and security require `manage:system` in
   `server/controllers/api/analytics.ts` and `server/controllers/api/site.ts`;
   system observations are checked in `server/controllers/api/system.ts` and
   transactionally in `server/operations/system-workspace.ts`; dashboard
   recent-pages and login-activity routes have endpoint checks; and page
   discovery is filtered through current page authority in
   `server/operations/pages.ts`.
2. The corrected admin screens do not invent security/posture scores. The
   security screen distinguishes saved policy, observed runtime configuration,
   response headers, and proxy behavior. The system screen limits claims to a
   single process and a single observation and explicitly does not verify
   ingress, certificates, provider delivery, schema integrity, or backups. The
   analytics screen labels counts as best-effort responses and its policy
   preview as a simulation rather than a live test.
3. Dynamic content in the reviewed paths uses Vue text interpolation; no
   surviving scoped `v-html` or `innerHTML` sink was identified. External links
   are fixed provider metadata, source identity, or guarded existing external
   construction. New-tab links use `noopener`/`noreferrer` where applicable.
   `client/components/common/social-sharing.vue` percent-encodes user/page
   values, severs the opener before navigation, reports popup failure,
   invalidates stale clipboard operations, restores focus after its legacy
   fallback, and clears feedback timers on URL change or unmount.
4. Request and timer cleanup is bounded in the reviewed paths. Dashboard and
   page-atlas requests use `AbortController` and request identities; analytics,
   security, and editor reads invalidate stale completions on replacement or
   unmount; Agent elapsed-time polling uses watcher cleanup; AnimatedNumber
   cancels frames and removes its media-query listener; and navigation and page
   components remove global listeners/observers and cancel pending work.
5. Theme and accessibility behavior does not mask security-sensitive controls.
   Destructive goal cancellation retains confirmation, focus-visible and
   forced-colors rules remain, reduced motion disables nonessential motion,
   semantic status/progress text remains available, and responsive layouts
   preserve alternate action surfaces.
6. The deleted decorative components and source-text contract suites have no
   surviving client references. Their removal does not remove backend
   enforcement or a consumer-observable security regression test; the retained
   `client/components/common/animated-number.test.ts` exercises rendering,
   stale-frame cancellation, unmount cleanup, formatting, and reduced motion.

The reviewer’s exact inherited evidence includes
`docs/security/security-review-2026-09-09-6e206707287f-evidence.md`,
`docs/security/security-review-2026-09-09-54949bf6d081-evidence.md`, the
predecessor Docker successor evidence, and `docs/security/threat-model.md`.
The record also retains the relevant source and regression paths in each
finding object.

## Findings and carried risks

All nine predecessor finding objects are copied unchanged into the successor
record: `AUTH-APIKEY-HUMAN-IMPERSONATION`,
`AUTH-CALLBACK-INITIATION-BINDING`, `AUTH-OAUTH-STATE-LIFECYCLE`,
`STORAGE-ASSET-001`, `STORAGE-IMPORT-002`, `STORAGE-BACKUP-003`,
`SEC-STORAGE-NATIVE-BOUND-001`, `SEC-ADAPTER-001`, and `SEC-CACHE-001`.
No new finding is added.

The six High findings and `SEC-CACHE-001` remain resolved on the inherited
source evidence. The two accepted Medium residuals remain accepted with their
existing justifications:

- **SEC-STORAGE-NATIVE-BOUND-001:** native Git pack observation samples at
  100 ms and can overshoot; it is not a hard pack-size, disk, or memory quota,
  and Git setup/configuration/remotes remain outside the bounded synchronization
  runner. Exclusive application ownership and operator OS/filesystem controls
  remain required. A physical bound requires an OS quota or bounded volume and
  writer exclusion.
- **SEC-ADAPTER-001:** separately configured external adapters and providers
  remain operator-trusted integrations requiring deployment-specific canaries.
  Utility egress can include ACL-restricted shared published content only when
  configured as an operator-approved shared-content processor; retrieval still
  enforces requester authorization and publication/revision/hash checks. This
  acceptance is not a claim that every external integration was live exercised.

This frontend-only change does not alter either accepted residual or silently
convert it into a release, deployment, or runtime guarantee.

## Main-attributed completed observations

The following are execution observations supplied by Main, not commands run by
`DeploySecurityReview` and not prospective A results. Main reports the
corrected-source local-gate record as **489/489 tests passed**, with focused
client tests passed, client/shared/server typechecks passed, production build
and bundle-budget checks passed, LSP proof passed, and local browser proof
passed. Main also reports that the pre-A CI prerequisites for dependency policy,
license inventory, production audit, lint, OpenAPI, placeholders, and
agent-release checks passed; the CI run stopped only at the expected stale
active-record/source-digest/dirty-state threat-model check.

Those observations establish completed validation of the supplied corrected
source context only. They do not establish a strict gate for the documentation
successor, and they do not turn local browser proof into production runtime
proof. The prior running c9d3f17d image likewise is not runtime evidence for S.

## Explicit exclusions and non-claims

This source-review record’s `releaseEligible: true` is the maintainer
attestation for S’s reviewed source and zero-blocker finding state. It is not a
claim that the documentation successor has passed a strict gate or has been
released. The following are expressly outside this evidence and remain
unclaimed:

- the ordinary or strict A threat-model/release gate, including
  `test:security` after A is committed;
- an A image build, image identity/metadata inspection, or runtime execution;
- Compose replacement, production deployment, health checks, authenticated
  live-surface verification, backups, restores, or rollback;
- registry publication or push, and public availability of a future unpushed A
  source URL;
- native ARM64 runtime proof, external-provider canaries, or maintained-instance
  behavior.

No future strict result, image result, deployment result, or public-source
result is inferred from `releaseEligible`, the covered-tree digest, the
reported 489/489 result, or the existing c9d3f17d deployment.
