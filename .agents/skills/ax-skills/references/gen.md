# AxGen execution, streaming, and validation

Use for `ax()`, `AxGen`, `forward()`, `streamingForward()`, structured outputs, assertions, processors, hooks, and self-tuning. Source snapshot: Ax 25.4.9. Prefer short, modern, copyable code; add tutorial prose only when requested. Use [signature reference](references/signature.md) for field contracts, [AI reference](references/ai.md) for providers, [refine reference](references/refine.md) for reward-scored selection, [MCP reference](references/mcp.md) for MCP construction/transports/prompts/resources/tools/tasks/subscriptions/authentication/events, and [event runtime reference](references/event-runtime.md) for wake/resume routing.

## Construction and execution defaults

- Use `ax(...)`, not `new AxGen(...)`.
- Pass an `ai(...)` instance as `forward()`'s first argument, never raw API keys/configuration.
- Stream with `streamingForward()`, not `forward()` with a stream option.
- Use schemas for field shape/constraints, `addAssert()` for whole-output hard invariants, and `addStreamingAssert()` for partial-output hard invariants. Streaming assertions are not reward/refine mechanisms.
- Use `bestOfN()` / `refine()` for reward-scored complete outputs.
- Multi-step execution continues until all outputs are filled, a stop function fires, or `maxSteps` is reached; do not assume one LLM call.
- Hook mutations are queued, then consumed at defined boundaries: `beforeStep` changes apply before the current generation step's initial request, not every provider request or retry; `afterFunctionExecution` / `afterStep` changes apply before the next step's initial request.

```typescript
import { ai, ax, s } from '@ax-llm/ax';

const llm = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
});

const gen = ax('userMessage:string -> assistantReply:string, reasoning:string');
const sig = s('question:string, context:string[] -> answer:string');
const gen2 = ax(sig);
const gen3 = ax('userMessage -> assistantReply', {
  description: 'A helpful assistant',
  maxRetries: 3,
  maxSteps: 10,
  modelConfig: { temperature: 0.7 },
});

const result = await gen.forward(llm, { userMessage: 'Hello world' });
console.log(result.assistantReply);
```

### Standard Schema signatures and tools

`ax()` accepts `f().build()` signatures. `f().input()` / `.output()` accept [Standard Schema v1](https://standardschema.dev) validators (zod, valibot, arktype), per-field or whole-object:

```typescript
import { z } from 'zod';
import { ax, f } from '@ax-llm/ax';

const gen = ax(f()
  .input(z.object({
    productName: z.string(),
    buyerProfile: z.string(),
  }))
  .output(z.object({
    headline: z.string(),
    recommendation: z.string().refine((value) => ['buy', 'wait', 'skip'].includes(value), 'Use buy, wait or skip'),
  }))
  .build());
```

Constraints (`.min()`, `.email()`, `.regex()`) and custom `.refine()`, `.transform()`, `.superRefine()` run in normal validation/retries at parse time on complete field values, including streaming field boundaries. Ax hints use companion options: `.input('ctx', z.string(), { cache: true })`, `.output('reasoning', z.string(), { internal: true })`.

**Pinned Zod 4 enum-conversion defect (not a blanket Standard Schema limitation):** the bundled guide's whole-object `z.enum(...)` example fails during signature construction with Ax 25.4.9 and Zod 4.1.11. The [Ax converter](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/standardSchema.ts#L228-L235) reads `def.values`, while [Zod 4.1.11](https://github.com/colinhacks/zod/blob/v4.1.11/packages/zod/src/v4/classic/schemas.ts#L1545-L1557) stores enum values in `def.entries`; the resulting empty class options are rejected. The refined string above preserves runtime membership validation but does not advertise an enum in the converted prompt/schema. For a native Ax enum contract use `.output('recommendation', f.class(['buy', 'wait', 'skip'] as const))`. The [standard-schema example](examples/01-signatures.ts) explicitly asserts the rejected original boundary, exercises corrected whole-object string/refinement validation and separately executes the native `f.class` alternative. It does not claim the original Zod enum path succeeds.

`fn().arg()` / `.returns()` accept per-argument or whole-object schemas and infer handler argument types:

```typescript
import { z } from 'zod';
import { ax, fn } from '@ax-llm/ax';

const lookupProduct = fn('lookupProduct')
  .description('Look up a product by name')
  .arg(z.object({
    productName: z.string().min(1),
    includeSpecs: z.boolean().optional(),
  }))
  .returns(z.object({
    price: z.number(),
    inStock: z.boolean(),
    rating: z.number().min(1).max(5),
  }))
  .handler(async ({ productName, includeSpecs }) => ({
    price: 79.99, inStock: true, rating: 4.3,
  }))
  .build();

// Supply the input values required by gen's signature.
const result = await gen.forward(llm, {
  productName: 'Headphones', buyerProfile: 'Commuter',
}, { functions: [lookupProduct] });
```

## Forward calls, defaults, and option precedence

```typescript
const result = await gen.forward(llm, { userMessage: 'Hello world' });
const configuredResult = await gen.forward(llm, { userMessage: 'Hello world' }, {
  maxRetries: 5,
  model: 'gpt-5.4-mini',
  modelConfig: { temperature: 0.9, maxTokens: 1000 },
  debug: true,
});
```

### Live global defaults

```typescript
import { axGlobals } from '@ax-llm/ax';
import { trace } from '@opentelemetry/api';

const responseCache = new Map<string, any>();
axGlobals.rateLimiter = async (next, info) => next();
axGlobals.tracer = trace.getTracer('my-app');
axGlobals.debug = true;
axGlobals.cachingFunction = async (key, value?) => {
  if (value !== undefined) {
    responseCache.set(key, value);
    return;
  }
  return responseCache.get(key);
};
```

- Runtime-hook precedence: forward options → generator options → AI service options → globals snapshotted at run start.
- Forward-scoped `rateLimiter`, `tracer`, `meter` reach every retry/provider call without serialization or generator mutation; concurrent forwards remain isolated.
- Limiter failures propagate; tracer/meter failures are ignored. Telemetry contains metadata, not prompts, outputs, or tool payloads.
- Global `abortSignal` merges with local forward signals. `customLabels` merge globals → AI service → forward options.
- `cachingFunction` / `functionResultFormatter` fall back to current globals when local options are absent.
- For agent-specific usage/callback telemetry, see [agent observability reference](references/agent-observability.md).

### Constructor defaults

Provider-facing forward options merge with constructor defaults before chat; per-call values win. This includes `promptCacheKey`, `sessionId`, `contextCache` in TypeScript and every generated language package.

Constructor forward options default every call, including:
- `model`, `modelConfig`, `sampleCount`, `showThoughts`, `thinkingTokenBudget`, `stepHooks`, `onFunctionCall`, `disableMemoryCleanup`, `selfTuning`, `asyncMode`, `resultPicker`, `strictMode`, `maxRetries`, `maxSteps`.
- Run options: `control`, `stream`, `sessionId`, `abortSignal`, `timeout`, `fetch`, `webSocket`, `traceContext`, `executionPath`, `eventContext`, `speech`.
- Service options passed to provider chat: `serviceTier`, `verbose`, `beta`, `corsProxy`, `includeRequestBodyInErrors`, `promptCacheRetention`, `excludeContentFromTrace`.

`modelConfig` and `customLabels` merge key by key: constructor `{ temperature: 0.2 }` plus call `{ maxTokens: 500 }` sends both. Constructor `control` applies to every forward and skips cache, as call-scoped control does. The `stream` option's default inheritance does not replace the requirement to use `streamingForward()` for streaming generation.

## Streaming output and replacement versions

```typescript
const stream = gen.streamingForward(llm, { userMessage: 'Write a long story' });
for await (const chunk of stream) {
  if (chunk.delta.assistantReply) process.stdout.write(chunk.delta.assistantReply);
}
```

- Chunks are `{ version, index, delta }`. Merge per `index`: append strings/arrays; replace other values. Reset accumulated output when `version` changes.
- Versions never decrease. Validation/refusal retries and later steps replacing already-emitted output (such as processor feedback) start a new version; thought accumulated so far is re-emitted.
- In TypeScript, partial JSON repair preserves string text such as `, t`, `, n`, trailing punctuation, and commas before brackets inside strings. Structural repair applies outside strings so these fragments do not change into literals or repeat in merged deltas. [PR #862](https://github.com/ax-llm/ax/pull/862) aligns partial-JSON string and escaped-quote repair across generated Python, C++, Rust, Go, and Java ports; this is a scoped repair-parity claim, not blanket streaming parity.
- Streamed `code` drops fences regardless of chunk split. Incomplete possible fences and partial labels are held back so merged deltas equal non-streaming values.
- Text labels are case-sensitive and signature-derived: `javascriptCode` is titled `Javascript Code`, not `JavaScript Code`. Match that label (or the exact field name) and its colon before testing code-fence stripping; otherwise singleton fallback can preserve the unmatched label as content. See the [code-and-json-deltas example](examples/03-tools-streaming.ts).
- Deltas never end in half a surrogate pair: a trailing high surrogate waits for its low half.
- Error/token-limit terminal results are rejected even if the final chunk is empty and earlier chunks already form valid output.

## Stopping and cancellation

```typescript
import { AxAIServiceAbortedError } from '@ax-llm/ax';

const timer = setTimeout(() => gen.stop(), 3_000);
try {
  const result = await gen.forward(llm, { topic: 'Long document' }, {
    abortSignal: AbortSignal.timeout(10_000),
  });
} catch (err) {
  if (err instanceof AxAIServiceAbortedError) console.log('Aborted');
}
```

`gen.stop()` gracefully stops multi-step execution at the next boundary; `abortSignal` immediately cancels the underlying AI service call. Catch `AxAIServiceAbortedError` for either mechanism.

## Validation, selection, and hard guards

```typescript
import { ax, bestOfN, f } from '@ax-llm/ax';
import { z } from 'zod';

const gen = ax(f()
  .input('topic', z.string().min(1))
  .output('summary', z.string().min(50))
  .build());

const selected = bestOfN(gen, {
  n: 4,
  rewardFn: ({ prediction }) => prediction.summary.length,
});

gen.addAssert(
  (output) => output.summary.includes(topic) || 'Summary must mention the topic.'
);
gen.addStreamingAssert(
  'summary',
  (text) => !text.includes('forbidden'),
  'Output contains forbidden text'
);
```

- Schemas retry with parser/constraint feedback.
- `addAssert()` checks complete parsed output after validation/processors; failures retry with correction feedback. Assertions/processors run on answering steps, not tool-calling steps.
- `bestOfN()` scores complete candidates; returns highest reward or first threshold hit.
- `refine()` runs rounds and can inject reward-derived advice into instruction components between rounds; see [refine reference](references/refine.md).
- `addStreamingAssert()` targets string/code output, receives partial text so far, and fails the current attempt with `AxStreamingAssertionError`; AxGen retries with correction feedback.

## Field processors

```typescript
gen.addFieldProcessor('summary', (value) =>
  String(value).length > 200 ? 'Keep the summary under 200 characters.' : null
);
gen.addStreamingFieldProcessor('content', (partialValue) =>
  String(partialValue).includes('TODO') ? 'Finish every section.' : null
);
```

`addFieldProcessor()` runs once after field completion; `addStreamingFieldProcessor()` runs on every target-field chunk. Results are feedback, not replacement field values. Except `undefined`, `null`, `''`, and strings `"null"` / `"undefined"`, feedback becomes a user message with one text part, causing another step whose answer replaces the prior answer. Streaming feedback waits until step end, follows the full answer, and precedes final-processor feedback.

## Function calling and stop functions

```typescript
const result = await gen.forward(llm, { question: '...' }, {
  functions: tools,
  functionCallMode: 'auto',
  stopFunction: 'finalAnswer',
});
```

- `functionCallMode`: `'auto'` (default), `'native'`, `'prompt'` (prompt emulation).
- **Pinned prompt-tool boundaries:** emit the exact wire keys requested by `<output_fields>`: the [prompt-tools example](examples/03-tools-streaming.ts) uses `lookup_price_product_name: Notebook` for the emulated call and `priceUsd: 12` for the answer, not their display titles. In TypeScript 25.4.9, [`forward()` response handling](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/response/nonStreaming.ts#L77-L175) records parsed emulated calls in memory but executes only the original native `result.functionCalls`. The example validates the actual call name and semantic arguments (params can be an object or JSON string) before classifying missing execution. [`streamingForward()` finalization](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/response/finalize.ts#L161-L211) executes the host handler, then appends the emulated assistant call after the function result; the generator's last-memory-role continuation check therefore ends without requesting the final answer. The example asserts real streamed execution and actual call-ID/result correlation separately from the missing continuation. For a complete host-tool/answer loop in this version, use a provider supporting native functions with `functionCallMode: 'native'`; the same example proves that control with the same handler and a grounded final price. These are version-bound prompt-emulation limitations, not universal lack of tool support.
- `functionCall`: `'auto'`, `'none'`, `'required'`, or `{ type: 'function', function: { name: 'search' } }` for a forced named call.
- Forced `'required'` / named calls apply only on the first step. Subsequent steps remove the force and tools to allow an answer. In the `function` structured-output rung, the forced step omits `__axOutput` so forcing reaches a user tool.
- `stopFunction` accepts string or string[]; matching calls halt multi-step without an answer. Output retains every step's thought, including the stop step, streamed or not.
- Otherwise continue until outputs are filled or `maxSteps` is reached.
- In TypeScript AxGen, an unknown function name receives a result for its own call ID with `isError: true` and the available registered names. Its plain error text bypasses `functionResultFormatter`; valid results still use that formatter. Valid sibling calls run normally and their completed results remain in history; every call ID in that batch is answered before the next model request, allowing correction on the next step without discarding successful results. This applies to `forward()` and `streamingForward()`.
- Unknown-name recovery does not swallow arbitrary validation/runtime failures or authorize replaying completed effects. Unexpected handler and result-formatter errors still fail the run; application code owns authorization, idempotency and replay policy.
- For 25.4.9, [PR 883](https://github.com/ax-llm/ax/pull/883) reports TypeScript-derived fixture conformance in generated Python, Java, C++, Go, and Rust for unknown calls first, middle, last, or alone in both forward modes: call ID, plain error text, error flag, formatter bypass, and continued sibling execution. Generated clients already continued such batches; this release removes JSON wrapping of the unknown-call error. This bounded source evidence is not a blanket generated-port or agent/RLM parity guarantee.

## Response/context caching and sampling

```typescript
const gen = ax('question:string -> answer:string', {
  cachingFunction: async (key, value?) => {
    if (value !== undefined) {
      await cache.set(key, value);
      return;
    }
    return await cache.get(key);
  },
});
const result = await gen.forward(llm, { question: '...' }, {
  contextCache: { cacheBreakpoint: 'after-examples' },
});
```

`cachingFunction(key)` reads; `(key, value)` writes. Both `forward()` and `streamingForward()` store finished results, with or without result pickers. `contextCache` enables provider prompt caching for long context. Constructor/call merging follows the defaults section; run control bypasses cache.

```typescript
const result = await gen.forward(llm, { question: '...' }, {
  sampleCount: 3,
  resultPicker: async (samples) => {
    // Evaluate the samples and return the selected sample index.
    return bestIndex;
  },
});
```

`sampleCount` generates completions in parallel; `resultPicker` receives all samples and must return the chosen index.

## Extended thinking

```typescript
const result = await gen.forward(llm, { question: '...' }, {
  thinkingTokenBudget: 'medium',
  showThoughts: true,
});
console.log(result.thought);
```

`thinkingTokenBudget` accepts `'none'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'highest'`. Numeric provider configuration is only for models exposing numeric budgets, such as Gemini 2.5; Gemini 3 uses model-aware levels. `showThoughts: true` includes reasoning in `result.thought`.

## Structured outputs and provider capability rungs

In TypeScript, providers advertising `requiresStructuredOutput` (for example Typesafe) automatically receive schemas even for scalar-only signatures. Ax renders JSON instructions/examples and parses objects without changing the signature. Typesafe/OpenAI Decisions support required boolean, class, and ordered rubric score outputs. Value descriptions become native criteria; conventional providers receive readable prompt/schema descriptions. See [Typesafe reference](references/typesafe.md) for native questions, thresholds, hybrid text generation; original resource: [ax-typesafe](https://github.com/ax-llm/ax/blob/main/src/ax/skills/ax-typesafe.md). Providers disabling native functions and `functionEmulation` reject tool-bearing programs before rendering prompts.

```typescript
const sig = f()
  .input('articleText', f.string())
  .output('summary', f.string())
  .output('metadata', f.json().optional())
  .useStructured()
  .build();
```

- `.useStructured()` requests native schema-constrained JSON where supported, including OpenAI, Anthropic, Gemini.
- Prompt contracts retain exact wire keys, required/optional status, types, constraints, nested shapes, even when provider capability fallback occurs.
- `structuredOutputMode: 'auto'` follows the profile/model's ordered `structuredOutputModes`. Exact caller `modelInfo` overrides beat profile model rules/defaults.
- Without native schema support, one required non-array string/code output can use provider-neutral `json_object`, exact-shape prompts, client validation, bounded correction retries; no provider-visible tools required.
- Richer shapes use the first advertised rung. `json_object` never sends synthetic `__axOutput`; exact-shape prompts, strict parsing, correction retries remain.
- Declared tools/forced `functionCall` never change `auto` rung selection. Explicitly choose `'function'` to answer through `__axOutput` alongside tools.
- Ax advertises only `__axOutput`, accepts legacy inbound `__finalResult` for stored-trajectory replay, and rejects user-function collisions with either reserved name.
- `'native'` requires native schema enforcement; unsupported requirements error rather than silently weaken.
- `'function'` requires function arguments; unavailable function calling errors before requests.
- Meta profiles require the sole Ax output tool with an unnamed choice; this does not enable unsupported caller-named tool choices.
- `'json_object'` requires verified JSON object capability for rich or singleton outputs; unsupported profile/models error before transport.
- Direct `json_schema` / `json_object` chat requests validate their respective capabilities independently. `structuredOutputs` aliases native JSON Schema only.
- Chat-log provenance records `providerMetadata.ax.structured_output_rung`: `native`, `function`, `json_object`.
- Native schemas mark every object property required, set `additionalProperties: false`, and represent optional fields with nullable types.
- Flexible `json` / unshaped `object` values become JSON-encoded native-schema strings, parsed back to JavaScript values.
- Values must match declared types. Numeric strings become numbers; `"true"` / `"false"` become booleans as in text contracts. Other mismatches (number for string, string for array, invalid class value) fail validation and retry with correction.
- Streaming rejects error/token-limit terminal results even when prior chunks form valid output and the last chunk has no content.

## Step hooks and pending mutation

```typescript
const result = await gen.forward(llm, values, {
  stepHooks: {
    beforeStep: (ctx) => {
      if (ctx.functionsExecuted.has('complexanalysis')) {
        ctx.setModel('smart');
        ctx.setThinkingBudget('high');
      }
    },
    afterStep: (ctx) => {
      console.log(`Usage: ${ctx.usage.totalTokens} tokens`);
    },
  },
});
```

Read-only `AxStepContext`:
- `stepIndex`: current step number; `maxSteps`: configured maximum; `isFirstStep`: first-step flag.
- `functionsExecuted`: `Set<string>` of called names; `lastFunctionCalls`: most recent call results.
- `usage`: token statistics; `state`: current step state.

Mutators:
- `setModel(model)`: select model; `setThinkingBudget(budget)`: thinking budget.
- `setTemperature(temp)`, `setMaxTokens(max)`: temperature/output-token limit.
- `setOptions(opts)`: arbitrary forward options.
- `addFunctions(fns)`: add functions; `removeFunctions(...names)`: remove by name (rest arguments, not an array).
- `stop()`: terminate after an executed step; observe the pinned early-stop/result-value limitation below.

Mutations are queued. `beforeStep` runs once per generation step, before its initial provider request; TypeScript 25.4.9 immediately consumes its mutations before that request. Infrastructure and validation retries within the step can issue additional provider requests without rerunning `beforeStep`, so it is not a per-request budget-enforcement hook. `afterFunctionExecution` / `afterStep` mutations wait for the next iteration's boundary. Use `afterFunctionExecution` to react to specific function results. `state` is an application-owned mutable `Map`, not a pending-options mutator.

**Pinned source/guide disagreement:** the bundled official guide says all hook mutations apply at the next step boundary. The actual [25.4.9 generator source](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/generate.ts#L2399-L2457) consumes prior mutations near the loop start, and calls `applyStepContextMutations()` immediately after `await stepHooks.beforeStep(stepContext)`. The [25.4.9 context type](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/types.ts) declares `removeFunctions(...names: string[])`. These TypeScript source contracts take precedence over the guide's blanket timing statement and array-like pseudocode. The offline `28-advanced-generation/hook-timing` case captures actual provider requests to make both boundaries observable; it does not establish generated-language parity.

**Pinned hook-stop limitation:** [`AxStepContext.stop(resultValues)`](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/stepContext.ts#L107-L110) stores stop values and exposes `_stopValues`, but the 25.4.9 generator never consumes those values. A `beforeStep` stop [breaks the outer loop](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/generate.ts#L2450-L2457), reaching its [unconditional max-steps error](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/generate.ts#L3147-L3164) without a provider call. An `afterStep` stop can prevent subsequent work and retain already-emitted output, but cannot replace it with supplied stop values. The [cancellation example](examples/28-advanced-generation.ts) keeps the early-stop error explicit, demonstrates the ignored override on an emitted answer, and independently covers actual `gen.stop()` cancellation, pre-aborted run control and successful non-aborted completion. These bounded hook defects do not make ordinary aborts or all hook mutations unsupported.

## Self-tuning

```typescript
const result = await gen.forward(llm, values, { selfTuning: true });
const granularResult = await gen.forward(llm, values, {
  selfTuning: {
    model: true,
    thinkingBudget: true,
    functions: [searchWeb, calculate],
  },
});
```

`true` injects `adjustGeneration` with model and thinking-budget controls; it does not optimize invisibly or prove improved quality. Model selection, including the default for `true`, requires an AI `models` list with **at least two chat entries** (`model`, not `embedModel`), checked by the [25.4.9 generator](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/generate.ts#L1983-L2008). Pass a configured entry's **key** to the tool's `model` argument; the [self-tuning tool](https://github.com/ax-llm/ax/blob/25.4.9/src/ax/dsp/selfTuning.ts#L32-L53) builds its enum from those keys. Granular configuration tunes aspects independently; `selfTuning.functions` supplies a pool the tuner may add/remove per step. The [self-tuning example](examples/28-advanced-generation.ts) configures two actual fixture chat entries and captures a model-key switch in both modes, without provider calls; it does not disable model selection to bypass the requirement.

## Errors and strict labels

```typescript
import { AxGenerateError } from '@ax-llm/ax';
try {
  const result = await gen.forward(llm, { userMessage: 'Hello world' });
} catch (error) {
  if (error instanceof AxGenerateError) {
    console.log(error.details.model, error.details.signature);
  }
}
```

- `AxGenerateError.details` contains `model`, `signature`.
- Failed forwards use `Generate failed: <reason>` with wrapped error as `cause`. Exhausted validation/assertion/refusal retries use `Generate failed: Unable to fix validation error: <last error>`, ending with `LLM Output:` and last-attempt answers (samples joined with `---`).
- Token-limit truncation fails with `Generate failed: Max tokens reached before completion`, streamed or not.
- A refusal retry removes the refused assistant turn and resends from the same user or function-result message, including when refusal follows already-streamed partial content. This request-history cleanup does not undo text already presented to the caller; apply the streaming version-reset rules.
- Wrapping follows type, not message: `ValidationError` / `AxAssertionError` outside retries surface unchanged; other failures wrap regardless of message.
- `stop()` / `abortSignal` cancellation throws `AxAIServiceAbortedError`.
- Constructor/call `strictMode: true` requires the answer to start with its first required field's label. Unlabeled answers retry with correction instead of being treated as single-field answers; call value wins.

## Normalized chat logs and usage

`gen.getChatLog()` returns every `ai.chat()` round-trip after `forward()` or `streamingForward()`: system prompt, all messages, model responses. Logs reset at each `.forward()` start; multi-step tool generators produce one entry per step.

```typescript
await gen.forward(llm, { question: 'What is 2+2?' });
for (const entry of gen.getChatLog()) {
  console.log('model:', entry.model);
  for (const msg of entry.messages) {
    console.log(`[${msg.role}]`, msg.content);
  }
  console.log('tokens:', entry.modelUsage?.tokens);
}

type AxChatLogMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string };

type AxChatLogEntry = {
  name?: string;
  model: string;
  messages: AxChatLogMessage[];
  modelUsage?: AxProgramUsage;
};

// Return contract:
// gen.getChatLog(): readonly AxChatLogEntry[]
```

Assistant content uses inline `<think>...</think>` for reasoning and `<tool_call>\n{...}\n</tool_call>` for invocations. System messages include a `<tools>` JSON block when functions exist.

`getUsage()` returns `AxProgramUsage[]` aggregated by `(ai, model)` across steps. Provider cache reports split uncached `promptTokens` from `cacheReadTokens` / `cacheCreationTokens`. `resetUsage()` clears usage:

```typescript
const usage = gen.getUsage();
console.log(usage[0]?.tokens?.promptTokens);
gen.resetUsage();
```

`AxAgent` / `AxFlow` also return flat `AxChatLogEntry[]`; composite programs set `entry.name` for node/stage filtering. See [agent reference](references/agent.md) and [flow reference](references/flow.md).

## Native MCP/UCP attachment

Use [MCP reference](references/mcp.md) for client construction, transports, authentication, catalogs/tasks, subscriptions, event routing, recording/replay. AxGen accepts live clients in constructor/forward options:

```typescript
const gen = ax('question:string -> answer:string', { mcp: [docs, search] });
const result = await gen.forward(llm, { question }, {
  mcpContext: [
    { client: 'docs', resource: { uri: 'docs://guide' } },
  ],
});
```

Models receive native tool definitions. Structured, image, audio, resource-link, embedded-resource, metadata, task, error results remain preserved until provider adapters map supported content. MCP progress/task streaming events remain separate from Ax output. Never use `toFunction()` for native integration.

With endpoint-only configuration, `client.inspectCatalog()` discovers server tool/prompt names, concrete resource URIs, and URI templates. Event sources require explicit none/all/URI/selector resource subscription policies; they never implicitly create wake routes.

Under event targets, required task-backed tools automatically register owning `namespace:taskId` continuations. `AxMCPEventSource` plus `axMCPEventRoutes` observe progress and resume targets on `input_required` or terminal states.

## Event targets and input mapping

Wrap with `eventTarget('id').program(gen).ai(ai).input(...).build()` for explicit wake/resume routes. Use segment-safe `eventPath` selectors; projection/explicit fields are validated against the generator signature before invocation. `.wakeInput()` and `.resumeInput()` separate action contracts. Streaming targets persist each chunk before optional chunk sinks and final results before final sinks.

Use reusable `eventInput().project(...).field(...)` for callback-free mapping. Callback `mapInput` results are cloned, stripped to declared generator inputs, and signature-validated before the first model call; mapper exceptions cause non-retryable `event_input_invalid` deliveries. See [event runtime reference](references/event-runtime.md).

## Automatic sessions in TypeScript

Declare independent host tools with `.execution('background')`. AxGen uses supported async sessions automatically, submits results, and validates final answers after pending work. `asyncMode: 'off'` selects the ordinary loop. Attach `runControl()` via `{ control }` for steering, reasoning updates, cancellation.

Session streaming is provisional until completion. Each response streams ordinary chunks; later responses after tool results or corrections start a new version. Reset accumulation on version changes; final outputs still pass field validation/assertions. Streaming assertions run before provisional text emits; correction prompts preserve partial answers as in plain streams. Assertions may correct before tools begin; once host work starts, mid-stream assertions fail the run without replaying that work.

Automatic tool/controller-attached runs resolve and pin a router/balancer provider before execution. Mixed balancers use sessions only if the selected provider supports them. Chat-only providers (`.chat()`) use the ordinary loop.

Generated-language status: C++ session tools using raw JSON schemas validate required properties/argument types before handlers start. Invalid arguments enter correction; exhausted step limits fail. This is not support for every JSON Schema constraint. Generated-session parity remains open; source checkout resource: `docs/COMPILER.md`.

## Decision model outputs

Boolean/class `.withEvidence()` and `f.score(levels).withEvidence()` retain probabilities/native confidence through `forward()`. String forms: `boolean(evidence)`, `score "Low, Medium, High"(evidence)`. These are normal outputs: processors, assertions, result selection, traces, caches receive decoded evidence. See [decision evidence](references/typesafe.md#evidence-provenance-and-reranking) for shapes, provenance, refusal policy, reranking.

## Novel F1 evaluation

`AxEvalUtil.novelF1ScoreOptimized(history, prediction, groundTruth, returnRecall)` normalizes text, excludes stopwords and history tokens, and measures multiset word overlap between the remaining prediction and ground truth. Each repeated word contributes the minimum of its prediction and ground-truth occurrence counts; repeating a prediction word cannot add matches beyond the ground-truth count.

The default returns F1; passing `true` as `returnRecall` returns recall. Two empty filtered inputs score `1`; exactly one empty filtered input scores `0`. These are filtered-input semantics, including inputs emptied by stopword or history exclusion.

Generated Python, C++, and Rust expose `novel_f1_score`; Go exposes `NovelF1Score`; Java exposes `Ax.novelF1Score`. They share the same Core metric, including Unicode normalization, stopword/history exclusion, multiset overlap, F1/recall selection, and finite empty-input scores. [PR #862](https://github.com/ax-llm/ax/pull/862) preserves TypeScript punctuation and literal-backslash behavior in this cross-port metric work; do not infer a new TypeScript normalization contract.

The official optimization examples score a rationale returned by a real provider. That is a source observation, not evidence of local provider execution. Novel F1 measures lexical novelty overlap, not factual correctness or confidence calibration. It does not replace holistic judging or explicit action invariants; see [metric versus judge](references/agent-optimize.md#metric-versus-judge) for agent optimization.

## Working examples

- [Streaming](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/streaming.ts): field-by-field streaming.
- [Best Of N](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/best-of-n.ts): reward-scored selection.
- [Refine](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/refine.ts): retry rounds with generated feedback.
- [Streaming Assert](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/streaming-asserts.ts): fail-fast partial-output correction.
- [Structured Output](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/structured_output.ts): fluent validation.
- [Debug Logging](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/debug-logging.ts): debug mode/hooks.
- [Stop Function](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/stop-function.ts): stop functions.
- [Fibonacci](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/fibonacci.ts): streaming/thinking.
- [Extraction](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/extract.ts): information extraction.
- [Multi-Sampling](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/sample-count.ts): sample count.
