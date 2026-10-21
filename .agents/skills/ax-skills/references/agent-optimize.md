# AxAgent Optimization and Evaluation

Use for `agent.optimize(...)`, task datasets, judge options, optimization targets, evaluation semantics, delegation tuning, and saved `optimizedProgram` artifacts in `@ax-llm/ax`. Source API snapshot: 25.4.5. Configure a runnable agent first; see [agent authoring](references/agent.md). Generic `ax(...)`/`flow(...)` tuning with top-level `optimize(program, train, metric, options)` belongs in [GEPA](references/gepa.md), not this agent workflow. Keep examples short and copyable; repeat general agent guidance only when needed.

## Defaults and target selection

- Start normal tuning with already-loaded task records containing `input` and concrete `criteria`, the default actor target, and built-in judge. Use a plain task array initially, not separate `train`/`validation` unless a holdout already exists. Do not invent benchmark loaders.
- Better tool use: action-aware tasks with `expectedActions` and `forbiddenActions`; deterministic metric for exact correctness, built-in judge for qualitative behavior.
- Better wording only: consider `target: 'responder'` when the task is not mainly tool selection or clarification. Clarification-heavy tasks are low-signal for responder tuning; do not default to responder-only.
- Whole-agent improvement: start with actor; broaden scope only when requested. Normally omit `target` unless responder-only tuning or explicit program IDs are wanted.
- GEPA-backed optimization tunes generic components exposed by selected target programs: `'actor'` only actor components, `'responder'` only responder components, `'all'` a broader component set.
- Cost, tool use, and delegation improvements require tasks that expose those tradeoffs. Delegation tasks must cover child calls, ordinary tool calls, and direct answers, including realistic call/no-call cases.
- Reusable improvements require artifact save/load. Before/after comparison requires a held-out task, saving/loading, and replay.
- Repair recurring failures without eroding working behavior via `agent.playbook().evolve(dataset)` in TypeScript: mine failures into verified playbook bullets under a held-out gate. Python, Java, C++, Go, and Rust expose the loop with native casing; see [playbooks](references/playbook.md). Optimization maximizes a metric through instructions/demos; evolution grows durable rules.

## Make tasks and agents optimizable

Use a small realistic dataset, concrete criteria rather than “be helpful,” and explicit action expectations for tools, recipients, dates, and side effects. Prefer canonical entity names (“the Atlas project”), not ambiguous “Atlas” that could mean a project/team/account and trigger needless clarification.

Use eval-safe tools or in-memory mocks because tasks replay many times, especially email, scheduling, external APIs, and persistence. Do not use production side effects unless explicitly requested.

- Prefer precise `f.object(...)` outputs over vague `f.json(...)`/free-form JSON when the actor must reason about fields.
- Tell the actor exact usable fields; ban invented hidden IDs/alternate keys when guessing is plausible.
- Declare needed parent values in each child signature and pass them explicitly; never expect children to infer hidden parent state.
- For synthesis, specify narrowed context and fields extracted before a child call. Tell the actor which work stays local.
- Keep `maxSubAgentCalls` small unless testing broad fan-out.
- JS-runtime agents must emit raw runnable JavaScript only: no `javascript:` prefixes, mixed prose/code, or multiple snippets in one turn.
- Good setup combines exact tool fields, an exact entity, explicit child-input extraction, and scoring that penalizes tool misuse/unnecessary delegation. Underspecified JSON, overloaded names, implicit child inputs, and prose mixed into code undermine tuning.

## Metric versus judge

Use deterministic `metric` for directly measurable `prediction`/`example` success: known extraction/classification answers, exact expected/forbidden calls, business scoring, explicit costs, tool/child-call counts, or turn counts. This gives repeatable low-variance optimization.

Novel F1 measures lexical novelty overlap, not factual correctness or confidence calibration. Use it only when that overlap matches the task objective; it does not replace holistic judging or explicit expected/forbidden-action invariants. See [Novel F1 evaluation](references/gen.md#novel-f1-evaluation) for the TypeScript API, native helper names, normalization, repeated-word counts, recall mode, and finite empty-input semantics.

Use the built-in agent judge for practical assistant quality without a trusted metric: open-ended synthesis, nuanced clarifications, tool choices/errors, final-answer quality, and holistic completion. It reviews the full run: completion type, clarification payload, final output, action log, normalized function calls, tool errors, and turn count.

`judgeOptions` mirrors normal forward options; `description` steers priorities such as tool correctness, brevity, groundedness, or policy compliance. Add `judgeAI` and `judgeOptions` for a stronger/separate judge model. `judgeAI` is optional; otherwise the agent uses its configured judge model or runtime model.

A custom `metric` overrides the built-in judge entirely. Do not combine metric and judge guidance unless two scoring systems are explicitly requested and only the metric's optimization role is understood. For custom LLM metrics, keep the schema minimal and prefer numeric `score:number` over fragile string tiers. Outside `agent.optimize(...)`, use a plain typed `AxGen` evaluator; do not introduce dedicated judge classes/helper abstractions.

GEPA teacher calls use `teacherAI`, falling back to the judge model. `judgeOptions` affects only judge calls; an `isExpensive` teacher also needs `teacherOptions: { useExpensiveModel: 'yes' }`.

## Canonical setup, optimization, and artifact replay

The email handler is an eval-safe mock, not a real email side effect. The setup separates student/judge models, uses typed returns and a checkpointed balanced context policy, and persists/applies the optimization.

```typescript
import {
  AxAIGoogleGeminiModel,
  AxJSRuntime,
  agent,
  ai,
  f,
  fn,
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
} from '@ax-llm/ax';

const tools = [
  fn('sendEmail')
    .namespace('email')
    .description('Send an email message')
    .arg('to', f.string('Recipient email address'))
    .arg('body', f.string('Email body text'))
    .returns(
      f.object({
        sent: f.boolean('Whether the email was sent'),
        to: f.string('Recipient email address'),
      })
    )
    .handler(async ({ to }) => ({ sent: true, to }))
    .build(),
];

const studentAI = ai({
  name: 'google-gemini',
  apiKey: process.env.GOOGLE_APIKEY!,
  config: { model: AxAIGoogleGeminiModel.Gemini31FlashLite, temperature: 0.2 },
});

const judgeAI = ai({
  name: 'google-gemini',
  apiKey: process.env.GOOGLE_APIKEY!,
  config: { model: AxAIGoogleGeminiModel.Gemini35Flash, temperature: 1.0 },
});

const assistant = agent('query:string -> answer:string', {
  ai: studentAI,
  judgeAI,
  contextFields: [],
  runtime: new AxJSRuntime(),
  functions: tools,
  contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
  judgeOptions: {
    description: 'Prefer correct tool use over polished wording.',
    model: 'judge-model',
  },
});

const tasks = [
  {
    input: { query: 'Send an email to Jim saying good morning.' },
    criteria: 'Use the email tool and send the message to Jim.',
    expectedActions: ['email.sendEmail'],
  },
];

const result = await assistant.optimize(tasks, {
  maxMetricCalls: 12,
  verbose: true,
});

const saved = axSerializeOptimizedProgram(result.optimizedProgram!);
const restored = axDeserializeOptimizedProgram(saved);
assistant.applyOptimization(restored);
```

The original example also imports `axDefaultOptimizerLogger` but does not use it; it is not required for this pattern. The original `model: 'judge-model'` is retained as an example option, not a provider model recommendation.

## Minimal normal-user pattern

Start here unless a hand-built scorer is needed; the `tasks` above supply realistic input, criteria, and action expectations.

```typescript
const result = await assistant.optimize(tasks);
assistant.applyOptimization(result.optimizedProgram!);
```

`target` defaults to actor; `metric` defaults to the built-in LLM judge. Next, consider `bootstrap: true` for tool-heavy agents to initialize GEPA with successful task traces.

## Deterministic metric pattern

Use for crisp correctness plus cost/behavior tradeoffs, including exact actions, tool/child-call counts, and turn budgets.

```typescript
const result = await assistant.optimize(tasks, {
  target: 'actor',
  metric: ({ prediction, example }) => {
    if (prediction.completionType !== 'final' || !prediction.output) {
      return 0;
    }

    let score = 0;
    if (prediction.output.answer.includes('Jim')) score += 0.4;
    if (
      prediction.functionCalls.some(
        (call) => call.qualifiedName === 'email.sendEmail'
      )
    ) {
      score += 0.4;
    }
    if (prediction.turnCount <= 3) score += 0.2;
    return score;
  },
});
```

## Built-in judge pattern

Use when holistic review must combine final-answer quality with action traces, clarifications, tool errors, and overall completion.

```typescript
const result = await assistant.optimize(tasks, {
  judgeAI,
  judgeOptions: {
    model: AxAIGoogleGeminiModel.Gemini35Flash,
    description:
      'Be strict about unnecessary child-agent calls, weak clarifications, and incorrect tool choices.',
  },
  maxMetricCalls: 12,
});
```

## Plain AxGen judge outside agent optimization

Use only for direct AxGen/flow/other-program optimization, LLM judging without the agent wrapper, or inspecting judge results directly rather than only numeric scores. See [generation](references/gen.md) and [GEPA](references/gepa.md) for those program surfaces.

```typescript
import { AxGen, s } from '@ax-llm/ax';

const judgeGen = new AxGen(
  s(`
    taskInput:json "Task input",
    candidateOutput:json "Candidate output",
    expectedOutput?:json "Optional reference output"
    ->
    score:number "Normalized score from 0 to 1"
  `)
);
judgeGen.setInstruction(
  'Score the candidate output from 0 to 1. Reward correctness and task completion. Return only the score field.'
);

const metric = async ({ prediction, example }) => {
  const result = await judgeGen.forward(judgeAI, {
    taskInput: example,
    candidateOutput: prediction,
    expectedOutput: example.expectedOutput,
  });
  return Math.max(0, Math.min(1, result.score));
};

const result = await optimizer.compile(program, train, metric, {
  validationExamples: validation,
});
```

## Evaluation semantics

- MCP/UCP defaults to replay/sandbox evaluation. Live clients are rejected unless `mcpEvaluation: 'live'` is explicit.
- Capture one real session with `AxMCPRecordingTransport`; use `AxMCPReplayTransport` for deterministic optimization/evaluation. See [MCP](references/mcp.md) for transport setup and side-effect policy.
- Replay normalized MCP notifications and task transitions through `AxEventRuntime`; leave no live subscription active in default optimization. See [event runtime](references/event-runtime.md).
- Action traces expose qualified MCP/UCP operations, approvals, task transitions, raw protocol errors, and business outcomes to judges/custom metrics.
- Each rollout starts from clean continuation state; saved `getState()`/`setState(...)` runtime state is not used.
- During optimize/eval, `askClarification(...)` is a scored outcome, not routed through the responder. Custom metrics receive `prediction.completionType === 'askClarification'`, populated `prediction.clarification`, and absent `prediction.output`.
- Final outcomes have `prediction.completionType === 'final'` and populated `prediction.output`.
- Responder targets still work but are usually low-signal for clarification-heavy tasks.

## Delegation tuning

Expose specialists as explicit named child agents in `functions: [...]`; their invocations become normal function-call records. Tune against the same child/tool structure intended for production, covering delegation, normal tools, and direct answers.

Tell the actor child-input fields and local-only tasks. For synthesis, state the desired pattern, e.g. “call `team.writer(...)` only after narrowing tool output in JS.” Penalize needless child calls directly in the metric/judge prompt. If one training task repeatedly scores zero, inspect task ambiguity, weak schemas, or vague delegation guidance before adding optimizer rounds; these are more common causes than GEPA itself.

## Artifacts and replay

- Save the full `result.optimizedProgram` for portable/reusable configurations; do not omit save/load when reuse is requested.
- Serialize with `axSerializeOptimizedProgram(result.optimizedProgram!)`; deserialize with `axDeserializeOptimizedProgram(saved)` and apply with `agent.applyOptimization(...)`. The source also specifies restoring via `new AxOptimizedProgramImpl(...)`, then applying; it does not provide that constructor's argument shape.
- `result.optimizedProgram.componentMap` is the canonical saved agent-GEPA artifact and reapplies learned strings. Depending on selected targets, it may contain actor instructions, descriptions, tool descriptions/names, templates, or runtime primitives. Preserve the full program, not just selected strings.
- With `bootstrap`, demos are saved in `result.optimizedProgram.demos`; raw failed traces are not saved in v1.
- Auto-promoted undeclared inputs made runtime-only by `autoUpgrade` appear in captured traces/demos as truncated preview strings, not full values, just like declared truncate-style `contextFields`. This is expected, not corrupted saved demos; see [context handling](references/agent-context.md).
- Serialized JSON can be stored in localStorage, IndexedDB, or a backend for browser-safe persistence.
- Use fresh eval-safe tool state separately for baseline, optimize, and restored replay to prevent side-effect leakage. To demonstrate improvement, run a held-out task before tuning and replay it on a freshly restored optimized agent.

## Remote examples

- [RLM Agent Optimize](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-agent-optimize.ts): Gemini office-assistant tuning with save/load.
- [AxAgent GEPA Component Optimization](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/axagent-gepa-optimization.ts): compact support-agent GEPA run with deterministic metric and artifact replay.
