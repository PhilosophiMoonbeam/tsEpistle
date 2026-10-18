# Ax System Architecture Before Implementation

Use this guide to choose an architecture, justify rejected alternatives and produce an implementation reading plan before writing code. For a narrow API change, use the owning reference directly.

This is **authored synthesis** grounded in the collection's official `@ax-llm/ax` **25.4.3** snapshots, not an additional upstream API contract. “Recommend” identifies application design guidance; statements about Ax behavior have specialist destinations below. Check the installed version and declarations before implementation. These TypeScript contracts do not establish universal generated-language parity.

## 1. Define the Design Deliverable

Produce a compact design with the following fields. Mark unresolved facts and the evidence needed to resolve them; do not replace them with assumed library guarantees.

| Deliverable | Required decision |
| --- | --- |
| Goals and non-goals | User outcome, workload, quality criteria, latency/cost limits, allowed effects, deployment/runtime and intentionally excluded behavior. |
| Execution topology | Each generator, flow, agent, tool and child boundary; who chooses the next step; why a simpler topology is insufficient. |
| Data and provider contracts | Signature inputs/outputs, invariants, media/evidence semantics, chosen providers/models and acceptable fallback substitutes. |
| Context and state ownership | Corpus orientation, run history, retrieval, runtime skills, continuation state and durable business records; tenant scope, persistence and freshness owners. |
| Trust and lifecycle | Authenticated identity, tool authorization/approval, clarification, wake/resume correlation, cancellation, retry safety, uncertain outcomes and output delivery. |
| Operations and improvement | Usage attribution, observability/privacy, pricing, evaluation criteria, improvement mechanism and spending bounds. |
| Implementation and verification plan | Ordered specialist sections to read, interfaces to implement, staged checks and authorization required for billed/live/state-changing work. |

For each material choice, state **requirement → selected mechanism → rejected alternative → consequence → specialist section**. A list of Ax APIs without these reasons is not a design.

## 2. Follow the Decision Procedure

1. Specify the outcome and hard boundaries first. Is the task extraction, a typed decision, synthesis, a fixed workflow, tool-directed investigation or externally triggered work? Separate hard invariants from quality preferences.
2. Choose the smallest execution topology in the next table. Add an agent only when model-directed work warrants it; add a flow only when application-defined composition warrants it.
3. Define signatures and provider capabilities together. Do not select a model alias before checking every required input, output, tool and evidence contract.
4. Classify each context/state item by lifetime and authority. Select the context mechanism, durable store and conversation/tenant isolation separately.
5. Trace one normal run and its clarification, cancellation, restart and uncertain-side-effect paths. Assign every transition and external effect to an owner.
6. Choose observability, evaluation and improvement after correctness and authority are explicit. Count internal calls and replayed effects, not just top-level requests.
7. Write the reading plan and staged verification plan. Load only the specialist sections needed by the selected design or an unresolved boundary.

## 3. Choose Execution Topology

| Need | Choose | Reject or qualify | Implementation destination |
| --- | --- | --- | --- |
| One typed extraction, decision or generation contract | `ax(...)` / `AxGen` | No agent, RLM or DAG merely to wrap a single contract. A generator can still take several model/tool steps; it is not a one-call guarantee. | [Generators: Construction and execution defaults](references/gen.md#construction-and-execution-defaults); [Signatures: String syntax and field types](references/signature.md#string-syntax-and-field-types) |
| Known dependencies, parallel independent work, application-defined branches or map/reduce | `flow(...)` / `AxFlow` with typed nodes and explicit input/output mappings | A DAG does not provide an external event inbox or durable application transactions. Guard feedback loops; do not assume untaken branch results exist. | [Flows: Builder rules and boundaries](references/flow.md#builder-rules-and-boundaries) and State Evolution |
| Model-directed tool selection, evidence gathering, clarification and synthesis | `agent(...)` / `AxAgent` with scoped functions/native clients | Do not use a decision-only provider as the general actor. Do not treat model-selected actions as authorization. | [Core agents: Choose the Agent Shape](references/agent.md#choose-the-agent-shape) and Defaults and Execution Constraints |
| Large context requiring code inspection, computed intermediate values or multi-turn code execution | Agent runtime/RLM, `AxJSRuntime`, declared `contextFields` | RLM is an agent execution strategy, not a separate durable workflow engine. Ordinary agent setup remains in the core guide. | [RLM: Mental Model](references/agent-rlm.md#mental-model) and RLM Actor Code Rules |
| Distinct specialists with their own signatures, tools/runtime or instructions | Explicit children in `functions`, with `agentIdentity` and meaningful namespaces | `llmQuery(...)` is a focused semantic query over narrowed context, not a tool-using child agent. Thread parent fields explicitly. | [Core agents: Child Agents, Identity, and Namespaces](references/agent.md#child-agents-identity-and-namespaces); [RLM: Use These Defaults](references/agent-rlm.md#use-these-defaults) |
| Notifications, webhooks, queues, timers or completion events must wake/resume programs | `AxEventRuntime` around the selected generator/agent/flow | Sources and protocol callbacks enqueue or observe; they do not invoke models directly. An explicit route chooses observe/invalidate/wake/resume. | [Event runtime: Rules](references/event-runtime.md#rules); [MCP: Subscriptions, events, and ownership](references/mcp.md#subscriptions-events-and-ownership) |

AxAgent runs distiller → executor → responder, but `directResponse: 'auto'` can skip the executor for context-only answers. Static agents without executor authority are respond-only. When tools or native operations exist, direct response is constrained against live-state requests, side effects and listed tool domains. Recommend evaluating tool-required versus direct-answer cases rather than using executor skipping as an application safety boundary. See [RLM: Direct respond](references/agent-rlm.md#direct-respond-executor-skip).

## 4. Define Data and Provider Contracts Together

**Signature first.** Declare named inputs/outputs, optionality, arrays, constraints and descriptions with signature strings, `s()` or `f()`. Use schemas for shape, `addAssert()` for complete-output invariants and `addStreamingAssert()` for partial-output invariants. Reward scores are selection preferences, not hard validation. `fn()` gives host tools typed arguments/returns; handler authorization remains separate. Read [Signatures](references/signature.md), [Generators: Validation, selection, and hard guards](references/gen.md#validation-selection-and-hard-guards) and [Core agents: Tool Functions and Schemas](references/agent.md#tool-functions-and-schemas).

**Decision versus generation.** Jev supports required flat boolean/class/rubric score/Box outputs, not arbitrary numeric, optional/array/nested/freeform outputs or general tools. Native Noul/Choice/Score questions support advanced decision criteria. Compose a decision step with a generative provider for prose or a tool-using actor; pass typed decisions and evidence explicitly. Evidence provenance distinguishes native from elicited output, not guaranteed correctness or equal calibration across models. Validate thresholds/ranking on application data. Read [Typesafe: Evidence, provenance, and reranking](references/typesafe.md#evidence-provenance-and-reranking), Boolean/class signatures and adapter restrictions, and Native questions and application decisions.

| Provider choice | Design obligation | Specialist destination |
| --- | --- | --- |
| Provider/model/catalog | Check operation availability, structured output, tools, media input **and output**, thinking, runtime and deployment restrictions. Bundled catalogs/pricing are snapshots, not live guarantees. | [AI providers: Model Catalog](references/ai.md#model-catalog) and provider-specific sections |
| Caller-selected logical model | `AxMultiServiceRouter` dispatches the selected key; it does not decide which model a task needs. | [AI providers: Routing And Balancing](references/ai.md#routing-and-balancing) |
| Request-capability selection | `AxProviderRouter` selects by capability; configured processors may degrade unsupported media. Decide whether degraded input still satisfies the task. | [AI providers: Routing And Balancing](references/ai.md#routing-and-balancing) |
| Equivalent operational substitutes | `AxBalancer` provides ordered failover or adaptive reliability/latency/estimated-cost selection. Every model behind an alias must be acceptable for this workload. Quality evaluation/content-aware selection is application-owned, not semantic balancing. | [AI providers: Routing And Balancing](references/ai.md#routing-and-balancing) |
| Streaming fallback | Failover can occur before the first emitted chunk; partial output cannot be transparently replayed after emission. Define UI failure/reset behavior. | [AI providers: Routing And Balancing](references/ai.md#routing-and-balancing); [Generators: Streaming output and replacement versions](references/gen.md#streaming-output-and-replacement-versions) |

**Streaming is a presentation protocol, not a commit signal.** Merge deltas per `index`, append strings/arrays, replace other values and reset accumulated output on a new `version`. Validation/refusal retries or processor feedback may replace prior output. Partial JSON repair preserves string contents; do not “fix” partial strings into new literals. A valid-looking partial result can still end in failure. Recommend publishing business effects only through an authorized application action, never from a UI delta. See [Generators: Streaming output and replacement versions](references/gen.md#streaming-output-and-replacement-versions).

## 5. Separate Context Mechanisms and State Lifetimes

| Information / lifetime | Mechanism and boundary | Specialist destination |
| --- | --- | --- |
| Reusable orientation over a recurring repository/corpus | `contextMap` is prompt-resident corpus knowledge, not a task-answer cache. It updates after successful completed runs, not failures/aborts/clarification; persist snapshots through application storage. | [Memory and skills: Context Map](references/agent-memory-skills.md#context-map) |
| Replay pressure during one investigation | `contextPolicy` controls action replay/compaction; successful runtime values still exist when old actions become summaries. It does not carry knowledge across runs. | [RLM: Context Policy Presets](references/agent-rlm.md#context-policy-presets) |
| Task-relevant facts or prior conversation | Memories via `recall()`/preloaded `inputs.memories`; loaded facts accumulate for one `forward()` then reset. Durable retrieval backend and tenant filtering are application-owned. | [Memory and skills: Memory Search](references/agent-memory-skills.md#memory-search) and Carrying Memories Across `.forward()` Calls |
| On-demand operational/runbook instructions | Runtime skills via catalogs/search and `discover({ skills })`; loaded guides remain on the agent across runs. Scope the agent and retrieved content accordingly. These are not this coding skill collection. | [Memory and skills: Skills Search](references/agent-memory-skills.md#skills-search) |
| Reusable learned task strategy | Stage-bound playbook, explicitly saved/loaded; not corpus orientation or factual recall. | [Playbooks: Program-bound lifecycle](references/playbook.md#program-bound-lifecycle) and Agent-owned playbooks |
| Live computed variables and imports | Runtime session; continue from successful state until a restart notice. Logs, `liveRuntimeState` and checkpoints change visibility, not persistence guarantees. | [RLM: Mental Model](references/agent-rlm.md#mental-model) |
| Paused conversation execution | `getState()`/`setState()` continuation snapshots; only serializable/structured-clone-friendly values are guaranteed to round-trip. Reserved globals are rebuilt. | [Core agents: Clarification and Resume State](references/agent.md#clarification-and-resume-state) |
| Orders, approvals, tenant records, idempotency keys, durable delivery and accounting | Application database/store and authenticated services, not runtime variables, prompt memory or an agent snapshot. Select retention, recovery, access control and concurrency policy explicitly. | [Event runtime: Rules](references/event-runtime.md#rules); [Agent observability: Centralized usage observer](references/agent-observability.md#centralized-usage-observer) |

Use catalogs for plain arrays and retrieval callbacks for external BM25/vector/KV stores. Batch recall/discovery searches of each kind per turn; these calls return `void`, with loaded content visible next turn. Respect stage availability and the callback-versus-catalog distiller caveat. Children need explicit search callbacks; they do not inherit them. Loaded IDs show retrieval, while used IDs show declared reliance, neither independent proof of factual grounding. Read [Memory and skills: Retrieval Defaults and Stage Ownership](references/agent-memory-skills.md#retrieval-defaults-and-stage-ownership). For mechanism selection alone, use [Agent context chooser](references/agent-context.md).

Recommend separate mutable agent instances per conversation/tenant-owned instance, explicit corpus/version keys and storage policies for persisted maps, skills and playbooks. Never share a resumed mutable agent across unrelated concurrent conversations.

## 6. Own Clarification, Resume and Reliability

Public `forward()`/`streamingForward()` throw `AxAgentClarificationError` on `askClarification(...)`; clarification bypasses the responder. Capture the error's state, present its normalized question, persist the continuation if required, restore with `setState(...)`, then forward the answer. Successful `final(...)` still passes through the responder. Host-handler `extra.protocol` APIs are not actor globals. Read [Core agents: Host-Side Completion and Unified Final Signal](references/agent.md#host-side-completion-and-unified-final-signal) and Clarification and Resume State.

Recommend treating user clarification, authenticated approval and execution authority as separate application concepts. A question or model response is not proof that a purchase/message/write has been authorized. Record approval against the exact intended action and identity before dispatching an effectful tool.

| Lifecycle concern | Ax boundary and application responsibility |
| --- | --- |
| Wake versus resume | Explicit routes map events to signature inputs; a resume requires an owned continuation correlation key. Do not manufacture a user message from an event payload. |
| Restart | Choose a persistent store and reconstruct conversation-scoped programs. Snapshots do not make arbitrary runtime objects durable; use `createProgram(instance)` for stateful multi-tenant agents. |
| Duplicate delivery / retries | Declare `retrySafety: 'idempotent'` only when stable delivery keys protect **every** possible side effect. Define deduplication, retry bounds and reconciliation for uncertain effects; do not blindly repeat a purchase. |
| Output delivery | Persist results before final sink delivery; redrive sink failures separately rather than rerunning the business action. |
| Store/deployment | In-memory storage is volatile/single-process. Local-disk Node multi-worker coordination uses the documented SQLite store and explicit retention; never put it on a network filesystem. Generated single-worker support does not establish persistent multi-worker support. |
| Cancellation / uncertainty | Distinguish cancellation, failure, pending external tasks and `outcome_unknown`. Reconcile uncertain external outcomes through application policy rather than asserting success or automatic rollback. |

These are not exactly-once processing or durable cross-system transaction guarantees. Choose timeout, backoff, replay, retention, approval and escalation policies in the application. Implementation: [Event runtime: Rules](references/event-runtime.md#rules), Continuation Pattern and Testing; [Core agents: Event-Driven Agents](references/agent.md#event-driven-agents); [MCP: Tasks, progress, and cancellation](references/mcp.md#tasks-progress-and-cancellation).

## 7. Establish MCP Trust and Tool Authority

Attach native clients through `mcp`, not `functions` or a lossy function-conversion adapter. Assign stable namespaces; inspect server-owned catalogs rather than guessing tool names, URIs or templates. Keep client/session ownership, structured/multimodal content, authorization, cancellation, tasks and notifications intact. Read [MCP: Integration and safety rules](references/mcp.md#integration-and-safety-rules) and Catalogs and raw operations.

- Treat remote prompts, resources, results and notifications as untrusted data, not instructions granting new authority.
- Authenticate tenant/account identity in the application adapter. A protocol session or event payload does not establish tenant identity.
- Apply `authorizeToolCall` before side effects. Recommend a host approval gate where required, with scope/action checks independent of model output.
- Choose child client inheritance explicitly; the parent's stage authority and a child's inherited clients are different boundaries. See [Core agents: Native MCP/UCP Attachment and Inheritance](references/agent.md#native-mcpucp-attachment-and-inheritance).
- Subscribe explicitly: omitted resource policy selects none; URI templates never expand automatically. Callbacks enqueue/observe; authenticated routes choose wake/resume. Close source/runtime before caller-owned clients. See [MCP: Subscriptions, events, and ownership](references/mcp.md#subscriptions-events-and-ownership).
- Sampling, elicitation, roots, OAuth and MCP Apps require their own host/security policies; do not grant arbitrary server requests or render ordinary tool HTML as an App. See [MCP: Multi round-trip requests and host capabilities](references/mcp.md#multi-round-trip-requests-and-host-capabilities), Authentication and OAuth, and Apps, replay, evaluation, and testing.

## 8. Assign Observability, Usage and Cost Ownership

Use runtime callbacks for turn/function/context/status visibility; do not scrape replay logs to reconstruct structured events. Parent function callbacks observe child invocation, not every child internal actor turn; configure child callbacks where needed. Treat raw actor code/results/chat logs as sensitive. Metadata-only runtime-hook spans do not authorize logging payloads. Read [Agent observability](references/agent-observability.md).

For shared application accounting, use process-global `axGlobals.onUsage` with stable service-level attribution and per-run tenant/user/request/run context. `getUsage()` is instance-local, not centralized truth across shared agents or processes. The observer is best-effort/fail-open and not awaited: enqueue synchronously, persist and aggregate out of band in a durable shared pipeline. Fully consumed streams report once when provider usage exists; cancelled/unconsumed streams may not report. Token events are not currency cost: apply versioned pricing downstream and define reconciliation for missing events. Keep opaque IDs and low-cardinality attributes; exclude secrets and payloads. Read [Agent observability: Centralized usage observer](references/agent-observability.md#centralized-usage-observer) and [AI providers](references/ai.md) for direct-call usage.

Recommend budgets that include distiller/executor/responder turns, semantic queries, context-map updates, checkpoint summaries, speech, retries, candidate selection, judges and teachers. Balancer-local metrics and routing decision state are not an accounting ledger. Choose an enforcement owner separately from fail-open telemetry; limiter failures propagate, while observer/tracer/meter failures do not.

## 9. Choose Evaluation and Improvement Deliberately

| Need | Mechanism | Acceptance / rejection criterion | Destination |
| --- | --- | --- | --- |
| Establish quality before tuning | Representative tasks, deterministic metrics for exact contracts/actions, qualitative judge for open-ended behavior | Include direct-answer, tool-required, clarification, failure and delegation/no-delegation cases. A polished reply cannot compensate for a forbidden action. | [Agent optimization: Metric versus judge](references/agent-optimize.md#metric-versus-judge); [GEPA: Metrics and judge boundaries](references/gepa.md#metrics-and-judge-boundaries) |
| Offline instruction/demo tuning | `optimize(...)`/GEPA for generators/flows/trees; `agent.optimize(...)` for agent targets | Separate training and held-out validation; bound metric calls; save/load/apply the full optimized artifact and compare on holdout. | [GEPA: Execution and selection contract](references/gepa.md#execution-and-selection-contract); [Agent optimization: Defaults and target selection](references/agent-optimize.md#defaults-and-target-selection) |
| Reusable task knowledge from failures/feedback | `playbook().evolve(...)` offline, `update(...)` online | Persist/load knowledge explicitly. Verified agent evolution gates bullets against held-in improvement and held-out regression; online update is trusted feedback, not equivalent verification. | [Playbooks: Agent-owned playbooks](references/playbook.md#agent-owned-playbooks) and Program-bound lifecycle |
| Better complete candidate for this call | `bestOfN()` for independent scoring; `refine()` for feedback-informed attempts | Reward is not a hard invariant or durable learning. Serial attempts isolate sessions, not external side effects. Do not use refinement for streaming. | [Refine: Validation and Assertions](references/refine.md#validation-and-assertions), Strategies and Streaming Safety |

Recommend isolated eval-safe tools or recording/replay for repeated runs, never production messaging/writes by default. Authorize billed/live work explicitly, cap evaluation calls/trials/attempts and opt in explicitly to expensive teachers where required. See [Agent optimization: Make tasks and agents optimizable](references/agent-optimize.md#make-tasks-and-agents-optimizable), [GEPA: Options and teacher permissions](references/gepa.md#options-and-teacher-permissions) and [MCP: Apps, replay, evaluation, and testing](references/mcp.md#apps-replay-evaluation-and-testing).

## 10. Preserve Audio, Multimodal and Portability Boundaries

| Requirement | Choose / qualify | Destination |
| --- | --- | --- |
| Batch speech-to-text or text-to-speech | `transcribe()` / `speak()`; verify actual endpoint capability. Input support does not imply output support. | [Audio: Direct Batch APIs](references/audio.md#direct-batch-apis); [AI providers](references/ai.md) |
| Structured response with scripted speech artifact | Signature `:audio` output plus forward-time `speech`; model output is text, synthesized after parsing. Agent audio inputs are transcribed before stages. | [Audio: Audio values and execution boundaries](references/audio.md#audio-values-and-execution-boundaries) |
| Conversational/realtime voice | `.chat()` with `modelConfig.audio`, provider formats/turn lifecycle and explicitly selected streaming behavior | [Audio: Conversational `.chat()` Audio](references/audio.md#conversational-chat-audio) and provider/live sections |
| Image/file/media contracts | Top-level restrictions, provider capability and supported metadata; no general assumption that native decisions, generative vision and media degradation are equivalent. | [Signatures: Media boundaries and forwarded metadata](references/signature.md#media-boundaries-and-forwarded-metadata); [AI providers: Routing And Balancing](references/ai.md#routing-and-balancing) |
| Jev localization | Experimental PNG/JPEG and required single Box with Jev 1.14/model/header/dimension/size constraints. Ax supplies the experimental header, not image resizing. Pair Box with presence boolean; consume it only when present. | [Typesafe: Image inputs and Box outputs](references/typesafe.md#image-inputs-and-box-outputs); [Signatures: Bounding boxes](references/signature.md#bounding-boxes) |

Do not combine conversational audio output with native structured response formats unless that provider explicitly supports it. Generative Box evidence is elicited, with no fabricated native confidence; OpenAI Decisions supports image decisions but rejects Box outputs.

**Preserve two official-source discrepancies in 25.4.3:**

- The provider summary still excludes Jev media broadly; the dedicated Typesafe contract specifically supports experimental PNG/JPEG/Box while excluding audio/files/tools. Use that narrow TypeScript image exception, not universal media support or a blanket image ban.
- The Typesafe source claims Image/Box across TypeScript, Python, Java, C++, Go and Rust with examples; the signature source says generated-language Box remains in the AxIR backlog. This collection establishes the TypeScript contract, not either universal port availability or universal absence. Before a port, inspect the exact generated package/version, declarations and runnable examples. The disagreement remains explicit in [Typesafe](references/typesafe.md#image-inputs-and-box-outputs) and [Signatures](references/signature.md#bounding-boxes).

## 11. Compose Small Patterns and Stage Verification

These are recommended application compositions, not new Ax guarantees.

| Pattern | Composition and reason | Reject when / reading plan |
| --- | --- | --- |
| Typed invoice service | Signature + `AxGen` + hard validation; ordinary application persistence after acceptance | Reject an agent/RLM/flow with no tool or orchestration need. Read Signatures → Generators → Providers. |
| Evidence-aware ticket handling | Jev decision contract → explicit typed handoff → generative explanation or authorized tool-using agent | Reject a Jev actor or uncalibrated confidence-as-correctness rule. Read Typesafe → Generators or Core agents → Providers. |
| Repository investigator | Agent/RLM + corpus `contextMap` + within-run `contextPolicy` + tenant-filtered recall; children only for separate specialist responsibilities | Reject full-corpus prompt replay, implicit child inputs or `llmQuery` as a tool specialist. Read Context chooser → Memory and skills → RLM → selected Core agent sections. |
| Webhook/MCP review with external completion | Authenticated adapter → explicit event routes/store → typed flow or conversation-scoped agent; continuation for external completion; independent sink delivery | Reject model calls in notification callbacks and restart/exactly-once assumptions. Read Event runtime → selected Flow/Core agent sections → MCP if applicable. |
| Spoken assistant with failover | Audio contract + compatible input/output providers + acceptable alias substitutes + explicit stream failure UI | Reject input-only providers for spoken output and transparent replay after partial emission. Read Audio → Providers → Generators if structured artifacts are needed. |

Stage checks from cheapest and least effectful to most realistic; do not run them without task authorization:

1. **Static/local:** inspect installed version/types, signature parsing, schemas, tool contracts and selected reference examples. Record source conflicts and unsupported capability combinations.
2. **Deterministic isolated behavior:** test mappings, hard invariants, streamed version replacement, authorization denial, tenant separation, clarification snapshot/restore and cancellation with eval-safe dependencies.
3. **Lifecycle/recovery:** use manual clocks, deterministic IDs and output-capturing sinks; test explicit observe versus wake/resume, restart/store behavior, duplicate/uncertain effects and sink-only redrive. See [Event runtime: Testing](references/event-runtime.md#testing) and [MCP: Apps, replay, evaluation, and testing](references/mcp.md#apps-replay-evaluation-and-testing).
4. **Authorized bounded model evaluation:** representative holdout, action expectations and actual fallback substitutes; compare quality, latency and usage. Isolate side effects and bound trials/teacher cost.
5. **Authorized live integration:** verify real provider/media/protocol capability, durable delivery and shutdown ownership in a controlled environment. Live audio, external services, model billing and production mutations are separate permissions, not implicit test prerequisites.

Finish with the selected topology, explicit application-owned policies, unresolved evidence and an ordered reading plan containing only relevant specialist sections. Report checks actually exercised; proposed checks are not evidence.
