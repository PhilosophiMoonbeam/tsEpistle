# Provider execution, recovery, and immutable source-review evidence — 2026-09-11

## Review identity, ancestry, and immutable binding

This document is the durable evidence for schema-2 source-review record
`security-review-99e94b9e98c6f693b49f03396d3904354f059e3e`.

- **Prior reviewed source (`S1`):** `907831b89576e4876e51a471f8a16859fbb71575`.
- **Reviewed source (`S`):** `99e94b9e98c6f693b49f03396d3904354f059e3e`.
- **Exact cumulative review range:** `907831b89576e4876e51a471f8a16859fbb71575..99e94b9e98c6f693b49f03396d3904354f059e3e`.
- **Source base revision:** `907831b89576e4876e51a471f8a16859fbb71575`.
- **Covered security-boundary digest:** `8942b526392c24466ae0ea9a44e06593d202e817252c20bb08462304660d3f03`.
- **Threat-model SHA-256:** `f643fcea653b67bf10c98cdae0744586857f4c47635d62bf6cdf905288002a07`.
- **Review date:** 2026-09-11 UTC.

The cumulative history is explicit. `dc42e6cfdef7f9046f2df135b3c7d9af4bca2053`
is the predecessor documentation attestation for S1; `6088c647261e44a205551f2e471df2eaa24c0da0`
is the recovery commit that fixed the blocker-discovered Agent execution and
tool-discovery issues; and S is the final one-line `AGENT-2` guarded-provider-
egress clarification. The review binds the final immutable source tree S and
the complete cumulative delta from S1. The new record, this evidence, and the
manifest selection are intended for a documentation-only successor A. No future
A SHA is asserted here.

The checker-supplied canonical digests bind the policy-version-1 source
boundary and the current threat model independently. Documentation, README,
and other paths outside that canonical boundary remain review context; their
presence in the cumulative Git delta does not make them inputs to the covered
source digest.

## Exact cumulative delta reviewed

The exact
`907831b89576e4876e51a471f8a16859fbb71575..99e94b9e98c6f693b49f03396d3904354f059e3e`
name-status manifest contains 38 paths:

```text
M .github/workflows/build.yml
M client/helpers/agents-api.test.ts
M client/helpers/agents-api.ts
M docs/.planning/2026-08-16_first-class-agent-architecture-plan.md
M docs/agent-workspace.md
M docs/agents-deployment.md
M docs/security/review-attestations.json
A docs/security/review-attestations/security-review-907831b89576e4876e51a471f8a16859fbb71575.json
A docs/security/security-review-907831b89576e4876e51a471f8a16859fbb71575-evidence.md
M docs/security/threat-model.md
M server/agents/actions/catalog.ts
M server/agents/projection.ts
M server/agents/providers/engine.ts
M server/agents/providers/execution-failure.ts
M server/agents/providers/factory.ts
M server/agents/providers/gemini-interactions.ts
M server/agents/providers/openresponses.ts
M server/agents/providers/prompt-tools.ts
M server/agents/providers/registry.ts
M server/agents/providers/session-harness.ts
A server/agents/providers/tool-discovery.ts
M server/agents/providers/usage.ts
M server/agents/runtime.ts
M server/agents/skills/runtime.ts
M server/controllers/agents-host.ts
M server/master.ts
M server/test/agents/agent-engine-orchestration.test.ts
M server/test/agents/agent-engine.test.ts
M server/test/agents/contracts.test.ts
M server/test/agents/provider-factory.test.ts
M server/test/agents/provider-registry.test.ts
M server/test/agents/provider-transports.test.ts
M server/test/agents/repository.postgres.test.ts
M server/test/agents/repository.test.ts
M server/test/agents/skill-runtime.test.ts
A server/test/agents/tool-discovery.test.ts
M server/test/controllers/agents-host-sessions.test.ts
M shared/agents/contracts.ts
```

The final source commit S itself is `docs(security): clarify guarded provider
egress`; its one-line AGENT-2 clarification is included in the frozen tree.
The earlier documentation attestation paths in the table are historical
predecessor inputs, not a claim that this successor has already been committed.

## Review chronology and corrections

The following chronology preserves the intermediate blocking reviews as well as
the final passes. A BLOCK below records the state that triggered a correction;
it is not a finding in the final S record.

### Initial FinalCorrectnessReview — BLOCK

`FinalCorrectnessReview` initially reported:

> BLOCK. Two patch-introduced engine defects remain in tool activity fidelity
> and context-safe category discovery; both affect valid runtime paths and
> should be corrected before release. No documentation-only follow-up was
> identified.

The two exact blocker roots were:

1. **Structured tool-start input fidelity.** Native calls whose provider
   `params` was an object could record `input: '{}'` even though the accepted
   object was parsed and dispatched. That would make `priorRunActivity` and
   diagnostics reconstruct false tool input. The correction canonicalizes native
   object and JSON-string parameters before `tool.started`, reuses the parsed
   value for dispatch, and on malformed JSON omits the recorded input while
   retaining a correlated failure.
2. **Next-turn context-safe category discovery.** Enabling a category using only
   the current turn's catalog could report success and then fail on the next
   turn's expanded catalog with `AGENT_CONTEXT_TOO_LARGE`. The correction builds
   and preflights the prospective next `ToolDiscoveryTurn`, including its
   provider functions, system prompt, and synthesis reserve, before reporting
   the category enabled; an over-capacity request takes the bounded synthesis
   path without committing the category.

### FinalBlockerRereview — PASS

`FinalBlockerRereview` re-read the corrected engine, discovery implementation,
consumers, and regressions and reported:

> PASS. Both accepted blockers are closed: native object and JSON-string
> parameters are canonicalized before `tool.started`, the same parsed value is
> reused for dispatch, and malformed JSON omits the recorded input while
> receiving a correlated failure. `previewNextTurn` is pure and includes all
> pending categories; the engine preflights the prospective tool
> catalog/system prompt before committing a category, evaluates later
> same-batch output against that prospective state, and transitions to tool-free
> synthesis without rolling back an already reported enable.

### Documentation BLOCK reviews, corrections, and final PASS

`DocsArchitectureReview` and `DocsSecurityReview` both reported blocking
problems in the documentation-only changes while the source was still being
corrected. The preserved correction list is:

`DocsArchitectureReview` recorded the intermediate status explicitly:

> BLOCK — documentation corrections required before S. The implementation
> remained reviewed/passing; the required work was documentation-only.

`DocsSecurityReview` recorded the corresponding static-review status:

> FAIL — static review is complete. Four release-blocking documentation roots
> were submitted: continuation encryption/remote-ID persistence is overstated;
> provider credential egress and retention residual are misstated; durable
> provider continuation is incorrectly said to supersede process-local search
> pagination; and Catch Up partial-state, core-tool visibility, and
> synthesis-call count are overstated. No validation was run.

The four roots were corrected before the final fresh reads; the provider
credential/retention and AGENT-2 precision corrections were included in the
same documentation reconciliation.

- **Search pagination versus provider continuation:** `docs/agents-deployment.md`
  must not say that durable provider continuation supersedes Search pagination.
  Search remains a 128-entry, five-minute, owner/query-bound process-local
  `Map`; restart, expiry, and process-affinity limitations remain. Provider-
  native continuation envelopes are a separate mechanism.
- **Bounded remote reasoning IDs:** the OpenAI Responses documentation must not
  claim that all remote IDs remain outside PostgreSQL. A bounded, validated
  `rs_` reasoning-item ID can persist inside the origin-bound continuation
  envelope; it does not grant resume authority. Arbitrary raw response payloads,
  plaintext hidden reasoning, logs, and UI remain excluded.
- **Provider credential and retention residual:** the provider rows must state
  the exact configured public HTTPS origin and allowlisted base path, reject URL
  credentials and ambient credentials, send only configured authentication and
  allowlisted additional headers, pin public DNS/address resolution, reject
  every redirect, and use injected guarded fetch without private/proxy
  overrides. `store:false` is a request preference where supported, not proof
  that an external provider cannot process, log, retain, or later delete
  transmitted content.
- **Catch Up capacity semantics:** `docs/agent-workspace.md` must condition
  partial/nonretryable status on results omitted or calls not executed because
  of capacity. A Catch Up request that fits the available budget can complete
  normally.
- **Flat discovery and synthesis semantics:** always-visible core tools are
  qualified as visible on collecting/tool-enabled turns only. The docs describe
  one monotonic bounded synthesis phase rather than guaranteeing one provider
  call; evidence-correction turns remain possible with tools absent.
- **Normative AGENT-2 wording:** the threat-model residual must carry the
  injected guarded fetch, exact public HTTPS origin/allowlisted base path,
  public DNS/address pinning, configured authentication and headers, rejection
  of all redirects and private/reserved destinations, no proxy/private-address
  overrides, and the provider processing/logging/retention/deletion residual.

`PlanArchitectureFinalApproval` then performed a fresh read and passed the
corrected architecture-plan rows at 766, 821, and 1101–1102. It found no
remaining contradiction. `PlanSecurityFinalApproval` performed a fresh read of
the corrected provider rows and `docs/security/threat-model.md` and also passed:

> PASS. No findings or remaining review areas within scope. The
> architecture-plan rows at 766, 821, 1101–1102 and
> docs/security/threat-model.md AGENT-2 accurately state provider retention
> limitations and the complete guarded-egress contract.

These documentation BLOCK states and their corrections are retained as
chronology. The final docs status before S was PASS.

### FinalSecurityReview-2 — PASS

`FinalSecurityReview-2` reported no confirmed release-blocking security,
correctness, or maintainability finding after source-to-sink review. Its final
conclusion covered the following controls:

- Provider egress is restricted to the configured HTTPS origin and path,
  rejects redirects and credentials, validates DNS before dispatch and at
  connect time, and uses request-scoped transports and abort controllers.
- Continuation state is size/hash/dialect checked and admitted only when its
  persisted run origin exactly matches owner, session, profile version,
  transport, model, and capability.
- Provider and skill admission is serialized in the run-admission transaction,
  including continuation revalidation. Hostile responses are bounded at
  raw-body, raw-chunk, normalized-fragment, structured-value/depth,
  continuation, tool-call, retained, and incoming-byte layers. Incomplete or
  invalid responses keep dispatch exposure unsettled.
- Tool discovery is flat and turn-frozen; control calls are included in the
  shared activity contract; every terminal tool event has a paired start; and
  synthesis runs without tool authority.
- Proposal approval/apply uses immutable hashes, locked transitions, current
  authority rechecks, execution claims, and recovery fencing. Logs use
  normalized allowlisted diagnostics rather than raw provider errors or
  credentials. Quota accounting is monotone and fail-closed: positive pending
  settlement intent quarantines a run from automated release or reclaim.

The review retained these operational residuals without promoting them to new
findings: a positive settlement intent may require operator reconciliation if
terminal settlement repeatedly fails; an administrator can intentionally
configure a public third-party provider that receives admitted prompt content;
and raw streaming has byte, per-chunk, timeout, and concurrency limits but no
separate transport-chunk-count counter (normalized fragments are counted).
This is a monitoring/hardening consideration, not a demonstrated unbounded
path. The review was read-only; supplied execution evidence was corroboration,
not reviewer-executed tests, builds, or network calls.

### Immutable review passes at S

`ImmutableSecurityReview` completed the exact immutable source review at S and
reported PASS, zero surviving security blockers, and zero new findings after
the full 38-path delta plus adjacent-control review. The exact source digest
command was:

```console
bun server/scripts/check-threat-model.ts --digest 99e94b9e98c6f693b49f03396d3904354f059e3e
```

In the detached S worktree, it reported covered-tree digest
`8942b526392c24466ae0ea9a44e06593d202e817252c20bb08462304660d3f03` and
threat-model digest
`f643fcea653b67bf10c98cdae0744586857f4c47635d62bf6cdf905288002a07`.

`ImmutableCorrectnessReview` independently reviewed the same cumulative range
and reported PASS, with zero actionable patch-introduced correctness or
maintainability findings. It specifically confirmed that the intermediate
BLOCK was closed by `6088c647261e44a205551f2e471df2eaa24c0da0` and S, and that
the final one-line AGENT-2 clarification did not add a source-boundary defect.
Both immutable reviews were read-only and did not run payloads, tests,
formatters, builds, deployment actions, or network calls.

## Corrected real repository path table

Earlier review summaries contained path-prefix shorthand that could be read as
paths outside the repository. The immutable PASS reviews use the following
real repository paths; in particular, the provider files below all use the
`server/agents/providers/` prefix.

| Review area | Correct real repository path |
| --- | --- |
| CI and release wiring | `.github/workflows/build.yml` |
| Provider engine | `server/agents/providers/engine.ts` |
| Provider factory and registry | `server/agents/providers/factory.ts`; `server/agents/providers/registry.ts` |
| Provider transports | `server/agents/providers/openresponses.ts`; `server/agents/providers/gemini-interactions.ts` |
| Provider request/session helpers | `server/agents/providers/session-harness.ts`; `server/agents/providers/action-sessions.ts`; `server/agents/providers/execution-failure.ts`; `server/agents/providers/usage.ts`; `server/agents/providers/prompt-tools.ts` |
| Flat discovery | `server/agents/providers/tool-discovery.ts` |
| Runtime and host | `server/agents/runtime.ts`; `server/controllers/agents-host.ts`; `server/master.ts` |
| Skills, projections, and action authority | `server/agents/skills/runtime.ts`; `server/agents/projection.ts`; `server/agents/actions/catalog.ts`; `server/agents/actions/kernel.ts`; `server/agents/actions/page-proposals.ts`; `server/agents/proposals/execution.ts`; `server/agents/proposals/repository.ts` |
| Shared and client consumers | `shared/agents/contracts.ts`; `client/helpers/agents-api.ts`; `client/helpers/agents-api.test.ts`; `client/store/agents.ts`; `client/components/agents/agent-thread-presentation.ts`; `client/components/agents/agent-thread.vue`; `client/components/agents/agent-tool-card.vue`; `client/components/agents/agent-mcp-approval.vue`; `client/components/agents/inline-agent-chat.vue` |
| Agent tests | `server/test/agents/agent-engine-orchestration.test.ts`; `server/test/agents/agent-engine.test.ts`; `server/test/agents/contracts.test.ts`; `server/test/agents/provider-factory.test.ts`; `server/test/agents/provider-registry.test.ts`; `server/test/agents/provider-transports.test.ts`; `server/test/agents/repository.postgres.test.ts`; `server/test/agents/repository.test.ts`; `server/test/agents/skill-runtime.test.ts`; `server/test/agents/tool-discovery.test.ts`; `server/test/controllers/agents-host-sessions.test.ts` |
| Governing docs | `docs/agents-deployment.md`; `docs/agent-workspace.md`; `docs/.planning/2026-08-16_first-class-agent-architecture-plan.md`; `docs/security/threat-model.md` |

The path table does not assert `server/agents/tool-discovery.ts`,
`server/agents/session-harness.ts`, `server/agents/action-sessions.ts`, or
`server/agents/execution-failure.ts`; those shorthand forms are not used as
immutable evidence paths.

## Security-relevant source observations

### Guarded provider execution and continuation integrity

The provider boundary resolves a configured profile and uses injected guarded
fetch for its exact public HTTPS origin and allowlisted base path. URL
credentials, ambient credentials, redirects, private/loopback/link-local/
CGNAT/multicast/reserved destinations, proxy overrides, and private-address
substitution are rejected. Public DNS/address resolution is pinned before
request dispatch and checked again at connection time. Request-scoped
transports, abort controllers, deadlines, and one-attempt behavior prevent a
provider response from widening the egress boundary.

Provider-native continuation is treated as bounded opaque or dialect-specific
state. Its hash, size, dialect, and origin fields are checked before admission;
owner, session, provider profile version, transport, model, and capability must
match the persisted run origin. A bounded validated OpenAI `rs_` reasoning-item
ID may be nested in that origin-bound envelope, but it is not a resume authority
and arbitrary provider response material is not persisted.

### Admission, tools, activity, and failure telemetry

Provider profiles, selected skill versions, run admission, initial messages,
quota reservations, and admission events are committed atomically under owner
and session locks. Continuation revalidation occurs in the same admission
transaction. Tool discovery is flat and frozen per turn: a pending category is
prospectively checked against the next catalog/system prompt and synthesis
reserve before it is enabled. Tool-control events use the same action/event
contract as ordinary tool calls. Every terminal tool event is paired with one
start under run, attempt, action, sequence, and hash fences; synthesis is
explicitly tool-free.

Provider output is bounded centrally for raw bodies and chunks, retained and
incoming bytes, content/result/argument/thought fragments, continuation blocks,
action calls, structured depth/values/bytes, and normalized fragments. Invalid,
incomplete, cancelled, or capacity-limited paths retain explicit failure or
partial state and do not falsely settle omitted work. Failure telemetry exposes
only generic messages, allowlisted codes/stages/status, and bounded safe
diagnostics; raw provider errors, URLs, prompts, page content, tool arguments or
results, credentials, and hidden reasoning are excluded. (The implementation's
safe diagnostics are bounded and normalized; the preceding text intentionally
makes no claim about a raw provider payload being safe.)

### Quota and durable side-effect fencing

Admission reserves the configured whole-token exposure before provider launch.
Measured usage and cost settle monotonically, with pending positive settlement
intent retained against goal budgets. A failed continuation cannot reacquire
its full allowance, and positive pending intent blocks automated release,
expiry, cancellation release, reclaim, and quota top-up until conservative
reconciliation. Proposal execution rechecks current authority, immutable hash,
locked state, and execution claim before side effects; stale or uncertain
outcomes remain recoverable evidence rather than automatic replay.

### Documentation and threat-model boundary

The normative model remains `modelVersion: 1` and its bytes are bound by the
record's threat-model digest. Its AGENT-2 row now states the complete guarded
fetch, exact public origin/base path, public DNS/address pinning, configured
credentials and headers, no ambient credentials, rejection of redirects and
private/reserved destinations, bounded activity/failure/accounting behavior,
and the external-provider processing/logging/retention/deletion residual.
No new normative threat-model policy or finding is introduced by this review.

## Main-attributed completed observations

Main reports the following observations for the final immutable source bytes.
These are execution evidence from Main's commands and the integrated throwaway
smoke, not commands run by either immutable reviewer.

### Typechecks and focused behavior

The following exact commands exited successfully:

```console
bun run typecheck:shared
bun run typecheck:client
bun run typecheck:server
```

The canonical focused test commands and results were:

```console
bun run test server/test/agents/provider-factory.test.ts server/test/agents/provider-transports.test.ts server/test/agents/agent-engine-orchestration.test.ts server/test/agents/agent-engine.test.ts server/test/agents/tool-discovery.test.ts
bun run test server/test/controllers/agents-host-sessions.test.ts server/test/agents/repository.test.ts server/test/agents/goals.test.ts client/helpers/agents-api.test.ts server/test/agents/contracts.test.ts server/test/agents/diagnostics.test.ts
bun run test server/test/agents/agent-engine.test.ts server/test/agents/agent-engine-orchestration.test.ts server/test/agents/tool-discovery.test.ts
```

The first isolated provider group passed **5/5 files**, and the second isolated
host/repository group passed **6/6 files**. The final engine/discovery rerun
passed **71 tests, 0 failures, and 507 assertions**.

### PostgreSQL 17 race coverage

Against a real disposable PostgreSQL 17 service, Main ran:

```console
bun test server/test/agents/repository.postgres.test.ts
```

The required suite passed **9/9 tests, 0 failures, and 38 assertions**. This is
real PostgreSQL 17 evidence, not a skipped or SQLite fallback run.

### Full repository suite

Main ran the canonical full-suite command:

```console
bun run test
```

It passed **498/498 test files**, and the same **498/498** result was repeated
after the final repairs/source freeze. No test-file failure remained in the
reported final runs.

### Integrated runtime smoke

Main reports an integrated throwaway runtime smoke using isolated SQLite and a
controlled HTTP/provider harness; it did not modify maintained state or claim
live deployment. The exercised observations were:

- the pre-dispatch budget fence denied provider dispatch (`dispatch0`);
- a malformed provider stream produced `INVALID_PROVIDER_RESPONSE`, left
  `10591` units of exposure unsettled, and issued no refund;
- REST/SSE emitted paired control/action activity and a partial-capacity result;
- exact-origin continuation state was forwarded for a matching origin and
  omitted after the origin was switched; and
- cleanup passed.

### Static chain and expected pre-A failure

Main ran the exact static-chain command:

```console
bun run ci:static
```

The chain passed through dependency policy, license inventory, the exact
unconditional `bun audit --production`, lint, all three typechecks, OpenAPI,
production-placeholder checks, and `bun run agents:release-check`. The final
`bun run threat-model:check` stage failed exactly where expected for the
pre-successor worktree: dirty security-boundary source/untracked files and
stale ignored `server/.build-metadata.json` (its revision did not match that
worktree's HEAD). This was an expected dirty attestation/metadata failure, not
an A release-gate result.

## Findings and inherited accepted risks

The nine predecessor finding objects are carried into the successor record
unchanged in order, with the same IDs, severities, dispositions, and finding
`evidencePaths`:

1. `AUTH-APIKEY-HUMAN-IMPERSONATION` — High — resolved.
2. `AUTH-CALLBACK-INITIATION-BINDING` — High — resolved.
3. `AUTH-OAUTH-STATE-LIFECYCLE` — High — resolved.
4. `STORAGE-ASSET-001` — High — resolved.
5. `STORAGE-IMPORT-002` — High — resolved.
6. `STORAGE-BACKUP-003` — High — resolved.
7. `SEC-STORAGE-NATIVE-BOUND-001` — Medium — accepted.
8. `SEC-ADAPTER-001` — Medium — accepted.
9. `SEC-CACHE-001` — Medium — resolved.

The six High findings and `SEC-CACHE-001` remain resolved on inherited source
evidence. Review candidates encountered while the cumulative source was still
being corrected—including incomplete provider execution/resource accounting,
notification preference transport, unbounded candidate scanning, cross-owner
cursor eviction, missing principal-envelope binding, 401 cache retention,
approval cache policy, missing session-bound `PAGE_LOCKED` checks, and missing
submit/resubmit revision fences—were corrected before S was frozen. The final
reviews found no surviving new finding, so those pre-freeze candidates are not
added as current record findings. There are zero findings with disposition
`blocking` and zero new blockers.

The accepted Medium residuals remain unchanged and justified:

- **`SEC-STORAGE-NATIVE-BOUND-001` — accepted.** Native Git pack observation
  samples at 100 ms and can overshoot; it is not a hard pack-size, disk, or
  memory quota. Git setup/configuration/remotes remain outside the bounded
  synchronization runner. Exclusive application ownership and operator
  OS/filesystem quotas or bounded volumes remain required where a physical
  bound is needed. The present delta does not broaden or weaken this boundary.
- **`SEC-ADAPTER-001` — accepted.** Separately configured external adapters and
  providers remain operator-trusted integrations requiring deployment-specific
  canaries. This review does not claim that every external integration was
  live exercised and does not add a provider, permission, or egress grant.

The current threat model governs the reviewed authentication, page, content,
agent, job, migration, supply-chain, and operator boundaries. It remains
`modelVersion: 1`, and its current bytes are bound by the declared
`threatModelDigest`; the one-line AGENT-2 clarification does not change the
policy version or add a new finding.

`releaseEligible: true` attests only to S's completed source review, matching
canonical digests, and zero-blocker finding state. Protected release
environments, clean-tree enforcement, ancestry, provenance, and artifact
verification remain mandatory.

## Deployment-impacting migration and cutover constraint

`tsepistle-000031-agent-total-token-accounting.ts` changes the Agent writer
schema. Before applying or reversing it, operators must disable Agent
admission, drain coordinators, workers, maintenance, MCP/browser activity, and
every other Agent-state writer, back up PostgreSQL, migrate, deploy the matching
writer to all nodes, and restart only after the fleet is homogeneous. The
migration does not authorize mixed old/new writers. Rollback with retained
Agent data requires the documented compatible image and paired state handling
rather than dropping the column under active writers.

The inherited federation/session migration constraints in the predecessor
evidence also remain applicable and are not reclassified by this review.

## Explicit exclusions and non-claims

This evidence does not claim an A commit SHA, an ordinary or strict A
threat-model/release-gate result, A `ci:static`, a production build success, an
image built from A, OCI identity, registry publication, push, public source
availability, Compose replacement, maintained tailnet deployment, live health
check, backup, restore, rollback, native ARM64 execution, production migration,
production credentials, or external-provider canaries. No build, push, deploy,
or live-success result has occurred or is claimed yet. The integrated smoke was
isolated throwaway evidence, not maintained/live acceptance.

It does not reclassify historical records or claim that every runtime
integration was exercised. The source reviewers did not run payloads, tests,
builds, formatters, deployment actions, or network calls. Any later
source-boundary change requires a new immutable source review and digest rather
than an update to this record.
