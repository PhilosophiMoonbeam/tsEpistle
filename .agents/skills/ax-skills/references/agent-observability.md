# AxAgent Observability

Use for AxAgent runtime visibility, progress, callbacks, telemetry, centralized or multi-tenant usage accounting, chat logs, and traces in `@ax-llm/ax`. Source API snapshot: 25.4.5. For setup see [agent authoring](references/agent.md); for runtime policy see [RLM](references/agent-rlm.md); for memories and dynamic skills see [memory and skills](references/agent-memory-skills.md). This is not general application logging.

## Choose the smallest hook

| Need | Surface |
| --- | --- |
| Development prompt/runtime trace | `debug: true` |
| Structured per-turn code, raw results, replay output, provider thoughts, actor stage | `actorTurnCallback` |
| Context pressure and compaction | `onContextEvent` |
| Actor-emitted real-time task progress | `agentStatusCallback` |
| Every JS runtime function call before execution | `onFunctionCall` |
| Model prompts/responses after a run | `getChatLog()` |
| Centralized chat/embedding usage across APIs, users, agents, services | `axGlobals.onUsage` with `usageContext` |
| Actor/responder token usage | `getUsage()`, `resetUsage()` |
| Context/task stage usage | `getStagedUsage()` |
| Ax program traces | `getTraces()` |

Add multiple hooks only when each output stream is needed. In particular, combine `debug: true` and `actorTurnCallback` only for both unstructured prompt/runtime visibility and structured telemetry. Do not scrape prompts or action logs when a callback exposes the data. Enable `showThoughts` only for needed provider-supported thought diagnostics; these are optional provider-returned fields, not guaranteed thoughts elicited by the callback.

## Global runtime defaults

```typescript
import { axGlobals, axCreateDefaultColorLogger } from '@ax-llm/ax';
import { metrics, trace } from '@opentelemetry/api';

axGlobals.rateLimiter = async (next, info) => next();
axGlobals.tracer = trace.getTracer('agent-app');
axGlobals.meter = metrics.getMeter('agent-app');
axGlobals.debug = true;
axGlobals.logger = axCreateDefaultColorLogger();
axGlobals.onUsage = (event) => usageQueue.enqueue(event);
```

Each run snapshots the globals. Forward-scoped `rateLimiter`, `tracer`, or `meter` overrides agent defaults, child-generator defaults, service hooks, and globals for that invocation. Ax propagates it through distiller, executor, responder, repeated actor turns, citation repair, built-in `llmQuery`, context-map work, checkpoint/tombstone summaries, and other direct internal model calls without mutating child programs or leaking between concurrent runs.

The limiter wraps model execution; its failures propagate. Tracer, meter, and usage-observer failures are fail-open. Runtime-hook spans contain metadata only, never prompts, outputs, tool arguments, or results, and preserve agent → internal AxGen → provider/tool parentage. External meter instruments neither replace nor derive from balancer-local `getMetrics()` snapshots. Use agent callbacks for structured turn events rather than spans/metrics.

## Centralized usage observer

Use the process-wide observer for application accounting across agents, routes, tenants, and users; keep `getUsage()` for one agent instance after a run, not as the centralized source of truth across shared agents or processes.

```typescript
import { axGlobals } from '@ax-llm/ax';

axGlobals.onUsage = (event) => {
  usageQueue.enqueue(event); // Enqueue synchronously and return immediately.
};

await supportAgent.forward(
  llm,
  { query: request.body.query },
  {
    usageContext: {
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: request.id,
      runId: crypto.randomUUID(),
      feature: 'support-chat',
      attributes: { environment: 'production' },
    },
  }
);
```

- One immutable normalized event is emitted per completed chat or embedding call reporting provider usage. Fully consumed streams emit once; unconsumed/cancelled streams may not emit.
- Events include `operation`, `ai`, `model`, normalized `tokens`, `streaming`, optional `context`, and available session/remote request IDs. See [AI services](references/ai.md) for direct calls and the complete event shape.
- Put stable application/environment attribution in service-level `usageContext`; tenant, user, request, run, and feature attribution belongs in per-call/per-forward context. Per-call context overrides service defaults; `attributes` shallow-merge.
- Ax does not await the best-effort observer and ignores its failures. Enqueue synchronously; persist/aggregate out of band. Never perform database or network work inline.
- Registration is process-wide; reassignment replaces the observer. Set `axGlobals.onUsage = undefined` during teardown/shutdown when appropriate.
- Multi-process/serverless accounting requires a shared durable pipeline, not an in-memory application-wide total.
- Keep identifiers opaque and attributes low-cardinality; exclude prompts, responses, secrets, and sensitive payloads.
- Token events do not estimate currency cost; apply a versioned provider/model pricing table downstream.

## Actor turn callback

`actorTurnCallback` provides structured telemetry for each actor turn: debug UIs, traces/analytics, supported internal thought diagnostics, and per-turn artifacts without scraping replay logs.

```typescript
actorTurnCallback?: (turn: {
  stage: 'distiller' | 'executor';
  turn: number;
  actionLogEntryCount: number;
  guidanceLogEntryCount: number;
  executorResult: Record<string, unknown>;
  code: string;
  result: unknown;
  output: string;
  isError: boolean;
  thought?: string;
  usage?: AxProgramUsage[];
  model?: string;
  chatLogMessages?: ReadonlyArray<{ role: string; content: string }>;
}) => void | Promise<void>;
```

- `code` is normalized actor-generated JavaScript; `stage` identifies distiller/executor.
- `result` is the raw untruncated runtime return, before type-aware serialization and budget-proportional truncation. `output` is the normalized/truncated action-log replay string, not raw stdout.
- `executorResult` is the full current-stage actor payload; the historical name remains for compatibility.
- `isError` marks execution paths treated as errors; `usage` covers this actor turn only. `model` is populated when explicitly set by `executorModelPolicy`.
- `thought` exists only if the underlying `AxGen` call enabled `showThoughts` and the provider returned that field.
- `chatLogMessages` is the raw turn ChatML conversation and is populated only when the callback is set.
- `actionLogEntryCount` and `guidanceLogEntryCount` are live sizes after turn processing, including resumed runs.
- Ownership is per configured agent instance. Child agents in `functions: [...]` need their own callback for internal actor turns; parent `onFunctionCall` observes the parent-side child invocation.
- The source repeats this identical callback declaration as a “deprecated alias” without naming a distinct alias; it does not define a second API.

```typescript
const supportAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  actorTurnCallback: ({
    stage, turn, actionLogEntryCount, guidanceLogEntryCount,
    code, result, output, thought, isError, usage, model,
  }) => {
    console.log({
      turn, stage, model, actionLogEntryCount, guidanceLogEntryCount,
      isError, code, rawResult: result, replayOutput: output, thought, usage,
    });
  },
  executorOptions: { model: 'gpt-5.4-mini', showThoughts: true },
});
```

## Context event observability

`onContextEvent` reports prompt pressure and compaction for logs, evals, and dashboards; it does not directly change model behavior.

| Event | Meaning/payload |
| --- | --- |
| `budget_check` | Character-based pressure before an actor turn; detailed metrics stay out of the actor prompt |
| `checkpoint_created`, `checkpoint_cleared` | Lifecycle, covered turns, reason |
| `tombstone_created` | Compact resolved-error summary creation |
| `relevance_ranking` | Once per ranked domain per forward when `relevanceRanking` is enabled; `domain: 'modules' \| 'skills' \| 'memories'`, most-relevant-first `shortlist: { id, score }[]`, `suppressed` true if the low-confidence guard emitted no hint |
| `field_auto_promoted` | Once per field/run when `autoUpgrade` keeps an oversized undeclared input runtime-only; `fieldName`, `originalChars`, `promptPreviewChars` (undefined if no inline preview was kept) |

Measure advisory-hint usefulness by joining each forward's `relevance_ranking.shortlist` IDs to subsequent loads: modules use internal `discover` calls (`onFunctionCall`, `kind: 'internal'`, `name: 'discover'`, `args.request`) plus module parts of external `qualifiedName`s; skills use `onLoadedSkills` / `used(id)`; memories use `onLoadedMemories` / `used(id)`.

Prompt `contextPressure` is intentionally only `ok`, `watch`, or `critical` plus one short instruction. Character-based metrics are provider-neutral and exposed through the callback; do not scrape actor prompts. Callback errors are swallowed so telemetry cannot break the run. See [context policy](references/agent-context.md) for behavior configuration.

```typescript
const supportAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
  onContextEvent: (event) => {
    if (event.kind === 'budget_check') {
      console.log(event.pressure, event.mutablePromptChars);
    }
  },
});

// Option type
onContextEvent?: (event: AxAgentContextEvent) => void | Promise<void>;
```

## Agent status callback

Set `agentStatusCallback` for real-time actor progress. It automatically exposes `reportSuccess(message)` and `reportFailure(message)` in the actor prompt and instructs the actor to update the user; actor JavaScript can call `await reportSuccess(message)` or `await reportFailure(message)`. These names become reserved runtime names. Child agents inherit the callback through RLM config.

```typescript
const supportAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  agentStatusCallback: (message, status) => {
    console.log(`[${status}] ${message}`);
  },
});

// Option type
agentStatusCallback?: (
  message: string,
  status: 'success' | 'failed'
) => void | Promise<void>;
```

## Runtime function calls

Agent `onFunctionCall` fires once before each actor JS-runtime function executes. It is independent of DSP-layer `AxProgramForwardOptions.onFunctionCall`, which observes LLM tool calls and never fires under AxAgent because functions are injected as runtime globals.

```typescript
const supportAgent = agent('query:string -> answer:string', {
  contextFields: ['query'],
  runtime,
  functions: [helperAgent, lookupOrderTool],
  onFunctionCall: ({ name, qualifiedName, args, kind }) => {
    console.log(`[${kind}] ${qualifiedName}`, args);
  },
});

// Option type
onFunctionCall?: (call: {
  name: string;
  qualifiedName: string;
  args: Record<string, unknown>;
  kind: 'internal' | 'external';
}) => void | Promise<void>;
```

`name` is bare (`'lookupOrder'`); `qualifiedName` is actor-visible/namespaced (`'tools.lookupOrder'`) or equals `name` for unnamespaced globals. `args` is the resolved positional/named argument object. The source classifies caller-registered `functions` as `'external'` and agent-injected globals (child agents, `discover`, `recall`, `used`) as `'internal'`. Callback exceptions are swallowed and cannot break the actor loop. Do not use the DSP hook for runtime calls or let telemetry-hook failures break runs.

## Chat logs, usage, and traces

AxAgent exposes actor and responder subprograms. `getChatLog()`, `getUsage()`, and trace export refresh the agent snapshot from distiller, executor, and responder before returning, even after `forward()` throws. Successful calls before actor limits, provider errors, cancellation, or responder errors remain observable and counted.

### `getChatLog()`

Returns full normalized history after any `.forward()`, in the same flat `AxChatLogEntry[]` shape as AxGen/AxFlow. Each entry is an `ai.chat()` round-trip; actors accumulate one per turn, responder typically one. Optional `name` distinguishes `distiller`, `executor`, `responder`. Entries contain the full model prompt and response.

```typescript
const log = myAgent.getChatLog();
for (const entry of log) {
  console.log(entry.name, entry.model);
  for (const msg of entry.messages) {
    console.log(`[${msg.role}]`, msg.content);
  }
}

type AxChatLogMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string };

type AxChatLogEntry = {
  name?: string; // distiller, executor, responder
  model: string;
  messages: AxChatLogMessage[];
  modelUsage?: AxProgramUsage;
  stage?: 'ctx' | 'task';
};
```

### Usage and trace access

`getUsage()` splits actor/responder usage. Each array contains an `AxProgramUsage` entry per model/run, merged by `(ai, model)`. `getStagedUsage()` splits pipeline stages: `ctx` has only distiller actor; `task` has executor actor plus responder. `getTraces()` returns pipeline Ax program traces rather than chat messages or token summaries. `resetUsage()` resets actor and responder together.

```typescript
const usage = myAgent.getUsage();
console.log('Actor tokens:', usage.actor[0]?.tokens);
console.log('Responder tokens:', usage.responder[0]?.tokens);

const staged = myAgent.getStagedUsage();
console.log(staged.ctx?.actor);
console.log(staged.task.actor);
console.log(staged.task.responder);

const traces = myAgent.getTraces();
myAgent.resetUsage();

// AxAgent
agent.getChatLog(): readonly AxChatLogEntry[]
agent.getUsage(): { actor: AxProgramUsage[]; responder: AxProgramUsage[] }
agent.getStagedUsage(): { ctx?: AxAgentUsage; task: AxAgentUsage }
agent.getTraces(): AxProgramTrace[]
agent.resetUsage(): void

// AxGen / AxFlow
 gen.getChatLog(): readonly AxChatLogEntry[]
 gen.getUsage(): AxProgramUsage[]
```
