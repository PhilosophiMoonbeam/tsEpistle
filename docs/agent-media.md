# Agent media: independent tools and explicit model inputs

## Assessment and the original defects

The maintained integration uses `@ax-llm/ax` **25.0.0** for generative inference, image chat and transcription. The application owns authorization, run leases, tool execution, accounting, context compaction and continuation integrity. Request-scoped Ax services sit behind the existing DNS-pinned, bounded provider fetch. Keeping that host loop is intentional: replacing it with an independent AxAgent/AxBalancer loop would not automatically preserve these application contracts.

The original image-model lock had four independent causes: a readonly administration field, a client save payload containing a fixed model, a server `z.literal` model schema, and a transport dispatching a module constant instead of the configured model. Changing only the field would not fix the API request. The separate media configuration now binds the editable model to the actual guarded endpoint and request.

Gemini image model IDs are validated for safe wire syntax and the Gemini prefix, not a numeric generation, `flash`/`pro` family or `-image` suffix. Administrators can configure newly released IDs such as `gemini-nano-banana-2.1` without updating an application catalog. Google's API determines availability and image-output support; configured pricing remains explicit. Invalid configuration feedback identifies the model field and does not misattribute every failure to pricing.

Gemini **LLM** inference still uses Ax's stateless GenerateContent transport, not the Interactions API. The former Omni video and Lyria music settings therefore could not perform those operations. They were neither LLM input capabilities nor working generation controls. Interactions is now a separate **media-only** adapter; it does not change Gemini chat, provider-native continuation or the canonical conversation store.

Native SDK feature hints are not complete protocol proof. With this pinned Ax version, actual Responses requests support images/PDFs even when `getFeatures()` reports false; Anthropic PDF parts fail before dispatch; Gemini's native file path supports video/WebM despite incomplete hints. The shared implemented transport/format matrix and an administrator's exact-model opt-in govern admission. Positive native size/duration restrictions remain additional limits. A checkbox is not evidence that a vendor account can access a model.

## Architecture

```mermaid
flowchart LR
  U[User request and owned attachments] --> A[Atomic run admission]
  L[LLM profile: model and input opt-ins] --> A
  M[Media profiles: operation, API, model, key, grants and price] --> A
  A --> E[Host Agent engine and dispatch budget]
  E --> X[Request-scoped Ax LLM inference]
  E --> T[Independent media tool]
  T --> P[Configured media API]
  P --> V[Bounded decoding and private artifact storage]
  V --> C[Artifact IDs and metadata in tool context]
  C --> X
  U --> I[Authorized opted-in input parts]
  I --> X
```

Generation and model input are separate authorities:

- An OpenAI text-only LLM can invoke a Gemini image tool. A Gemini LLM can invoke OpenAI Images or standalone Stability Core. Generation never changes the chosen LLM merely because a media operation is requested.
- Each media profile represents one operation: image, video, music or transcription. It has its own API, model, official endpoint, credential, exposure/grants, input/output exposure ceilings, timeout and pricing. No LLM profile is required for a media-only vendor.
- Enabled authorized profiles resolve independently per operation: eligible operation default first, otherwise stable display-name/profile-ID order. There is no user-facing provider/model selector.
- Admission pins immutable media version IDs into the canonical admission/queued event alongside the LLM binding. Goals and durable continuations retain their authoritative bindings. Current account access, grants, enabled state, current version and credential readiness are rechecked after guarded DNS resolution, immediately before credential-bearing HTTP dispatch. A changed binding fails closed; it does not silently substitute another model or retry paid generation. This protects the host dispatch boundary, not instantaneous cancellation of an already-dispatched remote request.
- Ordinary run generation controls restrict offered tools. An explicit direct media response uses its matching admitted operation. Planners and child inference do not acquire root generation authority.

In the chat composer, **Images** is selected by default only when image generation is supported for the current conversation; users can deselect it. Other generation choices remain explicit. Redundant image-reference and media-readiness helper notices are omitted; capability controls and actionable errors still describe unavailable operations.

Wiki Agent citation-number badges share a deterministic five-color pastel cycle in answers and Sources: **1 rose, 2 peach, 3 mint, 4 sky, 5 lavender**, repeating every five numbers (so 6 matches 1, including large numbers). CSS uses the existing displayed citation number, blending each tint with the current light/dark surface and retaining the theme's readable foreground. Numbers, keyboard focus, source previews, link targets and sanitized hrefs remain unchanged; color is supplemental, not the citation identifier.

### Implemented generation APIs

| API | Operation | Reference input | Configuration boundary |
| --- | --- | --- | --- |
| Gemini GenerateContent through Ax | Image generation/editing | PNG/JPEG/WebP images | Configured Gemini image model |
| Gemini GenerateContent through Ax transcription | Transcription/dictation | One supported audio file | Configured transcription model |
| Google Interactions, media-only REST | Omni video | Images | Exact supported Omni model; no Veo substitution |
| Google Interactions, media-only REST | Lyria music | None | Exact supported Lyria model |
| OpenAI Images | GPT Image generation/editing | PNG/JPEG/WebP images | Configured supported GPT Image model; generations or multipart edits |
| Stability Stable Image Core | Image generation | None | Core product endpoint and fixed per-generation pricing |

These are real distinct adapters, not generic endpoint guesses. Unsupported API/operation combinations, unsafe model IDs and nonofficial endpoints are rejected before egress; Gemini image model availability and output capability are determined by Google's API. There is no remote output-URL download fallback: generated bytes must be returned through the supported bounded response and pass validation. Stability Core does not advertise editing/reference-image support.

## When media enters the model context

In the LLM profile editor, explicitly enable **Images**, **Documents**, **Audio** and/or **Video** only if the particular configured main model supports that input. All new opt-ins default off. Switch availability is constrained by implemented transport support, not inferred from a model name.

| LLM transport | Image | PDF/document | Audio | Video |
| --- | --- | --- | --- | --- |
| Gemini GenerateContent | PNG/JPEG/WebP | PDF | WebM, Ogg, WAV, MP3, MP4, AAC, FLAC | MP4/WebM |
| OpenAI Chat | PNG/JPEG/WebP | No | WAV/MP3 only | No |
| OpenAI Responses / OpenResponses | PNG/JPEG/WebP | PDF | No | No |
| Anthropic Messages | PNG/JPEG/WebP | No in the pinned implemented Ax path | No | No |
| Legacy text Completions | No | No | No | No |

MIME parameters, case and recognized audio aliases are normalized before applying this same matrix in configuration, upload admission, routing, composer and engine dispatch. A WebM recording is not advertised as OpenAI Chat audio merely because the transport accepts WAV.

1. A user attaches a file, imports an authorized Wiki asset, or explicitly reuses an owned artifact. Ownership, expiry, source hash, count/size bounds and the configured input policy are checked. MP4/WebM asset MIME uses bounded track metadata: audio-only containers require audio opt-in, not video opt-in; unrecognized track kinds fail closed. PDF preparation and complete audio/video decoding happen under existing bounded native processing before persistence. Signature bytes alone are insufficient.
2. Compatible opted-in attachments become native Ax parts in the prompt. Gemini uses the LLM credential's Files/countTokens lifecycle; other supported transports use their native inline parts. Provider upload resources and temporary prepared parts are cleaned up.
3. If a current LLM cannot accept the requested ordinary context format, existing input-aware routing may select another currently eligible authorized LLM; otherwise admission rejects it. Media generation itself is not an LLM routing requirement.
4. Image references may instead go directly to an image/video tool that accepts them, even when LLM image input is disabled. Those bytes do not gain model-analysis permission. A video-only media profile can accept image references without an image-generation profile or a vision LLM.
5. Generated files initially enter tool context as private artifact IDs, MIME/dimension/count metadata and bounded text, **not automatic base64 replay**. The user must attach/reuse them to make them model input. Already authorized attached files can be replayed with conversation history only under the current input/ownership/expiry rules. Old generated artifacts are not automatically promoted into every later prompt.
6. Outbound MCP image/audio result parts obey the same explicit LLM input policy and native validation; a tool cannot bypass it. Music is audio when analyzed by a model, not a fifth input modality. Dictation uses the independent transcription profile and returns text.

Final typed synthesis receives the actual native files from the retained eligible
user attachment window, including eligible historical attachments. Each final
dispatch owns its own upload, native count, authorization and cleanup lifecycle;
preflight never uploads files. File parts and host-owned ID/name/MIME references
are appended to the uncached variables suffix, never the cached Wiki source
prefix or a question-specific schema enum. Planning reserves measured exposure
or the conservative full input/output window rather than counting file placeholders.

Attachment descriptions are a separate claim channel attributed to the escaped
host filename, not Wiki citations or host-observed facts. Independent verification
checks that claims stay within provided-material scope; it does not verify pixel
truth. The final native model must perceive the real authorized file. Collector
prose, tool-only image references and automatically generated assistant artifacts
are not attachment-content evidence. Coverage checks both claim channels without
allowing attachment statements to satisfy missing Wiki facts or recent-page
obligations. Ownership, input capability and payload authority are rechecked
before count, dispatch and publication; model perception remains fallible.
Final perception uses only user attachments in the retained conversation window.
Accepted history compaction/checkpoints retire swallowed historical inputs; a
summary or earlier model prose cannot reattach those files. A new current input,
including an explicitly reused **Edit image** upload, keeps its own authorization.

Wiki support and provided-file scope use separate native decision contexts. Wiki
evidence cannot stand in for file contents, and a Wiki-only support policy does not
turn a clearly attributed file description into an unsupported Wiki claim. Both
channels must pass their own required checks; confidence must still exceed 0.8.

Failed native verification records its local failure code, received HTTP status
(including a successful status with an unreadable body), and allowlisted native
error class / transport code in `model.turn.verification.failure`. Provider bodies,
messages, stacks, credentials and raw causes remain redacted. Missing usage retains
conservative exposure rather than manufacturing a zero-cost receipt.

### Context window and accounting

Gemini input admission uses native Files token counting. Other supported model paths retain the application's conservative serialized-size/full-window exposure guard; these are **estimated admission units, not measured prompt tokens**. Large valid inline images/PDFs can consequently be rejected in small configured windows. OpenAI Responses and Anthropic do have separate input-token-count APIs; this implementation does not claim otherwise or call private Ax serializer internals to fabricate a wire-faithful count. Actual inference receipts settle usage after complete output.

Automatic routing preflight is provider-call-free and uses the engine's admitted input and output exposures as one frame, including host output caps. An unmeasured-media full-window bound already covers the entire authorized dispatch window, including possible opaque native replay; it must not be inflated by adding a second continuation-byte proxy. This is a conservative bound, not a measured token receipt. Ordinary serialized request/text estimates still add compatible stored continuation exposure, so genuinely oversized combined frames remain rejected. Native Files counting and actual prompt/window/dispatch admission remain in place before inference.

Media dispatch reserves its **own** configured exposure and price before paid generation, independently of LLM prices. Accounting marks dispatch only at credential-bearing HTTP invocation, after guarded DNS, live authorization and abort checks. Proven pre-HTTP failures release their reservation; paid failures or incomplete receipts retain conservative unsettled exposure. Reported receipts are validated and reconciled exactly once. Fixed-priced products can have zero token usage and positive cost. Missing Interactions usage is explicitly estimated, not invented as measured usage. No failure can publish unvalidated bytes. Configuration rates are operator estimates, not provider invoices or guaranteed cache savings. Context compaction retains the host's canonical-history and accounting invariants.

## Administration and migration

Use **Administration → Agents → Media providers** to add/edit a profile, its model, credentials, grants and rates, then deliberately enable it and optionally select its operation default. Creation does not spend money on an implicit readiness probe. `secretConfigured` proves configured credential readiness, not vendor product availability. Omitted credentials retain the current secret only within the same vendor origin. Switching origins with an existing secret requires explicit replacement, a different environment-secret reference, or clearing; a retained Google key cannot silently move to OpenAI or Stability. Same-origin Google API changes may retain credentials. Admin writes require current `manage:system` authority and optimistic revision fencing; secrets are never returned in views.

The LLM editor now owns only inference configuration and its media-input opt-ins. A new immutable LLM version follows existing disable/recheck/enable conformance rules; do not assume changing input switches preserves an old conformance receipt. Conformance of a text LLM does not certify a separate media product.

Gemini inference uses Ax's GenerateContent transport, not Interactions. The generative provider wizard states that distinction explicitly; video/music profiles use the separate media-only Interactions adapter.

Migration `tsepistle-000055-agent-media-providers.ts` adds independent identities, immutable versions, group grants and a configuration lock. It copies each current legacy operation's exact model, price, credential reference and exposure/grants. Working image/transcription profiles are enabled only when their former LLM profile was enabled and conformed. Formerly unsupported Omni/Lyria profiles are seeded **disabled**. Historical LLM media settings, versions, credentials, runs, artifacts and ledgers remain stored. Legacy attachment opt-in retains image/PDF permission only where actually supported; it does not silently enable audio/video.

Old queued admissions without media bindings do not acquire new generation authority. Do not restore a retired writer to reinterpret their hashes/configuration. Runtime authorization and ordinary retention/deletion still govern old artifacts and immutable credentials.

The affected application image includes real `ffmpeg`/`ffprobe` for complete bounded decoding, alongside existing `qpdf`. File protocols/demuxers, process concurrency, CPU/memory/time/output and sample/frame/dimension limits are constrained. FFmpeg's separate GPL distribution notices and source references are in `NOTICE` and `COPYING.GPL-3.0`; this is not a link-time replacement of the application license.

The independent media administration/input controls have an approved **24 KiB aggregate JavaScript allowance**. The clean image build measured 13,671.3 KiB against the maintained image's 13,653.2 KiB; the fixed aggregate ceiling is now 13,678 KiB. Every initial-load, largest-chunk, login and lazy-scene budget remains unchanged.

## Primary API references

- [Ax library](https://github.com/ax-llm/ax)
- [Gemini image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)
- [Gemini transcription](https://ai.google.dev/gemini-api/docs/generate-content/transcribe)
- [Google Omni](https://ai.google.dev/gemini-api/docs/omni)
- [Google music generation](https://ai.google.dev/gemini-api/docs/music-generation)
- [OpenAI Images API](https://platform.openai.com/docs/api-reference/images)
- [Stability API](https://platform.stability.ai/docs/api-reference)
- [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting)
