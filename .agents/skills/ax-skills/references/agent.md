# Core AxAgent Construction and Runtime Contracts

Use for `agent(...)`, ordinary tool-using assistants, identity, child delegation, namespaced functions, discovery, `bubbleErrors`, host-side completion, clarification, and public run/state APIs. Generate the smallest correct factory-based shape and copyable code; do not add tutorial prose unless requested. Source API snapshot: `@ax-llm/ax` 25.4.3.

## Choose the Agent Shape

| Need | Shape or companion reference |
| --- | --- |
| Use tools and answer | Plain `agent(...)` with local functions; minimal configuration, no extra observability |
| Delegate distinct specialist responsibilities | Child agents in `functions: [...]`; set each child's `agentIdentity.namespace` for call sites such as `team.writer(...)` |
| Discover unstable callable names or schemas | Enable discovery; generate discovery-first actor code |
| Let selected fatal errors escape the loop | `bubbleErrors` with Error classes; propagation covers function handlers, actor code, and `llmQuery(...)` sub-queries |
| Inspect large context with code, long-running execution, RLM, or `llmQuery(...)` | [RLM](references/agent-rlm.md); do not write a full multi-step RLM actor program in one turn |
| Callbacks, debugging, logs, traces, progress, tool/chat logs, or usage | [Agent observability](references/agent-observability.md) |
| Recall, dynamic memory/skill guides, `discover({ skills })`, loaded/used tracking | [Memory and runtime skills](references/agent-memory-skills.md) |
| `agent.optimize(...)`, tuning, evaluation, judge setup, datasets, saved artifacts | [Agent optimization](references/agent-optimize.md) |
| MCP clients, native modules, transports, authentication, catalogs, subscriptions, tasks, Apps, server handlers, recording/replay, or event-driven wake/resume | [MCP](references/mcp.md); [event runtime](references/event-runtime.md) covers wake/resume orchestration |

For Typesafe/Jev decisions, keep a generative model for the actor's tools, code, and prose; invoke Typesafe as a separate decision step. Jev cannot supply a general tool-using actor's output contract. See [Typesafe](references/typesafe.md) for supported signatures/native questions. Original remote guidance remains at [ax-typesafe.md](https://github.com/ax-llm/ax/blob/main/src/ax/skills/ax-typesafe.md); local guidance is the companion reference, not a separately required skill.

## Defaults and Execution Constraints

- Use `agent(...)`, not `new AxAgent(...)`, for new code.
- Prefer string signatures or `f()` signatures to hand-written signature objects, and `fn(...)` host functions to hand-written JSON Schema.
- Configure `ai`, `judgeAI`, and `agentIdentity` for instance defaults or child metadata.
- Prefer namespaced functions, e.g. `utils.search(...)` and `kb.find(...)`.
- Delegate through explicit child agents in `functions`, not recursive `llmQuery(...)`.
- Actor responses must contain one executable program. Multiple fenced code blocks reject the entire turn without executing any block; the runtime asks for one program. This applies to text and structured JSON responses, with LF or CRLF line endings.
- Actor code stages require structured generation with the exact `javascriptCode` wire key. Native-capable providers retain strict `json_schema`; providers such as DeepSeek use validated `json_object` and need no provider-visible tools for runtime execution.
- Generated Go, Python, Java, C++, and Rust distiller/executor stages use `validation_retries`, with one correction attempt by default; set `0` to fail on the first invalid response.
- Do not combine actor `console.log(...)` with `final(...)`.

### Direct-response default

`directResponse` defaults to `'auto'`. If no executor authority is needed, the distiller ends with `respond(task, evidence)` and skips the executor: zero executor model calls. Static agents with no functions, child agents, or native MCP/UCP operations are always respond-only. Agents with any such authority retain the executor and permit `respond` only under a conservative covenant: no live/fresh-state requests, no side effects, and nothing covered by a listed function/module domain. Set `directResponse: 'off'` to always run the executor. This distiller shortcut does not replace the host-function `final(...)` protocol below.

## Canonical Pattern

```typescript
import { agent, ai, f } from '@ax-llm/ax';

const llm = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
});
const assistant = agent(
  f().input('query', f.string()).output('answer', f.string()).build(),
  {
    agentIdentity: { name: 'Assistant', description: 'Answers user questions' },
    contextFields: [],
  }
);
const result = await assistant.forward(llm, { query: 'What is TypeScript?' });
console.log(result.answer);
```

## Audio Inputs and Speech Outputs

Audio input fields are transcribed before planner/executor/responder stages; internal stages receive text transcripts, not base64 audio. After selection of the final structured response, `:audio` output fields are synthesized as scripted speech artifacts.

```typescript
const voiceAgent = agent(
  'recording:audio, question:string -> speech:audio, summary:string',
  {
    agentIdentity: { name: 'Voice Assistant', description: 'Answers spoken requests' },
    contextFields: [],
  }
);
const result = await voiceAgent.forward(
  llm,
  {
    recording: { data: base64Wav, format: 'wav' },
    question: 'What should I do next?',
  },
  {
    speech: {
      transcribe: { model: 'gpt-4o-mini-transcribe' },
      speak: { voice: 'alloy', format: 'mp3' },
    },
  }
);
console.log(result.summary);
console.log(result.speech.data);
```

Use direct `ax(...)` or `.chat()` for native model audio instead of the transcript-first agent pipeline. See [audio](references/audio.md) for speech details and [generators](references/gen.md) for direct `ax(...)` use.

## Child Agents, Identity, and Namespaces

Pass children directly in the parent's `functions` array, alongside `fn(...)` tools. There is no separate `agents` option for new code. A child's `agentIdentity.namespace` determines its runtime module; the default is `utils`, not `agents.*`.

```typescript
const writer = agent('draft:string -> revision:string', {
  agentIdentity: {
    name: 'Writer',
    description: 'Polishes drafts',
    namespace: 'team',
  },
  contextFields: [],
});
const coordinator = agent('query:string -> answer:string', {
  functions: [writer],
  contextFields: [],
});
```

With `AxJSRuntime`, actor calls are:

```javascript
const result = await team.writer({ draft: '...' });
```

Without the child's namespace override:

```javascript
const result = await utils.writer({ draft: '...' });
```

`onFunctionCall` observers report `kind: 'internal'` for agent-derived calls and `kind: 'external'` for user-registered tools; see [observability](references/agent-observability.md).

### Reserved namespace names

Neither `agentIdentity.namespace` nor agent-function namespaces may use these injected runtime globals:

```text
inputs
llmQuery
final
askClarification
reportSuccess
reportFailure
inspectRuntime
discover
recall
```

Choose another lowercase identifier, such as `utils`, `kb`, `tools`, `team`, or `db`.

### Explicit parent-field threading

Children receive only actor-passed arguments, not automatic parent inputs. Declare required parent fields in the child signature and pass `inputs.<field>` explicitly:

```typescript
const writingCoach = agent('draft:string, audience:string -> revision:string', {
  agentIdentity: {
    name: 'Writing Coach',
    description: 'Polishes summaries for a target audience',
    namespace: 'team',
  },
  contextFields: [],
});
const analyst = agent('context:string, audience:string, query:string -> answer:string', {
  functions: [writingCoach],
  contextFields: ['context'],
});
```

Actor call:

```javascript
const polished = await team.writingCoach({
  draft: summary,
  audience: inputs.audience,
});
```

If many children need the same value on every call, use `inputUpdateCallback` to inject it before each executor turn; do not assume automatic propagation.

## Tool Functions and Schemas

```typescript
import { agent, f, fn } from '@ax-llm/ax';

const findSnippets = fn('findSnippets')
  .description('Find handbook snippets by topic')
  .namespace('kb')
  .arg('topic', f.string('Topic keyword'))
  .returns(f.string('Matching snippet').array())
  .example({
    title: 'Find severity guidance',
    code: 'await kb.findSnippets({ topic: "severity" });',
  })
  .handler(async ({ topic }) => [])
  .build();
const analyst = agent('query:string -> answer:string', {
  functions: [findSnippets],
  contextFields: [],
});
```

Actor call:

```javascript
const snippets = await kb.findSnippets({ topic: 'severity' });
```

- Default namespace is `utils`; prefer an explicit meaningful namespace.
- `AxJSRuntime` calls use `await <namespace>.<name>({...})`. Custom runtimes should expose equivalent namespaced calls through their own `formatCallable()` guidance.
- `.arg()` and `.returns()` accept Ax field helpers or any Standard Schema v1 validator directly.

## Grouped Function Modules

Use `AxAgentFunctionGroup` in discovery mode to establish namespace trees such as `kb.find(...)` or `metrics.score(...)` without a namespace on every `fn(...)`:

```typescript
const parent = agent('query:string -> answer:string', {
  functions: [
    {
      namespace: 'kb',
      title: 'Knowledge Base',
      selectionCriteria: 'Use for handbook and documentation lookups.',
      description: 'Knowledge base lookups',
      functions: [findSnippetsFn, searchPagesFn],
    },
    {
      namespace: 'workflow',
      title: 'Workflow Controls',
      description: 'Small control functions the actor should always see',
      alwaysInclude: true,
      functions: [completeFn],
    },
  ],
  functionDiscovery: true,
  contextFields: [],
});
```

- Group shape: `{ namespace, title, description, functions: [...] }`, with optional `selectionCriteria` and `alwaysInclude`.
- `selectionCriteria` tells the actor when to choose the module. Namespace, title, selection criteria, and description appear in discovery module docs.
- `alwaysInclude: true` keeps the group's full callable definitions inline even with discovery enabled.
- Keep `functions` entirely flat or entirely grouped; runtime validation rejects mixed plain entries and groups.
- Flat lists accept `fn(...)` tools and child agents directly. Groups contain callable entries; expose a child using `childAgent.getFunction()`.
- `relevanceRanking` is on by default; set `false` to opt out. A deterministic local ranker adds an advisory `### Likely Relevant` shortlist to the executor turn as a dynamic, non-cached field, leaving cached prompts byte-stable. The default passed its A/B gate on small and frontier models; generated-language ports implement it through AxIR Core. See [memory and skills](references/agent-memory-skills.md) for details and [observability](references/agent-observability.md) for the `relevance_ranking` context event.

## Native MCP/UCP Attachment and Inheritance

Attach clients through the native execution context, not `functions`. Ax initializes them once, exposes `mcp.<namespace>` / `ucp.<namespace>` modules, and propagates them through actor stages, `llmQuery`, RLM, and children. Native `mcp` attachment preserves tasks, resources, subscriptions, elicitation, sampling, authorization, cancellation, and protocol metadata. Use [MCP](references/mcp.md) for client construction, transport/authentication, server handlers, subscription policies, task continuations, and recording/replay.

```typescript
const parent = agent('query:string -> answer:string', {
  mcp: [memoryClient, searchClient],
  mcpInheritance: 'all',
  functionDiscovery: true,
  contextFields: [],
});
// Restrict clients passed to children, not the parent's own stages.
await parent.forward(llm, { query }, { mcpInheritance: ['memory'] });
```

- The parent's distiller and executor retain attached clients. Apply `mcpInheritance` on child delegation, not between stages of one agent.
- A child's explicitly configured clients take precedence over inherited clients.
- `none` and an empty namespace list pass no parent clients.
- Resource wake-ups use `AxMCPEventSource` and an explicit authenticated `wake` route. MCP sessions are not tenant identity; obtain identity from the application's authenticated token mapping.
- An endpoint does not imply a resource URI. Inspect `client.inspectCatalog()` and choose `resourceSubscriptions` explicitly: omission selects none; `'all'` selects all discovered concrete resources; selectors can match names, descriptions, MIME types, URIs, and annotations. Templates are not expanded.
- Map events with a signature-aware `.wakeInput(...)` plan or reuse `eventInput()`. Callback `mapInput` remains signature-validated and cannot inject undeclared Agent fields.
- Multiple matching routes wake multiple Agents with independent state, authorization, retries, and runs.
- UCP lifecycle webhooks use `AxUCPWebhookEventSource`. Verify the request, then map verified profile/account state to Ax tenant identity; never derive tenant identity from the order payload.

See [event runtime](references/event-runtime.md) for routing and continuations.

## Host-Side Completion and Unified Final Signal

Use namespaced host functions when their handlers must decide to end the actor turn:

```typescript
import { f, fn } from '@ax-llm/ax';

const finishReply = fn('finishReply')
  .description('Complete the actor turn with the final reply text')
  .namespace('workflow')
  .arg('reply', f.string('Final reply text'))
  .returns(f.string('Final reply text'))
  .handler(async ({ reply }, extra) => {
    extra?.protocol?.final(reply);
    return reply;
  })
  .build();
const askForOrderId = fn('askForOrderId')
  .description('Complete the actor turn by requesting clarification')
  .namespace('workflow')
  .arg('question', f.string('Clarification question'))
  .returns(f.string('Clarification question'))
  .handler(async ({ question }, extra) => {
    extra?.protocol?.askClarification(question);
    return question;
  })
  .build();
```

- `extra.protocol` exists only for function calls from an active AxAgent actor runtime session.
- `extra.protocol.final(...)`, `.askClarification(...)`, and `.guideAgent(...)` are host-handler-only APIs. Actor-authored code uses runtime globals `final(...)` and `askClarification(...)` with the active runtime's syntax.
- Handler-only `extra.protocol.guideAgent(...)` stops the current actor turn and appends trusted guidance to `guidanceLog` for the next iteration.
- Successful completion uses `final(message)` when the answer is known without another context object, or `final(task, context)` when collected evidence needs synthesis into output fields. Handlers use the same one-/two-argument forms through `extra.protocol.final(...)`, not a separate respond API.
- Both successful `final(...)` forms continue through the responder in public flows.
- `askClarification(...)` requests missing user information and bypasses the responder. It accepts a string or `{ question, type?, choices? }`; normalization and failures are specified below.

## Clarification and Resume State

Public `forward()` and `streamingForward()` throw `AxAgentClarificationError` on `askClarification(...)`. Prefer the error's captured continuation state, restore it with `setState(...)`, then call `forward(...)` with the user's answer:

```typescript
import { AxAgentClarificationError, AxJSRuntime, agent, ai } from '@ax-llm/ax';

const llm = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY! });
const tripAgent = agent('request:string, answer?:string -> reply:string', {
  contextFields: [],
  runtime: new AxJSRuntime(),
});
let savedState = tripAgent.getState();
try {
  await tripAgent.forward(llm, { request: 'Plan a Lisbon trip' });
} catch (error) {
  if (error instanceof AxAgentClarificationError) {
    console.log(error.question);
    savedState = error.getState();
  } else {
    throw error;
  }
}
if (savedState) {
  tripAgent.setState(savedState);
  const resumed = await tripAgent.forward(llm, {
    request: 'Plan a Lisbon trip',
    answer: 'June 1-5',
  });
  console.log(resumed.reply);
}
```

- `.question`: user-facing question text; `.clarification`: normalized structured payload; `.getState()`: continuation state captured at throw time.
- Agent `getState()` / `setState(...)` export/restore instance continuation state.
- `test(...)` is a harness/debug exception to public flow: it returns structured completion payloads rather than throwing clarification exceptions.

### Payload constraints

String shorthand is valid: `askClarification("What dates should I use?")`. Prefer structured payloads for richer UIs:

```javascript
askClarification({
  question: 'Which route should I use?',
  type: 'single_choice',
  choices: ['Fastest', 'Scenic'],
});
```

- Supported `type`: `text`, `number`, `date`, `single_choice`, `multiple_choice`.
- Choice entries are strings or `{ label, value? }` objects.
- Missing, empty, or malformed `single_choice.choices` downgrades to a plain clarification question instead of failing the turn.
- `multiple_choice` requires at least two valid choices; otherwise the actor turn fails with a corrective runtime error.
- Invalid payloads, such as a missing `question`, are actor-turn runtime errors, not successful clarification completions.

### State constraints

- `runtimeBindings` restores execution state; `runtimeEntries`, `actionLogEntries`, and `checkpointState` restore prompt context.
- Resume adds no fake rehydration action-log turn; provenance remains the original actor code that set the value.
- Only serializable/structured-clone-friendly values are guaranteed to round-trip.
- Reserved globals (`inputs`, tools, protocol helpers) are rebuilt fresh, not saved.
- A mutable resumed agent instance is conversation-scoped; never share it across unrelated concurrent conversations.

## Bubble Errors

Normally the actor loop catches errors and returns `[ERROR] ...` strings for recovery. Use `bubbleErrors` only for fatal infrastructure failures that must escape `.forward()`, such as database outage, authentication failure, or quota exhaustion:

```typescript
import { agent, f, fn } from '@ax-llm/ax';

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}
const dbTool = fn('queryUsers')
  .description('Query the user database')
  .namespace('db')
  .arg('filter', f.string('Filter expression'))
  .returns(f.string('JSON result'))
  .handler(async ({ filter }) => {
    if (!isConnected()) throw new DatabaseError('DB connection refused');
    return JSON.stringify(await db.query(filter));
  })
  .build();
const myAgent = agent('query:string -> answer:string', {
  contextFields: [],
  functions: [dbTool],
  bubbleErrors: [DatabaseError],
});
```

- The option is an array of Error constructor classes, matched with `instanceof`.
- Matching errors from handlers, actor execution, or `llmQuery(...)` sub-queries bypass actor-loop catches and propagate immediately to `.forward()`.
- Do not list expected recoverable tool errors; let the actor handle `[ERROR] ...`.
- `AxAgentClarificationError` and `AxAIServiceAbortedError` always bubble unconditionally.

## Discovery Mode

Enable discovery to inspect modules and fetch callable definitions on demand:

```typescript
const analyst = agent('context:string, query:string -> answer:string', {
  agentIdentity: {
    name: 'Analyst',
    description: 'Analyzes long context',
    namespace: 'team',
  },
  contextFields: ['context'],
  functions: [writer, ...tools],
  functionDiscovery: true,
});
```

Supported actor API forms:

```typescript
await discover(item: string): void
await discover(items: string[]): void
await discover({ tools?: string | string[], skills?: string | string[] }): void
```

The object form requires `onSkillsSearch`. Discovery returns `void`; fetched docs appear in the **next executor prompt**, not in its return value.

- `discover('kb')`: callable list for discoverable module `kb`.
- `discover('kb.findSnippets')`: full callable definition.
- `discover('lookup')`: resolves to `utils.lookup`.
- `discover({ tools: ['kb'], skills: ['release-checklist'] })`: tool docs and skill bodies in one turn.
- Call one batched `discover(...)` with all needed modules, callables, and skills. Do not split calls, loop discovery, or wrap it in `Promise.all(...)`.
- Read the next prompt's "Discovered Tool Docs" and "Loaded Skills". Do not assign or inspect `await discover(...)`'s result.
- Discover before using callables whose docs are absent from the prompt. Never call `discover()` in distiller/responder stages.
- After a guessed call fails, stop guessing nearby names; discover the module/function and use only the exact discovered qualified name.

## Core Configuration

```typescript
agent(signature, {
  ai,
  judgeAI,
  agentIdentity,
  contextFields,
  functions,
  functionDiscovery,
  autoUpgrade,
  playbook,
  citations,
  ...agentOptions,
});
```

`ai` is an optional instance-default service; `.forward(ai, ...)` can still supply the runtime service. `judgeAI` is the optional default judge/teacher for optimization flows. Identity controls user-facing prompts and child-function metadata:

```typescript
agentIdentity?: {
  name: string;
  description: string;
  namespace?: string;
}
```

- `name` is camelCase-normalized for child function names.
- `name` and `description` appear in actor/responder prompts as user-facing identity.
- `namespace` replaces the default child module `utils`, e.g. with `team`.

### Context field inline policies

Each `contextFields` entry is a plain field name or an inline-policy object for the distiller prompt:

- `{ field, promptMaxChars: N }`: inline only if the serialized value is at most `N` characters; otherwise omit it and retain it runtime-only. Use when partial data is worse than none.
- `{ field, keepInPromptChars: N, reverseTruncate?: boolean }`: always inline a truncated string excerpt. `reverseTruncate: true` keeps the last `N` characters; otherwise a prefix. Use when a prefix/suffix is useful.

`promptMaxChars` and `keepInPromptChars` are mutually exclusive on one field. For choosing context tools, use [context selection](references/agent-context.md); for runtime/context-map implementation, use [RLM](references/agent-rlm.md).

### Auto-upgrade defaults and precedence

`autoUpgrade` is on by default and applies discovery/context controls based on character counts:

```typescript
autoUpgrade?: boolean | {
  functionDiscovery?: boolean | { aboveFunctionDocChars?: number }; // default 10_000
  contextFields?: boolean | { promoteAboveChars?: number; previewChars?: number }; // 8_000 / 1_200
}
```

- When `functionDiscovery` is unset and estimated inline docs for discoverable functions exceed approximately 10,000 characters, discovery turns on. Explicit `functionDiscovery: true | false` always wins.
- Per run, an undeclared input value over 8,000 serialized characters is kept runtime-only, with a 1,200-character truncated prompt preview and `contextMetadata` entry. The full value remains `inputs.<field>`; the responder gets the same preview.
- Explicitly declared `contextFields` retain their declared configuration.
- Required non-string fields (arrays, objects, numbers, media) are never auto-promoted; explicitly declare them as context fields when potentially large.
- Set `autoUpgrade: false`, or disable one side, for manual behavior.
- Each promotion emits `field_auto_promoted` through `onContextEvent`, with field name, original size, and preview size; see [observability](references/agent-observability.md).

### Learning and citations

Construction-time `playbook` and `citations` both default off and are portable across TypeScript and generated Python, Java, C++, Go, and Rust packages.

**`playbook`** attaches an ACE playbook:

- When attached, `learn` defaults on. Runs with failure signals (error turns, dead ends, failing tool calls) trigger one bounded update of durable avoidance rules for the next actor prompt. Clean runs incur zero learning LLM cost.
- Restore with `playbook: { playbook: snapshot }`; snapshot can be `{ playbook, artifact }` or a bare playbook. Generated packages accept the same shape. Their older `seed` snapshot key still works with a deprecation warning; in the next major version `seed` is TypeScript's numeric random seed.
- Persist via `onUpdate`; read the live handle via `getPlaybook()` or its language-shaped equivalent.
- Gate with `learn: { minSignals, dedupe }`; disable with `learn: false`.
- Reflection/curation uses `teacherAI`, defaulting first to the agent's `judgeAI`, then its `ai`. An `isExpensive` teacher also requires `teacherOptions: { useExpensiveModel: 'yes' }`; otherwise updates curate nothing.
- Evolve the same playbook from a task set with a held-out verification gate using the agent-bound evolve method; see [playbooks](references/playbook.md).

**`citations`** adds an optional `evidenceCitations: string[]` responder output naming used evidence: top-level curated-evidence keys and memory IDs. In-pipeline validation prevents citations to uncollected evidence; it checks existence, not entailment. Pass `true` or `{ field?, surface?: 'output' | 'hidden', includeMemoryIds?, onCitations? }`.

### Stage guidance and generated-language spellings

`setInstruction` replaces the stage-owned actor instruction; `addActorInstruction` appends an additive rule. Both are optimization components retained when split programs are rebuilt. Generated spellings follow language conventions: `set_instruction` in Python/C++/Rust, `SetInstruction` in Go.

| Language | Citations observer | Verified agent playbook evolve |
| --- | --- | --- |
| Python | `citations.onCitations` | `agent.playbook().evolve(dataset, options)` |
| Java | `citations.onCitations` (`Consumer`) | `agent.playbook(null).evolve(dataset, options)` |
| C++ | `set_citations_observer(...)` | `agent.get_playbook()->evolve(dataset, options)` |
| Go | `citations.onCitations` (`func([]Value)`) | `agent.GetPlaybook().EvolveAgent(ctx, dataset, options)` |
| Rust | `set_citations_observer(...)` | `playbook.evolve_agent(&mut agent, client, dataset, options)` |

C++/Rust use `set_playbook_observer(...)` for construction-time learning updates. Python/Java/Go accept `playbook.onUpdate` in their native configuration maps.

## Public Surface and Tuning Boundary

| Area | Methods/options | Details |
| --- | --- | --- |
| Running | `forward(ai, values, options?)`, `streamingForward(ai, values, options?)` | Prefer `forward`; stream only when the caller needs streamed responder output |
| Forward-time retrieval | `skills`, `onUsedMemories`, `onUsedSkills` | [Memory and runtime skills](references/agent-memory-skills.md) |
| State/control | `getState()`, `setState(state?)`, `getContextMap()`, `setContextMap(map?)`, `stop()`, `getSignature()`, `setSignature(signature)`, `getFunction()`, `getId()`, `setId(id)` | Context-map evolve policy is on `AxAgentContextMap`: `infiniteEvolve`, `evolveSteps`, `maxChars`, not agent config |
| Observability | `getChatLog()`, `getUsage()`, `getStagedUsage()`, `resetUsage()`, `getTraces()` | [Agent observability](references/agent-observability.md) |
| Demos/tuning | `setDemos(...)`, `namedPrograms()`, `namedProgramInstances()`, `optimize(...)`, `applyOptimization(...)`, `getOptimizableComponents()`, `applyOptimizedComponents(...)` | [Agent optimization](references/agent-optimize.md) |
| Learning | `playbook()`, `getPlaybook()` | `playbook()` returns an agent-aware handle with `update(...)`, `render()`, state/load methods, and verified dataset evolution; `getPlaybook()` reads the live handle. Generated packages use language-shaped names; see [playbooks](references/playbook.md) |

- `getFunction()` requires `agentIdentity` for child-tool metadata.
- `setSignature(...)` must retain configured `contextFields`; a missing configured field throws.
- Low-level component methods are advanced hooks; normal tuning examples use `agent.optimize(...)` / `agent.applyOptimization(...)`.
- For tuning, use eval-safe tools; treat `judgeOptions` as optimize configuration; use an objective `metric` for mechanical scoring and the built-in judge for qualitative run review. Runtime authoring stays here; tuning belongs in [agent optimization](references/agent-optimize.md).
- [rlm-context-map-live.ts](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-context-map-live.ts) demonstrates provider-backed persistence and finite evolution.

## Event-Driven Agents

`AxEventRuntime` wakes or resumes Agents while retaining logical state. Use `createProgram(instance)` for multi-tenant Agents; do not run one mutable Agent object concurrently for multiple instance keys. Clarification and remote task completion are owned continuations, not synthetic user turns.

Declare the signature with `eventTarget('id').createProgram(signature, factory)` and map values using `eventPath`. Before invocation, the runtime verifies each created Agent against that signature. Fan out with multiple matching routes so each Agent has its own authorization, instance serialization, retry policy, and run record. See [event runtime](references/event-runtime.md).

## Automatic Sessions (TypeScript)

- On supporting providers, declared-background tools become native actor tools after discovery. Invocation uses existing runtime bindings; do not call a native background tool again in generated code.
- Stateful code remains serialized. Pass the shared controller through forward options.
- Agent stage scopes: `root/distiller`, `root/executor`, `root/responder`.
- `forward()` and `streamingForward()` report identical run-control events: `started` at `root`, each stage's event pair at its scope, then `completed` or `failed` at `root`.
- If a streaming consumer stops early, the in-flight stage and `root` end with `aborted`.
- A steer targeting a stage scope applies to that stage in both methods.

## Working Examples and Resources

Fetch full working examples as needed:

- [Agent](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/agent.ts): basic agent.
- [Functions](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/function.ts): function validation.
- [Food Search](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/food-search.ts): API tools.
- [Smart Home](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/smart-home.ts): state management.
- [Customer Support](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/customer-support.ts): classification agent.
- [Abort Patterns](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/abort-patterns.ts): abort handling.
- [Smart Defaults Agent](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/smart-defaults-agent.ts): automatic context promotion, relevance hints, and runtime tools.
- [Portable Playbook Evolve](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/python/optimization/agent-playbook-evolve.py): Python construction-time learning, validated citations, stage guidance, and verified task-set evolution; parallel Java/C++/Go/Rust examples are alongside it.

Additional RLM examples are in [RLM](references/agent-rlm.md); memory/skill examples are in [memory and runtime skills](references/agent-memory-skills.md).
