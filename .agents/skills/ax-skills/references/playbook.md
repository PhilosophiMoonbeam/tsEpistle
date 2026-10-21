# Context playbooks and ACE evolution

Source API snapshot: `@ax-llm/ax` 25.4.5. Use for `playbook()`, `AxPlaybook`, evolving context/task knowledge, ACE (Agentic Context Engineering), `agent.playbook()`, offline `evolve()`, and online `update()`. A playbook accumulates reusable knowledge rendered into program context. Prefer `playbook(...)`, which hides ACE; use `AxACE` directly only when low-level engine access is explicitly requested.

Playbooks complement offline instruction/demo tuning via [global GEPA optimization](references/gepa.md) and [agent optimization](references/agent-optimize.md); they are not best/Pareto optimization artifacts or inference-time [bestOfN/refine](references/refine.md). Only playbooks also learn online via `update(...)`.

## Program-bound lifecycle

- Create `playbook(program, { studentAI, teacherAI? })` to obtain an `AxPlaybook` bound to an `AxGen`. `evolve`/`update` need its signature. Prefer `ai()`, `ax()`, and `agent()` for new code.
- Use a cheaper `studentAI` for execution and optional stronger `teacherAI` for reflection/curation.
- Offline: `await pb.evolve(examples, metric)` returns only `{ bestScore, playbook }`, never `paretoFront` or `optimizedProgram`. Keep the metric deterministic and cheap, as for GEPA.
- Online: `await pb.update({ example, prediction, feedback })` needs no metric and works without prior `evolve()`/`load()`; hydration is lazy on first use. Supply both `example` and `prediction`. `example` contains the program input fields plus any expected output; never put bare input fields at the top level.
- `pb.applyTo(program)` defaults to the bound program. It injects `## Context Playbook` into the program description and always recomposes from the original base; repeated calls do not stack blocks.
- Inspect `pb.render()` for markdown and `pb.getState()` for `{ playbook, artifact }`.
- Persist plain JSON with `pb.toJSON()`; restore into a fresh production program with `playbook(program, opts).load(snapshot)`.
- `teacherOptions` configures reflect/curate AI service calls. An `isExpensive` teacher (e.g. OpenAI `gpt-5.5-pro`) is rejected unless `teacherOptions: { useExpensiveModel: 'yes' }` is set. Generated Python, Java, C++, Go, and Rust packages enforce the same gate and accept `teacherOptions` in option maps.

### Offline evolution

```typescript
import { type AxMetricFn, ai, ax, playbook } from '@ax-llm/ax';

const program = ax('review:string -> sentiment:class "positive, negative"');
const studentAI = ai({ name: 'openai', apiKey: process.env.OPENAI_APIKEY! });
const metric: AxMetricFn = ({ prediction, example }) =>
  (prediction as any).sentiment === (example as any).sentiment ? 1 : 0;

const pb = playbook(program, { studentAI, maxEpochs: 2 });
const { bestScore } = await pb.evolve(train, metric);
pb.applyTo(program);
```

### Online feedback

After a real run, feed its outcome back to retain lessons:

```typescript
await pb.update({
  example: { review: 'Five stars, would buy again.' },
  prediction: { sentiment: 'negative' },
  feedback: 'WRONG: enthusiastic praise is positive.',
});
pb.applyTo(program);
```

### Persist and restore

```typescript
const snapshot = pb.toJSON(); // { playbook, artifact } — plain JSON
// Later, in another process / production program instance:
playbook(prodProgram, { studentAI }).load(snapshot).applyTo(prodProgram);
```

## Agent-owned playbooks

`a.playbook({ target })` returns an `AxAgentPlaybook`: the stage `AxPlaybook` handle plus agent-level `evolve`. Target is `'actor'` (default) or `'responder'`. Use this agent-aware handle rather than a bare `playbook()` on an internal program. See [agent construction](references/agent.md) for construction-time attachment, and [context selection](references/agent-context.md) for choosing among playbooks, `contextMap`, `contextPolicy`, and recall.

The same playbook rendered into the agent prompt grows through three paths:

| Path | Contract |
|---|---|
| Continuous trust | Construction-time `playbook` option automatically harvests each run's failures; no dataset. |
| On-demand trust | `apb.update({ example, prediction, feedback })` injects online lessons into the live stage prompt. |
| Batch verified proof | `apb.evolve(dataset, options)` runs the full agent task set, mines failure clusters, and proposes one bullet per weakness. `verify` defaults on: retain a bullet only when held-in improves and held-out `validation` does not regress; otherwise restore the exact prior snapshot. `verify: false` is trust-batch. Bullets only. |

```typescript
const a = agent('ticket:string -> reply:string', { ai });
const apb = a.playbook({ target: 'actor' }); // default actor; or responder
await apb.update({ example, prediction, feedback });
const result = await apb.evolve(
  { train, validation }, // AxAgentEvalDataset
  { metric, runsPerTask: 2 }, // verify:true by default
);
```

Agent-level `evolve(dataset, options)` takes `AxAgentEvalDataset` plus options, runs the whole pipeline, and returns baseline/final held-in and held-out scores with per-bullet outcomes, not `{ bestScore }`. Do not confuse it with program-level `pb.evolve(examples, metric)`. To tune full-pipeline agent instructions and demos instead of playbook bullets, use `agent.optimize(...)` ([agent optimization](references/agent-optimize.md)).

### Teacher ownership and expensive models

Each teacher call uses the options configured beside its model:

- `a.playbook({ teacherAI, teacherOptions })` and construction-time `playbook: { teacherAI, teacherOptions }` configure reflector/curator calls, including applying proposals from `apb.evolve(...)`.
- `apb.evolve(dataset, { teacherAI, teacherOptions })` configures the weakness miner.
- Both teachers default to the agent's `judgeAI`, then the student. With an `isExpensive` `judgeAI`, set `teacherOptions: { useExpensiveModel: 'yes' }` in both places, and `judgeOptions` when the built-in judge scores runs.

### Generated-language agent evolution

The playbook engine, construction-time agent attachment, failure harvesting, and verified agent evolution exist in TypeScript and generated Python, Java, C++, Go, and Rust packages. Use native casing and callback types.

| Language | Agent-bound evolve call |
|---|---|
| Python | `agent.playbook().evolve(dataset, options)` |
| Java | `agent.playbook(null).evolve(dataset, options)` |
| C++ | `agent.get_playbook()->evolve(dataset, options)` |
| Go | `agent.GetPlaybook().EvolveAgent(ctx, dataset, options)` |
| Rust | `playbook.evolve_agent(&mut agent, client, dataset, options)` |

All five generated packages carry structured `failureSignals` through agent evaluation predictions. Their default verification gate requires held-in improvement and held-out score within `epsilon`; rejection restores the exact prior snapshot. Scoring follows the host: TypeScript uses its metric; Python/Java/Go accept metric callbacks; all generated ports can use task `score`/`scores` plus the agent evaluation result.

## Failure diagnosis

- `update()` throws "Cannot convert undefined or null to object": wrap top-level input fields in `example: { ... }` and provide `prediction`.
- Empty playbook after `evolve()`: the model may already score well, leaving nothing to curate. Use harder/ambiguous examples or a weaker student to expose lessons.
- No effect on agent behavior: ensure `apply` is not `false` and use `agent.playbook(...)`, not bare `playbook()` on an internal program.
- No growth with an expensive teacher: reflector/curator calls are rejected before any request; only `verbose: true` logs rejection. Set `teacherOptions: { useExpensiveModel: 'yes' }`. An `apb.evolve(...)` miner rejection reports `miner failed` through `onProgress`, also to the console with `verbose: true`.
