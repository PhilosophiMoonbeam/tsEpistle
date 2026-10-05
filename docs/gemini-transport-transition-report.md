# Gemini chat transport: archived transition assessment

**Superseded/archive — 2026-10-05.** The Ax 24.0.24 assessment dated 2026-09-27 is historical, not an instruction to defer the cutover or retain Interactions or Google Search. Its original observations and decision are available in the [dated repository tree at `7e50ba2ec0e4`](https://github.com/PhilosophiMoonbeam/tsEpistle/tree/7e50ba2ec0e4). Do not apply those dated synthetic results as defects in the current Ax release.

## Current cutover facts

- The installed and lock-pinned release is **`@ax-llm/ax` 25.0.0**. Gemini chat uses native `ai({ name: 'google-gemini' })` over stateless `generateContent` / `streamGenerateContent` with canonical application history, not a custom Interactions adapter.
- Narrow host bridges preserve Wiki action/JSON schemas, configured thinking with an output ceiling, exact signed assistant parts, guarded egress, and bounded completion/usage validation. Permissions, approvals, evidence, ownership, quotas and settlement remain host responsibilities.
- Current native continuation is `gemini-generate-content-v1`. Origin/profile-version/model/capability binding and integrity checks still apply. Historical Interactions state is retained but is incompatible with current native replay: the runtime falls back to canonical history rather than translating retired opaque state. Hidden historical protocol context is not guaranteed to survive that fallback.
- New Google Web Search calls and live Search consent/configuration are retired. Stored answers, citations, admission hashes and provider state remain historical data under their existing ownership, retention, deletion and expiry rules. Wiki page search and authorized page reads remain supported; historical web citations do not confer Wiki evidence or action authority.
- Migration `tsepistle-000049-agent-ax-gemini.ts` creates immutable current profile versions, disables affected profiles and clears conformance for deliberate rechecking. It preserves historical versions, runs, messages, citations, provider state/hashes, approvals, grants, configured prices, accounting and secret references. A preserved but disabled global default cannot resolve. This is not a retired-transport rollback mechanism.

## Media compatibility boundaries

Native image generation/editing (`gemini-3.1-flash-image`) uses Ax chat, and transcription (`gemini-3.5-transcribe`) uses Ax `transcribe`. Narrow guarded bridges retain Files upload/read/delete, `countTokens`, and bounded media validation absent from the native surface. Image/PDF attachment admission remains permission-, profile-, owner- and expiry-bound; a chat cutover does not waive media authorization or billing constraints.

The exact configured video model **`gemini-omni-1.1-flash`** and music model **`lyria-3.5`** remain explicitly **unsupported** on the current transport because those configured operations require Interactions. Reject them before paid generation or input upload; do not substitute another model or endpoint. Preserve their configuration and existing artifacts under ordinary access, retention and deletion rules. This report does not infer new availability or prices.

## Current authority and evidence limits

Use [Agent deployment and operations](agents-deployment.md) for the normative transport, continuation, migration, media and recovery contract; [Agent controls](agent-controls.md) for separate decision providers, controlled external MCP and administrator-only direct stay/swap routing; [Agent media](agents-media.md) for media operations; and [Wiki Agent workspace](agent-workspace.md) for the model-free user experience.

The current design does not add asynchronous Ax subagents or new custom specialist proposals. Existing host goals, research and historical specialist receipts/pending continuations remain retained with their authority and accounting constraints.

Installed-version and implementation facts are not proof that integrated gates, live-provider conformance for every operation, deployment or release acceptance have passed. This archived report makes no latency, cache-hit, measured-savings or provider-billing claim.
