# Agent deployment and operations
This document separates the current normative runtime and recovery contract below from the historical deployment record that follows. The historical record retains the release-candidate baseline `1d1e25a7c131880fc963084fa993b73a19d579bc`, its operational conclusions, the maintainer-owned `schemaVersion: 2` source-review policy, and the later search-foundation working-tree evidence (`3adffcba7255a3f88ec490ceffefe6f826e9508a`); that evidence is not deployed or release-eligible. Do not treat historical instructions as authority when they conflict with the current contract.


## Current normative runtime and recovery contract

This section is the operator authority for the reviewed recovery implementation. It describes behavior and safe operating boundaries, not a build, deployment, live-provider run, or release-attestation result. A healthy process alone is not acceptance; retain separate evidence for any canary exercise.

### Request admission and provider continuation

- A send resolves the provider profile/version and selected skills inside the same database transaction as session-version, owner, group, and run admission. A failed provider or skill admission commits no partially admitted run. The provider service is request-scoped: load it for the agent request/run, create a fresh adapter/transport scope for each chat invocation, and do not share mutable SDK, request, response, or continuation state across requests.
- Persisted provider-native continuation is optional, dialect-specific state attached to the originating assistant message. OpenAI Responses and OpenResponses retain bounded validated reasoning blocks whose provider-supplied encrypted content is opaque, but their envelope may also retain the validated provider `rs_…` result identifier. OpenAI Chat and Anthropic Messages likewise retain bounded provider blocks marked encrypted. Gemini Interactions instead retains bounded canonical JSON for validated model-output, function-call, and thought steps; its `encrypted: true` marker is a format/validation marker, not application encryption. The serialized envelope is stored as provider-state bytes on the assistant message in PostgreSQL with a SHA-256 integrity check; the hash detects alteration but does not encrypt, so a database operator with local access can inspect the locally encoded bytes. Reuse it only when the current run matches the exact origin owner, session, provider-profile version, transport kind, model, and capability revision. Current versioned state must pass its stored integrity hash, schema, dialect, encrypted-block marker, block-count, and byte-limit checks. An incompatible origin, dialect, or unrecognized legacy shape omits the state and falls back to the canonical transcript; matched versioned or integrity-bearing state that fails validation fails closed as `AGENT_PROVIDER_STATE_CORRUPT`. Supported persisted dialects are OpenAI Responses, OpenResponses, Gemini Interactions, OpenAI Chat, and Anthropic Messages; legacy text Completions has no persisted continuation dialect. Never remap continuation state to a different owner, session, profile version, transport, model, or capability.
- Durable approval continuation is a separate run-owned checkpoint. Resume requires the same root run, owner, attempt, active status, currently offered action, and approved authority hash; otherwise return a safe continuation-mismatch/recovery result. Finalize an action session at most once and before accepted assistant content is presented.

### Bounds, genuine EOF, and cancellation

Every provider turn derives its limits through `deriveAgentProviderResourceLimits(maxOutputTokens)`; `maxOutputTokens` must be a positive safe integer. The helper centrally bounds retained response bytes (64 KiB minimum, 4 MiB maximum), content bytes (at most 384,000), argument bytes (at most 65,536), continuation bytes (at most 262,144), fragment bytes (1,024 minimum, 65,536 maximum), raw response bodies (at most 32 MiB), raw chunks (4 KiB minimum, 512 KiB maximum), cumulative incoming work, 32 action calls, 128 continuation blocks, response/result/argument/thought fragments, and structured input at depth 64, 16,384 values, and 65,536 bytes. These are host/provider bounds, not permission grants or a transport chunk-count guarantee.

- A stream is settled only after genuine EOF. A read, acceptance, or normalization failure before EOF aborts dispatch, makes exactly one cancellation attempt with the fixed safe reason, and preserves the normalized provider-stream/provider-response failure plus conservative unsettled exposure.
- The engine waits at most **1,000 ms** for that cancellation attempt (`Promise.race`); it then releases the reader lock even if cancellation rejects or does not settle. Normal EOF does not cancel and is the only stream path that permits complete usage reconciliation.
- Lower-level raw-body and raw-chunk limit handlers cancel their reader nonblocking (`void reader.cancel(...).catch(...)`) and release their lock; they do not extend or defeat the engine's 1,000 ms cancellation bound. An operator must not interpret this cleanup as proof that the remote provider stopped transmitting.

### Failure telemetry and accounting

Provider and host failures use the allowlisted execution stages `setup`, `context_admission`, `dispatch_admission`, `provider_request`, `provider_stream`, `provider_response`, `usage_reconciliation`, `action_cleanup`, or `unknown`, plus an allowlisted error code. The user-facing failure remains the generic `Agent inference failed`; cleanup-only failure is `ACTION_SESSION_CLOSE_FAILED`, and cleanup cannot replace an already-classified primary failure.

`agent.run.failed` may contain only `event`, `runId`, nonnegative `attempt`, `providerProfileVersionId`, `errorCode`, `failureStage`, safe `status`, optional safe `providerStatus`, validated bounded `diagnostics`, and nonnegative `unsettledExposure.tokens`/`costMicros`. `diagnostics` is limited to usage issue/field, safe prior/current token receipts, safe context byte/count fields, provider turn, and the allowlisted transport kind. `agent.worker.failed` is similarly fixed to its safe event, code, stage, and status fields. Normal logs must not contain prompts, source bodies, raw provider errors, credentials, authorization headers, opaque continuation bytes, or hidden reasoning.

The usage contract keeps independent nonnegative safe `inputTokens`, `outputTokens`, and provider `totalTokens`, with `totalTokens >= inputTokens + outputTokens`; residual tokens remain deliberately unclassified. Provider-reported cost uses the configured directional rates and the maximum rate for the residual, with safe integer arithmetic. An explicitly permitted missing-usage fallback is an admitted estimate charged at the full exposure; it is not measured usage and receives no residual/classification refund.

Dispatch reserves configured exposure before launch. A positive actual usage/cost is durably recorded before terminalization as a monotone pending settlement intent in the owner-, lease-, token-, and event-fenced reservation while it remains reserved with no reconciliation timestamp. This positive intent is a quarantine: maintenance, reclaim, expiry, cancellation release, and quota top-up must skip it, and operators must never clear it or zero it in SQL to make a drain appear complete. Final settlement must be at least the pending value; if settlement is unavailable, fail closed with `AGENT_QUOTA_SETTLEMENT_REQUIRED` and leave the intent for repair. A complete receipt settles once, releases the original hold once, and charges the full actual total/cost once; an incomplete attempt retains conservative unsettled exposure without inventing a measured receipt.

### Admitted tools and flat next-turn discovery

The action session exposes only functions already admitted by the current user, flags, selected-skill restrictions, execution mode, and (for a child) the fixed read-only action set. The flat category index is derived from those admitted functions and includes only nonempty `explore`, `history`, `canonical`, `authoring`, and `browser` categories. During collecting/tool-enabled turns, core functions remain visible. Once synthesis begins, no actions—including core functions or `wiki_enable_tools`—are exposed. `wiki_enable_tools` is the sole control function when collection tools are exposed; it is a read-only control activity, not a Wiki action, permission grant, action-kernel authority, or mutation.

Enabling a category returns its admitted tool descriptions and records a paired control activity, but activates those tools only on the next model turn. Before committing the enable result, the engine prospectively builds the expanded action catalog and system prompt and checks both the current tool-call result and a reserved tool-free synthesis context. If that expanded view cannot fit, the enable is rejected as `AGENT_CONTEXT_TOO_LARGE` and no category is activated. Calls from one model batch are processed serially in model order even when the provider declares parallel calls; a later call cannot invalidate an already recorded successful enable.

Once collection reaches its context/result capacity or otherwise transitions to synthesis, the phase is monotonic: subsequent provider turns are tool-free. Synthesis receives the bounded transcript, delivered results, and explicit omissions, and cannot execute an action or silently expand authority. This is one bounded synthesis phase, not necessarily one provider invocation: evidence-correction turns may add bounded tool-free provider turns within the existing turn and token limits.

### Catch Up and result capacity

The **Catch Up** starter is a normal read-only request. Its recent-page and page-read results are passed as bounded whole packets: the engine either admits a complete projected result that fits its prospective provider context or records that result as omitted; it does not truncate a source packet into a misleading partial source. A result that completed at the Wiki action layer but cannot fit provider context is returned to synthesis with `status: "omitted"` and `reason: "tool_result_capacity"`. Calls after capacity is reached are not invoked and receive `status: "not_executed"` with the same reason. Each omission has an explicit action-call ID and paired durable activity.

When a result is omitted or a later call is not executed because of context capacity, the engine adds a bounded coverage notice, switches permanently to tool-free synthesis, and preserves monotonic collection/accounting. It may still return a useful assistant message grounded in the delivered evidence, but it must disclose the coverage limitation and never claim complete coverage, cite an omitted source, fabricate a missing finding, or automatically repeat the same collection. In that capacity case, runtime persists the assistant message as complete while marking the run `partial`; the completion assessment includes `AGENT_CONTEXT_TOO_LARGE` with `retryable: false` and outcome `blocked`. A durable goal therefore becomes blocked rather than launching a repeated automatic continuation for this nonretryable capacity condition. If all requested evidence fits and no capacity omission occurs, Catch Up retains its ordinary completion assessment rather than being forced to `partial` or `blocked`.

### Controlled maintained-canary cutover and rollback

The recovery inventory introduces **no new database migration**. Retain `tsepistle-000031-agent-total-token-accounting.ts` and its writer-drain/backfill guidance for installations that have not applied migration 31; do not rerun it on an installation that already has the column. The current code-only canary path does not require migration down, schema reset, profile reconformance, provider-secret changes, or PostgreSQL recreation.
Repository-disabled defaults are not a statement about the maintained installation: inspect the resolved configuration privately. The maintained canary configuration enables goals, orchestration, skills, proposals, write actions, and MCP while browser remains disabled; preserve those settings and establish the real admission gate before replacement.

1. Establish a real admission gate for Wiki writes, Agent sends and continuations, MCP mutations, scheduled/background writers, and integrations. Drain active work and positive settlement intents; never expire, release, or zero a positive pending intent.
2. Record the running Compose project/service/container, image, network, volumes, port, migration ledger, baseline page/history/asset/user/group counts, representative source/asset hashes, and unsettled reservations. Inspect resolved configuration privately.
3. Quiesce writers and take a **fresh paired recovery point**: custom PostgreSQL dump plus a copy of the complete `/wiki/data` tree, configuration, and referenced secrets with restrictive access. Preserve the old image as a rollback reference without treating that tag as compatibility proof.
4. Change only `services.wiki.image` in the maintained Compose file. Preserve project `wiki-tailnet-6629be44`, service key `wiki`, container name, PostgreSQL container/database/volume, content and repo volumes, network, secret/config mounts, restart policy, and port `3014`.
5. Recreate only the Wiki application with the verified candidate image while admission remains gated. Copy the saved complete `/wiki/data` contents into the replacement before starting it. Any unexpected migration, missing key/file, permission error, restart loop, or projection/provider-state error is a stop condition.
6. After health and continuity checks, exercise the controlled read-only acceptance surfaces (three starters, custom message/follow-up isolation, discovery, Catch Up capacity, activity/reconnect, accounting, and safe failure logs). A healthy container or HTTP health response alone is not acceptance, and no live success is implied by this runbook.

For **no-loss rollback before candidate writes or migrations**, keep admission gated, stop the candidate, restore the saved Compose/config and old image, recreate only `wiki`, restore the saved complete `/wiki/data`, and start it against the unchanged PostgreSQL resources. For **any run, write, or migration after cutover**, stop and gate traffic, preserve a second complete PostgreSQL/data/config/key snapshot, and do not start an arbitrary older image on newer Agent event state. Prefer disabling the smallest failing capability and forwarding the schema-aware application. Restoring PostgreSQL, `/wiki/data`, and keys from a recovery point rewinds intervening edits, conversations, approvals, usage, or other records; it is not a no-loss rollback and requires explicit operator authorization plus reconciliation. Never use `down -v`, volume pruning, destructive migration-down, `pg_restore --clean`, or manual SQL that discards pending settlement intent.

## Historical deployment record

Wiki agents use the ordinary Wiki origin plus one isolated browser-service boundary:

| Surface | Example | Purpose | Exposure |
| --- | --- | --- | --- |
| Wiki | `https://wiki.example.com` | Existing UI, inline Search/Ask, `/admin/agents`, internal agent REST/SSE, approvals | Existing authenticated users |
| MCP | `https://wiki.example.com/mcp` | Streamable HTTP MCP | Resource-bound API keys only |
| Browser worker | private mTLS endpoint | Playwright execution in a separate unprivileged process/container | Wiki application replicas only |

There is no agent-specific public origin, login, cookie, launch token, popup, iframe, or sidecar application. The internal agent controller handles only `/_api/agents`. When MCP is enabled, the exact `/mcp` endpoint on the Wiki origin is reserved for MCP; its API-key authentication remains independent from Wiki browser sessions.

## Historical database and compatibility record

Agents require PostgreSQL for multi-replica leases and notification. Apply migrations through `2.5.157` and `tsepistle-000031-agent-total-token-accounting.ts` before enabling any flag:

- `2.5.139` adds the source-revision ledger and agent tables.
- `2.5.140` removes the obsolete cross-origin launch-handoff table. Its down migration recreates only the empty compatibility shape.
- `2.5.156` adds the durable depth-one research task ledger, child-attempt identity, authority/result hashes, lifecycle state, and evidence counts.
- `2.5.157` adds the opt-in durable goal ledger, run continuations, host completion assessments, and hidden continuation-message marker.
- `tsepistle-000031-agent-total-token-accounting.ts` adds `agentRuns.totalTokens` as `BIGINT NOT NULL DEFAULT 0`.

The `tsepistle-000031-agent-total-token-accounting.ts` backfill validates each legacy row's nonnegative safe `inputTokens` and `outputTokens` and their safe sum, then stores that directional sum as a lower bound. It does not reconstruct an independent provider total, invent or categorize residual tokens, or rewrite quota-ledger rows. Its down migration drops only this additive column. Treat this as a writer cutover: drain every agent-state writer before applying or reversing it.

The historical repository-default snapshot had all agent flags, including specialist orchestration and durable goals, disabled. Back up PostgreSQL before upgrade or rollback.

### Historical migration rollback paths (retained, superseded for the current recovery)

The historical release-candidate procedure recorded two migration rollback paths. They remain historical evidence only; use the current state-preserving canary rollback contract above for this recovery:

1. With no authoritative agent or goal data to retain: disable all agent flags, drain coordinators and maintenance, apply `tsepistle-000031-agent-total-token-accounting.ts` down first, then apply `2.5.157` down, `2.5.156` down, `2.5.140` down, and the guarded `2.5.139` down, and start the prior image. The `2.5.157` down migration refuses to discard any goal.
2. With agent data to retain: disable all flags and run the release-produced N-1 compatibility image. Keep the schema-compatible maintenance command active. Do not run an arbitrary older image or drop `agentGoals` or `agentRunTasks`.

Never run a destructive down migration while an application, MCP client, browser worker, or maintenance job can write agent state.

## Ingress

Route the Wiki hostname normally and apply a stricter exact-path policy to `/mcp` on that same hostname. Preserve `Host`, terminate TLS at trusted ingress, reject unknown hosts, disable proxy buffering for SSE/MCP, and apply an ingress rate limit to MCP.

Representative policy:

```nginx
server {
  listen 443 ssl http2;
  server_name wiki.example.com;
  location = /mcp {
    limit_req zone=mcp burst=20 nodelay;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 10m;
    proxy_pass http://wiki_app;
  }
  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 10m;
    proxy_pass http://wiki_app;
  }
}
```

The application derives the canonical MCP resource as `${wiki.config.host}/mcp` and rejects MCP `Host`, `Origin`, and resource-claim mismatches. `/mcp` is reserved while MCP is enabled; `_agent` remains an ordinary Wiki page path.

## Historical configuration baseline

Start with every capability disabled:

```yaml
agents:
  enabled: false
  retention:
    temporarySessionHours: 24
    savedSessionDays: 90
    mcpContentDays: 7
    auditDays: 90
    maintenanceBatchSize: 100
  provider:
    enabled: false
    globalConcurrency: 4
    perUserConcurrency: 1
    pollingMilliseconds: 1000
  orchestration:
    enabled: false
    maxConcurrentChildren: 3
    maxChildren: 6
    plannerTurns: 2
    childTurns: 4
    childToolCalls: 8
    plannerTimeoutMilliseconds: 30000
    childTimeoutMilliseconds: 120000
    plannerMaxOutputTokens: 1024
    childMaxOutputTokens: 2048
    maxAggregateChildTokens: 12000
    maxAggregateChildOutputCharacters: 96000
  goals:
    enabled: false
    maxContinuations: 3
    maxTokens: 48000
    maxToolCalls: 96
    maxDurationMilliseconds: 3600000
  sse:
    maximumConnectionsPerUser: 3
  skills:
    enabled: false
    namespace: system/agent-skills
  browser:
    enabled: false
  proposals:
    enabled: false
  writes:
    enabled: false
    create: { enabled: false }
    patch: { enabled: false }
    move: { enabled: false }
    restore: { enabled: false }
    delete: { enabled: false }
  mcp:
    enabled: false
```

Startup rejects provider concurrency, polling, orchestration, durable-goal, SSE, and retention values outside their bounded ranges. `perUserConcurrency` cannot exceed `globalConcurrency`, and specialist concurrency cannot exceed the per-response task limit. Flags are independent kill switches; write application requires `writes.enabled`, proposals, and the exact action flag.

Provider inference is intentionally unavailable until an operator enables the provider subsystem with its signing, profile-resolution, and provider-credential encryption keyrings, then an administrator adds a provider profile in `/admin/agents`. Wiki runs a connection check automatically after every save. A new profile is enabled when that check succeeds; a failed check leaves it disabled and displays the provider's bounded, sanitized error. Enabling the subsystem alone offers no usable model destination. The admin API encrypts credentials inside the profile transaction and never returns them.

### Specialist research orchestration

`agents.orchestration.enabled` enables host-owned decomposition only for sufficiently complex read-only research requests in Agent mode. A deterministic host gate decides whether planning is eligible; a bounded planner may then return either zero tasks or 2–`maxChildren` independent `source_scout`, `fact_check`, or `conflict_check` tasks. The host validates duplicate titles, questions, and overlapping source-scout scopes before it writes the plan.

Every task and child attempt is durable in `agentRunTasks`. Children are depth one, run under the root lease and cancellation signal, and receive only the intersection of the root's admitted actions, selected-skill action restrictions, current user permissions and flags, and the fixed Wiki read profile. They cannot write, prepare or apply proposals, browse the open web, read or change memory, change skills, delegate, or persist a root action snapshot. The stored child authority hash covers the complete offered action set.

`maxConcurrentChildren`, `maxChildren`, `childTurns`, `childToolCalls`, planner/child deadlines, per-call output tokens, aggregate child tokens, and aggregate child output characters are hard host bounds. Before any provider launch, the host atomically reserves the child's full configured output-token ceiling and a character allowance of at most the 64 KiB packet cap from the root's remaining aggregate capacity. Only fully token-admissible children launch, their provider and stream ceilings are reduced to the reserved allowances, and deterministic planner order is preserved across bounded concurrent batches. Measured input and output tokens consume the reservation before unused capacity is released after terminal task accounting; when input usage exhausts the remaining headroom, later tasks terminate without provider launch. Lease recovery rebuilds consumed capacity from hashed model-turn telemetry across every prior child attempt before reserving a retry, so retries cannot reset aggregate accounting. Usage from the planner, every child attempt, retries after lease recovery, root synthesis, and title utility work is charged to the root run reservation. Root cancellation marks pending and running tasks cancelled; lease recovery returns abandoned running tasks to pending with a superseded-attempt event.

Children return strict evidence packets, not user prose. Each claim names successful `wiki_get_page` or `wiki_get_page_version` evidence IDs and their exact source revisions; its inline citation markers must match those declared IDs exactly. A conflict may be a completed finding without a duplicate prose claim, but it must name at least two distinct sources read by that child. The host rejects wrong task ownership, unread or undeclared evidence, duplicate conflict sources, revision mismatch, malformed packets, and false completion. The root model alone synthesizes the answer. Existing lexical citation validation remains authoritative, every completed task must be covered by the final citations, and every validated conflict must cite all of its sources together in a passage that explicitly discloses disagreement or uncertainty. A run becomes `partial` rather than `succeeded` when any required task is blocked, partial, failed, cancelled, or disabled.

The conversation projects task titles, kinds, scopes, status, evidence counts, and bounded public failure notes. Host-authored UI never renders child packets as answer text, hidden reasoning, provider continuation, or subagent identifiers; durable event/API identifiers remain correlation metadata only. The admin runtime page shows the effective flag and limits. AG-UI/A2UI adapters and nested delegation remain intentionally absent.

### Durable opt-in goals

`agents.goals.enabled` exposes an explicit **Goal** send mode. Ordinary prompts remain one-shot. Starting a goal creates one authoritative `agentGoals` row and links its initial run as continuation zero. A session can have only one open goal. The owner may pause, resume, or cancel it with optimistic version checks; no third party or model action can create or mutate a goal.

The host—not the model—assesses each terminal run. Completion requires terminal required tasks, satisfied evidence and citation gates, no pending proposal, and reconciled usage. Retryable incompleteness creates a new linked run with a hidden host continuation prompt; the assistant answer remains visible in conversation history. A blocked specialist task is non-actionable and moves the goal to `blocked` instead of consuming automatic continuations. Continuations re-authorize the current provider profile and require the exact admitted profile snapshot, while selected skill versions stay frozen from the initial run. Provider/profile drift blocks the goal instead of silently changing authority.

`maxContinuations`, `maxTokens`, `maxToolCalls`, and `maxDurationMilliseconds` are aggregate per-goal limits. Exhaustion moves the goal to `budget_limited`; model output cannot extend them. Goal token usage is derived from terminal runs joined to owner-matched, reconciled quota reservations: each terminal run contributes the greater of its valid independent `totalTokens` (an immutable legacy event contributes only its validated directional lower bound) or its valid reservation `consumedTokens`, never both. A valid provider receipt may exceed its original reservation: reconciliation releases only the original held tokens/cost from daily reserved counters, adds the full actual total/cost to daily consumed counters, and records the full actual total/cost on the reservation. The reservation's held fields remain immutable admission provenance, not retrospective accounting ceilings. Before terminalization, positive actual input/output/total/cost usage is durably recorded as a monotone pending settlement intent in the reservation's consumed fields while it remains `reserved` with a null `reconciledAt`; owner and active lease/token/event fences apply, and original holds/daily counters remain unchanged. Positive pending intent blocks reclaim, expiry, cancellation release, and quota top-up until repaired; final actual usage must be at least the pending value, and an unavailable settlement fails closed with `AGENT_QUOTA_SETTLEMENT_REQUIRED`. No-quota terminalization uses the greater of persisted event usage and pending intent. Active held reservations are not prior goal usage, and directional run counters remain truthful. A missing or unreconciled terminal reservation fails closed, records `GOAL_ACCOUNTING_UNAVAILABLE`, and blocks continuation until the ledger is reconciled. Approval waits move the goal to `blocked` without consuming a continuation.`
Queue selection excludes positive pending intents before bounded claim and maintenance batch limits, so older blocked rows cannot starve eligible work.

Goal objective and completion assessments are SHA-256 bound. The session diagnostics export includes the goal ledger, linked continuation numbers, host assessments, lifecycle events, aggregate usage, and visibility markers for host continuation messages. Never replay an individual continuation outside the owning goal.

### Provider API protocols

A provider profile describes one approved destination, encrypted credential, primary Agent model, optional utility model, separate reasoning controls for those two roles, explicit tool-calling mode, protocol-derived capability descriptor, and policy. The utility model shares the profile's destination, credential, API protocol, and transport policy; leaving it blank routes bounded utility work to the Agent model while preserving the independent utility reasoning setting. Its API protocol selects the exact wire contract used at that destination; it is not inferred from the URL. The ordinary admin form derives the remaining low-level transport behavior.

| API protocol | Endpoint | Native action mapping |
| --- | --- | --- |
| OpenAI Responses API | `POST /v1/responses` | Function tools, `function_call` items, and `function_call_output` items; preferred OpenAI integration |
| OpenResponses-compatible API | `POST /v1/responses` | The same item model, with strict request, semantic-event, sequence, and terminal-marker validation |
| OpenAI-compatible Chat Completions | `POST /v1/chat/completions` | Function tools, assistant `tool_calls`, and `tool` result messages |
| Legacy text Completions | `POST /v1/completions` | No native action fields; strict prompt-emulated action turns only |
| Anthropic Messages API | `POST /v1/messages` | Anthropic tools, `tool_use` content blocks, and `tool_result` content blocks |
| Google Gemini Interactions API | `POST /v1beta/interactions` | Stateless `user_input`, `model_output`, `thought`, `function_call`, and `function_result` steps |

Reasoning effort is optional and model-dependent. The administrator selects the Agent and utility values independently; leaving either value at **Provider / model default** omits that role's wire field. Wiki exposes only the values defined by the selected protocol and runs both configured model roles through connection conformance before enabling the profile. A provider can still reject a level that its selected model does not implement.

| API protocol | Request field | Exposed values |
| --- | --- | --- |
| OpenAI Responses API | `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| OpenResponses-compatible API | `reasoning.effort` | `none`, `low`, `medium`, `high`, `xhigh` |
| OpenAI-compatible Chat Completions | `reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Anthropic Messages API | `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Google Gemini Interactions API | `generation_config.thinking_level` | `minimal`, `low`, `medium`, `high` |
| Legacy text Completions | — | Not available |

OpenAI documents that reasoning-model support varies by model. OpenResponses limits its reasoning contract to GPT-5 and o-series models. Anthropic effort applies to all response tokens, including tool calls and thinking when active, and supported models default to `high`; `xhigh` and `max` support varies by model. Gemini uses the Interactions API's `thinking_level` field directly—never `generateContent` thinking configuration. These controls adjust effort, not visible response length, and Wiki does not request, expose, or log private reasoning text.

**Native API tools** is the default for Responses, OpenResponses, Chat Completions, Anthropic Messages, and Gemini. Wiki submits provider-native definitions and results, requests strict schemas where the protocol supports them, and enables parallel calls only when the profile declares them. Multiple calls from one native model turn are executed serially in model order so policy, approval, and audit ordering remain deterministic.

Gemini profiles use only the Google AI Interactions API, the `v1beta` API root, and a Gemini 3.x model ID such as `gemini-3.7-flash`. Wiki sends the API key in `x-goog-api-key`, permits only the exact `/interactions` path, sets `store: false`, and resends the complete client-managed step history on every turn. Model steps are retained as one size-bounded continuation item encoded as canonical JSON for replay, including validated model-output, function-call IDs/arguments, ordering, and any returned thought signature/summary; the `encrypted: true` marker is required by the continuation block schema but is not application encryption. The locally encoded bytes are stored in the assistant message's PostgreSQL provider-state field and remain inspectable by a database operator with local access; private thought text is not requested or exposed. `store: false` is a request preference, not proof that the external provider cannot process, log, or retain transmitted content. The transport supports Wiki's system instructions, text, SSE streaming, native and parallel functions, action results and errors, JSON Schema output, usage accounting, and request cancellation. It never calls `generateContent`. The currently documented Interactions gaps—video metadata, Batch API, Python automatic function calling, explicit caching, and custom safety settings—are not Wiki Agent operations and therefore do not justify a fallback.

**Prompt-emulated tools** is available for deployments whose API does not implement native tools reliably and is mandatory for legacy text Completions. Wiki sends no provider tool fields. Instead, a trusted system instruction supplies an allowlisted JSON Schema catalog and requires a whole-response `<wiki-tool-call>` envelope. Exactly one call is accepted per turn. Mixed prose, Markdown fences, malformed JSON, extra envelope fields, unknown names, oversized arguments, and unexpected native calls fail closed. Wiki creates the call ID; action lookup, input validation, authorization, risk handling, approval, and execution still occur in the same server action kernel used by native calls. Tool results are escaped, labeled untrusted, and returned in a `<wiki-tool-result>` envelope.

The prompt protocol is a compatibility path, not equivalent provider behavior: instruction-following is model-dependent, parallel calls are unavailable, and intermediate model text is buffered until a final no-action answer. Prefer native tools whenever the provider implements them correctly.

Every save runs a live conformance check for the selected mode. In addition to cancellation, bounded output, streaming, and usage accounting, the check forces a temporary echo action, verifies its exact arguments, returns a result using that protocol, and requires a final text response. When a distinct utility model is configured, the same check also requires bounded text from that model before enabling the profile. A provider profile remains disabled until the current settings pass. Capability revision 2 remains current for the other protocols. Gemini Interactions uses revision 3; its migration disables and removes default status from previously conformed Gemini profiles so an administrator must recheck them before use.

Chat Completions and text Completions are not aliases. Chat Completions accepts structured message history and may use native tools; legacy text Completions accepts one flattened prompt and can use only prompt emulation. Likewise, OpenAI Responses and OpenResponses share an item-oriented shape but represent different compatibility promises. Administrators must choose the server's documented protocol and tool mode; Wiki verifies the selected behavior instead of probing endpoints heuristically.

Editing updates the existing provider profile, temporarily disables it, and runs the same connection check. A previously enabled profile is enabled again when the check succeeds; an intentionally disabled profile remains disabled. The current encrypted credential is retained when the administrator leaves the API-key field blank; entering a value replaces the managed credential. Removing a profile immediately excludes it from administration, session selection, default resolution, and new run admission. Audit records remain, while managed provider credentials are permanently deleted. A removed display name can be reused by a new profile.

### Failure classification, usage accounting, and action cleanup

Provider and host failures are normalized into an allowlisted `failureStage` (`setup`, `context_admission`, `dispatch_admission`, `provider_request`, `provider_stream`, `provider_response`, `usage_reconciliation`, `action_cleanup`, or `unknown`) and a safe `errorCode`; unknown codes fall back to `PROVIDER_REQUEST_FAILED`. Terminal persistence records that stage and code, the generic user-facing message `Agent inference failed`, and an optional validated provider status; raw provider errors never cross the persistence or response boundary. Cleanup-only failures use `ACTION_SESSION_CLOSE_FAILED` at `action_cleanup`, while a primary inference failure remains the reported failure if cleanup also fails.

Before a provider launch, dispatch reserves the configured exposure as an admission bound. Before terminalization, the host durably records any positive actual usage as a monotone pending settlement intent in the owner- and lease/token/event-fenced reservation while it remains `reserved` with a null `reconciledAt`; this does not change original holds or daily counters. Positive pending intent blocks reclaim, expiry, cancellation release, and quota top-up, while zero intent may still be expired and released. Actual input/output/total/cost usage is reconciled once; a valid complete receipt may exceed the original hold, in which case terminal quota reconciliation releases exactly that original hold once, charges the full actual total/cost to daily consumed counters, and stores the full actual total/cost in the reservation while preserving the original held fields as admission provenance. Final settlement must be at least the pending usage; if accounting cannot complete, `AGENT_QUOTA_SETTLEMENT_REQUIRED` fails closed and leaves the intent for repair. No-quota terminalization uses the greater of persisted event usage and pending intent. If a provider attempt fails before a complete receipt, the active `unsettledExposure` is retained and included with settled usage when quota and run cost are terminalized; the persisted exposure makes attempted-provider accounting conservative without double-counting a later settled receipt. This is a safety/accounting boundary, not proof of provider acceptance or a billing assertion.

The historical cancellation wording here is superseded by the current bounded contract above: a pre-EOF read, acceptance, or normalization failure receives exactly one cancellation attempt, the engine waits at most **1,000 ms**, and the reader lock is released even if cancellation rejects or does not settle. Normal EOF does not cancel and is the only stream path that completes usage reconciliation.

A live action session is finalized exactly once; subsequent cleanup observes the finalized state and performs no second close, before accepted assistant content is presented. A cleanup exception cannot trigger a second close and cannot replace an already-classified primary failure. These boundaries apply to ordinary runs, action continuations, and provider-request failure paths.

### Independent total-token accounting and current provider evidence

The canonical `AgentTokenUsage` record preserves three immutable measured fields: `inputTokens`, `outputTokens`, and the provider-reported `totalTokens`. Each is a nonnegative safe integer, and safe addition must establish `totalTokens >= inputTokens + outputTokens`; `totalTokens` is never silently replaced by the directional sum. The accepted/estimated total is persisted in `agentRuns.totalTokens` and carried into diagnostics and aggregate safe sums. Usage, cost, and aggregate counters remain nonnegative safe integers. The residual `totalTokens - (inputTokens + outputTokens)` is intentionally unclassified. Do not label or allocate it as reasoning, cache, tool, or any other category.

`agentProviderCostMicros(pricing, input, output, total)` charges the measured directions at their configured micros-per-million-token rates and charges the unclassified residual at `max(inputRate, outputRate)`. It performs the numerator and ceiling with `BigInt`: `ceil((input × inputRate + output × outputRate + residual × max(inputRate, outputRate)) / 1,000,000)`. This is conservative pricing under the two-rate profile, not a claim about a provider invoice. Charged-token limits and settled reservation/daily/goal `consumedTokens` use the full `totalTokens`; the dispatch hold remains a configured exposure bound, and directional values remain truthful measured diagnostics.
That residual formula and any classification-based refund apply only to a validated provider-reported receipt. If usage is omitted and the profile explicitly permits estimated fallback, the accepted directions and total are admitted estimates, not measured usage; cost remains the full admitted max-rate exposure, with no residual or classification refund inferred without a receipt. For example, an estimated `input=1326`, `output=4000`, `total=5326` remains `10652` at rates `1/2`, while an actually reported receipt with the same counts costs `9326`.

New `model.turn`, `task.planCreated`, and `usage.updated` payloads carry `usageVersion: 2` together with `totalTokens`; the outer agent-event envelope remains `schemaVersion: 1`. `readAgentProviderUsage` and `readAgentUsageEvent` reject unsafe, negative, incomplete, or inconsistent usage. Immutable legacy events are accepted only when both `usageVersion` and `totalTokens` are absent and the directional values have a valid safe sum; decoding them exposes `inputTokens + outputTokens` only as a lower bound and does not invent a residual. Mixed-era payloads and unknown usage versions fail closed.

Dispatch reserves the configured whole-token exposure before provider launch; an active hold is counted once and is not added to terminal measured usage. A valid complete receipt settles once using its full measured total and cost, even when that exceeds the original hold: reconciliation releases exactly the original held tokens/cost from daily reserved counters, adds the full actual total/cost to daily consumed counters, and records the actual on the reservation. Held fields remain immutable admission provenance. A positive pending settlement intent is monotone and owner/lease/token/event fenced; it blocks reclaim, expiry, cancellation release, and quota top-up until settlement, while zero intent may still be released. A failed attempt without a complete receipt retains conservative unsettled exposure rather than inventing a measured total; it is not added again when a later receipt settles. If settlement is unavailable, preserve conservative unsettled exposure and do not report successful completion.

**Current deterministic provider-path evidence (one external configured-provider request; synthetic prompt/results).** One real read-only request used the configured external provider with synthetic prompt and result content. Profile/secret resolution and database inspection were read-only; no maintained application, database, or provider state was written. The request returned HTTP 200, its SSE stream reached genuine EOF, and the final text was rejected only by the old strict equality that required `totalTokens` to equal `inputTokens + outputTokens`. The normalized receipt was `inputTokens=3`, `outputTokens=309`, `totalTokens=4580`; the residual 4,268 tokens is unclassified. The current fix accepts a validated independent total at least as large as the safe directional sum and preserves that total through events, runs, diagnostics, pricing, and settlement. This demonstrates the current deterministic equality defect and fix only. No post-fix live rerun was performed, no private **Catch up** continuation replay was attempted, and the historical pre-H1 cause remains unknown. No private, secret, or raw-provider material is retained or documented.

The historical cancellation wording here is superseded by the current bounded contract above: a pre-EOF read, acceptance, or normalization failure receives exactly one cancellation attempt, the engine waits at most **1,000 ms**, and the reader lock is released even if cancellation rejects or does not settle. Normal EOF does not cancel and is the only stream path that completes usage reconciliation.

### Historical Catch up evidence boundary

The current deterministic equality defect and its fix are separate from the historical third-turn **Catch up** provider-request/continuation blocker. The request above does not establish historical causal identity: the original continuation payload and provider-error evidence remain unavailable, and no private **Catch up** continuation replay was attempted. Safe failure classification, conservative attempted-provider accounting, and exactly-once cleanup therefore do not establish that historical root cause or claim that Catch up is fixed; the historical pre-H1 cause remains unknown. No post-fix live rerun or deployed verification is implied.

Required cryptographic environment:

| Variable | Required when |
| --- | --- |
| `AGENT_SNAPSHOT_SIGNING_SECRET` or `AGENT_SNAPSHOT_SIGNING_SECRET_FILE` | Provider or MCP actions are enabled |
| `AGENT_PROFILE_RESOLUTION_KEYS` or `AGENT_PROFILE_RESOLUTION_KEYS_FILE` | Providers are enabled |
| `AGENT_PROVIDER_SECRET_KEYS` or `AGENT_PROVIDER_SECRET_KEYS_FILE` | Providers are enabled |
| `AGENT_MCP_REQUEST_STATE_KEYS` | MCP is enabled |

Each keyring uses `{ "currentKeyId": "name", "keys": { "name": "<base64>" } }`. Provider credential encryption keys must decode to exactly 32 bytes. Wiki encrypts each UI-supplied credential with AES-256-GCM, a fresh 96-bit nonce, and authenticated record identity, stores only ciphertext in `agentProviderSecrets`, and writes an opaque `managed:<uuid>` reference into internal provider storage. Retain every encryption key ID referenced by stored credentials when rotating `currentKeyId`; removing an in-use key fails closed. Existing operator-managed `env:NAME` references remain readable for compatibility, including `NAME_FILE`, but the admin UI creates managed encrypted credentials. The `_FILE` forms read a mounted keyring when the matching inline variable is absent.

## Revisioned knowledge projections and OKF

For Markdown pages, OKF authority is implicit across create, read, update, move, restore, import, export, and download. The Wiki page source, hierarchy, permissions, and revision ledger remain authoritative. The stored OKF authority record is server-owned: human and agent edits can change permitted metadata, but generated, verified, and restore provenance is stamped or retained by the server. Missing and invalid authority are explicit states, never inferred from a projection.

`pageKnowledgeProjections` is a revision-keyed, repairable derived index, not a human-editable page store. Schema version 2 is a clean stored/wire cutover that adds bounded `searchTerms`, persisted normalized `searchTokens`, and the configured `searchDictionary`; schema-1 projection reads are unavailable and repair only from validated immutable intent. Every committed mutation may carry a `knowledge` outbox effect. Projection failure never rewrites source, page history, pageTags, or OKF authority.

Deterministic projection is first: source bytes and revision metadata produce a source hash, stable concept identity, bounded section/link/source information, conservative entities/relationships, lifecycle/trust state, declared gaps, `searchTerms`, and field provenance. Historical revisions remain addressable from immutable history. `searchTokens` are PostgreSQL GIN-indexed and invalidated with the configured dictionary. Projection-derived values are retrieval hints, not permission or citation evidence.

### Utility enrichment policy

The utility boundary is intentionally narrow and implemented. The conformed global provider profile is an operator-approved **shared-content processor**, not a requester-scoped read. At **preflight** it checks current revision/source hash, public visibility, publication window, and password/protection state; it does not evaluate requester, page-rule, or anonymous-read ACL. It can receive a published shared page that a later retrieval withholds from a requester. A private, protected, unpublished, scheduled, expired, or invalid-window source found at preflight makes **no provider request**. Recheck revision/hash/eligibility immediately before accepting output. If they change after dispatch, discard the output and finalize safely; already transmitted bytes cannot be retracted. Empty publication bounds remain open where the page contract permits; valid offset-bearing timestamps compare as instants. Retrieval retains its separate requester ACL enforcement.

The utility request has no tools, accepts strict bounded schema output for declared projection gaps only, and cannot write page source, `pageTags`, authority, or verification state. This is not an injection-proof prompt boundary or a semantic-truth guarantee. Input and output are clamped to resolved provider capabilities; `maxActive` uses the configured `globalConcurrency` value to cap knowledge leases across workers. It is separate from Agent-run slot accounting and does not make a combined chat/background provider pool. New `searchTerms` backfill may invoke utility once for each eligible current page. There is no shared per-user background-cost accounting, implied background per-user quota, or total backfill-cost quota; before deployment, approve the provider for this shared corpus and review corpus size/provider budget. Never log source content or credentials. Valid output fills only still-missing declared fields and preserves deterministic data. Malformed output, timeout, unavailable profile, preflight ineligibility, or revision/hash race leaves the deterministic projection usable; ineligible work is not retried as utility work. Accepted output records hashes, selected model, exact profile-version ID, and generation time.

Normal reads may expose authority and a revision-matched projection when present. `operations.search` centralizes lexical-plus-projection fusion, applies current ACL, publication, protection, selected-page, locale/path, and private owner/system-manager constraints before caps, and labels a projection match as **knowledge hints**. It neither grants access nor proves a factual claim. An exact revision request that is missing or mismatched fails closed rather than returning current content; a current page without a completed projection remains readable with pending/null knowledge.

`wiki_get_page_okf` is the raw exact-interchange operation. Use it only when an integration needs a canonical, revision-bound OKF document or authority metadata; ordinary reads do not need it. The immutable MCP resource URI is `wiki://pages/{pageId}/versions/{version|current}/revisions/{sourceRevision}/okf`, and its identifiers must match the returned page, version, and source revision. It serializes authorized Markdown only, with `text/markdown`, canonical links, source hash, authority, and the revision-matched projection; invalid or missing authority and non-Markdown pages fail closed.

### Storage classification and Markdown egress

Storage uses the canonical page layout `{locale}/{path}.md`. Reserved page paths use `{locale}/index.concept.md` and `{locale}/log.concept.md`; valid OKF at another object path is rejected without a database mutation. Explicit storage ingress classifies each bounded document as `okf_valid`, `okf_invalid`, `legacy_wiki`, `legacy_v1`, or `plain_markdown`. A document that claims OKF but has malformed frontmatter or metadata is quarantined as invalid rather than silently downgraded to legacy. Valid OKF imports metadata, publication state, and links into the Wiki page; imported Markdown body line endings are normalized for the database, while the original source bytes and SHA-256 remain unchanged for the storage operation. Imported `verified` claims are stripped at the server-owned mutation boundary, and importer-generated provenance is stamped there.

Explicit storage egress writes deterministic OKF 0.2 Markdown for every Markdown page, including bounded frontmatter, retained valid authority extensions, Wiki database facts, and canonicalized internal links. Direct `/d/...` downloads use the same canonical Markdown egress for the current page; `?v={versionId}` selects an authorized historical version. Public downloads require `read:source` (or `read:history` for a version), private downloads require page access and unlock, and invalid stored authority is an error rather than a legacy fallback. Non-Markdown pages retain their existing serializers.

The human editor's **Knowledge / OKF** panel displays authority state, trust, source revision, projection completeness, provenance, and utility use. It permits editing bounded core metadata, sources, and non-core extension JSON through the normal page save. Direct draft reads require authority matching the editor context; they do not broaden draft-source disclosure. When authority is missing or invalid, **Reset to stable reference** sets `{ type: "Reference", status: "stable" }`; save then advances the page through the ordinary revision path.

System administrators use **Administration → Storage** to enable targets, choose sync direction, run explicit import/export actions, and inspect target status plus the latest operation ledger. Import reports classify OKF/legacy/plain/invalid items and diagnostics; egress may replace target files. Storage actions never invoke utility enrichment. Monitor the projection worker and metrics for projection gaps, projection/enrichment state, and durable maintenance status, cursor, repaired, and requeued counters; these maintenance/status signals do not grant authority.

OKF frontmatter is limited to 64 KiB of JSON-compatible metadata with bounded depth and node count. YAML uses the JSON schema and rejects duplicate and prototype-sensitive keys. Stored producer extensions remain on the authoritative page when valid; ordinary human authoring advances generation provenance.

The MCP surface uses the official `@modelcontextprotocol/server` TypeScript SDK v2 and advertises MCP `2026-07-28` while retaining the repository's tested legacy negotiation path. Keep this direct SDK integration: it supplies the protocol level and control needed for resource-bound API keys, live action admission, immutable approval state, and dual-era compatibility. Do not replace it with a convenience framework that would downgrade the negotiated protocol or bypass the shared action kernel.


## Skills and Wiki authoring

When skills and a tool-capable Agent profile are enabled, each run receives the names, descriptions, exact version IDs, and content hashes of the approved system skills visible to that user and the user's personal skills marked **Available to the agent automatically**. The model must inspect that catalog and load a matching `SKILL.md` with `wiki_read_skill` before it calls task actions; do not load unrelated skills. Users manage personal `SKILL.md` documents from the chat Skills menu, can remove them from automatic discovery without preventing explicit use, and can type `/` at the start of the composer to fuzzy-search and invoke any selectable system or personal skill for the next message. Skills pinned in Session configuration and skills explicitly invoked for one message are loaded in full before generation starts. Skill bodies are untrusted instructions constrained by runtime permissions and the frontmatter allowlist.

Install the following operational skill as the Markdown source page `system/agent-skills/wiki-authoring`, then register the page as `wiki-authoring`, approve its exact version, and expose it to the intended groups in `/admin/agents`. Edit skill source pages with the Markdown source editor because YAML frontmatter is part of the signed skill bytes. Reapprove after every source change. The `wiki_*` names are the single public tool vocabulary used by both built-in Agent providers and MCP clients; dotted action IDs remain internal authority and audit identifiers only.

```markdown
---
name: wiki-authoring
description: Create and edit Wiki pages while preserving Markdown, links, and human-editor compatibility.
compatibility: tsEpistle Visual Markdown and Markdown source editors
metadata:
  owner: wiki-operations
allowed-tools:
  - wiki_search_pages
  - wiki_search_tags
  - wiki_list_tags
  - wiki_discover_pages
  - wiki_get_page
  - wiki_get_page_okf
  - wiki_read_page_for_patch
  - wiki_list_recent_pages
  - wiki_list_page_history
  - wiki_get_page_version
  - wiki_list_page_links
  - wiki_get_related_pages
  - wiki_prepare_page_create
  - wiki_prepare_page_patch
  - wiki_prepare_page_move
  - wiki_prepare_page_restore
  - wiki_apply_page_proposal
---
# Wiki authoring

Use this skill for any request to discover, read, create, edit, move, or restore a Wiki page, or to draft Wiki-compatible page source.

## One knowledge path

- The `wiki_*` names in this file are exact callable tool names in both built-in Agent runs and external MCP sessions.
- Use ordinary Wiki page reads (`wiki_get_page`, `wiki_get_page_version`, search, discovery, recent, and related-page actions) by default. They expose the authoritative page plus its authority record and revision-matched `knowledge` projection when ready.
- OKF authority is implicit for every Markdown page lifecycle operation, including create, read, update, move, restore, import, export, and download. Every mutation still goes through immutable preparation, human approval, live reauthorization, and application.
- Projection lifecycle, trust, verification, and staleness values rank or filter retrieval; they never grant permission or replace page-source evidence. Read the underlying page before making a factual claim or proposing an edit.
- Call `wiki_get_page_okf` only for exact canonical OKF interchange or an exact source-revision document. Use the immutable `wiki://pages/{pageId}/versions/{version|current}/revisions/{sourceRevision}/okf` resource identity; storage import/export remains an administrator operation, and page authoring uses ordinary proposals.

## Before acting

1. Resolve the exact locale and path with page search/read actions. Never infer an existing page identity from display text.
2. Read the target before editing. Only Markdown pages support hashline patches. Do not convert or rewrite an HTML page; explain that it requires a human HTML-editor workflow.
3. Preserve the page's language, terminology, heading hierarchy, link style, line ending, and final-newline state unless the user explicitly requests a change.
4. Make the smallest source change that fulfills the request. Do not normalize unrelated text or reserialize the whole document.

## Compatible Markdown

For new pages, write canonical GitHub Flavored Markdown that round-trips through Visual Markdown:

- paragraphs and ATX headings (`#` through `######`);
- bold, italic, strikethrough, inline code, and fenced code blocks with language identifiers;
- ordered, unordered, nested, and task lists;
- blockquotes, horizontal rules, basic images, and rectangular GFM tables;
- ordinary links. For internal pages, prefer the root-relative path form already used by nearby pages and preserve locale prefixes where the Wiki uses them.

Do not add raw HTML, Markdown attributes, custom classes or IDs, merged/multiline tables, tabsets, math, diagrams, footnotes, or other extended syntax unless the existing page already uses that construct and the user specifically asks to preserve or change it. Never replace supported source with rendered HTML. These constraints keep the page editable in both Visual Markdown and Markdown source editors.

Skill source pages are a deliberate exception: preserve their YAML frontmatter and edit them only as Markdown source.

## Create workflow

1. Check both the requested path and likely collisions with `wiki_search_pages` or `wiki_get_page`.
2. Supply a concise title and description, canonical Markdown content, `contentType: "markdown"`, the resolved locale/path, publication state, and intentional tags to `wiki_prepare_page_create`.
3. The prepare action waits for the human decision. A denial leaves the page unchanged.
4. Approval triggers live reauthorization and automatic application of the exact immutable proposal. The prepare action returns `status: "applied"` only after the mutation commits.
5. Use `wiki_get_page` when the final source or metadata must be verified.

## Edit workflow

1. Read the page, then call `wiki_read_page_for_patch` with `previousSnapshotToken: null` and only the ranges needed. Use a returned token only for later reads of the same page.
2. Build `wiki-line-patch-v1` from the exact document tag, snapshot token, line numbers, and line tags. Keep undisclosed lines untouched. Preserve the snapshot's final-newline state unless the requested edit changes it.
3. Submit the patch with `wiki_prepare_page_patch`. If the revision or an anchor changed, reread and rebuild; never guess a token or tag.
4. Wait for the human decision. Approval triggers live reauthorization and automatic application of the exact immutable proposal.
5. Do not say the page changed until the prepare action returns `status: "applied"`.

## Knowledge discovery and exact interchange

1. Use `wiki_discover_pages` to browse candidate concepts and `wiki_search_pages` for a focused query. Apply knowledge lifecycle filters only when the request requires them.
2. Read the authoritative source with `wiki_get_page` before making a factual claim or proposing an edit. Treat trust, verification, and staleness as retrieval signals rather than permission or proof.
3. If `knowledge` is `null` or `partial`, continue with the page source. Do not fabricate missing projection fields or invoke an undeclared enrichment path.
4. Call `wiki_get_page_okf` only when exact canonical OKF interchange or an exact source revision is required. It is not a normal read shortcut; its immutable resource URI must match the returned page identity and source revision.
5. Use the ordinary create or patch proposal workflow for every requested authoring change.

Move and restore follow the same prepare, human approval, and automatic application sequence. `wiki_apply_page_proposal` remains available for MCP clients and idempotent recovery; Agent chat does not rely on another model-selected tool call after approval.
```

This skill intentionally omits deletion. Keep destructive deletion in a separate, narrowly exposed skill and rollout.

## Browser worker

For a canary deployment, treat `ghcr.io/philosophimoonbeam/wiki-canary-promotion:canary-set` as the only commit point for the application/browser-worker set. The ordinary `:canary` image tags are non-authoritative conveniences and can temporarily name different runs while publication is in progress. Resolve the set once with the checked-in verifier; it validates the record, its exact main revision, all four architecture descriptors, and the matching immutable record keyed by that revision:

```sh
eval "$(dev/resolve-canary-promotion.sh --format=env)"
printf 'Deploying validated main revision %s\n' "$WIKI_CANARY_MAIN_SHA"
docker pull "$WIKI_IMAGE"
docker pull "$WIKI_AGENT_BROWSER_IMAGE"
```

`WIKI_IMAGE` and `WIKI_AGENT_BROWSER_IMAGE` are digest references selected for the host architecture. The resolver also exports `WIKI_CANARY_APPLICATION_AMD64`, `WIKI_CANARY_APPLICATION_ARM64`, `WIKI_CANARY_AGENT_BROWSER_AMD64`, and `WIKI_CANARY_AGENT_BROWSER_ARM64` for schedulers that place both architectures. Pass the application digest to Helm rather than a mutable tag:

```sh
helm upgrade --install wiki dev/helm \
  --set-string image.repository="${WIKI_IMAGE%@*}" \
  --set-string image.digest="${WIKI_IMAGE#*@}"
```

Use `WIKI_AGENT_BROWSER_IMAGE` as the final image argument to the hardened browser-worker invocation below. Never resolve the application and browser-worker convenience tags separately: an interrupted tag update does not advance `canary-set`, and therefore must not advance deployment.

For a packaged release, deploy the application and browser worker using the immutable `containerImage.reference` and `agentBrowserImage.reference` values in `release-manifest.json`; do not resolve the release tags independently.

Build `dev/build/Dockerfile.agent-browser`. It pins Playwright/Chromium, runs as `pwuser`, launches Chromium with its sandbox enabled, and executes outside the Wiki application process.

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file dev/build/Dockerfile.agent-browser \
  --build-arg WIKI_BUILD_REVISION="$WIKI_BUILD_REVISION" \
  --provenance=mode=max --sbom=true --push \
  --tag registry.example.com/wiki-agent-browser:"$WIKI_BUILD_REVISION" .
```

Run it with a read-only root filesystem, writable temporary storage only, no application/database/provider secrets, bounded memory/PIDs/CPU, and ingress only from Wiki replicas over mTLS. Worker variables:

The repository includes Playwright `1.62.1`'s reviewed `dev/build/agent-browser-seccomp.json`. The default Docker seccomp profile blocks the user namespaces required by Chromium's sandbox; do not disable the Chromium sandbox or use `seccomp=unconfined`. A hardened container invocation must preserve the minimal `SYS_CHROOT` capability required by the sandbox:

```sh
docker run --detach --name wiki-agent-browser \
  --network wiki-agent-browser-egress \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --shm-size=256m \
  --pids-limit=256 --memory=1g --cpus=1 \
  --cap-drop=ALL --cap-add=SYS_CHROOT \
  --security-opt no-new-privileges=true \
  --security-opt seccomp="$(pwd)/dev/build/agent-browser-seccomp.json" \
  --mount type=bind,src=/run/wiki-agent-browser-tls,dst=/run/browser-tls,readonly \
  --env-file /run/wiki-agent-browser.env \
  registry.example.com/wiki-agent-browser:"$WIKI_BUILD_REVISION"
```

The signing-key environment file and TLS mount contain only browser-worker credentials. The worker image needs no Wiki configuration, database credentials, provider keys, host mounts, or Docker socket.

- `AGENT_BROWSER_TLS_CERT`, `AGENT_BROWSER_TLS_KEY`, `AGENT_BROWSER_TLS_CA`
- `AGENT_BROWSER_SIGNING_KEYS`
- `AGENT_BROWSER_PORT` (default `9443`)
- `AGENT_BROWSER_MAX_CONTEXTS` (default `8`, allowed `1..64`)
- `AGENT_BROWSER_CHROMIUM_PATH` when overriding the bundled executable

Application replicas use `AGENT_BROWSER_WORKER_URL`, `AGENT_BROWSER_WORKER_SIGNING_KEY_ID`, `AGENT_BROWSER_WORKER_SIGNING_SECRET`, `AGENT_BROWSER_WORKER_CA_PATH`, `AGENT_BROWSER_WORKER_CERT_PATH`, and `AGENT_BROWSER_WORKER_KEY_PATH`.

The worker validates signed request identity, sequence, replay nonce, context/action/navigation/time/byte limits, canonical HTTPS GET targets, public DNS answers, stale refs, and screenshot format. Chromium request interception blocks non-attested requests, alternate methods, sockets, downloads, service workers, and popups.

In-process checks are not a network sandbox. Deploy the container in a network namespace with no direct external route and force egress through an independently filtered Layer 3/4 gateway. Do not enable `agents.browser.enabled` until packet capture or gateway logs prove Chromium cannot bypass that route. This repository cannot install a universal host-network policy because enforcement belongs to the deployment network.

Drain by disabling browser admission, waiting for active contexts, then sending `SIGTERM`. Keep the prior signing verification key only through the maximum request lifetime.

## Agent identity

Wiki follows Hermes Agent's separation of identity from operations. The source-controlled `server/agents/SOUL.md` is the first system-prompt section and defines only durable character, voice, and conversational defaults. Permission boundaries, tool protocols, citations, skills, and Wiki-specific behavior remain in code-owned core instructions. User memory, page hints, skill material, browser content, and tool results follow both sections as explicitly untrusted data.

The shipped soul gives every user the same recognizable baseline: warm without flattery, curious without interrogating, concise by default, willing to recommend and respectfully disagree, and responsive to frustration, ambiguity, playfulness, and routine work. Personal memory can tune that baseline with a user's durable communication preferences; it cannot replace identity or policy. Users can also request a temporary tone naturally in conversation. Wiki deliberately does not expose a per-user soul editor: a shared product identity is predictable, reviewable, cache-friendly, and does not create another persistent prompt-injection surface.

At process start, Wiki reads the soul beside its loader, strips a UTF-8 BOM, normalizes line endings, and rejects empty content, unsafe role/control text, or more than 4 KiB. The validated bytes are loaded once and stay stable for the life of that process. A deployment can revise the soul under normal source review; no database state, conversation migration, or user-memory rewrite is involved.

## Conversation history and personal memory

Saved conversations are bounded history, not durable memory. A draft does not enter conversation history until it contains a completed user message, and replacing an unused draft first creates its replacement, then cleans up the old empty session. Failed creation preserves the current session and unsent text. Unfiled temporary sessions are excluded before history pagination, even after a completed user message. **Keep conversation** converts a temporary session to saved retention and clears its expiry; empty kept sessions still require a completed user message to appear in history. Legacy foldered temporary sessions remain visible. Maintenance permanently removes unfiled saved sessions after `savedSessionDays` without activity (90 days by default); temporary sessions continue to use `temporarySessionHours` (24 hours by default). The workspace displays this expiry, while actual removal occurs through maintenance. Temporary retention does not disable personal-memory reads or writes. Active runs fence deletion until they become terminal.

The Agent workspace's **New** action creates a fresh saved session; **Temporary** creates a fresh temporary session; **Keep conversation** applies saved retention to the same session ID and clears expiry, rather than creating a replacement. Session pins carry only version, owner, and session references for tab/account resume; they do not preserve a draft, source, memory, skills, or retention policy.

The Agent workspace opens conversation history in the left side panel. Users can create up to 32 private folders and move conversations into them. A foldered conversation is exempt from both saved and temporary session expiration until it leaves the folder. Moving it back to **Recent**, or removing its folder, converts it to saved retention, clears any temporary expiry, and resets `lastActivityAt`, beginning a fresh `savedSessionDays` window. Folder removal never deletes its conversations. Conversations remain individually deletable in both Recent and folders. The user-scoped **Reset** action still cancels owned active work, tombstones every owned conversation in one transaction, and opens a clean saved draft; it retains empty folder structure and never deletes personal memory.

An empty-folder drop or New folder flow commits folder creation and session move as two existing transactions. If folder creation is uncertain, the client reconciles by name; if the subsequent move is uncertain or fails, the folder remains available for retry and the UI reports moved only after the move is confirmed. It never presents the two-step flow as one atomic transaction.

After each of the first two successful exchanges, Wiki asks the profile's utility model for a concise conversation title. The second pass deliberately refines the title from the broader chronological transcript instead of freezing the opening prompt as the conversation's identity. Requests contain bounded user and assistant messages, have no tools, treat the transcript as untrusted data, allow a small reasoning/output budget, and use a 15-second ceiling. Malformed output or provider failure falls back to a bounded title derived from the first user message; a later successful second pass can replace that fallback. Utility titles then stabilize, while an explicitly edited title is never overwritten. Utility receipts preserve the same independent input/output/total semantics and conservative residual pricing; their full total and cost are added once to the corresponding run's usage accounting even when presentation falls back.
For troubleshooting, every provider turn now records its bounded visible output, per-turn token usage, outcome, and requested action-call IDs; action events retain canonical inputs, results, cache reuse, and evidence-gate outcomes. Aggregate usage separates Agent-model and title-utility tokens. System administrators can download a conversation snapshot directly from `GET /_api/agents/admin/sessions/:sessionId/diagnostics.json`; the endpoint is intentionally absent from ordinary navigation, requires `manage:system`, accepts any conversation ID for support work, returns `private, no-store`, and omits encrypted provider continuation content. The export contains each user and assistant message, run/provider metadata, selected skill context, verified event timelines, derived duplicate-read and evidence-retry findings, and explicit limitations. Private model chain-of-thought is neither retained nor represented as an inferred rationale.
Numeric `schemaVersion: 1` diagnostics exports fail closed with `AGENT_DIAGNOSTIC_USAGE_OVERFLOW` when individually valid run usage or cost cannot be safely aggregated; they never round, clamp, stringify, or emit partial evidence.

Within a run, identical `wiki_get_page` and `wiki_get_page_version` selectors reuse the first successful result unless a mutating action invalidates the read cache. The action timeline remains complete and labels reuse rather than hiding the model's redundant request. Successful page reads also require at least one valid final citation, and the evidence gate accepts markers placed either before or after sentence punctuation. Later turns receive a bounded prior-run activity summary, preventing the Agent from falsely claiming that no earlier actions occurred while still withholding private reasoning.


Wiki adopts the bounded, curated shape of Hermes Agent's default memory rather than treating every transcript as memory:

| Store | Purpose | Capacity |
| --- | --- | ---: |
| About you | Identity, preferences, communication style, and working habits | 1,375 characters |
| Agent notes | Stable project, environment, convention, workflow, correction, and completed-work facts | 2,200 characters |

Entries are rows in `agentMemories`, scoped by `ownerId`, exact-deduplicated by content hash, and deleted with the owning user. `wiki_manage_memory` gives the Agent add/replace/remove operations; the right-side Memory panel gives the user equivalent review, edit, remove, and clear controls without covering the conversation on desktop. Writes reject invisible control characters, role/context fences, instruction-override language, embedded credentials, ambiguous substring matches, stale versions, and over-capacity results.

Each new conversation captures one immutable JSON snapshot in `agentSessions.memorySnapshot`. Every run in that conversation receives the same snapshot, preserving a stable prompt prefix and preventing a mid-conversation memory write from silently changing prior context. Live writes are immediately durable and their tool result reports the current store, but prompt recall begins with the next conversation. The prompt labels recalled entries as user-specific data: useful preferences and facts, never authorization, tool input, or policy.

This first-class path deliberately omits automatic transcript extraction, embeddings, and unbounded conversation search. Curated memory covers the high-value always-on context with fixed token cost; Recent history remains a privacy-bounded record, while explicitly foldered conversations are durable until the user moves or deletes them. A future semantic provider would need an explicit opt-in flag, per-user index isolation, deletion propagation, provenance, retention semantics independent from chat history, prompt-injection defenses, quality evaluation, and a visible recall/write audit surface before it could replace this store.

## Security and privacy

- Internal agent REST accepts ordinary authenticated user sessions only. Mutations require exact same-origin `Origin`, `Sec-Fetch-Site: same-origin`, and the session CSRF token. API keys are rejected.
- MCP accepts resource-bound API keys only at `/mcp` on the configured Wiki origin; ordinary browser sessions are rejected.
- Wiki `extra.js` is administrator-installed privileged code. It can act as the signed-in user on the Wiki origin; do not treat it as untrusted tenant content. Provider text, skill text, and page content never execute as code and are rendered through the existing sanitizer.
- Permission and ownership checks occur when actions are offered and again at execution. Write approvals are immutable, single-use, revision-fenced records.
- Conversation reset, retention, memory reads, and memory mutations are owner-scoped. Clearing history cannot clear memory, and clearing memory cannot alter history.
- Memory enters the system prompt only through a bounded, frozen snapshot. Unsafe control text and embedded credentials are rejected before persistence; recalled content never grants permissions.
- Browser contexts are per run. Cookies, storage, cache, live DOM, and browser profiles are not persisted into sessions.
- Logs and metrics contain IDs, states, hashes, durations, bounded error codes, token counts, and costs—not conversation or hidden reasoning content.

## Maintenance

Run the normal application image with:

```sh
bun server/scripts/agent-maintenance.ts
```

Set `AGENT_MAINTENANCE_DATABASE_URL`. Optional positive bounds are `AGENT_MAINTENANCE_BATCH_SIZE`, `AGENT_MAINTENANCE_SAVED_SESSION_DAYS`, `AGENT_MAINTENANCE_MCP_CONTENT_DAYS`, `AGENT_MAINTENANCE_AUDIT_DAYS`, `AGENT_MAINTENANCE_COMPACT_DELTA_DAYS`, and `AGENT_MAINTENANCE_MAX_BATCHES`.


## Historical token-accounting rollout (retained, superseded)

The following coordinated writer cutover is retained as historical migration guidance; it is not the current code-only maintained-canary procedure. Use the normative cutover and rollback contract near the top of this document.
1. Disable new agent admission, drain every Agent worker and coordinator, and stop maintenance plus any other agent-state writer. Wait for active work and settlement to finish; verify no old writer can write before proceeding.
2. With writers stopped, back up PostgreSQL and apply migrations through `2.5.157`, including `tsepistle-000031-agent-total-token-accounting.ts`. Verify ordinary Wiki routes, backup, restore, the empty-goal down migration, and the compatibility rollback path on PostgreSQL 16 and 17.
3. Deploy the same current application and worker image to **all** nodes. Do not route traffic to, or permit writes from, a node that still runs the old writer.
4. Restart all application, Agent worker, coordinator, and maintenance processes only after the full fleet is on the current image. Verify the schema/writer pair and that every writer emits `usageVersion: 2` usage before enabling admission.
5. Configure approved skills and provider profiles in `/admin/agents`; keep user access false.
6. Save each provider profile and confirm its automatic connection check passes. Perform one controlled real read only after credentials and egress policy are ready.
7. Enable `agents.enabled` and one read-only provider for an explicit canary group. Keep goals, orchestration, browser, proposals, writes, and MCP false.
8. Observe queue depth, concurrency, reconnects, token/cost reservations, retention, and provider errors.
9. Enable `agents.orchestration.enabled` for the same canary. Exercise a simple non-delegated request, a multi-source completed plan, one blocked source, cancellation during child work, reconnect during child work, and expired-lease recovery.
10. Require durable task order and status after reconnect, root-only answers, exact source revisions, final citations covering every completed task and conflict, aggregate bounds across retries, and `partial` rather than success for incomplete required work. Alert on rising planner rejection, task failure/timeout, partial-run, cancellation-lag, aggregate-limit, citation-gate, and recovery counts.
11. Enable `agents.goals.enabled` for the same canary. Exercise explicit creation, one automatic continuation, completion, pause/resume, approval blocking, user cancellation, profile drift, each aggregate limit, reconnect, and coordinator restart. Require one open goal per session, exact continuation order, hidden host prompts, frozen skill versions, host completion assessments, owner-matched reconciled terminal ledgers, conservative attempted-provider charges without double-counting measured usage, persisted `agentGoals.consumedTokens` matching the aggregate authority, and terminal `budget_limited` or `blocked` (including `GOAL_ACCOUNTING_UNAVAILABLE`) rather than silent overrun.
12. Enable browser only after the separate worker and no-bypass network proof.
13. Enable proposals, then create and patch separately. Enable move, restore, and delete only after action-specific review.
14. Enable MCP first behind private exact-path ingress for a dedicated `use:mcp` API-key group.

### Search and knowledge deployment evidence

The unified `operations.search` cutover and utility boundary were committed as `85a2adfde9e66c0b768811b0163499d4281fbc58` and deployed to the maintained `wiki-tailnet` canary on 2026-09-08. Image `tsepistle:85a2adfd` (`sha256:f99a6eccd7ef2988cd06038fe6c1a941a57c418a1e0d3dc7eaa0ac9a8c37f9de`) started healthy, reported the exact source revision, and applied `tsepistle-000027-knowledge-search.js`. PostgreSQL 17.11 exposes `searchDictionary`, the `tsvector` `searchTokens` column, and the GIN index `page_knowledge_projection_search_tokens_gin`. Local and tailnet `/healthz` returned `{"ok":true}`, and the native tailnet UI returned a real `Pasta Recipes` search result with title, tags, page-path match fields, language, preview, and suggestion controls. The pre-migration custom-format backup `/home/bbferko/.local/state/wiki-tailnet/backups/before-search-foundation-85a2adfd-20260908T022058Z.dump` is 2,910,329 bytes, mode `0600`, SHA-256 `bd0993b3869d3c8efd103c23d8035ce21fcefe82c21773e2f61368837cd610d3`, and has 656 validated archive entries; `compose.before-85a2adfd.yml` retains the previous `tsepistle:4d146593` rollback configuration. This maintained canary deployment is not an independent review or official release attestation. The foundation record retains focused implementation proof, four explicitly enabled real PostgreSQL suites with all 21 cases / 61 assertions passing (`knowledge-search` 4/10, `utility-admission` 3/5, `search-foundation` 12/37, and `search-graph-rank` 2/9), server types, a passed isolated PostgreSQL 17.10 / pg_trgm 1.6 20,000-page benchmark report (30 iterations, 5 warmups, rebuild 25,772.876510 ms, p95 query latencies within thresholds, zero violations), migrated MCP-focused tests (7/7), native reader/admin light/dark accessibility (zero WCAG 2 A/AA and 2.1 AA violations), real utility behavior, cleanup proof, and explicit semantic-recall and deployment-topology limits.

Graph confidentiality/freshness has native proof in [`search-graph-boundary-2026-09-07.json`](benchmarks/search-graph-boundary-2026-09-07.json). Native probing identified and resolved two findings: public Seed 71 → protected Bridge 70 → public Tail 69 traversal leaking protected knowledge/score was closed with protected-endpoint and current body-read fencing (score dropped 7.4925 → 6.75 while public direct 71 → 69 restored distance-one signal), and a held running links receipt on page 70 revision 2 returned `links[]` and only public incoming 71—not stale 69—until lease release produced a real succeeded receipt and deleted old 70 edges. The cited graph artifact substantiates broad legacy render and link recovery (`legacyRenderAndLinksRecovered: true`), while the specific synthetic page 69 render/links recreation at exact revision 1 with succeeded status was an interactive session observation not retained as populated receipt rows in `recovery.receipts`. Graph admission uses pre-cap authorized revision pins, current succeeded link receipts, and raw edge revision/route checks against the authorization snapshot. No new migration beyond 27 or model work is involved.

Before enabling a production utility canary, operators must independently verify their deployment's provider egress and worker topology. The provider must be approved for the published shared corpus, including pages restricted by requester/page-rule ACL, because utility preflight does not apply that retrieval authority. A private, protected, unpublished, scheduled, expired, or invalid-window source found ineligible at preflight must make no provider request; a post-dispatch source/hash/publication change must discard the output and finalize safely, not promise retraction of transmitted bytes. Verify no-tools/strict-schema/gap-only/no-authority-write behavior, capability clamps, global knowledge-lease admission, provenance, deterministic fallback, and the potential once-per-eligible-current-page `searchTerms` backfill cost. There is no total backfill-cost quota, so review corpus size and provider budget. Disable the provider capability if that boundary fails; preserve authoritative pages/history/OKF and deterministic projections, and investigate hashes/state rather than replaying source content or manually repairing derived output.

The historical search-foundation note's process-local Search pagination constraint remains current and is distinct from the separately persisted provider-native continuation above. Search pagination retains only bounded owner/query-bound identity snapshots in a process-local in-memory store: at most 128 snapshots, each expiring after five minutes. A restart or routing a continuation request to another replica loses that snapshot and yields an expired-search response, so deployments need deliberate worker-affinity handling across replicas. Each continuation reruns current permission-aware retrieval and retains no page contents or excerpts; neither this mechanism nor provider continuation bypasses owner/query binding, expiry, or current-access reauthorization.
Disable the smallest failing capability. Disabling goals stops new goal creation, pause/resume/cancel API mutations, and automatic continuation while preserving the goal/run ledger. Disabling orchestration stops new plans and marks incomplete persisted tasks cancelled while preserving their task/event ledger; affected root runs finish `partial`. Existing session history remains reconstructable from PostgreSQL.

### Security review and release attestation gate

Official beta and production release publications are gated by the executable security check (`bun server/scripts/check-threat-model.ts --release`). Release qualification is strictly separated from working-tree development and is owned by the repository maintainer or a delegated agent.

1. **Manifest-driven maintainer review:**
   Releases are governed by `docs/security/review-attestations.json`, which references structured records in `docs/security/review-attestations/<id>.json`. The manifest and every registered record use `schemaVersion: 2`; `policyVersion: 1` and the normative threat-model `modelVersion: 1` remain unchanged. A maintainer-owned `source-review` record records the responsible identity, reviewed source boundary, current model digest, contained evidence, and structured findings. The former schemaVersion 1 external-review, detached-signature, and trusted-key process is superseded historical policy and is not a release prerequisite.
2. **Releasable source reviews vs. staged working-tree evidence:**
   - A releasable attestation is a committed `kind: "source-review"` record with `repository: "PhilosophiMoonbeam/tsEpistle"`, `releaseEligible: true`, zero active blocking findings, a current `threatModelDigest`, real contained evidence, an exact canonical `coveredTreeDigest` match against the reviewed source and `HEAD`, and valid source/base ancestry.
   - Working-tree audits (such as `search-foundation-2026-09-07.json` for content fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a`) are staged evidence only (`releaseEligible: false`, `fingerprintAlgorithm: "tsepistle-isolated-preview-v1"`). Working-tree fingerprints never qualify as release attestations, cannot be active, and cannot bypass release gating.
   - Historical records are migrated for representation only, remain release-ineligible, and retain their original scope, findings, and evidence. They are explicitly superseded and do not authorize or block a new active release. The `publish-canary` job publishes a non-production, pre-release validation image from `main`; it is gated by the ordinary manifest/digest check in `ci:static` plus architecture-specific image tests, not by `--release`. Operators must not promote or treat a canary image as a beta or production release; those publication jobs remain subject to the strict release gate.
3. **Exact non-circular release procedure:**
   - **Freeze and commit source:** Commit all changes within the canonical security boundary (the entire `dev/` prefix, `server/`, `client/`, `shared/`, `deploy/`, `patches/`, `.github/workflows/`, `.github/actions/`, root release/config manifests, `tsconfig*.json`, and root packaging, repository attribute, and legal compliance files `.dockerignore`, `.gitattributes`, `LICENSE`, `NOTICE`; these root files are essential to the boundary because `.dockerignore` controls the container build context boundary, `.gitattributes` governs release archive export filtering and line endings for release bundles, and `LICENSE`/`NOTICE` establish mandatory distribution licensing terms). Call this reviewed source commit **S**.
   - **Calculate digests:** Compute canonical boundary and threat-model digests with `bun server/scripts/check-threat-model.ts --digest <source-revision>`.
   - **Perform maintainer review:** Write a schema-2 `source-review` record for **S** with maintainer or agent attribution, real contained evidence, and resolved or justified accepted findings. Set `releaseEligible: true` only when the review is complete and no active finding is blocking.
   - **Update manifest:** Set `activeReviewId` in `docs/security/review-attestations.json` to the new record and include it in `records`.
   - **Commit attestation docs:** Commit the record and manifest as documentation-only successor **A**. Because documentation (`docs/`) is excluded from the canonical security boundary, this commit does not alter the `coveredTreeDigest`; the checker proves **S** is an ancestor and that the reviewed boundary equals the current `HEAD` boundary. Do not require literal `source.revision === HEAD` equality.
   - **Execute release gate:** Run `bun server/scripts/check-threat-model.ts --release` on the clean checkout. The release gate rejects dirty tracked, untracked, ignored, index, or submodule boundary state (with only the canonical `server/.build-metadata.json` exception), requires current source/model/evidence and exact boundary equality, and requires zero active blocking findings. No external key, signature, or second-party authorization is read or required.
## Incident runbook

- **Provider exfiltration or outage:** disable `agents.provider.enabled`, revoke provider secrets, retain the audit ledger, and inspect profile/version, skill-use, action, and destination metadata.
- **Browser escape:** disable `agents.browser.enabled`, revoke worker certificates/signing keys, isolate the worker network, and retain gateway logs and artifact hashes.
- **MCP key compromise:** revoke the API key, rotate request-state keys, preserve the compromised key only as offline evidence, and review proposals by requester API-key ID.
- **Unsafe writes:** disable `writes.enabled`, preserve proposals/approvals/executions/outbox rows, reconcile the page projection, and restore only through normal page revision operations.
- **Specialist orchestration fault:** disable `agents.orchestration.enabled`; preserve `agentRunTasks` and agent events, inspect root/child usage and public failure codes, and verify incomplete roots terminate `partial`. Do not replay an individual child outside its root lease.
- **Durable goal fault:** disable `agents.goals.enabled`; preserve `agentGoals`, linked runs, completion-assessment hashes, and lifecycle events. Inspect aggregate usage and the last terminal run. Do not manually insert or replay a continuation.
- **Lease or queue growth:** stop new admission, drain healthy workers, inspect expired leases and `recovery_required`, then run bounded maintenance. Never manually replay a run after an ambiguous side effect.
- **SSE pressure:** reduce per-user connection bounds or disable agent admission; reconnect uses durable `Last-Event-ID`.
- **Rollback:** disable flags, drain, back up, choose the empty-ledger or compatibility path above, and verify retention before restoring traffic.
