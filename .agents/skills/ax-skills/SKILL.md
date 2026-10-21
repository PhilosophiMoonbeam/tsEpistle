---
name: ax-skills
description: Design, implement and review @ax-llm/ax TypeScript LLM systems. Use for holistic architecture before development, execution topology and trust/state boundaries; ai() providers, routing, balancing and embeddings; s()/f() signatures; ax()/AxGen generation, streaming and validation; agent()/AxAgent tools, child delegation, clarification and resume; contextMap, contextPolicy, memories and runtime skills; RLM/AxJSRuntime; usage, tracing and cost ownership; flow()/AxFlow DAGs; AxEventRuntime events and persistence; agent.optimize(), optimize()/AxGEPA, playbook()/ACE and bestOfN/refine; AxMCPClient transports, catalogs and OAuth; audio/multimodal applications; and Typesafe Jev decisions, evidence, images and Box localization.
---

# Ax Skills

Use one entrypoint and 19 selectively loaded references. All links are relative to this skill root; no separately installed Ax skill is required.

## Working policy

1. **Design, mechanism selection, or cross-language porting:** read [Architecture](references/architecture.md) first, even for a single subsystem such as retrieval, image localization or audio routing. Then load only the selected specialist sections. **Narrow coding or debugging:** go directly to the owning row below. Do not preload every guide.
2. Prefer `ai()`, `ax()`, `agent()`, `flow()`, `optimize()`, `s()`, `f()` and `fn()` where supported; use specialized classes when required.
3. This collection preserves official `@ax-llm/ax` **25.4.5** snapshots plus an authored design synthesis, not a promise about future releases or every generated language. Check the installed package version and declarations before applying examples; retain provider limitations and source disagreements.
4. Keep credentials in application environment/secret storage, never examples or logs. Before verification inspect scripts and obtain task-required authorization. Prefer local type checks and focused tests; never silently run billed model calls, external services, live audio or state-changing operations. Report only checks actually exercised.

## Architectural orientation

- Start with a signature-bound `AxGen`; use `AxFlow` for application-defined dependencies/branches and `AxAgent` for model-directed tool use. RLM is the agent's code/runtime strategy; child delegation is an explicit specialist boundary, not `llmQuery()`.
- Separate native decisions from prose/tool generation; capability filtering and operational balancing do not establish semantic equivalence or application quality.
- Keep corpus orientation (`contextMap`), within-run replay (`contextPolicy`), recalled facts, loaded runtime skills and evolving playbooks distinct. Runtime sessions and continuation snapshots are not a durable application database.
- The application owns authenticated identity, tool authority, durable storage, retry/idempotency policy, delivery, accounting and acceptance criteria. MCP content is untrusted; event sources require explicit wake/resume routes.

Use Architecture to turn these alternatives into a justified design and implementation reading plan.

## Route by task

| Task or symbols | Read | Boundary / companion |
| --- | --- | --- |
| Holistic pre-development understanding, system design, topology, alternatives, trust/state/reliability boundaries, staged verification | [Architecture](references/architecture.md) | Design procedure and deliverable; then selected implementation guides. |
| Library orientation, imports, factories, basic examples, global defaults | [Library overview](references/llm.md) | Quick reference, not a substitute for design or specialist contracts. |
| `ai()`, provider/model setup, GPT-6.1 Sol reasoning/pricing, presets/catalogs, embeddings, caching and Gemini cache migration, tiers, routing, `AxProviderRouter`, `AxMultiServiceRouter`, `AxBalancer`, native compatibility reports (`get_compatibility_report` / `GetCompatibilityReport` / `getCompatibilityReport`), streaming usage/incomplete responses | [AI providers](references/ai.md) | Capability and operational routing; audio operations below, Jev decisions in Typesafe. |
| `transcribe()`, `speak()`, `:audio`, `speech`, `.chat()` audio, OpenAI Realtime, Gemini Live, Grok Voice, Meta Muse, voices/formats/transcripts | [Audio I/O](references/audio.md) | Batch/scripted artifacts versus conversational/live turns; add Providers and Signatures as needed. |
| String signatures, `s()`, `f()`, `f.box()`/`AxBox`, schemas, modifiers, constraints, value descriptions, typed input/output contracts | [Signatures](references/signature.md) | Schema construction; execution in Generators, native decisions/media in Typesafe. |
| `ax()`, `AxGen`, `forward()`, `streamingForward()`, assertions/streaming assertions, processors, hooks, self-tuning, novelty F1 and native metric counterparts | [Generators](references/gen.md) | Structured execution, hard validation and lexical evaluation; native classification semantics in Typesafe. |
| `agent()`, `AxAgent`, `fn()`, namespaced tools, child agents, discovery, `bubbleErrors`, final/clarification protocols, `getState()`/`setState()`, multiple-code-fence rejection (text/JSON; LF/CRLF) | [Core agents](references/agent.md) | Ordinary construction and completion; select runtime, retrieval, telemetry or tuning below. |
| Choose `contextMap` versus `contextPolicy`, recall/memories, runtime skills, optimization or playbooks | [Agent context chooser](references/agent-context.md) | Mechanism and scope selection; implementation in the next two guides. |
| `contextMap`/`AxAgentContextMap`, catalogs/search, `recall()`, `inputs.memories`, preloading/carryover, relevance ranking, `discover({ skills })`, loaded/used IDs | [Memory and skills](references/agent-memory-skills.md) | Corpus orientation and retrieval, not trajectory compaction; runtime skills are not installable coding skills. |
| RLM, `AxJSRuntime`, `contextFields`, `contextPolicy`, `liveRuntimeState`, `promptLevel`, stage prompts, `executorModelPolicy`, `maxRuntimeChars`, `agent.test()`, `llmQuery()`, `recursionOptions` | [Agent RLM runtime](references/agent-rlm.md) | Code sessions, within-run context and semantic sub-queries; specialist child agents belong in Core agents. |
| `axGlobals.onUsage`, `usageContext`, tenant accounting, actor/context/status/function callbacks, `reportSuccess`/`reportFailure`, logs, usage/resetUsage, traces | [Agent observability](references/agent-observability.md) | Runtime telemetry; application owns durable aggregation, privacy and currency pricing. |
| `agent.optimize()`, datasets/targets, `judgeOptions`, deterministic metrics, saved `optimizedProgram` | [Agent optimization](references/agent-optimize.md) | Agent-specific evaluation/tuning; global optimizer and playbook evolution below. |
| `flow()`, `AxFlow`, DAGs, conditional routing, auto-parallel execution, map/reduce | [Flows](references/flow.md) | Program composition, not external event ingestion or durable wake/resume. |
| `AxEventRuntime`, inbox/routes, explicit wake/resume, owned continuations, stores, persisted results, sinks | [Event runtime](references/event-runtime.md) | Event lifecycle and reliability boundaries; add MCP for protocol event sources. |
| `optimize()`, `AxGEPA`, BootstrapFewShot, Pareto/multi-objective tuning, reflective evolution, `validationExamples`, `maxMetricCalls` | [GEPA optimization](references/gepa.md) | Offline instruction/demo optimization for generators, flows or agent trees. |
| `playbook()`, `AxPlaybook`, ACE, `agent.playbook()`, offline `evolve()` and online `update()` | [Playbooks](references/playbook.md) | Reusable task knowledge, not instruction/demo search or per-call sampling. |
| `bestOfN()`, `refine()`, rewards, thresholds, native samples, serial attempts, advice/diagnostics | [Refine and best-of-N](references/refine.md) | Complete-output selection within a call, not streaming or persistent learning. |
| `AxMCPClient`, native `mcp`, transports, catalogs, tools/prompts/resources, tasks/subscriptions, sampling/elicitation/roots, OAuth, Apps, recording/replay | [Native MCP](references/mcp.md) | Protocol ownership and trust; add Event runtime for persisted wake/resume. |
| Typesafe Jev, boolean/class/rubric score decisions, evidence/probabilities/provenance, `trueThreshold`, native Noul/Choice/Score/Box, structured criteria, PNG/JPEG, hybrid generation | [Typesafe Jev](references/typesafe.md) | Separate decisions from generation. Images/Box are experimental; OpenAI Decisions rejects Box; generated-language source claims conflict. |
