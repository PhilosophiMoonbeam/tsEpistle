# Typesafe / Jev decisions with Ax

Use for TypeScript Typesafe System One integration: images/Box localization, boolean/class/rubric signatures, evidence and provenance, value descriptions, native Noul/Choice/Score/Box questions, structured criteria, probability decisions, and explicit hybrid generation. Source API snapshot: 25.4.3. Select `name: 'typesafe'`; Jev is the model family and `jev-latest` the default model. Python, Java, C++, Go, and Rust also support the adapter and native client; their generated `ax-<language>-typesafe` skills supply language-specific syntax/types. This reference supplies TypeScript integration without requiring those skills; see the generated-language Box scope disagreement below. Typesafe is not a freeform generation or tool-use provider.

## Choose an interface

| Need | Interface | Result |
|---|---|---|
| Required booleans/fixed classes | `ai({ name: 'typesafe', ... })` plus `ax(...).forward()` | Ordinary signature-shaped values |
| PNG/JPEG images/localization (TypeScript) | `ax(...)` with `image` inputs and `box` outputs | Coordinates, optional evidence |
| Probabilities/confidence/rubric scores | `ax(...)` evidence fields | Typed evidence in normal results |
| Advanced structured criteria/state | `typesafe(...).systemOne(...)` | Native request features |
| Decisions then prose/tools | Decision step then generative provider | Explicitly composed results |

`reply:string` requests unsupported freeform text. `team:class "support, billing"` returns either label. Numeric fields, even with `min`/`max`, do not define native scoring rubrics.

## Evidence, provenance, and reranking

Jev, OpenAI Decisions, and generative providers support decision metadata through signature fields:

```text
query:string, document:string ->
  relevant:boolean(evidence, threshold 0.7),
  category:class "support, billing"(evidence),
  relevance:score "Irrelevant, Related, Partial answer, Direct answer"(evidence)
```

| Evidence | Fields |
|---|---|
| Boolean | `value`, `probability`, `threshold`, `provenance` |
| Class | `value`, complete label-to-probability map, `provenance` |
| Score | Continuous `value` from zero to final rubric index, ordered `levels`, ordered `probabilities`, `provenance` |

Native class/score results may also contain provider `confidence`. Scores without `(evidence)` return only numeric values; existing scalar boolean/class behavior is unchanged.

Ax preserves native selected classes, continuous scores, probabilities, and confidence. A native value can differ from probability argmax or weighted mean. For generative models Ax requests probabilities, derives boolean/class locally, and computes score as probability-weighted rubric index. It preserves supplied probabilities and never invents confidence.

Ax—not generated output—sets `provenance.source` (`native` or `elicited`), `provider`, and available `model` from the actual response. Shared result shapes do not imply equally calibrated probabilities/confidence across providers/models. Evaluate thresholds/ranking on your data. Rubric scores are not probabilities of correctness.

For reranking, judge every query/document pair, retain application candidate IDs, and sort by `relevance.value` within one rubric/model. Processors, assertions, result selection, traces, and caches receive decoded results; streaming waits for complete evidence.

```typescript
const judge = ax(f().input('query', f.string()).input('document', f.string())
  .output('relevance', f.score(['Irrelevant', 'Related', 'Partial answer', 'Direct answer']).withEvidence())
  .build());
const result = await judge.forward(model, { query, document });
console.log(result.relevance.value, result.relevance.probabilities);
```

`boolean(evidence, refusal return)` or an evidence field with `refusal return` returns `{status: "answered", ...evidence}` or `{status: "refused", provenance}`. Default refusals raise `AxDecisionRefusalError` and stop correction retries.

Generative providers allow nested/optional/array evidence fields. Native Jev and OpenAI Decisions require flat required single-value outputs (Jev includes Box; OpenAI Decisions rejects Box); unsupported shapes fail before transport. Use direct native clients for advanced structured criteria/features. Label-only examples are accepted without manufactured distributions; examples with actual evidence retain it while omitting runtime-owned result metadata from inference demonstrations.

## Boolean/class signatures and adapter restrictions

```typescript
import { ai, ax, f } from '@ax-llm/ax';

const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_APIKEY;
if (!apiKey) throw new Error('Set a Typesafe API key.');
const model = ai({ name: 'typesafe', apiKey, trueThreshold: 0.9 });
const triage = ax(`
  ticket:string ->
  urgent:boolean(
    true "Customers cannot complete a core task",
    false "A routine request or minor inconvenience"
  ) "Does this need immediate attention?",
  team:class "support, billing, engineering"(
    support "Product usage questions",
    billing "Individual invoice or charge disputes",
    engineering "Broken functionality or service outages"
  ) "Which team should investigate?"
`);
const decision = await triage.forward(model, {
  ticket: 'Checkout fails for every customer. Payments cannot complete.',
});
// decision.urgent: boolean
// decision.team: 'support' | 'billing' | 'engineering'
```

`trueThreshold` defaults to `0.5`, must be finite in `[0, 1]`, and converts all provider-instance booleans using `noul >= trueThreshold` (equality included). This local policy is never sent to Typesafe. Choice returns its selected label without automatic confidence cutoff or abstention.

Field names/descriptions become question instructions. Boolean value descriptions map to `criteria.true`/`criteria.false`; class descriptions use exact label keys. Partial descriptions are allowed; undescribed class labels map to `null`. Duplicate/unknown keys and empty descriptions fail validation. Quote labels containing spaces/punctuation. Fluent equivalents: `f.boolean(...).describeValues({ true: '...', false: '...' })` and `f.class([...], ...).describeValues({ label: '...' })`.

Conventional providers render base descriptions plus `value: description` lines in prompt/JSON schema. Annotations survive serialization without changing inferred types/allowed values. Complete local syntax: [signatures](references/signature.md); original [signature resource](https://github.com/ax-llm/ax/blob/main/src/ax/skills/ax-signature.md). Use `score` for ordered label rubrics. Structured JSON criteria/custom numeric rubric entries belong in native requests, not JSON encoded into quoted descriptions.

The adapter sends the normal Ax prompt as native state and batches outputs into one request. It supports required boolean/class/rubric score/box outputs; optional, array, nested, ordinary numeric, and freeform outputs fail before network access. PNG/JPEG image inputs are supported; audio, files, tools, multiple completion samples, and controls such as `temperature`/`maxTokens` are unsupported. No token streaming exists; `streamingForward()` can deliver a completed result. Program behavior: [Gen](references/gen.md); provider configuration: [AI](references/ai.md).

## Image inputs and Box outputs

```typescript
const vision = ai({
  name: 'typesafe', apiKey,
  config: { model: 'jev-1.14.0' },
});
const locate = ax(`
  photo:image ->
  visible:boolean "Is the red square visible in photo?",
  target:box(evidence) "The red square in photo"
`);
const result = await locate.forward(vision, {
  photo: { mimeType: 'image/png', data: imageBase64 },
});
// result.target.value: { top, bottom, left, right }, each in [0, 1]
// result.target.confidence: native confidence, when supplied
// result.target.provenance.source: 'native'
```

`target:box` returns `AxBox`, just the four coordinates; `target:box(evidence)` returns `AxBoxEvidence`: `{ value: AxBox, confidence?: number, provenance }`. Fluent equivalents are `f.box(description)` / `f.box()` and `.withEvidence()`. Coordinates are normalized fractions from the image top-left: multiply left/right by width, top/bottom by height for pixels. Ax rejects non-finite/out-of-range coordinates, inverted boxes, and zero area: `top < bottom` and `left < right` are strict. It never clamps. A Box always returns a region, even if the target is absent; ask a presence boolean alongside it and use that to decide whether to consume the box. Generative providers support box arrays, optional/nested boxes, and box inputs; native Jev outputs must be flat, required, single boxes.

Jev images/Box are experimental. Ax sends `TypeSafe-Danger-Zone-Images: true` for image/Box requests. Box needs Jev 1.14 (`jev-1.14.0` or `jev-preview`); the ordinary default remains `jev-latest`.

Send still PNG/JPEG as raw base64 or matching image data URLs, never hosted URLs. Ax maps `image` and `image[]` inputs to referenced assets, retaining prompt order. Jev limits each side to 256–1568 pixels and total area to at least 78,400 pixels: 256×256 is too small. Limits also include 16 MiB per decoded image and 32 MiB per request. Prepare orientation and dimensions before calling; Ax does not resize.

Native assets use `assets: { [reference]: { type: 'image', format: 'png' | 'jpg' | 'jpeg', data_base64: string } }`. Include references in state, question instructions, or criteria. References match substrings in string values; use unique long references, preferably UUIDs. Box questions are `{ type: 'box', instructions: 'The target in photo' }`, with no criteria, returning `{ type: 'box', box: { top, bottom, left, right }, confidence }`. The client does not support multipart uploads.

Generative vision providers use the same Box signature with validated JSON schema; evidence has `provenance.source: 'elicited'` and no invented confidence. Jev supplies native provenance and confidence when supplied. OpenAI Decisions supports inline images for boolean/class/score questions, but has no documented native Box primitive: Ax rejects Box outputs before transport. Use a generative OpenAI vision model for Box.

**Generated-language source disagreement (25.4.3):** the Typesafe source says Image/Box signatures are available in TypeScript, Python, Java, C++, Go, and Rust, with runnable localization examples in each `src/examples/<language>/generation/` directory. The signature source instead says generated-language Box support remains in the AxIR backlog. Preserve these as conflicting claims, not universal support or universal lack of support; this tutorial establishes the TypeScript contract only. See [signature scope note](references/signature.md#bounding-boxes) and upstream [Images](https://docs.typesafe.ai/images) / [Box](https://docs.typesafe.ai/primitives/box) contracts.

## Native questions and application decisions

```typescript
import { typesafe } from '@ax-llm/ax';

const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_APIKEY;
if (!apiKey) throw new Error('Set a Typesafe API key.');
const client = typesafe({ apiKey });
const result = await client.systemOne({
  state: { ticket: 'Checkout fails for every customer.', recentEvents: [] },
  questions: {
    urgent: {
      type: 'noul',
      instructions: 'Does this require immediate incident response?',
      criteria: {
        true: { description: 'Core task blocked', examples: ['Cannot pay'] },
        false: 'Routine request or minor inconvenience',
      },
    },
    team: {
      type: 'choice',
      instructions: 'Which team should investigate?',
      criteria: {
        support: 'Product usage questions',
        engineering: 'Broken functionality or service outages',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the customer impact?',
      criteria: ['Minor inconvenience', 'Feature impaired', 'Core task blocked'],
    },
  },
});
const escalate = result.answers.urgent.noul >= 0.9;
const team = result.answers.team.choice; // 'support' | 'engineering'
const severity = result.answers.severity.score; // Fractional values allowed, 0–2.
const severityOnTen = (severity / 2) * 10; // Explicit application scale.
const models = await client.listModels();
```

Keep questions inline or use `as const satisfies AxAITypesafeQuestions` for reusable definitions to preserve literal question keys/Choice labels.

- Noul returns `noul` in `[0, 1]`, with no separate confidence. Adapter `trueThreshold` does not apply to native clients.
- Choice returns `choice`, `probabilities`, `confidence`; Score returns `score`, `probabilities`, `legend`, `confidence`.
- Responses also include `model` and `usage.input_tokens`/`usage.output_tokens`.
- Choice/Score probabilities must be finite `[0, 1]` values matching criteria keys, summing to one within inclusive `0.01` tolerance. Totals `0.99` and `1.01` are accepted with floating-point summation allowance. Ax preserves probabilities without renormalizing.
- State, instructions, and individual criteria accept text, JSON objects, arrays, or `null`. Nested JSON accepts finite numbers/booleans; bare numbers/booleans are invalid top-level entries. Instructions are optional in Ax/native types, but provide explicit questions: keys identify answers, not instructions. Choice permits 1–255 labels; Score requires 2–10 ordered levels. `null` leaves outcomes undescribed.

Question design:
- Noul asks one clear yes/no judgment; near `0.5` means uncertainty about that judgment, not degree/severity. Use Score for degree.
- Give similar Choice labels distinct descriptions; add catch-all labels only if allowed by the application.
- Use one dimension per Score rubric. Preserve fractional zero-based position; explicitly choose rounding, normalization, and weighting in application code.
- Batch independent questions. Same-request questions cannot consume another answer; dependencies require later calls.
- Test wording/thresholds against representative labeled inputs. Confidence describes distribution, not correctness.

Provider guidance: [Noul](https://docs.typesafe.ai/primitives/noul), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [official API types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts).

## Models, transport, and diagnostics

| Setting | Signature provider | Native client |
|---|---|---|
| Default model override | `config: { model: 'jev-latest' }` | `model: 'jev-latest'` |
| Per-call model override | Third `forward()` argument `{ model }` | `systemOne({ state, questions, model })` |
| Endpoint | `apiURL`, default `https://api.typesafe.ai` | Same |
| Authentication | `apiKey` or `credentialProvider` | Same; optional static `headers` |
| Transport | `options.fetch`, `timeout`, `retry`, `abortSignal` | Same; methods take a second transport-options argument, or first for `listModels()` |

`listModels()` returns native cards (`name`, `description`, `release_date`), not changes to configured Ax model aliases. Renewable credential callbacks receive `{ profile, operation, method, url }` on each attempt; operation is `chat` for inference and `models` for discovery. Native instance/per-call cancellation signals both apply.

Context limits cover combined state/instructions/criteria; consult [models](https://docs.typesafe.ai/models). Ax neither silently truncates nor claims exact local token counts. Token usage is returned; Ax assumes no model token prices.

Adapter diagnostics use `program.getUsage()`/`program.getChatLog()`. Logs retain `providerMetadata.typesafe.answers`; direct `.chat()` responses retain the same metadata. Native calls return usage/full answers directly. No generic metadata getter or alternate forward result is needed.

## Routing and hybrid workflows

Typesafe-only balancers preserve schema-required generation for scalar signatures. Mixed pools retain normal prompting; Typesafe is eligible only if the actual request already contains a supported output schema. Incompatible requests are excluded from selection/fallbacks even with degradation enabled. Bare chat without a supported schema fails.

For prose, call a second `ax()` with a generative provider and pass ticket plus decision fields. Ax does not automatically split `urgent:boolean, reply:string`. Agents requiring tools/code generation use a generative actor and a separate Typesafe decision step; see [Agent](references/agent.md).

## Runnable examples and live checks

Run in the Ax repository root; `tsx` loads `.env`:

```bash
npm run tsx src/examples/typescript/generation/typesafe.ts
npm run tsx src/examples/typescript/generation/typesafe-native.ts
npm run tsx src/examples/typescript/generation/typesafe-hybrid.ts
npm run tsx src/examples/typescript/generation/value-descriptions.ts
```

First two require `TYPESAFE_API_KEY` or `TYPESAFE_APIKEY`; last two also require `OPENAI_API_KEY` or `OPENAI_APIKEY`. [Comparison](https://github.com/ax-llm/ax/blob/main/src/examples/typescript/generation/value-descriptions.ts) uses the same described signature across providers; [native](https://github.com/ax-llm/ax/blob/main/src/examples/typescript/generation/typesafe-native.ts) covers all primitives/model discovery; [hybrid](https://github.com/ax-llm/ax/blob/main/src/examples/typescript/generation/typesafe-hybrid.ts) composes two programs. Assert response contracts in live checks, never exact model probabilities.
