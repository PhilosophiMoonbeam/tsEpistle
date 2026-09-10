# Frontend successor source-review evidence — 2026-09-10

## Review identity and immutable binding

This document is the evidence for schema-2 source-review record
`security-review-db1a4456bd967808bcd8797b42c68ceeff076551`.

- **Reviewed source S:** `db1a4456bd967808bcd8797b42c68ceeff076551`.
- **Reviewed base B:** `594fe5c109f6cdc04545712fdac677dd0fc00691`.
- **Covered security-boundary digest:**
  `1b217f7ef208e0703f0acf95dace55a854552176ddaabd681367566a2c1575af`.
- **Threat-model SHA-256:**
  `2b2baa8c523bbbb2b3ffa89e2cad954ba63e3af372529dc76e931291bbd3b748`.
- **Review date:** 2026-09-10.

The documentation-only successor is called **A** in the non-circular release
model. The intended A change is limited to this evidence file, the successor
record, and the manifest entry; A has no asserted future commit SHA here. A is
intended to be a child of S with the same covered source-boundary bytes. This
record's `releaseEligible: true` attests only to the reviewed source S and its
zero-blocker finding state; it is not a gate or release result for A.

## Complete 33-path review boundary

`FrontendReleaseSecurityReview` performed an independent, read-only review of
the complete S context and all 33 supplied source, test, fixture, manifest, and
lockfile paths. The reviewer made no edits and ran no commands, tests, builds,
formatters, validators, Docker operations, deployment actions, or network
operations. The review returned **PASS**: no new blocking or non-blocking
finding survived the implemented controls.

The predecessor's cited targeted reviews remain **PASS** on their prior
scopes and are carried forward unchanged; `FrontendReleaseSecurityReview` is
the full independent review for this frontend source context.

The reviewed paths were:

1. `bun.lock`
2. `client/client-app.modern-vuetify.test.ts`
3. `client/client-app.ts`
4. `client/components/agents/agent-citations.ts`
5. `client/components/agents/agent-composer.interaction.test.ts`
6. `client/components/agents/agent-composer.resize.test.ts`
7. `client/components/agents/agent-composer.vue`
8. `client/components/agents/agent-history-folder-actions.test.ts`
9. `client/components/agents/agent-history-panel.selection.test.ts`
10. `client/components/agents/agent-history-panel.vue`
11. `client/components/agents/agent-markdown.vue`
12. `client/components/agents/agent-memory-manager.mount.test.js`
13. `client/components/agents/agent-memory-manager.vue`
14. `client/components/agents/agent-panel-header.vue`
15. `client/components/agents/agent-thread.disclosures.test.ts`
16. `client/components/agents/agent-thread.interaction.test.ts`
17. `client/components/agents/agent-thread.vue`
18. `client/components/agents/inline-agent-chat.interaction.test.ts`
19. `client/components/agents/inline-agent-chat.vue`
20. `client/components/common/nav-header.vue`
21. `client/components/editor/markdown/preview.ts`
22. `client/helpers/content-extension-runtime.test.ts`
23. `client/helpers/content-extension-runtime.ts`
24. `client/helpers/content-extension-runtimes/mermaid-security.test.ts`
25. `client/helpers/content-extension-runtimes/mermaid.ts`
26. `client/helpers/safe-markdown.ts`
27. `client/store/agents.polling.test.ts`
28. `client/store/agents.ts`
29. `client/themes/default/components/page.vue`
30. `dev/e2e/agent-fixture.ts`
31. `dev/e2e/quality.e2e.ts`
32. `dev/e2e/responsive.e2e.ts`
33. `package.json`

## Security-relevant source observations

- **Mermaid and content-extension lifecycle:** Mermaid input is bounded to 32
  KiB, 500 edges, and eight selected hosts per applicable root/message. Mermaid
  uses a strict locked configuration. Returned SVG is parsed while detached;
  active or foreign elements, event attributes, and external-reference
  attributes are rejected. CSS is structurally parsed with the pinned
  `css-tree` parser; at-rules and discarded/custom declarations are removed,
  retained property grammar and same-SVG CSS URL IDs are checked, and selectors
  are scoped to a collision-checked root. On sanitizer failure or a cap
  violation the original source is preserved rather than unsafe output being
  inserted. Runtime busy state, source fallback, settled completion, and
  cancellation/cleanup prevent stale or unbounded automatic hydration.

- **Markdown and citation trust:** `agent-markdown.vue`, `safe-markdown.ts`,
  `preview.ts`, and `agent-citations.ts` disable raw HTML and use a narrow
  DOMPurify allowlist. Citation styling and preview behavior derive only from
  citation metadata resolved by evidence ID, not authored markup. URL protocols
  and new-tab isolation are constrained.

- **Agent state and race handling:** Agent session, history, and memory
  mutations retain CSRF and server-authoritative expected-version contracts.
  Conflicting session mutations serialize; stale reads are cancelled or
  generation-fenced; committed state survives refresh failures; reconnect
  backoff is bounded; and polling/timer cleanup prevents stale completions.
  The reviewed interaction, mount, disclosure, selection, and polling tests
  cover the relevant transitions and race cases.

- **Vue/Vuetify wiring:** Client registrations are hard-coded, theme colors are
  normalized, Agent entry visibility is authenticated and permission-aware, and
  operations remain server-authoritative. Removal of
  `client/client-app.modern-vuetify.test.ts` removes no security control; the
  retained wiring and behavioral coverage still exercise the relevant surface.

- **Browser fixture integrity:** `dev/e2e/agent-fixture.ts` intercepts the
  complete Agent API namespace, aborts and records unexpected requests, exposes
  an explicit assertion, and cleans up conditionally. Mixed-host setup uses
  ordinary authenticated API creation and removal rather than synthetic DOM
  insertion. The targeted browser scenarios therefore exercise the real page
  boundary and hostile Mermaid no-network behavior, including the eight-of-nine
  rendering cap.

- **Dependency binding:** `css-tree` is a direct dependency exactly pinned to
  `3.2.1` in `package.json` and integrity-locked in `bun.lock`.

## Findings and carried risks

All nine predecessor finding objects are copied unchanged into the successor
record: `AUTH-APIKEY-HUMAN-IMPERSONATION`,
`AUTH-CALLBACK-INITIATION-BINDING`, `AUTH-OAUTH-STATE-LIFECYCLE`,
`STORAGE-ASSET-001`, `STORAGE-IMPORT-002`, `STORAGE-BACKUP-003`,
`SEC-STORAGE-NATIVE-BOUND-001`, `SEC-ADAPTER-001`, and `SEC-CACHE-001`.
There is no new finding and no blocking finding.

The six High findings and `SEC-CACHE-001` remain resolved on inherited
source evidence. The accepted Medium residuals remain unchanged:

- `SEC-STORAGE-NATIVE-BOUND-001`: native Git pack observation samples at
  100 ms and can overshoot; it is not a hard pack-size, disk, or memory quota,
  and Git setup/configuration/remotes remain outside the bounded
  synchronization runner. Exclusive application ownership and operator
  OS/filesystem controls remain required.
- `SEC-ADAPTER-001`: separately configured external adapters and providers
  remain operator-trusted integrations requiring deployment-specific canaries.
  This review does not claim that every external integration was live
  exercised.

The threat model is unchanged and needs no normative update. Its existing
untrusted authored SVG/Markdown/content-extension browser boundary and
`CONTENT-1`, `CONTENT-2`, `EXT-1`, and `SUPPLY-1` controls already govern the
reviewed source, and the record retains the current threat-model digest above.

## Main-attributed completed observations

Main supplied the following validation observations for the reviewed S context;
they were not commands run by `FrontendReleaseSecurityReview` and are not
prospective A results:

- `491/491` tests passed.
- Client typecheck passed.
- Lint reported no errors and two informational names.
- Production build and bundle-budget checks passed.
- Targeted browser acceptance scenarios passed. The reviewed browser coverage
  includes Agent and hostile-Mermaid/no-network/cap scenarios.

These observations support the reviewed source context only. They are not
production-runtime proof, and they do not establish a strict gate for A.

## Explicit exclusions and non-claims

This evidence does not claim any future A attestation SHA, ordinary or strict
A threat-model/release gate (including `test:security` after A is committed),
A image build or image identity, registry publication or push, public
availability of an A source URL, Compose replacement, deployment, health
checks, authenticated live-surface verification, backup, restore, rollback,
native ARM64 execution, external-provider canaries, or maintained-instance
behavior. No image, backup, deployment, live-production, push, or future
attestation result is inferred from `releaseEligible`, the covered-tree digest,
Main's supplied observations, or this documentation-only successor evidence.
