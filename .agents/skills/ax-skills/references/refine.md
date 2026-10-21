# Reward-Based Selection and Refinement

Use `bestOfN(...)` to score complete outputs independently; use `refine(...)` when failed rounds should generate feedback that changes the next attempt. Covers reward functions, thresholds, native samples, serial attempts, advice, and diagnostics, not streaming selection. Source API snapshot: 25.4.5.

## Validation and Assertions

Keep reward scoring separate from hard invariants:

| Mechanism | Purpose and failure behavior |
| --- | --- |
| Schema validation | Shape, types, and field-level constraints. |
| `addAssert(...)` | Whole-output hard invariants; failures feed correction text into the normal retry loop. |
| `addStreamingAssert(...)` | Partial streaming hard invariants; a failing partial field aborts the current stream attempt and feeds correction text into the normal retry loop. |
| `bestOfN(...)` | Complete-candidate selection. |
| `refine(...)` | Reward-scored retry rounds with generated feedback. |

See [generators](references/gen.md) for assertion callback contracts.

## APIs and Diagnostics

```typescript
import { bestOfN, refine } from '@ax-llm/ax';

const selected = bestOfN(program, {
  n: 4,
  threshold: 0.8,
  rewardFn: ({ input, prediction, traces, chatLog }) => score(prediction),
});

const improved = refine(program, {
  rounds: 3,
  samplesPerRound: 2,
  threshold: 0.85,
  rewardDescription: 'Prefer complete, grounded, concise answers.',
  rewardFn: ({ prediction }) => score(prediction),
});
```

- `forward(...)` returns the selected prediction.
- `streamingForward(...)` is unsupported: score complete outputs instead.
- `getUsage()` aggregates usage across attempts.
- `getTraces()` and `getChatLog()` return the selected attempt's diagnostics.
- `getAttempts()` returns all attempt metadata, including rewards, errors, and advice application.

## Rewards and Thresholds

A reward function returns a number; higher is better. `threshold` marks a good-enough candidate and can stop serial attempts early. Use serial strategy when scoring needs traces, chat logs, tools, or full flow behavior.

```typescript
const rewardFn = ({ prediction }) => {
  const exact = prediction.answer === 'Paris' ? 1 : 0;
  const concise = prediction.answer.length < 80 ? 0.2 : 0;
  return exact + concise;
};
```

## Strategies

| `strategy` | Behavior |
| --- | --- |
| `"auto"` | Native samples for `AxGen`; serial attempts for composite programs. |
| `"native-samples"` | Uses `sampleCount` and a reward-backed `resultPicker`. Candidate context contains outputs, not full per-candidate traces. |
| `"serial"` | Isolated full-program attempts with fresh memory/session IDs. |

## Refinement Advice

After a below-threshold round, `refine(...)` generates advice. It temporarily appends advice to matching `kind: "instruction"` components exposed by `getOptimizableComponents()`, then applies them through `applyOptimizedComponents()`.

- Original instruction values are restored in `finally`, on success and error.
- Programs without instruction components continue as best-of-N rounds and report `adviceApplied: false`.
- Do not add DSPy-style `hint_` signature fields: Ax uses instruction-component advice.

## Streaming Safety

Do not use `refine(...)` for streaming. For partial-output safety, use `AxGen.addStreamingAssert(fieldName, fn, message?)`. A streaming assertion fails fast in the current attempt with `AxStreamingAssertionError`; when retries remain, generation retries with correction feedback. See [generator streaming assertions](references/gen.md).
