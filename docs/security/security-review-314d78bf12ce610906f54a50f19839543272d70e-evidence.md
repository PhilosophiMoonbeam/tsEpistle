# Agent panels correction source-review evidence — 2026-09-10

## Review identity, ancestry, and binding

This document is the evidence for schema-2 source-review record
`security-review-314d78bf12ce610906f54a50f19839543272d70e`.

- **Exact reviewed source range:** `064f7cbf4f7d174e21b1aef3d82ffb6e52dece89..314d78bf12ce610906f54a50f19839543272d70e` (`A1..S2`).
- **Prior reviewed source (`S1`):** `db1a4456bd967808bcd8797b42c68ceeff076551`.
- **Documentation-only ancestor/current parent (`A1`):** `064f7cbf4f7d174e21b1aef3d82ffb6e52dece89`, the documentation successor of S1.
- **Reviewed source (`S2`):** `314d78bf12ce610906f54a50f19839543272d70e`, the panel correction child of A1.
- **Covered security-boundary digest:** `633474cd3f4e23c695d8287a7a4ff99728bdfdd114b2e4e765c4973b91f86e25`.
- **Threat-model SHA-256:** `2b2baa8c523bbbb2b3ffa89e2cad954ba63e3af372529dc76e931291bbd3b748`.
- **Review date:** 2026-09-10.

The record uses S1, rather than the documentation-only A1, as
`source.baseRevision` under the non-circular successor convention. The
manifest, this evidence, and the S2 record are documentation-only successor
files outside the covered source boundary. No future A2 commit hash is
asserted here.

## Independent source review — PASS

`PanelsCorrectionSecurityReview` supplied the independent read-only review at
`agent://PanelsCorrectionSecurityReview`. The review covered the corrected
panel implementation and its interaction/browser contracts:

- `client/components/agents/inline-agent-chat.vue`
- `client/components/agents/inline-agent-chat.interaction.test.ts`
- `dev/e2e/responsive.e2e.ts`

The reviewer returned **PASS**: no new finding and no blocking finding were
identified. The correction changes presentation and interaction sequencing
only; it does not change authentication, authorization, storage, persistence,
privilege, attacker-controlled input handling, or a dangerous sink. The
threat model is therefore unchanged and needs no normative update.

## Live-found correction and retained controls

Live mobile acceptance of the deployed `064f7cbf4f7d174e21b1aef3d82ffb6e52dece89`
revision exposed an obscuring Panels menu: selecting History or Memory could
leave the menu overlay above the newly accepted drawer state. S2 closes the
controlled `panelMenuOpen` v-model before `historyOpen` or `memoryOpen` changes
in both panel actions. This removes the stale menu overlay while preserving
those drawer transitions.

The existing guards remain ordered before state changes: a busy memory
mutation still prevents conflicting History/Memory transitions, and Memory
close remains blocked while its mutation is busy. Modal focus containment,
nested owned-overlay roots, Escape closure, and responsive trigger-focus
restoration remain retained. The E2E contract covers pointer activation of
History, keyboard activation of Memory, menu hiding, drawer focus, nested
Memory-dialog Escape ordering, drawer Escape, and restoration to the Panels
trigger.

## Main-attributed completed observations

Main reports the component suite passed **15/15**, client typecheck passed,
and lint of the changed files reported no errors. These are Main's execution
observations for S2, not commands run by `PanelsCorrectionSecurityReview`.

The live `064f7cbf4f7d174e21b1aef3d82ffb6e52dece89` deployment is discovery and
acceptance evidence for the defect only; it is **not** proof for S2. Corrected
real-browser proof has not been completed and remains future evidence,
excluded from this record until A2 is deployed. The E2E contract described
above is not represented as a completed live-browser run here.

## Findings and carried risks

All nine predecessor finding objects are carried into the S2 record unchanged:
`AUTH-APIKEY-HUMAN-IMPERSONATION`, `AUTH-CALLBACK-INITIATION-BINDING`,
`AUTH-OAUTH-STATE-LIFECYCLE`, `STORAGE-ASSET-001`, `STORAGE-IMPORT-002`,
`STORAGE-BACKUP-003`, `SEC-STORAGE-NATIVE-BOUND-001`, `SEC-ADAPTER-001`, and
`SEC-CACHE-001`. No new finding or blocking finding was added.

The six High findings and `SEC-CACHE-001` remain resolved on inherited source
evidence. The accepted Medium residuals remain unchanged:

- `SEC-STORAGE-NATIVE-BOUND-001`: native Git pack observation samples at
  100 ms and can overshoot; it is not a hard pack-size, disk, or memory quota,
  and Git setup/configuration/remotes remain outside the bounded
  synchronization runner. Exclusive application ownership and operator
  OS/filesystem controls remain required.
- `SEC-ADAPTER-001`: separately configured external adapters and providers
  remain operator-trusted integrations requiring deployment-specific canaries.
  This review does not claim that every external integration was live
  exercised.

`releaseEligible: true` attests only to S2's reviewed source and its
zero-blocker finding state. It is not a release, deployment, or runtime result
for A2.

## Explicit exclusions and non-claims

This evidence does not claim an A2 commit hash, A2 covered-tree result, strict
A2 threat-model or release gate, A2 build, image identity, registry push,
public source availability, Compose replacement, deployment, health check,
authenticated live-surface verification, backup, restore, rollback,
native ARM64 execution, external-provider canaries, or maintained-instance
behavior. It does not claim that A2 has been committed, pushed, built,
deployed, or live-verified.
