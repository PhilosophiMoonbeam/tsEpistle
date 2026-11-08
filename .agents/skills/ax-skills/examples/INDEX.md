# Executable Ax Examples

Pinned to `@ax-llm/ax` and `@ax-llm/ax-tools` **25.4.9**. These 36 flat modules are an executable layer beside the guides, not another skill or a replacement for API contracts. Links resolve from the **skill root**, like the master’s links.

## Select, then run

For design or mechanism selection, start with [Architecture](references/architecture.md), choose the smallest topology, then read the owning guide and one selected module. For a narrow change, go directly to its guide/module below. Progress **core contracts → selected mechanisms → compositions**; do not preload the example corpus. CLI discovery imports metadata from all numbered modules without running cases; this is not an instruction to load all source into an agent’s context.

Run these commands from the installed `ax-skills` directory containing `SKILL.md`. No original `.agents` fixtures, Ax checkout, repository scripts or additional skill installation is required. Use **Node >=22.18.0**; use **Node 24 and npm 12 for the complete SQLite setup below**. The lockfile pins Zod 4.1.11, TypeScript 5.9.3, tsx 4.20.6 and Node types 22.18.6.

The package also pins the Ax Vercel provider 25.4.9, `ai` 7.0.2, esbuild 0.25.12 and overrides `@ai-sdk/provider`/`@ai-sdk/provider-utils` to 4.0.0/5.0.0. The Flow telemetry case uses real OpenTelemetry API 1.9.0 and trace SDK 2.0.1; the latter is npm-deprecated but tested compatible with this collection.

```sh
npm --prefix examples ci --ignore-scripts
npm --prefix examples install-scripts approve better-sqlite3
npm --prefix examples rebuild better-sqlite3 --foreground-scripts
npm --prefix examples run check
npm --prefix examples run list
npm --prefix examples run list -- 01-signatures
npm --prefix examples run offline -- 01-signatures
npm --prefix examples run offline
```

`--ignore-scripts` prevents dependency lifecycle scripts, including automatic upstream skill installation. Explicit approval/rebuild enables only the SQLite native dependency, requiring a compatible prebuild or native build toolchain. The package records npm 12 approval for the pinned driver; on npm versions without `install-scripts`, omit only that approval command and retain the targeted rebuild. Do not rebuild all dependencies or enable Ax’s postinstall. Installation downloads packages and writes `examples/node_modules`; `check` performs standalone `tsc --noEmit`. `list` emits JSON with exact case IDs, titles, features and supported modes without constructing services or loading an env file. Basenames omit `.ts`; exact IDs and basenames are supported, not prefixes or wildcards. A selected module expands to every exported case; execution rejects it if any selected case lacks that mode. Use a listed exact ID for mixed-mode modules.

Live execution is **named and opt-in**, never the default. Set `AX_EXAMPLE_ENV_FILE` to an absolute private env-file path. This exported case declares live mode; confirm current metadata with `list` before selecting another case:

```sh
npm --prefix examples run live -- --env "$AX_EXAMPLE_ENV_FILE" 26-architecture/typed-invoice
```

Keep that file outside the installed collection and version control. The runner loads only the explicitly supplied file; it does not search for root.env or print its contents. Listing ignores `--env`. Do not run live cases merely to follow a guide.

### Modes, prerequisites and effects

- **Offline fixtures:** default execution selects all offline-capable cases. Model I/O is scripted; actual SDK parsing, generation orchestration, routing, runtime, optimization and local protocol algorithms execute. Fixture outputs are not provider-quality evidence. Offline networking is limited to literal loopback addresses; local servers/sockets can still be used. No model credentials are required.
- **Live providers:** only listed live-capable cases make billed remote model/decision requests. General generation uses `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`; decisions use `AI_DECISIONS_PROVIDER`, `AI_DECISIONS_MODEL`, `AI_DECISIONS_API_KEY`. Optional endpoint/deployment names are `AI_API_URL`, `AI_RESOURCE_NAME`, `AI_DEPLOYMENT_NAME`, `AI_API_VERSION` and the corresponding `AI_DECISIONS_*` names. These are configuration names, not supplied credentials. Choose a compatible operation/model/profile; generic keys do not establish media, Box or native-decision capability. Native Jev questions require the Typesafe decision profile.
- **Bounds:** offline execution caps fetch HTTP requests and loopback socket connections at 50 each **per case**; live execution caps fetch HTTP requests at 50 **per invocation**. The runner gives each case 120 seconds, disables redirects and requests at most 512 generated output tokens through its generation helpers. This is not a dollar budget or a guarantee covering arbitrary third-party socket traffic. Run selected live cases, not an assumed live sweep; cost and acceptance remain application-owned.
- **SQLite/events:** in-memory cases need no durable service. SQLite cases use the native `better-sqlite3` dependency, not Node’s built-in SQLite API. Use Node 24, explicitly approve/build that native dependency after the script-free install, and provide writable local scratch; do not substitute a network filesystem. Any temporary database/store is example-owned, not a durable business record.
- **MCP/protocols:** offline protocol cases use local or injected fixtures, not an external business server. Permit loopback binding where the selected case requires it. Real server identity, OAuth credentials/consent, callback registration, authorization and delivery belong to the host application; generic model credentials do not configure them.
- **Audio/media:** modules 21, 22 and 31 are offline-only injected-fetch/WebSocket-frame examples. Generated silence and scripted responses exercise mapping/turn lifecycle, not recognition or speech quality; no microphone, real speech file, credential or external endpoint is required. Real audio needs valid spoken media, the selected provider’s dedicated STT/TTS/conversational/live capability and a suitable WebSocket runtime. Image fixtures likewise do not certify real-image decision accuracy; experimental Box has the guide’s separate constraints.
- **Effects and cleanup:** cases must own and close local servers, sockets, runtimes and temporary stores, and restore injected globals in `finally`; run the CLI sequentially rather than parallelizing shared-global fixtures. Summaries go to stdout; credentials and raw provider errors are withheld. No live microphone or external business write is part of this suite. Normal completion cleans case-owned resources; after interruption inspect only case-owned scratch. Remove `examples/node_modules` if you want to undo dependency installation; retain the lockfile and never delete unrelated data or private env files.

Supported APIs and exported modes describe intended scope. Only recorded commands/results establish what was **exercised** on a particular runtime/provider. Neither a listed case, fixture success nor typechecking proves current live acceptance, speech quality, calibrated decisions, production reliability or generated-language parity.

## Complete module map

### 1. Core contracts

| Module | Focus | Guide |
| --- | --- | --- |
| [01-signatures.ts](examples/01-signatures.ts) | String and fluent signature contracts | [Signatures](references/signature.md) |
| [02-generation.ts](examples/02-generation.ts) | Structured generation, memory/few-shot examples and extraction → host rule → explanation | [Generators](references/gen.md), [Overview](references/llm.md#memory-and-examples) |
| [03-tools-streaming.ts](examples/03-tools-streaming.ts) | Tool execution and streamed results | [Generators](references/gen.md) |
| [28-advanced-generation.ts](examples/28-advanced-generation.ts) | Advanced execution, recovery and evaluation contracts | [Generators](references/gen.md) |

### 2. Select mechanisms, not the whole table

| Module | Focus | Guide |
| --- | --- | --- |
| [04-providers.ts](examples/04-providers.ts) | Provider/model construction, image output, thinking overrides and capabilities | [Providers](references/ai.md) |
| [05-provider-routing.ts](examples/05-provider-routing.ts) | Capability routing and operational balancing | [Providers](references/ai.md) |
| [27-provider-replay.ts](examples/27-provider-replay.ts) | Provider replay and cache boundaries | [Providers](references/ai.md) |
| [33-browser-ai.ts](examples/33-browser-ai.ts) | Chrome-only adapter fixtures and [browser entry](examples/browser/chrome-ai.html); model inference remains unqualified | [Providers](references/ai.md#chrome-built-in-ai-typescriptjavascript-only) |
| [34-vercel.ts](examples/34-vercel.ts) | Real Vercel adapter, typed output and stream consumption | [Providers](references/ai.md#vercel-ai-sdk-integration) |
| [06-decisions.ts](examples/06-decisions.ts) | Typesafe and OpenAI Decisions; native evidence, scalar/evidence threshold ownership and applicability gating | [Typesafe](references/typesafe.md), [OpenAI Decisions](references/ai.md#openai-decisions) |
| [07-images.ts](examples/07-images.ts) | Image decisions and experimental localization | [Typesafe](references/typesafe.md), [Signatures](references/signature.md) |
| [08-refinement.ts](examples/08-refinement.ts) | Complete-candidate selection and refinement | [Refine](references/refine.md) |
| [09-agents.ts](examples/09-agents.ts) | Agent construction and scoped tools | [Core agents](references/agent.md) |
| [10-agent-delegation.ts](examples/10-agent-delegation.ts) | Explicit child-agent boundaries | [Core agents](references/agent.md) |
| [11-clarification.ts](examples/11-clarification.ts) | Clarification and continuation state | [Core agents](references/agent.md) |
| [12-runtime.ts](examples/12-runtime.ts) | RLM and JavaScript runtime execution | [RLM](references/agent-rlm.md) |
| [36-custom-runtime.ts](examples/36-custom-runtime.ts) | Real structured-plan runtime, host tools and retained state | [RLM](references/agent-rlm.md#custom-code-runtimes) |
| [13-context.ts](examples/13-context.ts) | Context orientation versus within-run policy | [Context chooser](references/agent-context.md), [RLM](references/agent-rlm.md) |
| [14-memory-skills.ts](examples/14-memory-skills.ts) | Recall and runtime skill discovery | [Memory and skills](references/agent-memory-skills.md) |
| [15-observability.ts](examples/15-observability.ts) | Usage, callbacks and attribution | [Observability](references/agent-observability.md) |
| [32-executor-context.ts](examples/32-executor-context.ts) | Executor/context execution boundaries | [RLM](references/agent-rlm.md), [Context chooser](references/agent-context.md) |
| [17-events.ts](examples/17-events.ts) | Explicit event routes and lifecycle | [Event runtime](references/event-runtime.md) |
| [18-event-resume.ts](examples/18-event-resume.ts) | Correlated continuation and delivery | [Event runtime](references/event-runtime.md) |
| [30-event-storage.ts](examples/30-event-storage.ts) | Event persistence and local storage | [Event runtime](references/event-runtime.md) |
| [35-ucp.ts](examples/35-ucp.ts) | Verified commerce webhooks, single-member freshness binding and native UCP inheritance | [Event runtime](references/event-runtime.md#ucp-adapter), [Flows](references/flow.md#native-mcpucp) |
| [19-mcp.ts](examples/19-mcp.ts) | Native MCP operations/catalogs; `function-overrides` covers legacy-wrapper compatibility only, leaving native/raw catalogs unchanged | [MCP](references/mcp.md) |
| [20-mcp-host.ts](examples/20-mcp-host.ts) | Host capabilities, events and authority | [MCP](references/mcp.md) |
| [29-mcp-oauth.ts](examples/29-mcp-oauth.ts) | OAuth ownership and protocol fixtures | [MCP](references/mcp.md) |
| [21-audio.ts](examples/21-audio.ts) | Batch and structured audio fixtures | [Audio](references/audio.md) |
| [22-audio-live.ts](examples/22-audio-live.ts) | Realtime protocol fixtures, not a live microphone | [Audio](references/audio.md) |
| [31-audio-streams.ts](examples/31-audio-streams.ts) | Streaming audio and turn lifecycle fixtures | [Audio](references/audio.md) |
| [23-optimize.ts](examples/23-optimize.ts) | Global optimization and bounded evaluation | [GEPA](references/gepa.md) |
| [24-agent-optimize.ts](examples/24-agent-optimize.ts) | Agent-specific optimization | [Agent optimization](references/agent-optimize.md) |
| [25-playbooks.ts](examples/25-playbooks.ts) | Reusable strategy and explicit evolution | [Playbooks](references/playbook.md) |

### 3. Compose after choosing boundaries

| Module | Focus | Guide |
| --- | --- | --- |
| [16-flow.ts](examples/16-flow.ts) | Typed dependencies, native score-rubric evidence, scoped session control, async/parallel map and real OpenTelemetry lifecycle | [Flows](references/flow.md) |
| [26-architecture.ts](examples/26-architecture.ts) | Five application patterns; `evidence-aware-ticket` composes atomic Jev judgments with authoritative facts, ordered host rules and optional prose | [Architecture](references/architecture.md#11-compose-small-patterns-and-stage-verification), [Jev policy](references/typesafe.md#atomic-judgments-and-host-policy) |

Use `npm --prefix examples run list -- MODULE_BASENAME` to find the exact case ID. Read that case's `run(ctx)`, imports and referenced helpers—not the corpus—then run `npm --prefix examples run offline -- CASE_ID`. Return to the guide for constraints; examples demonstrate selected contracts, not every supported combination.

For the browser surface, run `npm --prefix examples run build:browser`, serve `examples/browser/` with a local static HTTP server and open `chrome-ai.html`. `check` includes this entry. Only a compatible Chrome profile can run its local model; Node fixtures and an unavailable-state rendering do not establish Gemini Nano inference. No model session or download starts on import.
