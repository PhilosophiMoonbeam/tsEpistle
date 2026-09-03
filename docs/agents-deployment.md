# Agent deployment and operations
This guidance describes release candidate `1d1e25a7c131880fc963084fa993b73a19d579bc`; keep deployment and threat-model conclusions bound to that exact source revision.


Wiki agents use the ordinary Wiki origin plus one isolated browser-service boundary:

| Surface | Example | Purpose | Exposure |
| --- | --- | --- | --- |
| Wiki | `https://wiki.example.com` | Existing UI, inline Search/Ask, `/admin/agents`, internal agent REST/SSE, approvals | Existing authenticated users |
| MCP | `https://wiki.example.com/mcp` | Streamable HTTP MCP | Resource-bound API keys only |
| Browser worker | private mTLS endpoint | Playwright execution in a separate unprivileged process/container | Wiki application replicas only |

There is no agent-specific public origin, login, cookie, launch token, popup, iframe, or sidecar application. The internal agent controller handles only `/_api/agents`. When MCP is enabled, the exact `/mcp` endpoint on the Wiki origin is reserved for MCP; its API-key authentication remains independent from Wiki browser sessions.

## Database and compatibility

Agents require PostgreSQL for multi-replica leases and notification. Apply migrations through `2.5.157` before enabling any flag:

- `2.5.139` adds the source-revision ledger and agent tables.
- `2.5.140` removes the obsolete cross-origin launch-handoff table. Its down migration recreates only the empty compatibility shape.
- `2.5.156` adds the durable depth-one research task ledger, child-attempt identity, authority/result hashes, lifecycle state, and evidence counts.
- `2.5.157` adds the opt-in durable goal ledger, run continuations, host completion assessments, and hidden continuation-message marker.

All agent flags, including specialist orchestration and durable goals, default to false. Back up PostgreSQL before upgrade or rollback.

Two rollback paths are supported:

1. With no authoritative agent or goal data to retain: disable all agent flags, drain coordinators and maintenance, apply `2.5.157` down, apply `2.5.156` down, apply `2.5.140` down, then apply the guarded `2.5.139` down and start the prior image. The `2.5.157` down migration refuses to discard any goal.
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

## Configuration

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

`maxContinuations`, `maxTokens`, `maxToolCalls`, and `maxDurationMilliseconds` are aggregate per-goal limits. Exhaustion moves the goal to `budget_limited`; model output cannot extend them. Approval waits move the goal to `blocked` without consuming a continuation. Pausing cancels active compute and preserves the ledger; resuming admits a fresh continuation only after the prior run is terminal. Disabling `agents.goals.enabled` stops new goal admission and mutation without altering ordinary one-shot runs or deleting state.

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

Gemini profiles use only the Google AI Interactions API, the `v1beta` API root, and a Gemini 3.x model ID such as `gemini-3.7-flash`. Wiki sends the API key in `x-goog-api-key`, permits only the exact `/interactions` path, sets `store: false`, and resends the complete client-managed step history on every turn. Model steps are retained as one encrypted, size-bounded continuation item so thought signatures, function-call IDs, ordering, and outputs can be replayed exactly; private thought text is not requested or exposed. The transport supports Wiki's system instructions, text, SSE streaming, native and parallel functions, action results and errors, JSON Schema output, usage accounting, and request cancellation. It never calls `generateContent`. The currently documented Interactions gaps—video metadata, Batch API, Python automatic function calling, explicit caching, and custom safety settings—are not Wiki Agent operations and therefore do not justify a fallback.

**Prompt-emulated tools** is available for deployments whose API does not implement native tools reliably and is mandatory for legacy text Completions. Wiki sends no provider tool fields. Instead, a trusted system instruction supplies an allowlisted JSON Schema catalog and requires a whole-response `<wiki-tool-call>` envelope. Exactly one call is accepted per turn. Mixed prose, Markdown fences, malformed JSON, extra envelope fields, unknown names, oversized arguments, and unexpected native calls fail closed. Wiki creates the call ID; action lookup, input validation, authorization, risk handling, approval, and execution still occur in the same server action kernel used by native calls. Tool results are escaped, labeled untrusted, and returned in a `<wiki-tool-result>` envelope.

The prompt protocol is a compatibility path, not equivalent provider behavior: instruction-following is model-dependent, parallel calls are unavailable, and intermediate model text is buffered until a final no-action answer. Prefer native tools whenever the provider implements them correctly.

Every save runs a live conformance check for the selected mode. In addition to cancellation, bounded output, streaming, and usage accounting, the check forces a temporary echo action, verifies its exact arguments, returns a result using that protocol, and requires a final text response. When a distinct utility model is configured, the same check also requires bounded text from that model before enabling the profile. A provider profile remains disabled until the current settings pass. Capability revision 2 remains current for the other protocols. Gemini Interactions uses revision 3; its migration disables and removes default status from previously conformed Gemini profiles so an administrator must recheck them before use.

Chat Completions and text Completions are not aliases. Chat Completions accepts structured message history and may use native tools; legacy text Completions accepts one flattened prompt and can use only prompt emulation. Likewise, OpenAI Responses and OpenResponses share an item-oriented shape but represent different compatibility promises. Administrators must choose the server's documented protocol and tool mode; Wiki verifies the selected behavior instead of probing endpoints heuristically.

Editing updates the existing provider profile, temporarily disables it, and runs the same connection check. A previously enabled profile is enabled again when the check succeeds; an intentionally disabled profile remains disabled. The current encrypted credential is retained when the administrator leaves the API-key field blank; entering a value replaces the managed credential. Removing a profile immediately excludes it from administration, session selection, default resolution, and new run admission. Audit records remain, while managed provider credentials are permanently deleted. A removed display name can be reused by a new profile.

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

`pageKnowledgeProjections` is an immutable, derived index keyed by `(pageId, sourceRevision)`; it is never a human-editable page store. Every committed page mutation—human, built-in Agent, or MCP—adds a `knowledge` effect to `pageMutationOutbox`. The lifecycle worker backfills current revisions without a projection and processes those effects.

Projection is deterministic first. Exact source bytes and revision metadata produce a source hash, stable concept identity, Markdown section spans and hashes, internal and external links, source references, conservative entities and relationships, lifecycle/trust state, declared gaps, and field-level provenance. The projection never rewrites page source. Historical revisions remain addressable from immutable page history after the current page advances.

If the current public revision has declared gaps and a conformed global provider profile is enabled, the utility role receives the page plus only those gap names. Strict JSON validation and merge rules prevent utility output from replacing authoritative or deterministic values. Private pages are never sent to the provider. A missing provider or failure leaves the deterministic projection usable as `partial`; a source revision or hash change during the call discards utility output. Accepted utility provenance records input/output hashes, model, exact profile-version ID, and generation time. Staleness is computed at read time from `staleAfter`.

Normal human, API, and Agent reads expose both authority and the projection for the exact source revision when available. REST page reads include the `okf` authority/projection view; `wiki_get_page`, `wiki_get_page_version`, `wiki_list_recent_pages`, and `wiki_get_related_pages` include the corresponding authority and `knowledge`; search and discovery can search or filter projected fields. A current page without a completed projection returns a pending/null projection while the source remains readable.

Visibility remains authoritative. Projection search joins the exact current source revision, applies the same public/private ownership rules, and excludes password-protected pages from projection-only discovery. Projection trust, lifecycle, verification, and staleness are retrieval signals, never permissions or factual evidence. Agents must cite the underlying page source, stored citations, or an exact canonical OKF document when that is the evidence requested.

`wiki_get_page_okf` is the raw exact-interchange operation. Use it only when an integration needs a canonical, revision-bound OKF document or authority metadata; ordinary reads do not need it. The immutable MCP resource URI is `wiki://pages/{pageId}/versions/{version|current}/revisions/{sourceRevision}/okf`, and its identifiers must match the returned page, version, and source revision. It serializes authorized Markdown only, with `text/markdown`, canonical links, source hash, authority, and the revision-matched projection; invalid or missing authority and non-Markdown pages fail closed.

### Storage classification and Markdown egress

Storage uses the canonical page layout `{locale}/{path}.md`. Reserved page paths use `{locale}/index.concept.md` and `{locale}/log.concept.md`; valid OKF at another object path is rejected without a database mutation. Explicit storage ingress classifies each bounded document as `okf_valid`, `okf_invalid`, `legacy_wiki`, `legacy_v1`, or `plain_markdown`. A document that claims OKF but has malformed frontmatter or metadata is quarantined as invalid rather than silently downgraded to legacy. Valid OKF imports metadata, publication state, and links into the Wiki page; imported Markdown body line endings are normalized for the database, while the original source bytes and SHA-256 remain unchanged for the storage operation. Imported `verified` claims are stripped at the server-owned mutation boundary, and importer-generated provenance is stamped there.

Explicit storage egress writes deterministic OKF 0.2 Markdown for every Markdown page, including bounded frontmatter, retained valid authority extensions, Wiki database facts, and canonicalized internal links. Direct `/d/...` downloads use the same canonical Markdown egress for the current page; `?v={versionId}` selects an authorized historical version. Public downloads require `read:source` (or `read:history` for a version), private downloads require page access and unlock, and invalid stored authority is an error rather than a legacy fallback. Non-Markdown pages retain their existing serializers.

The human editor's **Knowledge / OKF** panel displays authority state, trust, source revision, projection completeness, provenance, and utility use. It permits editing bounded core metadata, sources, and non-core extension JSON through the normal page save. When authority is missing or invalid, **Reset to stable reference** sets `{ type: "Reference", status: "stable" }`; save then advances the page through the ordinary revision path.

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

Saved conversations are bounded history, not durable memory. A draft does not enter conversation history until it contains a completed user message, and replacing an unused draft deletes it instead of producing an empty history row. Maintenance permanently removes unfiled saved sessions after `savedSessionDays` without activity (90 days by default); temporary sessions continue to use `temporarySessionHours`. Active runs fence deletion until they become terminal.

The Agent workspace opens conversation history in the left side panel. Users can create up to 32 private folders and move conversations into them. A foldered conversation is exempt from both saved and temporary session expiration until it leaves the folder. Moving it back to **Recent**, or removing its folder, converts it to saved retention, clears any temporary expiry, and resets `lastActivityAt`, beginning a fresh `savedSessionDays` window. Folder removal never deletes its conversations. Conversations remain individually deletable in both Recent and folders. The user-scoped **Reset** action still cancels owned active work, tombstones every owned conversation in one transaction, and opens a clean saved draft; it retains empty folder structure and never deletes personal memory.

After each of the first two successful exchanges, Wiki asks the profile's utility model for a concise conversation title. The second pass deliberately refines the title from the broader chronological transcript instead of freezing the opening prompt as the conversation's identity. Requests contain bounded user and assistant messages, have no tools, treat the transcript as untrusted data, allow a small reasoning/output budget, and use a 15-second ceiling. Malformed output or provider failure falls back to a bounded title derived from the first user message; a later successful second pass can replace that fallback. Utility titles then stabilize, while an explicitly edited title is never overwritten. Utility tokens are added to the corresponding run's usage accounting.
For troubleshooting, every provider turn now records its bounded visible output, per-turn token usage, outcome, and requested action-call IDs; action events retain canonical inputs, results, cache reuse, and evidence-gate outcomes. Aggregate usage separates Agent-model and title-utility tokens. System administrators can download a conversation snapshot directly from `GET /_api/agents/admin/sessions/:sessionId/diagnostics.json`; the endpoint is intentionally absent from ordinary navigation, requires `manage:system`, accepts any conversation ID for support work, returns `private, no-store`, and omits encrypted provider continuation content. The export contains each user and assistant message, run/provider metadata, selected skill context, verified event timelines, derived duplicate-read and evidence-retry findings, and explicit limitations. Private model chain-of-thought is neither retained nor represented as an inferred rationale.

Within a run, identical `wiki_get_page` and `wiki_get_page_version` selectors reuse the first successful result unless a mutating action invalidates the read cache. The action timeline remains complete and labels reuse rather than hiding the model's redundant request. Successful page reads also require at least one valid final citation, and the evidence gate accepts markers placed either before or after sentence punctuation. Later turns receive a bounded prior-run activity summary, preventing the Agent from falsely claiming that no earlier actions occurred while still withholding private reasoning.


Wiki adopts the bounded, curated shape of Hermes Agent's default memory rather than treating every transcript as memory:

| Store | Purpose | Capacity |
| --- | --- | ---: |
| About you | Identity, preferences, communication style, and working habits | 1,375 characters |
| Agent notes | Stable project, environment, convention, workflow, correction, and completed-work facts | 2,200 characters |

Entries are rows in `agentMemories`, scoped by `ownerId`, exact-deduplicated by content hash, and deleted with the owning user. `wiki_manage_memory` gives the Agent add/replace/remove operations; the right-side Memory panel gives the user equivalent review, edit, remove, and clear controls without covering the conversation on desktop. Writes reject invisible control characters, role/context fences, instruction-override language, embedded credentials, ambiguous substring matches, stale versions, and over-capacity results.

Each new conversation captures one immutable JSON snapshot in `agentSessions.memorySnapshot`. Every run in that conversation receives the same snapshot, preserving a stable prompt prefix and preventing a mid-conversation memory write from silently changing prior context. Live writes are immediately durable and their tool result reports the current store, but prompt recall begins with the next conversation. The prompt labels recalled entries as user-specific data: useful preferences and facts, never authorization, tool input, or policy.

This first-class path deliberately omits automatic transcript extraction, embeddings, and unbounded conversation search. Curated memory covers the high-value always-on context with fixed token cost; Recent history remains a privacy-bounded record, while explicitly foldered conversations are durable until the user moves or deletes them. A future semantic provider would need an explicit opt-in flag, per-user index isolation, deletion propagation, provenance, retention semantics independent from chat history, prompt-injection defenses, quality evaluation, and a visible recall/write audit surface before it could replace this store.

## Maintenance

Run the normal application image with:

```sh
bun server/scripts/agent-maintenance.ts
```

Set `AGENT_MAINTENANCE_DATABASE_URL`. Optional positive bounds are `AGENT_MAINTENANCE_BATCH_SIZE`, `AGENT_MAINTENANCE_SAVED_SESSION_DAYS`, `AGENT_MAINTENANCE_MCP_CONTENT_DAYS`, `AGENT_MAINTENANCE_AUDIT_DAYS`, `AGENT_MAINTENANCE_COMPACT_DELTA_DAYS`, and `AGENT_MAINTENANCE_MAX_BATCHES`.

Schedule at least hourly with single-job concurrency. The command emits one bounded JSON summary. `maintenance: "complete"` is emitted with exit status zero only after a zero-change batch proves the current drain is empty. If every allowed batch changes rows, the command instead emits `maintenance: "exhausted"`, `truncated: true`, and `remainingRisk.rowsMayRemain: true`, then exits nonzero; it never reports that run as complete. Alert immediately on this exhausted/truncated signal and rerun with enough scheduled capacity to observe a zero-change batch. Also alert on repeated command failure, growing expiry backlog, or `recovery_required` runs. Continue maintenance while capabilities are disabled and during an N-1 compatibility rollback. Stop it only during database restore or destructive down migration.

## Security and privacy

- Internal agent REST accepts ordinary authenticated user sessions only. Mutations require exact same-origin `Origin`, `Sec-Fetch-Site: same-origin`, and the session CSRF token. API keys are rejected.
- MCP accepts resource-bound API keys only at `/mcp` on the configured Wiki origin; ordinary browser sessions are rejected.
- Wiki `extra.js` is administrator-installed privileged code. It can act as the signed-in user on the Wiki origin; do not treat it as untrusted tenant content. Provider text, skill text, and page content never execute as code and are rendered through the existing sanitizer.
- Permission and ownership checks occur when actions are offered and again at execution. Write approvals are immutable, single-use, revision-fenced records.
- Conversation reset, retention, memory reads, and memory mutations are owner-scoped. Clearing history cannot clear memory, and clearing memory cannot alter history.
- Memory enters the system prompt only through a bounded, frozen snapshot. Unsafe control text and embedded credentials are rejected before persistence; recalled content never grants permissions.
- Browser contexts are per run. Cookies, storage, cache, live DOM, and browser profiles are not persisted into sessions.
- Logs and metrics contain IDs, states, hashes, durations, bounded error codes, token counts, and costs—not conversation or hidden reasoning content.

## Rollout

1. Apply migrations through `2.5.157` with all flags false. Verify ordinary Wiki routes, backup, restore, the empty-goal down migration, and the compatibility rollback path on PostgreSQL 16 and 17.
2. Configure approved skills and provider profiles in `/admin/agents`; keep user access false.
3. Save each provider profile and confirm its automatic connection check passes. Perform one controlled real read only after credentials and egress policy are ready.
4. Enable `agents.enabled` and one read-only provider for an explicit canary group. Keep goals, orchestration, browser, proposals, writes, and MCP false.
5. Observe queue depth, concurrency, reconnects, token/cost reservations, retention, and provider errors.
6. Enable `agents.orchestration.enabled` for the same canary. Exercise a simple non-delegated request, a multi-source completed plan, one blocked source, cancellation during child work, reconnect during child work, and expired-lease recovery.
7. Require durable task order and status after reconnect, root-only answers, exact source revisions, final citations covering every completed task and conflict, aggregate bounds across retries, and `partial` rather than success for incomplete required work. Alert on rising planner rejection, task failure/timeout, partial-run, cancellation-lag, aggregate-limit, citation-gate, and recovery counts.
8. Enable `agents.goals.enabled` for the same canary. Exercise explicit creation, one automatic continuation, completion, pause/resume, approval blocking, user cancellation, profile drift, each aggregate limit, reconnect, and coordinator restart. Require one open goal per session, exact continuation order, hidden host prompts, frozen skill versions, host completion assessments, and terminal `budget_limited` or `blocked` rather than silent overrun.
9. Enable browser only after the separate worker and no-bypass network proof.
10. Enable proposals, then create and patch separately. Enable move, restore, and delete only after action-specific review.
11. Enable MCP first behind private exact-path ingress for a dedicated `use:mcp` API-key group.

Disable the smallest failing capability. Disabling goals stops new goal creation, pause/resume/cancel API mutations, and automatic continuation while preserving the goal/run ledger. Disabling orchestration stops new plans and marks incomplete persisted tasks cancelled while preserving their task/event ledger; affected root runs finish `partial`. Existing session history remains reconstructable from PostgreSQL.

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
