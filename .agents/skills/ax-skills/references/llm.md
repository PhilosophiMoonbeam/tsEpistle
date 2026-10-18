# Ax Library Quick Reference

Ax (`@ax-llm/ax`) is a TypeScript library for type-safe LLM signatures, streaming, and multiple providers. Use this overview for `ax()`, `ai()`, `f()`, `s()`, `agent()`, `flow()`, `AxGen`, `AxAgent`, and `AxFlow`; use the focused companion references for detailed contracts. Source API snapshot: 25.4.3.

Companion guidance: [AI providers](references/ai.md) covers providers, routing, and adaptive balancing; [Typesafe/Jev](references/typesafe.md) covers decisions, criteria, and native scoring; [signatures](references/signature.md) covers signatures and types; [generators](references/gen.md) covers generator behavior. For agents, select [core agents/tools](references/agent.md), [runtime/RLM/delegation](references/agent-rlm.md), [callbacks/logs/usage](references/agent-observability.md), [recall/dynamic skills](references/agent-memory-skills.md), or [tuning/evaluation](references/agent-optimize.md). See [flows](references/flow.md) for workflows and [GEPA](references/gepa.md) for top-level `optimize(...)`, BootstrapFewShot-to-GEPA migration, and Pareto optimization.

## Imports and Factories

Prefer `ax()`, `ai()`, `agent()`, and `flow()` over class constructors. Standard Schema v1 integrations support zod, valibot, and arktype; zod is optional.

```typescript
import { ax, ai, f, s, fn, agent, flow, AxMemory, AxMCPClient } from '@ax-llm/ax';
import { z } from 'zod';

const llm = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY });
const gen = ax('question:string -> answer:string');

const fluentGen = ax(
  f()
    .input('question', f.string('User question'))
    .output('answer', f.string('AI response'))
    .build()
);

const zodGen = ax(
  f()
    .input(z.object({ question: z.string().describe('User question') }))
    .output(z.object({ answer: z.string().describe('AI response') }))
    .build()
);

const sig = s('question:string, context:string[] -> answer:string');
const myAgent = agent('userInput:string -> response:string', {
  agentIdentity: { name: 'helper', description: 'A helpful assistant' },
});

const wf = flow<{ input: string }, { output: string }>()
  .node('step1', 'input:string -> output:string')
  .execute('step1', (state) => ({ input: state.input }))
  .returns((state) => ({ output: state.step1Result.output }));

// Native fluent function tool.
const tool = fn('search')
  .description('Search the web')
  .arg('query', f.string('Search query'))
  .returns(f.string('Search results'))
  .handler(({ query }) => searchWeb(query))
  .build();

// Standard Schema function tool.
const zodTool = fn('calculateTax')
  .description('Calculate tax for an amount')
  .arg(z.object({
    amount: z.number().positive().describe('Pre-tax amount in USD'),
    region: z.enum(['US', 'EU', 'UK']).describe('Tax region'),
  }))
  .returns(z.object({ tax: z.number(), total: z.number() }))
  .handler(async ({ amount }) => ({ tax: amount * 0.1, total: amount * 1.1 }))
  .build();
```

## Running and Forward Types

```typescript
const result = await gen.forward(llm, { question: 'What is 2+2?' });

for await (const chunk of gen.streamingForward(llm, { question: 'Tell a story' })) {
  if (chunk.delta.answer) process.stdout.write(chunk.delta.answer);
}
```

Programs use `forward(ai, values, options?)` and `streamingForward(ai, values, options?)`. For AI service type `T`, use forward-option types, not constructor options:

| Program | Forward options | Streaming options |
| --- | --- | --- |
| `AxGen` | `AxProgramForwardOptionsWithModels<T>` | `AxProgramStreamingForwardOptionsWithModels<T>` |
| `AxAgent` | `AxAgentForwardOptions<T>` | `AxAgentStreamingForwardOptions<T>` |
| `AxFlow` | `AxFlowForwardOptions<T>` | `AxProgramStreamingForwardOptionsWithModels<T>` |

`forward()` returns `Promise<OUT>`; `streamingForward()` returns `AxGenStreamingOut<OUT>` with `{ version, index, delta }` chunks. Agent inputs can include a per-run `memories` array. `AxAgentOptions<IN>` constructs an agent; it is not a forward-call option type.

- `AxGen` exposes `setExamples(...)`, `addAssert(...)`, `addStreamingAssert(...)`, `addFieldProcessor(...)`, `addStreamingFieldProcessor(...)`, and `stop()`. See [generator callback contracts](references/gen.md).
- `AxAgent.getFunction()` exposes a child-agent tool and requires `agentIdentity` at construction. See [agents](references/agent.md).
- `AxFlow` defines nodes with `.node(...)`, runs them with `.execute(...)`, and selects outputs with `.returns(...)`. See [flows](references/flow.md).

## Forward Options

Provider capabilities determine applicable outputs and options. Typesafe/Jev and OpenAI Decisions support required boolean/class/rubric score signatures. Jev additionally supports PNG/JPEG image inputs with native Box localization outputs; OpenAI Decisions supports image inputs but not Box outputs, so provider capabilities are not uniform. Use `(evidence)` or `.withEvidence()` for probabilities, scores, and native confidence through AxGen; provenance distinguishes native from elicited evidence. Use native clients for advanced request shapes and generative providers for prose or tools. Read [Typesafe/Jev](references/typesafe.md) before applying these general generation options to Jev.

| Goal | Option | Example |
| --- | --- | --- |
| Model override | `model` | `{ model: 'gpt-5.4-mini' }` |
| Temperature | `modelConfig.temperature` | `{ modelConfig: { temperature: 0.8 } }` |
| Max tokens | `modelConfig.maxTokens` | `{ modelConfig: { maxTokens: 500 } }` |
| Retry on failure | `maxRetries` | `{ maxRetries: 3 }` |
| Max agent steps | `maxSteps` | `{ maxSteps: 10 }` |
| Fail fast | `fastFail` | `{ fastFail: true }` |
| Thinking budget | `thinkingTokenBudget` | `{ thinkingTokenBudget: 'medium' }` |
| Show thoughts | `showThoughts` | `{ showThoughts: true }` |
| Context caching | `contextCache` | `{ contextCache: { cacheBreakpoint: 'after-examples' } }` |
| Multi-sampling | `sampleCount` | `{ sampleCount: 5 }` |
| Debug logging | `debug` | `{ debug: true }` |
| Abort signal | `abortSignal` | `{ abortSignal: controller.signal }` |
| Memory | `mem` | `{ mem: new AxMemory() }` |
| Stop function | `stopFunction` | `{ stopFunction: 'finalAnswer' }` |
| Function mode | `functionCallMode` | `{ functionCallMode: 'auto' }` |

## Global Defaults and Runtime Hooks

`axGlobals` supplies live defaults for future AI, AxGen, and AxFlow calls:

```typescript
import { axGlobals, axCreateDefaultColorLogger } from '@ax-llm/ax';
import { metrics, trace } from '@opentelemetry/api';

axGlobals.rateLimiter = async (next, info) => next();
axGlobals.tracer = trace.getTracer('my-app');
axGlobals.meter = metrics.getMeter('my-app');
axGlobals.debug = true;
axGlobals.logger = axCreateDefaultColorLogger();
```

Hook precedence: forward/direct-call hooks → enclosing program defaults → child-program defaults → AI-service hooks → globals snapshotted at operation start. Hooks are native run-scoped values, excluded from AxIR JSON state, cache keys, exported state, traces, and optimizer artifacts. Agent and flow forwards propagate them through every internal generator/model call without mutating children or leaking across concurrent runs. Limiter failures propagate; tracer, meter, and usage-observer failures are fail-open. `customLabels` merge by precedence. Combined `abortSignal` values permit either global or local cancellation.

## Memory and Examples

Reuse `AxMemory` across turns:

```typescript
const conversation = ax('userMessage:string -> response:string');
const memory = new AxMemory();
await conversation.forward(llm, { userMessage: 'My name is Alice' }, { mem: memory });
const r = await conversation.forward(llm, { userMessage: 'What is my name?' }, { mem: memory });
```

Supply few-shot examples with `setExamples(...)`:

```typescript
const classifier = ax('reviewText:string -> sentiment:class "positive, negative, neutral"');
classifier.setExamples([
  { reviewText: 'I love this!', sentiment: 'positive' },
  { reviewText: 'Terrible.', sentiment: 'negative' },
  { reviewText: 'It works.', sentiment: 'neutral' },
]);
```

## Common Patterns

### Classification

```typescript
const classifier = ax(
  f()
    .input('text', f.string())
    .output('category', f.class(['spam', 'ham', 'uncertain']))
    .output('confidence', f.number().min(0).max(1))
    .build()
);
```

### Extraction

```typescript
const extractor = ax(
  f()
    .input('text', f.string())
    .output('entities', f.object({
      people: f.string().array(),
      organizations: f.string().array(),
      locations: f.string().array()
    }))
    .build()
);
```

### Images

```typescript
const analyzer = ax(
  f()
    .input('image', f.image('Image to analyze'))
    .input('question', f.string('Question').optional())
    .output('description', f.string())
    .output('objects', f.string().array())
    .build()
);

const result = await analyzer.forward(llm, {
  image: { mimeType: 'image/jpeg', data: base64Data },
  question: 'What objects are in this image?'
});
```

### Chaining Generators

```typescript
const researcher = ax('topic:string -> research:string, keyFacts:string[]');
const writer = ax('research:string, keyFacts:string[] -> article:string');
const research = await researcher.forward(llm, { topic: 'AGI' });
const draft = await writer.forward(llm, { research: research.research, keyFacts: research.keyFacts });
```

## Errors and Debugging

```typescript
import { AxGenerateError, AxAIServiceError, AxAIServiceAbortedError } from '@ax-llm/ax';

try {
  const result = await gen.forward(llm, { question: 'test' });
} catch (error) {
  if (error instanceof AxGenerateError) {
    console.error('Generation failed:', error.details.model, error.details.signature);
  } else if (error instanceof AxAIServiceAbortedError) {
    console.log('Request was aborted');
  } else if (error instanceof AxAIServiceError) {
    console.error('AI service error:', error.message);
  }
}
```

Use per-call logging and OpenTelemetry hooks, or live app-wide defaults:

```typescript
import { axCreateDefaultColorLogger, axGlobals } from '@ax-llm/ax';

const result = await gen.forward(llm, { question: 'test' }, {
  debug: true,
  logger: axCreateDefaultColorLogger(),
  tracer: openTelemetryTracer,
  meter: openTelemetryMeter,
});
axGlobals.tracer = openTelemetryTracer;
axGlobals.meter = openTelemetryMeter;
```

## MCP Integration

See [MCP](references/mcp.md) for native clients, transports, authentication, catalogs, tasks, subscriptions, events, and replay.

```typescript
import { AxMCPClient, agent } from '@ax-llm/ax';
import { AxMCPStdioTransport } from '@ax-llm/ax-tools';

const transport = new AxMCPStdioTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
});
const mcpClient = new AxMCPClient(transport, { namespace: 'memory' });

// Initialize native MCP context once; all agent stages inherit it.
const myAgent = agent('userMessage:string -> response:string', {
  mcp: mcpClient,
  functionDiscovery: true,
  contextFields: [],
});
const result = await myAgent.forward(llm, { userMessage: 'Remember this.' });
await mcpClient.close(); // Caller-owned clients remain caller-owned.
```

### Remote HTTP Transport

```typescript
import { AxMCPStreamableHTTPTransport } from '@ax-llm/ax';

const transport = new AxMCPStreamableHTTPTransport('https://remote.example/mcp', {
  headers: { 'x-pd-project-id': projectId },
  authorization: `Bearer ${accessToken}`,
});
```

### Native MCP and UCP Behavior

- Pass `mcp` and `ucp` to AxGen, streaming AxGen, chat, AxAgent, AxFlow, optimization, or evaluation options.
- `mcpContext` injects attributed prompts/resources before the first model call.
- `mcpInheritance: 'all' | 'none' | string[]` restricts child programs.
- Tool calls retain raw MCP content, metadata, errors, tasks, and protocol provenance in memory.
- AxAgent exposes native modules as `mcp.<namespace>` and `ucp.<namespace>`.
- `inspectCatalog()` discovers tool/prompt names, concrete resources, and URI templates from only an endpoint. Resource event sources subscribe to nothing by default; require an explicit all/URI/selector policy.
- `toFunction()` is only a compatibility adapter; native Ax execution never uses it.
- Live optimization is rejected by default. Use recording/replay or explicitly opt into live MCP evaluation.

```typescript
const catalog = await mcpClient.inspectCatalog();
const tools = catalog.tools;
const prompts = await mcpClient.listPrompts();
const resource = await mcpClient.readResource('docs://guide');
const tasks = await mcpClient.listTasks();
```

### Function Overrides

```typescript
const mcpClient = new AxMCPClient(transport, {
  functionOverrides: [
    { name: 'search_documents', updates: { name: 'findDocs', description: 'Search docs' } }
  ]
});
```

## Event-Driven Programs

Use `eventRuntime()` for notifications, webhooks, timers, or remote tasks that wake/resume an Ax program. Sources publish to an inbox; explicit routes select `observe`, `invalidate`, `wake`, or `resume`. Event payloads are never inserted automatically as user messages. See [event runtime](references/event-runtime.md).

## Resources

Fetch full working examples as needed:

- [Standard Schema (zod)](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/standard-schema.ts): zod with `f()` and `fn()`.
- [Chat Log](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/chat-log.ts): conversation history and multi-step tool calls.
- [Marketing](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/marketing.ts): product use case.
- [MCP Integration](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/mcp-client-memory.ts): MCP integration.
- [Original Typesafe/Jev guidance](https://github.com/ax-llm/ax/blob/main/src/ax/skills/ax-typesafe.md): upstream resource; local guidance is [Typesafe/Jev](references/typesafe.md).
