# GEPA and Pareto optimization

Source API snapshot: `@ax-llm/ax` 25.4.3. Use for `AxGEPA`, global `optimize(...)`, reflective prompt evolution, multi-objective/Pareto tuning, `validationExamples`, `maxMetricCalls`, and generator/flow/agent-tree optimization. Prefer global `optimize(...)`; use direct `AxGEPA` or `AxBootstrapFewShot` only for low-level control. Agent wrapper tuning belongs in [agent optimization](references/agent-optimize.md); inference-time `bestOfN`/`refine` belongs in [refinement](references/refine.md); evolving context knowledge belongs in [playbooks](references/playbook.md).

## Execution and selection contract

- Use `optimize(program, train, metric, { studentAI, teacherAI, ... })` for normal generator/flow tuning; prefer `ai()`, `ax()`, and `flow()` for new code. Choose a cheaper student and strong teacher.
- Both `optimize(...)` and `AxGEPA.compile()` support a single generator or a tree-aware root (flow/agent) with registered optimizable descendants. There is no flow-only GEPA optimizer.
- GEPA edits generic string components from `getOptimizableComponents()`; a tree exposing none fails. Register child programs under the root. Selection uses measured component accept/reject history, not LLM-generated numeric scores: the teacher proposes text, metrics decide acceptance.
- For small starter sets, global `optimize(...)` defaults to `AxBootstrapFewShot -> AxGEPA`, retaining demos in `result.optimizedProgram.demos`. Direct `AxGEPA` has its own `bootstrap` option instead.
- Always keep `train` and held-out `validationExamples` distinct; do not reuse training examples for selection. Pass a holdout when available.
- Set `maxMetricCalls` for a strict cost bound (global default `100`); it must cover the initial full validation pass plus several rounds. For expensive trees start with `auto: 'light'` or fewer `numTrials`, then scale up.
- `result.optimizedProgram` is the best easy-to-apply candidate; `result.paretoFront` is the complete multi-objective trade-off set. Apply with `program.applyOptimization(result.optimizedProgram!)`, not only `setInstruction(...)`.
- Function/tool trace reflection uses stable component IDs where available; function renames do not break saved candidate maps.

## Metrics and judge boundaries

A metric returns `number` for one objective or `Record<string, number>` for Pareto optimization. Return plain numbers/object literals, keep objective names stable, and prefer normalized `0..1` scores. Every example must produce numeric scores.

Prefer cheap deterministic scoring when correctness follows from `prediction`/`example`, or when measuring cost, latency, recursion depth, or tool count. Avoid extra metric LLM calls unless explicitly requested. For qualitative non-agent tasks, use a plain typed `AxGen` evaluator rather than a custom judge abstraction; see [generators](references/gen.md).

For `agent.optimize(...)`, use a custom `metric` for crisp scoring; otherwise prefer its built-in judge. Normal agent users generally need neither `target` nor `metric`. Add `judgeAI` and `judgeOptions` only for a stronger/separate judge. If targeting is too broad, select `'actor'`, `'responder'`, `'all'`, or explicit program IDs; the wrapper filters GEPA components accordingly. See [agent optimization](references/agent-optimize.md).

```typescript
// Scalar objective
const scalarMetric = ({ prediction, example }) =>
  prediction.answer === example.answer ? 1 : 0;

// Multi-objective
const multiMetric = ({ prediction, example }) => ({
  accuracy: prediction.answer === example.answer ? 1 : 0,
  brevity:
    typeof prediction?.reasoning === 'string' &&
    prediction.reasoning.length < 120
      ? 1
      : 0.2,
});
```

## Scalar classifier example

```typescript
import { ai, ax, optimize, AxAIOpenAIModel } from '@ax-llm/ax';

const student = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});
const teacher = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54 },
});
const classifier = ax(
  'emailText:string -> priority:class "high, normal, low", rationale:string'
);
const train = [
  { emailText: 'URGENT: Server down!', priority: 'high' },
  { emailText: 'Weekly newsletter', priority: 'low' },
];
const validation = [
  { emailText: 'Invoice overdue', priority: 'high' },
  { emailText: 'Lunch plans?', priority: 'low' },
];
const metric = ({ prediction, example }: { prediction: any; example: any }) =>
  prediction?.priority === example?.priority ? 1 : 0;
const result = await optimize(classifier, train, metric, {
  studentAI: student,
  teacherAI: teacher,
  numTrials: 12,
  minibatch: true,
  minibatchSize: 4,
  earlyStoppingTrials: 4,
  sampleCount: 1,
  validationExamples: validation,
  maxMetricCalls: 120,
});
classifier.applyOptimization(result.optimizedProgram!);
console.log(result.bestScore);
```

## Pareto flow example

This independent example optimizes accuracy and rationale brevity across both flow nodes; see [flows](references/flow.md).

```typescript
import { ai, flow, optimize, AxAIOpenAIModel } from '@ax-llm/ax';

const student = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});
const teacher = ai({
  name: 'openai',
  apiKey: process.env.OPENAI_APIKEY!,
  config: { model: AxAIOpenAIModel.GPT54 },
});
const wf = flow<{ emailText: string }>()
  .n('classifier', 'emailText:string -> priority:class "high, normal, low"')
  .n(
    'rationale',
    'emailText:string, priority:string -> rationale:string "One concise sentence"'
  )
  .e('classifier', (state) => ({ emailText: state.emailText }))
  .e('rationale', (state) => ({
    emailText: state.emailText,
    priority: state.classifierResult.priority,
  }))
  .r((state) => ({
    priority: state.classifierResult.priority,
    rationale: state.rationaleResult.rationale,
  }));
const train = [
  { emailText: 'URGENT: Server down!', priority: 'high' },
  { emailText: 'Weekly newsletter', priority: 'low' },
];
const validation = [
  { emailText: 'Invoice overdue', priority: 'high' },
  { emailText: 'Lunch plans?', priority: 'low' },
];
const metric = ({ prediction, example }: { prediction: any; example: any }) => {
  const accuracy = prediction?.priority === example?.priority ? 1 : 0;
  const rationale = typeof prediction?.rationale === 'string'
    ? prediction.rationale
    : '';
  const brevity = rationale.length <= 40 ? 1 : rationale.length <= 80 ? 0.5 : 0.1;
  return { accuracy, brevity };
};
const result = await optimize(wf, train, metric, {
  studentAI: student,
  teacherAI: teacher,
  numTrials: 16,
  minibatch: true,
  minibatchSize: 6,
  earlyStoppingTrials: 5,
  sampleCount: 1,
  validationExamples: validation,
  maxMetricCalls: 240,
});
for (const point of result.paretoFront) {
  console.log(point.scores, point.configuration);
}
wf.applyOptimization(result.optimizedProgram!);
console.log(result.optimizedProgram?.componentMap);
```

## Options and teacher permissions

```typescript
const optimizer = new AxGEPA({
  studentAI,
  teacherAI,
  numTrials: 20,
  minibatch: true,
  minibatchSize: 5,
  minibatchFullEvalSteps: 5,
  earlyStoppingTrials: 5,
  minImprovementThreshold: 0,
  sampleCount: 1,
  seed: 42,
  verbose: true,
});
```

`numTrials` counts reflection/evolution rounds. `minibatch` reduces per-round evaluation cost; `minibatchSize` sets examples per minibatch. `earlyStoppingTrials` stops repeated non-improvement; `minImprovementThreshold` rejects tiny gains. `seed` stabilizes sampling for demos/tests. The example also preserves `minibatchFullEvalSteps`, `sampleCount`, and `verbose`.

`teacherOptions` supplies AI service options for GEPA feedback/proposals and global `optimize(...)` bootstrap demo runs. An `isExpensive` teacher (e.g. OpenAI `o3-pro` or `gpt-5.5-pro`) is rejected unless `teacherOptions: { useExpensiveModel: 'yes' }` is set.

## Artifacts and persistence

Single-generator components live in `optimizedProgram.componentMap`; instruction keys are `${programId}::instruction`, while descriptions and other components have separate keys. Tree runs use full component keys. Pareto candidate maps live in `point.configuration.componentMap`.

Prefer `axSerializeOptimizedProgram(...)` / `axDeserializeOptimizedProgram(...)` for persistence shared by browsers and Node. The source also provides this plain JSON save/reapply pattern:

```typescript
const { optimizedProgram, paretoFront } = result;
program.applyOptimization(optimizedProgram!);
const saved = JSON.stringify(optimizedProgram);
const loaded = JSON.parse(saved);
program.applyOptimization(loaded);
```

## Failure diagnosis

- Budget-too-small error: increase `maxMetricCalls` until the initial validation pass fits.
- Components never change: each failed teacher call emits `gepa_teacher` through the optimizer `logger` (default: student AI logger); `verbose: false` silences it. Check expensive-teacher permission.
- Empty/poor Pareto front: ensure metrics return numbers for every example.
- No tree effect: register children and expose optimizable components.
- Partial artifact application: use `applyOptimization(...)` so the full tree receives `componentMap`.

## Original example locations

Preserved source checkout paths (not required local dependencies):

- `/Users/vr/src/ax/src/examples/optimize.ts`
- `/Users/vr/src/ax/src/examples/gepa.ts`
- `/Users/vr/src/ax/src/examples/gepa-flow.ts`
- `/Users/vr/src/ax/src/examples/gepa-train-inference.ts`
- `/Users/vr/src/ax/src/examples/gepa-quality-vs-speed-optimization.ts`
- `/Users/vr/src/ax/src/examples/axagent-gepa-optimization.ts`
