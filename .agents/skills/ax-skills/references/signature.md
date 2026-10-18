# Ax signatures and field contracts

Use for `s()`, `f()`, signature strings, field types, validation, and type-safe inputs/outputs. Source snapshot: Ax 25.4.3. Generator execution belongs in [generator reference](references/gen.md); native decision criteria belong in [Typesafe reference](references/typesafe.md).

## String syntax and field types

```text
[description] input1:type, input2:type -> output1:type, output2:type
```

| Type | Syntax | TypeScript | Example |
|------|--------|-----------|---------|
| String | `:string` | `string` | `userName:string` |
| Number | `:number` | `number` | `score:number` |
| Boolean | `:boolean` | `boolean` | `isValid:boolean` |
| JSON | `:json` | `any` | `metadata:json` |
| Date | `:date` | `Date` | `birthDate:date` |
| DateTime | `:datetime` | `Date` | `timestamp:datetime` |
| DateRange | `:dateRange` | `{ start: Date; end: Date }` | `travelDates:dateRange` |
| DateTimeRange | `:datetimeRange` | `{ start: Date; end: Date }` | `meetingWindow:datetimeRange` |
| Image | `:image` | `{mimeType, data, details?}` | `photo:image` (input only) |
| Audio | `:audio` | input: `AxAudioInput`; output: `AxChatAudioOutput` | `recording:audio`, `speech:audio` |
| File | `:file` | `{mimeType, data \| fileUri, filename?}` | `document:file` (input only) |
| URL | `:url` | `string` | `website:url` |
| Code | `:code` | `string` | `pythonScript:code` |
| Class | `:class "a, b, c"` | `"a" \| "b" \| "c"` | `mood:class "happy, sad"` |
| Box | `:box` / `:box(evidence)` | `AxBox` / `AxBoxEvidence` | `photo:image -> target:box` |

```typescript
'tags:string[] -> processedTags:string[]'
'query:string, context?:string -> response:string'
'problem:string -> reasoning!:string, solution:string'
```

Put optional `?` on the name, not the type. Internal `!` fields are output-only scratchpads stripped from the result. Use descriptive names: `userQuestion`, `customerEmail`, `analysisResult`, `confidenceScore`; avoid generic `text`, `data`, `input`, `output`, `a`, `x`, `val`, and number-leading `1field`.

### Media boundaries and forwarded metadata

- Image/file fields are top-level inputs only. Audio supports top-level inputs or a single top-level output. No nested media fields.
- Media arrays are input-only; output `audio[]` is unsupported.
- Audio outputs are scripted speech: the model returns plain text, then Ax synthesizes `AxChatAudioOutput`. See [audio reference](references/audio.md).
- Use `f.image()`, `f.audio()`, and `f.file()` for media; zod has no equivalent.
- Only optional keys declared by the chat part reach the provider/router; other keys stay behind:
  - Image: `details` (`'high'`, `'low'`, `'auto'`; OpenAI image `detail`), `cache`, `optimize`, `altText`.
  - File: `filename`, `cache`, `extractedText`. OpenAI rejects inline file data without `filename`.
  - URL: `cachedContent`, `cache`.
  - Audio input: `mimeType`, `sampleRate`, `channels`, `cache`, `transcription`, `duration`.

### Date, datetime, and range validation

Accept ISO-style values; trim minor whitespace/casing issues. Ranges accept `{ "start": "...", "end": "..." }`, `[start, end]`, `start/end`, or natural delimiters such as `start to end`. Invalid values and reversed ranges fail validation; do not silently autocorrect them.

Datetime zones accept `Z`, an offset, `UTC`/`GMT`, IANA names (`2024-05-09 14:30 America/New_York`), or unambiguous abbreviations at their literal year-round offset (`PST` = -08:00 even in July; `EDT` = -04:00). Reject ambiguous `BST`, `IST`, `CST`, `AST`, `SST`, `NST`, `ECT`, `GST` and ICU legacy short IDs with correction requesting an IANA name or offset. `PST`/`PDT` and `CDT` use US meanings; Philippine `PST` requires `Asia/Manila` or an offset, and Cuban daylight `CDT` requires `America/Havana` or an offset. DST gaps are invalid; overlaps select the earlier instant.

## Modifier bags and nested objects

The string grammar expresses every fluent construct except Standard Schema fields. Prefer modifier bags and inline objects for constraints alone; reserve fluent/Standard Schema for schema-backed fields. Bags are optional, comma-separated, and order-independent.

```typescript
`userAge:number(min 0, max 120), contactEmail:string(format email, cache), codeSnippet:code(python)
 -> userName:string(pattern "^[a-z_]+$" "lowercase name"), tagList:string(item "a short tag")[] "all tags",
    profileList:object{ fullName:string, userAge?:number(min 0) }[] "matched profiles"`
```

| Modifier | Applies to | Effect |
|----------|-----------|--------|
| `min N` / `max N` | `string`, `number` | String length / numeric value bounds |
| `format email\|uri\|date\|date-time` | `string` | Format validation |
| `pattern "regex" ["desc"]` | `string` | Regex validation and optional description |
| `cache` | top-level input | Prefix-cache breakpoint |
| `item "desc"` | arrays | Per-item description: `tags:string(item "a tag")[]` |
| `<language>` | `code` | Snippet language: `snippet:code(python)` |
| `true "desc"` / `false "desc"` | `boolean` | Outcome guidance |

- `object{ field:type, opt?:type }` nests recursively; append `[]` for object arrays.
- Inside objects, reject internal `!`, media types, `cache`, and `item`; these apply only at the top level.
- Inapplicable string modifiers are parse errors (for example `min` on boolean); fluent modifiers silently ignore inapplicable constraints.
- Double backslashes in quoted values: regex `\d` becomes `pattern "\\d+"`.
- `AxSignature.toString()` losslessly renders every construct for round-trips, including flow-node serialization into mermaid `%%ax` directives; see [flow reference](references/flow.md).
- Signature-level descriptions preserve quotes and backslashes through `toString()` and reparsing. Fluent `.description(...)` accepts ordinary text; string signatures escape embedded quotes and backslashes inside their quoted description.

## Boolean/class value descriptions and evidence

```typescript
const triage = ax(`
  ticket:string ->
  urgent:boolean(
    true "Customers cannot complete a core task",
    false "A routine request or minor inconvenience"
  ) "Does this need immediate attention?",
  team:class "support, billing, engineering"(
    support "Product usage questions",
    billing "Invoice or charge disputes",
    engineering "Broken functionality"
  ) "Which team should investigate?"
`);

f.boolean('Does this need immediate attention?').describeValues({
  true: 'Customers cannot complete a core task',
  false: 'A routine request or minor inconvenience',
});
f.class(['support', 'billing'], 'Which team?').describeValues({
  support: 'Product usage questions',
  billing: 'Invoice or charge disputes',
});
```

Boolean descriptions use the modifier bag; class descriptions follow the allowed-label list. Quote labels with spaces/punctuation: `class "in progress, done"("in progress" "Work has started", done "Work is complete")`. Partial descriptions are valid; duplicate keys, unknown labels, and empty descriptions are errors.

Conventional providers, including OpenAI, receive the question plus `value: description` lines in prompts and JSON schema descriptions when used. Typesafe receives separate Noul/Choice criteria. Annotations remain separate in the signature and survive `toString()`; rendering neither mutates the signature nor duplicates descriptions. Types, allowed values, and optional/array behavior remain unchanged. Descriptions guide generation, not additional output validation. Number bounds remain validation constraints; use an explicit `score` field for an ordered rubric. Python, Java, C++, Go, and Rust generate the same description, validation, serialization, schema, and prompt semantics.

For Jev boolean/class criteria, use value descriptions; add `.withEvidence()` to retain AxGen probabilities and `f.score(levels)` for ordered rubrics. Full structured criteria require the separate native client. The adapter's `trueThreshold` is provider-wide conversion policy, not a field modifier. See [Typesafe reference](references/typesafe.md); original resource: [ax-typesafe](https://github.com/ax-llm/ax/blob/main/src/ax/skills/ax-typesafe.md).

Boolean/class evidence opt-in is `.withEvidence()` or `(evidence)`. `score "Low, Medium, High"` returns a continuous zero-based index; `(evidence)` retains ordered probabilities and provenance. Boolean `threshold 0.7` applies locally only to evidence fields. `refusal return` adds a tagged answered/refused union. See [decision evidence](references/typesafe.md#evidence-provenance-and-reranking).

## Bounding boxes

`photo:image -> target:box` returns `AxBox`: finite, normalized `top`, `bottom`, `left`, and `right` in `[0, 1]`, measured from the image top-left. Require `top < bottom` and `left < right`: inverted and zero-area boxes fail validation; Ax never clamps coordinates. Multiply left/right by image width and top/bottom by height for pixels.

`target:box(evidence)` returns `AxBoxEvidence`: `{ value: AxBox, confidence?: number, provenance }`. Fluent forms are `f.box(description)` (or `f.box()`) and `f.box(description).withEvidence()`. Generative providers support arrays, optional/nested boxes, and box inputs. Native Jev box outputs must be flat, required, single boxes.

Jev 1.14 supports native PNG/JPEG localization with the required experimental header supplied by Ax. Box always returns a region, not a presence judgment: pair it with a boolean if the target may be absent and consume the box only when present. Generative vision providers use validated structured output with `elicited` provenance and no invented native confidence. OpenAI Decisions supports images but rejects Box outputs before transport; use a generative vision model instead. See [Typesafe image/Box transport and preparation](references/typesafe.md#image-inputs-and-box-outputs).

**Source scope disagreement (25.4.3):** the signature source says generated-language Box support remains in the AxIR backlog, while the Typesafe source says Image/Box signatures are available in TypeScript, Python, Java, C++, Go, and Rust, with per-language examples. These statements disagree; this reference documents the TypeScript contract and does not establish universal generated-language Box availability.


## Four construction forms

### String and reusable signature

```typescript
import { ax, s } from '@ax-llm/ax';
const gen = ax('input:string -> output:string');
const sig = s('query:string -> response:string');
```

### Fluent builder

```typescript
import { f } from '@ax-llm/ax';
const sig = f()
  .input('userMessage', f.string('User input'))
  .input('contextData', f.string('Additional context').optional())
  .input('tags', f.string('Keywords').array())
  .output('responseText', f.string('AI response'))
  .output('confidenceScore', f.number('Confidence 0-1'))
  .output('debugInfo', f.string('Debug info').internal())
  .build();
```

### Standard Schema: zod, valibot, arktype

`.input()` / `.output()` accept [Standard Schema v1](https://standardschema.dev) without wrappers/adapters. Per-field schemas and whole-object schemas work; whole objects decompose in declaration order. Companion `AxFieldOptions` carry Ax-only hints: `{ cache: true }` for input prefix-cache breakpoints; `{ internal: true }` for hidden output scratchpads.

```typescript
import { z } from 'zod';
import { f } from '@ax-llm/ax';

// Per-field schema, then optional Ax hints.
const sig = f()
  .input('contextData', z.string().describe('Background context'), { cache: true })
  .input('userQuestion', z.string().describe('Question to answer'))
  .output('reasoning', z.string().describe('Step-by-step thinking'), { internal: true })
  .output('answer', z.string().describe('Final answer'))
  .build();

// Whole-object schema with companion field options.
const sig2 = f()
  .description('Answer questions from retrieved context')
  .input(z.object({
    contextData: z.string().describe('Background context'),
    userQuestion: z.string().describe('Question to answer'),
  }), { fields: { contextData: { cache: true } } })
  .output(z.object({
    reasoning: z.string().describe('Step-by-step thinking'),
    answer: z.string().describe('Final answer'),
  }), { fields: { reasoning: { internal: true } } })
  .build();

const sig3 = f()
  .input(z.object({
    emailAddress: z.string().email().describe('Contact email'),
    username: z.string().min(3).max(20).describe('Handle'),
    score: z.number().min(0).max(100).describe('Numeric score'),
  }))
  .output(z.object({
    priority: z.enum(['low', 'medium', 'high']).describe('Priority'),
    summary: z.string().describe('Result'),
  }))
  .build();
```

Zod string `.email()`, `.url()`, `.min()`, `.max()`, `.regex()` and number `.min()` / `.max()` flow into prompt validation. Arrays use `z.array(z.string())`; `z.enum([...])` maps to Ax `class`, valid only on outputs.

The same schema shapes work with `fn().arg()`, `.returns()`, `.returnsField()`; schemas infer handler argument types. Per-argument schemas can mix with `f.*()` arguments and Ax hints:

```typescript
import { z } from 'zod';
import { fn } from '@ax-llm/ax';

const lookupProduct = fn('lookupProduct')
  .description('Look up a product by name and return its current details')
  .arg(z.object({
    productName: z.string().min(1).describe('Exact product name'),
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

const searchDocs = fn('searchDocs')
  .description('Search indexed docs')
  .arg('query', z.string().min(1), { cache: true })
  .arg('limit', z.number().int().positive().optional())
  .returnsField('results', z.array(z.string()))
  .handler(async ({ query }) => ({ results: [] }))
  .build();
```

### Hybrid

```typescript
import { s, f } from '@ax-llm/ax';
const sig = s('base:string -> result:string')
  .appendInputField('extra', f.json('Metadata').optional())
  .appendOutputField('score', f.number('Quality score'));
```

## Fluent creators, modifiers, validation, and caching

Creators:
- `f.string(desc)`, `f.number(desc)`, `f.boolean(desc)`, `f.json(desc)`.
- `f.image(desc)`, `f.audio(desc)`, `f.file(desc)`, `f.url(desc)`.
- `f.email(desc)`, `f.date(desc)`, `f.datetime(desc)`, `f.dateRange(desc)`, `f.datetimeRange(desc)`.
- `f.class(['a','b','c'], desc)`, `f.code(desc)`, `f.object({ field: f.string() }, desc)`.
- `f.box(desc)`, `f.box(desc).withEvidence()`, `f.score(levels)`.

Use chaining only: `.optional()`, `.array()` / `.array('list description')`, output-only `.internal()`, input-only `.cache()`. Nested `f.array(f.string())`, `f.optional(f.string())`, and `f.internal(f.string())` are removed.

```typescript
f.string('description').optional().array()
f.string('context').cache().optional()
f.object({ field: f.string() }, 'item desc').array('list desc')

f.string('username').min(3).max(20)
f.string('email').email()
f.string('website').url()
f.string('birthDate').date()
f.string('timestamp').datetime()
f.string('pattern').regex('^[A-Z0-9]', 'Must start with an uppercase letter or digit')
f.number('age').min(18).max(120)
f.number('score').min(0).max(100)
```

`f.email()`, `f.url()`, `f.date()`, `f.datetime()` are shorthand for `f.string().email()` etc.; range creators return `{ start: Date; end: Date }`. Validation errors auto-retry with correction feedback.

```typescript
const sig = f()
  .input('formData', f.string('Raw form data'))
  .output('user', f.object({
    username: f.string('Username').min(3).max(20),
    email: f.string('Email').email(),
    age: f.number('Age').min(18).max(120),
    bio: f.string('Bio').max(500).optional(),
    website: f.string('Website').url().optional(),
    tags: f.string('Tag').min(2).max(30).array()
  }, 'User profile'))
  .build();

const cachedSig = f()
  .input('staticContext', f.string('Context').cache())
  .input('userQuery', f.string('Dynamic query'))
  .output('answer', f.string('Response'))
  .build();
```

## Signature gallery

Each contract parses with `s()`; `#` lines are captions, not signature content.

```text
# Support triage
 ticketText:string -> priorityClass:class "p0, p1, p2", sentimentClass:class "angry, neutral, happy", replyDraft:string(max 500)
# Invoice extraction
invoiceText:string -> invoiceNumber:string(pattern "^INV-\\d+$" "INV- then digits"), totalAmount:number(min 0), lineItems:object{ description:string, quantity:number(min 1), unitPrice:number }[]
# Contact enrichment
bioText:string -> contactEmail?:string(format email), websiteUrl?:string(format uri), birthDate?:string(format date)
# RAG with cached corpus and verbatim citations
corpusText:string(cache), userQuestion:string -> answerText:string, citedChunks:string(item "verbatim quote")[]
# Python code and tests
taskBrief:string -> pythonScript:code(python), testCases:code(python), riskNotes?:string
# Internal reasoning
problemText:string -> reasoning!:string, solutionText:string
# Resume: nested arrays and objects
resumeText:string -> candidateProfile:object{ fullName:string, yearsExperience:number(min 0), skillList:string[], education:object{ schoolName:string, degreeName?:string }[] }
# Lead scoring
"Score sales leads" leadNotes:string -> fitScore:number(min 0, max 100) "0-100 fit", nextStep:class "call, email, drop"
# Product image
productPhoto:image, question?:string -> productDescription:string, detectedObjects:string[]
# Meeting audio
meetingAudio:audio -> meetingSummary:string(max 1000), actionItems:string(item "one action item")[]
# Moderation
postText:string -> moderationVerdict:class "allow, review, block", flaggedSpans:object{ spanText:string, reasonNote:string }[]
# Translation
sourceText:string, targetLocale?:string -> translatedText:string, glossaryHits:string[]
# SQL with cached schema
schemaText:string(cache), questionText:string -> sqlQuery:code(sql), queryNotes?:string(max 200)
# Calendar extraction
emailText:string -> eventTitle:string, startsAt:datetime, endsAt?:datetime, attendeeNames:string[]
# Booking range
requestText:string -> stayWindow:dateRange, partySize:number(min 1, max 12), flexibleDates:boolean
# Contract dates
contractText:string -> effectiveDate:date, expiryDate?:date, autoRenews:boolean, noticeDays?:number(min 0)
# Link audit
pageText:string -> referencedUrls:url[], primaryUrl?:url
# JSON configuration
requirementsText:string -> serviceConfig:json, setupWarnings:string(item "one warning")[]
# Claims gate
claimText:string, policyText:string(cache) -> isCovered:boolean, confidenceScore:number(min 0, max 1), citedClause?:string
# Earnings
filingText:string(cache) -> revenueByPeriod:object{ periodLabel:string, amountUsd:number }[], guidanceTone:class "raise, hold, cut"
# Pull request review
diffText:code(diff), styleGuide?:string(cache) -> reviewComments:object{ filePath:string, lineNumber:number(min 1), commentText:string(max 300) }[], overallVerdict:class "approve, revise"
# Incident runbook
alertLog:string -> incidentSeverity:class "sev1, sev2, sev3", suspectedService?:string, runbookSteps:string(item "one step")[]
# Product listing with optional file
productPhoto:image, priceSheet?:file -> listingTitle:string(max 80), bulletPoints:string(item "one selling point")[], priceUsd?:number(min 0)
# Study cards
chapterText:string -> flashCards:object{ questionText:string, answerText:string, difficultyTag?:string }[]
```

Additional pattern variants:

```typescript
'problem:string -> reasoning!:string, solution:string'
'email:string -> priority:class "urgent, normal, low"'
'imageData:image, question?:string -> description:string, objects:string[]'
'question:string -> speech:audio, summary:string'
'invoiceText:string -> invoiceNumber:string, totalAmount:number, lineItems:json[]'
'reviewText:string(max 2000) -> rating:number(min 1, max 5), themes:string(item "a theme")[]'
'profileText:string -> profile:object{ fullName:string, age?:number(min 0) }'
'"Answer TypeScript questions" question:string -> answer:string, confidence:number'
```

## Working examples

- [Standard Schema (zod)](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/standard-schema.ts): zod with `f()` and `fn()`, all three source-described shapes.
- [Fluent Signature](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/fluent-signature-example.ts): native fluent API.
- [Structured Output](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/structured_output.ts): structured output with validation.
- [Debug Schema](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/debug_schema.ts): JSON schema validation.
