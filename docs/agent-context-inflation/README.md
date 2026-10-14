# Wiki context inflation: findings and complete-read correction

## Historical finding

A roughly 5,000-token page is not being rejected by Google as a 128,000-token document. The failing tsEpistle guard counts **UTF-8 bytes of the complete serialized Ax request**, then subtracts that byte count from a profile field called `maxContextTokens`.

The source also expands substantially before that check. In an offline reconstruction using the production parser, evidence registration, synthesis encoder and Ax prompt/schema generator, the 16,443-byte private page produces a **257,897-byte** typed request. That is approximately **15.68 times the page's byte size**, not a measured 51.86-fold increase in model tokens. Comparing 257,897 bytes with the operator's approximately 4,973 page tokens mixes units.

This is a local admission failure, before typed synthesis dispatch. There is no provider-reported token count for the rejected final request. The report does not assert that Google received it, exhausted its context window, or billed that hypothetical final request.

The portable anonymized fixture reproduces the same structural problem without this Wiki, database, page, credentials, browser, or an AI service. Removing section aliases alone does **not** solve it: the root-only reconstruction is still 220,750 bytes.

## Scope and files

Historical investigated revision: `252b8c465a8fabecde430431561e95316225dd65`, Bun 1.4.2, `@ax-llm/ax` 25.2.1, Gemini profile model `gemini-3.8-flash`. The historical reproduction, expansion tables and code walkthrough below describe that revision. Retained historical metric files are unchanged. Current architecture and separately measured results follow.

| File | Purpose |
| --- | --- |
| [observed-live-trace.json](observed-live-trace.json) | Fresh failing interaction, chronological events, reported ordinary model usage; no source text or authentication material |
| [private-page-metrics.json](private-page-metrics.json) | Numeric offline reconstruction from the private original page; no page content |
| [fixture-metrics.json](fixture-metrics.json) | Numeric reconstruction from the committed anonymized fixture |
| [falcon-like.md](falcon-like.md) | Portable 440-line Markdown capacity specimen, including lists, records, disclosures, tables, links and code blocks |
| [fixture.json](fixture.json) | Stored TOC, page metadata and exact question for that specimen |
| [reproduce.py](reproduce.py), [prepare.py](prepare.py), [probe.ts](probe.ts) | Offline reproduction using the checkout's actual production functions |

The fixture consistently pseudonymizes words and numbers with a private salted mapping while retaining Markdown/HTML syntax and parsing-sensitive continuation keywords. HTTP and email destinations use `example.invalid`. It contains no original people, contact details, working share URLs, share keys, credentials, cookies, login state or personal memories. The salt is not exported. Some labels are intentionally nonsensical: this is a **capacity/binding topology fixture**, not a semantic-answer benchmark.

## Complete reads, minimal locators and independent audit

The correction removes the model-facing unit/field/record/closure catalogs rather than compressing increasingly elaborate proof packets. `sourceText` carries each physical read's **unchanged complete original body once**, including facts not requested in the first question. `sourceReferences` contains only:

```ts
{
  reads: {
    [sourceRef]: { readRef, evidenceId, sourceRevision }
  }
}
```

One canonical immutable read binding replaces hundreds of overlapping root/section selectors. There are no model-facing previews, atomic selectors, field maps, record numbers, dependency spans or automatic quotation expansion. Root/section citation metadata still exists privately; aliases do not multiply source content or model authority. Every generated statement is explicit and nonempty. The model may emit concise prose, selected-field tables or lists without copying an entire native block.

The host and Jev have different responsibilities:

| Boundary | Authority |
| --- | --- |
| Permission, scope, current revision/hash, original read receipt, expiry and cancellation | Host; rechecked before dispatch/publication |
| Exact numeric values, signed values, addresses, phones, code and rendered links | Host; admitted visible source literals only |
| Subjects, fields, rows, comparisons, authored references and governing qualifications across one complete read | Native Jev; not a lexical unit/record eligibility grammar |
| Requested contribution and collective answer completeness | Independent compact full-read audit on the existing answer profile; not native Jev coverage |
| Usage, reservations, failed paid calls, unknown exposure and quotas | Existing accounting; no relaxation |

Every read-scoped claim requires native support proof, including exact-looking quotations. Native Jev handles support and narration only, **not coverage**; consumed decisions require both chosen probability and confidence **strictly above 0.8**. Missing, detached, malformed, uncertain, negative or unavailable support results do not publish facts. Support alone does not establish collective answer completeness.

Native verification shares original read text within bounded support/narration batches. Oversized batches split losslessly; they do not prune source content or claims. The unchanged native input ceiling is 122,880 bytes after its output reserve. A required complete source that cannot fit produces an honest evidence-capacity outcome, not a clipped quotation, larger quota or fabricated absence claim. The original 150 KB and 300 KB boundary specimens remain full size.

The parser retains the exact visible factual boundary separately from raw markup. When no body content is excluded, `authorText` equals the original body and shares its interned string. Otherwise native proof uses the complete admitted projection; raw-only HTML attributes, hidden elements, script/style/template bodies, comments, frontmatter and opaque content are not factual or literal authority. Exact code whitespace remains intact. This does not implement arbitrary CSS visibility analysis.

Complete reads survive ordinary same-owned-session follow-ups through existing persisted `tool.completed` receipts. Reuse still requires fresh authorization, scope, revision/hash and expiry validation; an earlier run's delivery is not current delivery authority. Latest valid logical reads replace older ones. Admitted user/assistant history resolves conversational references; it is not factual evidence. Tools, binary output and thought blocks are not duplicated into synthesis conversation context. No new store or migration is introduced.

The root read-tool projection retains unchanged complete bodies while removing the catalog and description; lexical search uses concise anchors rather than verbose discovery instructions. Jev readiness can bypass redundant collector acknowledgement for fresh retained reads or newly delivered complete reads, with probability and confidence strictly above 0.8 and normal source/provider fences. It is not repeated for an unchanged evidence registry, or added when the host already forces synthesis. Malformed measured readiness can fall back to ordinary collection only after valid settlement. Unknown exposure, timeout and stale-source errors fail closed.

One independent compact **collective full-read audit** runs on the existing answer profile, with `complete`, `incomplete` and `not_established` outcomes. It adds a paid call under normal pricing, admission, receipts and freshness checks, not new source obligations or catalogs. Its private feedback is bounded to 2,000 UTF-8 bytes and can use the one existing repair; it grants neither source authority nor extra retries.

### Current sprint measurements and qualification status

Warm ranked follow-ups retained all four complete bodies (**6,729 bytes**) with **zero GETs**; the collector still consumed **10,143 / 10,283 input tokens**. The native source-section coverage experiment consumed **44,478 tokens across eight controls**, versus **26,355** for the lean variant (**+69%**), and still missed the billing-owner condition. That experiment was rejected and is **not shipped**.

The independent audit calibration, before the later definition/measurement-actor refinements, used the unchanged frozen eight controls, source-first guidance and the existing low calibration: **18,355 input tokens, 177 output tokens, 19,714 provider-total tokens, 21,073 costMicros, eight real calls and zero unknown exposure**. Provider totals are retained as reported, not reconstructed as input plus output. All four positives passed; the three unambiguous omissions (billing owner, no-proxy restriction and queue-not-availability qualification) were rejected.

That calibration's raw result is **7/8**, not a universal correctness claim. The remaining original omit-not-resolution control retains “targets measure first human response during supported hours” while removing the literal “not resolution time”; its semantic interpretation is ambiguous. The corpus was not rewritten to improve the score. Its additional **1.3–5.85 seconds per candidate** is a real audit tradeoff, not a latency percentile. The final policy was subsequently evaluated in the deployed cohort below; no new eight-control score is claimed for those later refinements.

### Final deployed efficiency and coverage refinement

Tested source revision: `66f8f50b7`; image: `local/tsepistle:wiki-lean-context-66f8f50b7`. Only Wiki was replaced; PostgreSQL, configuration, secrets, keyrings, volumes, network, ports and capabilities were preserved. Writable cache/uploads were saved after graceful shutdown and restored before start. Ordinary continuity retained 31 pages, 12 users and the original page's unchanged revision/hash.

The frozen comparison retains all original questions, source bodies and rubric, with fingerprint `9c45ede1b9f6296205a4ab3ed8f642cece1f9e1cb3f7d9b15cbe84b1a07ed308`. Its final **18/18 runs completed, with zero repairs and zero unknown exposure**. Independent source-rubric reviewers graded **17 exact published answers**: all 27 required facts and 32 material restrictions were covered, with no unsupported claims. One ordinary new-topic answer remains ungraded because search returned metadata outside the frozen corpus; no outside body read occurred, and the answer was not inferred or relabeled eligible.

The following are historical-before versus final single samples within the named arm, not percentiles or a universal latency improvement:

| Frozen case / arm | Before input tokens | Final input tokens | Before seconds | Final seconds |
| --- | ---: | ---: | ---: | ---: |
| Selected role/email / ordinary | 31,998 | 19,204 | 11.422 | 14.016 |
| Order cutoff / ordinary | 34,185 | 27,954 | 10.766 | 11.314 |
| Two-page comparison / ordinary | 43,766 | 26,222 | 18.156 | 23.975 |
| Pilot summary / ranked selection | 28,829 | 32,315 | 11.604 | 14.155 |
| Linked annex / ordinary | 33,978 | 27,833 | 10.298 | 11.896 |
| Pronoun follow-up / ordinary | 16,864 | 6,206 | 9.010 | 6.504 |

Quality improved rather than being assumed from native acceptance: both final comparisons retain first **human** response, non-resolution limits, weekday/hour/holiday definitions, tax, expiry, eligibility and fictional framing. Both pilot summaries retain all 11 frozen facts/restrictions; the old ranked summary omitted the supported-hours schedule. Generic source-definition/measurement-actor instructions replaced omission-prone shorthand without adding source-obligation catalogs.

The ranked arm uses actual unfiltered Top-K search selection through the normal application, not an ideal deterministic two-call RAG implementation. **11/18 trials and three paired comparisons** met the strict protocol eligibility conditions. Six ranked trials did not ingest every selected Top-K page, and one ordinary trial had the off-corpus metadata result above. Quality grades do not change these exclusions. These measurements do not establish that this engine universally outperforms ideal whole-page Top-K.

Actual workspace proof used an owned **5,145-byte** fictional page: selected role/email completed in 9.121 seconds; a subsequent full plan-comparison table completed in 13.079 seconds with **zero new body reads**, retaining all 5,145 authored bytes and only 175 source-wrapper bytes. After changing its supported hours, the same conversation made one fresh body read and published **10:00–18:00 at revision 2** in 6.099 seconds. All three completed without repair or unknown exposure. These durations are the recorded run-event spans, not browser/network percentiles.

Intermediate failures remain part of the evidence. A required-empty-feedback plaintext mismatch and native nullable optional-field mismatch caused false audit failures and repairs; both now use the SDK's real protocol, while incomplete/uncertain verdicts still require nonblank private feedback. Earlier definition-only refinements still omitted the response actor and were not treated as fully covered. Two intermediate `a69c96ab1` runs failed on upstream HTTP 500/400 after readiness settled: observed receipts of 8,150 / 7,730 total tokens remain separate from outstanding conservative holds of 37,413 / 50,144 tokens. Holds are exposure bounds, not reported provider usage or invoices; no automatic retries were added.

Qualification: **632 changed-path tests across seven files**, server typecheck, affected-file lint and affected-service build passed. Regression coverage includes stale Jev identity before audit dispatch, aggregate audit receipt limits without an optional dispatch-budget object, native null-feedback handling, newly delivered read readiness and revocation after positive readiness. The final normal API cohort and actual workspace/freshness flow are behavioral proof; tests alone are not.

Remaining limits: model/service latency is variable; coverage judgments can still be wrong on unseen content; finite benchmarks cannot certify universal completeness. Complete-body retention avoids discarding later-useful facts from an already read source, not the legitimate need to retrieve a different or changed source. Failed calls keep normal measured receipts and conservative unknown-exposure handling.

Two additional structural false rejections were reproduced and corrected:

- `09:00-17:00` was scanned as positive `09:00` and negative `-17:00`, unlike the source's en-dash range. Signs are now distinguished from range separators; genuinely changed negative values remain rejected.
- Flattening independent table cells manufactured phone literals such as `120 30 48` from price, ticket count and response time. Phone extraction now preserves cell/block boundaries rather than requiring a fabricated identifier in the source.

An unanchored full-body email scan also became quadratic on long ordinary words. Matching is bounded to address-like tokens, with no scan when `@` is absent. These corrections change neither native thresholds nor retry allowances.

### Offline representation measurements

The unchanged portable specimen contains 16,426 UTF-8 bytes, 261 complete private projected units, 11 sections and 12 supplied TOC entries. Six registered root/section evidence identities now produce **one physical read, one synthesis binding and one locator**.

| Quantity | Previous named-row transport | Complete-read correction |
| --- | ---: | ---: |
| Root-only serialized Ax request bytes | 159,534 | 29,510 |
| Root + sections serialized Ax request bytes | 165,023 | 29,510 |
| Root + sections request + 8,192 output allowance | 173,215 | 37,702 |
| Complete original source bytes | 16,426 | 16,426 |
| Current read-locator JSON bytes | — | 103 |
| Current body plus read wrapper bytes | — | 16,603 |
| Current output-schema bytes | — | 2,105 |

Both variants fit the unchanged 128,000/8,192 diagnostic profile. The root/section multiplier is gone; current wrappers add 177 bytes to the original body. These are serialized request **bytes**, not model-token estimates. Fixed policy, schema, prefix and JSON overhead remain; deleting structure does not make the complete request identical to the source file.

### Historical accounted live benchmarks and limits

Native application measurements below use ordinary authenticated requests, owned fictional sources, existing profiles and normal accounting. The eight frozen query shapes were selected-field, new-topic follow-up, factual, broad summary, comparison, linked source, unavailable evidence and explicitly requested Markdown table. Questions and source bodies were not narrowed to get a pass. These are individual samples, not latency percentiles or a universal correctness certificate.

Historical deployed code revision: `6e03601297614983f0688f32d96973ee97b4f182`; local image `local/tsepistle:wiki-cell-boundaries-6e0360129`. Only Wiki was replaced. PostgreSQL, secrets, volumes, service/network identity and configuration were preserved; writable cache/uploads were copied after graceful stop and restored before start.

| Final frozen case | Seconds | New body reads | Repairs | Observed outcome |
| --- | ---: | ---: | ---: | --- |
| Selected field, first attempt | 11.304 | 1 | — | Native service failure; no facts published |
| Same-page new-topic follow-up | 5.914 | 0 | 0 | Correct returns, hours and exceptions |
| Factual | 5.448 | 0 | 0 | Correct lead time, threshold, fee and delivery scope |
| Broad summary | 12.746 | 0 | 0 | All substantive sections; completeness caveat below |
| Comparison | 10.195 | 0 | 0 | Correct dimensions and governing qualifications |
| Linked source | 5.119 | 1 | 0 | Annex-owned values, exception and citation |
| Unavailable evidence | 5.770 | 0 | 0 | No invented freight price or uptime percentage |
| Explicit Markdown table | 9.354 | 0 | 0 | Correct table and shared conditions |
| Selected field, separate new run after provider recovery | 20.697 | 1 | 0 | Correct concise role; contact details excluded |

Do not discard the failed first attempt. It returned `WIKI_VERIFICATION_FAILED`, with existing unsettled exposure recorded as `tokens: 64000, costMicros: 2688`. Subsequent verification calls succeeded; the later selected-field request was a distinct run, not an added automatic retry. The native dependency remains an availability and accounting risk.

| Unchanged 17,212-byte dense-page pair | Before correction | Final deployed sample |
| --- | ---: | ---: |
| First answer seconds | 34.450 | 18.515 |
| First typed-generation input tokens, provider reported | 75,759 | 10,609 |
| First serialized typed-request bytes | 175,513 | 31,222 |
| Delivery follow-up seconds | 17.486 | 17.206 |
| Delivery follow-up typed-generation input tokens, provider reported | — | 10,628 |
| Delivery follow-up new body reads | 1 | 0 |
| Delivery follow-up repairs | 1 | 0 |

The earlier delivery follow-up ended partial after refetching and repeated native verification. The final pair completed both questions, retaining all 17,212 original bytes and using one native batch per answer. Its follow-up's typed provider call alone took 10.993 seconds: smaller context is proven, uniformly low network/model latency is not. Earlier complete-source samples varied; reporting only the fastest would overstate improvement.

The genuine referential pair named Avery Moss, then answered “What is their email address?” with only Avery's address: 13.899 and 5.664 seconds, zero follow-up reads or repairs. The final actual workspace rendered the requested comparison table with citations, then completed the ordinary returns/hours follow-up without a body read. The UI comparison used its existing one repair after uncertain native coverage; the UI follow-up used none.

Freshness was exercised by changing only the owned policy page's hours from 09:00–17:00 at revision 3 to 10:00–18:00 at revision 4. The existing warm session made a new `pages.get`, answered the new hours and cited revision 4 in 9.377 seconds. Retention does not bypass freshness.

**Remaining semantic limit:** native “complete” is not independent proof of exhaustive summary quality. Earlier iterations omitted several material restrictions; targeted generic guidance improved coverage without restoring field catalogs. The final broad summary still omitted the explicit one-billing-owner condition and did not explicitly restate the first-response-versus-resolution non-guarantee. Do not represent the summary sample as exhaustive or universal correctness. Complete sources make those facts available for subsequent questions; they do not make model judgments infallible.

A targeted ordinary follow-up asked for those omitted eligibility and response limits. It returned one organization, one billing owner, reseller/multi-tenant exclusions and first-human-response-not-resolution in 6.707 seconds, with revision-4 authority, zero body reads and no repair. Answer omission no longer discards the underlying source context.

Historical qualification: 987 changed-surface tests passed across 13 files, server typecheck passed, affected-file lint passed, and the affected-service image built successfully. Full static checks passed on the preceding integration revision; final boundary edits were separately typechecked/linted and exercised in the deployed application. Training/selection classification covered 12 fixtures and 100 variants with zero mismatches; final holdout was not loaded, and this classification result is not native semantic verification.

Owned temporary pages 77, 78 and 79 were deleted through the normal revision-checked API after verification. The application returned to 31 pages, 12 users and zero active runs. Original page 13 remained revision 2, 1,105 bytes, SHA-256 `113c967750999dac6f7a07dbfb14067cb182b7c7ed0bfd955b4089121f19d84b`. Run histories, receipts and accounting records were not erased.

Default offline output is numeric metrics, assumptions and a source hash; it does not dispatch to a provider. Optional `PROBE_REQUEST_FILE=/private/path/request.json` writes the full captured request with mode `0600`; it contains source content and must not be published. Historical metric files and the historical reproduction below remain unchanged.

## Fresh live reproduction

The operator had cleared their earlier conversation. A new temporary session was created through the ordinary authenticated Wiki API, with all-Wiki scope, an empty selected-source list and no prior user/assistant history. The exact submitted question was:

> Who is our Falcon contact?

Run: `498556f1-3ddb-4ddc-9191-1638a2bb1eef`, 2026-10-12 22:31 UTC. The page was Markdown revision 2, 16,443 UTF-8 bytes. The operator's approximately 4,973 page-token estimate was not independently tokenized in this investigation.

| Time, UTC | Observation |
| --- | --- |
| 22:31:17.949 | Ordinary model turn returns tool calls: 5,313 reported input tokens, 69 output, 5,509 total; serialized request 25,542 bytes |
| 22:31:19.145 | `pages.search` completes, no cache hit |
| 22:31:32.884 | Next ordinary turn returns tool calls: 6,785 input, 29 output, 8,449 total; serialized request 32,724 bytes |
| 22:31:34.842 | `pages.get` completes, no cache hit |
| 22:31:35.578 | Run fails with `AGENT_CONTEXT_TOO_LARGE`; assistant message is failed |

The ordinary model turns precede completion of the body read. Their reported tokens are **not** a token count of the later typed synthesis request. Provider totals are retained as reported; they need not equal classified input plus output, and the trace does not invent a classification for the residual.

No successful typed-synthesis or Wiki-verification model turn appears after the read. Retrieval and permissions reached the page successfully. A missing Jev provider had previously caused `WIKI_VERIFICATION_UNAVAILABLE`; that setup was corrected before this reproduction. The default Jev provider was enabled, credentialed, live-checked and priced. This context failure is a separate condition.

Production had 102 applied migrations with a clear migration lock. The investigation did not stop or replace the application, modify page data, erase histories, alter provider limits, or disable validation. Test interactions are ordinary owned temporary sessions under normal retention.

## Reproduce on another system

Use the repository's supported Bun installation and Python 3.9 or later. Install the frozen dependencies in the checkout to measure. Use the investigated revision only when reproducing the historical numbers:

```sh
bun install --frozen-lockfile
python3 docs/agent-context-inflation/reproduce.py --output /tmp/falcon-metrics.json
```

The command is independent of the current working directory when invoked with the script's path. Generated engine code, helper exports, a dependency symlink and intermediate metrics live in an owned system temporary directory, which the launcher removes. It does not edit the engine or generated files into the checkout.

It constructs `AxMockAIService`, captures the actual Ax-generated request, and supplies a synthetic empty answer solely to complete the mock call. Global `fetch` throws if invoked. No Google or TypeSafe service is constructed, no application is started, no database or tools are run, and no provider key is needed. Dependency installation is the only step that ordinarily requires network access. FFmpeg and qpdf are not needed for this diagnostic.

For the committed fixture at the **historical investigated** code/dependency versions, expect:

- 16,426 source UTF-8 bytes; 259 complete projected units; 11 parsed sections.
- 12 supplied TOC citation entries; 6 evidence identities actually registered.
- 260 root-only synthesis source projections; 437 root-plus-section projections, with 260 distinct native unit IDs.
- Root-only final request: **221,151 bytes**. Root-plus-sections: **258,525 bytes**.
- Output schema: **5,797 bytes** in both nonempty variants.
- `passesRequestedContext: false` for both nonempty variants at 128,000 context / 8,192 output.

`sourceCharacters` is JavaScript UTF-16 string length, not Unicode code points, UTF-8 bytes or tokens. Use LF line endings and the frozen Ax version for byte-for-byte comparisons. Model names, question wording and TOC metadata can change counts or fixed overhead.

Optional input:

```sh
python3 docs/agent-context-inflation/reproduce.py --input /path/to/metadata.json
```

Metadata can include inline `content` or a relative `contentFile`. A bare `.md` input uses diagnostic title/path defaults and approximates section citation assembly; do not call that an exact stored-TOC reproduction. The committed JSON fixture includes the TOC and has `tocApproximation: false`. The helper's snapshot-array mode selects page ID 13; adapt the low-level probe argument if diagnosing another page.

### What the offline numbers establish

Preparation exposes existing lexical engine helpers in a **temporary copy**, extracts the exact synthesis source-construction block retained in `#synthesisTurn`, and extracts the production page-read TOC/citation functions. The production preflight reuses that construction; its dispatch/admission code is not executed by this probe. The probe executes production parsing, sentence/record projection, closures, root/section evidence normalization, source construction, encoding, Ax prompt generation and native output-schema generation. It also prepends the real `final-synthesis` host prompt before calling the production serialization-size helper.

This is a reconstruction, **not a production capture of the rejected full frame**. Assumptions are empty memory/skills and prior admitted conversation, all-Wiki scope, one literal request facet, no observations, no correction feedback and the stated model/output allowance. The measured production host prefix is included (2,140 bytes). Warm production requests separately include admitted user/assistant conversation and compaction notes for continuity; this empty-history fixture measures neither that variable overhead nor the actual full runtime admission path. Different live options change fixed overhead. The historical failed frame's byte breakdown was not logged; even its minimal/root-only reconstruction established failure without prior chat history.

These are serialized **Ax request** bytes. The Gemini adapter subsequently converts Ax fields to Google's native body; that body, its exact tokenization and its treatment of schema instructions were not measured here. The mock does not establish a semantically correct answer, native provider conformance, paid exposure settlement or end-to-end publication.

## Historical measured expansion

The anonymized specimen preserves the original's measured parser/binding cardinalities; its content and URL lengths differ slightly.

| Quantity | Private original | Portable fixture |
| --- | ---: | ---: |
| Raw page bytes | 16,443 | 16,426 |
| Complete projected body units | 259 | 259 |
| Parsed sections / supplied TOC citations | 11 / 12 | 11 / 12 |
| Registered evidence identities | 6 | 6 |
| Root-only source projections, including page title | 260 | 260 |
| Root + section projections | 437 | 437 |
| Distinct native unit IDs | 260 | 260 |
| Root-only `sourceBindings` JSON | 49,351 | 49,588 |
| Root + sections `sourceBindings` JSON | 83,742 | 84,206 |
| `sourceStructures` JSON, either variant | 137,551 | 137,715 |
| Native output schema JSON, either variant | 5,797 | 5,797 |
| Complete root-only serialized Ax request | 220,750 | 221,151 |
| Complete root + sections serialized Ax request | 257,897 | 258,525 |
| Root + sections input bytes + 8,192 output allowance | 266,089 | 266,717 |

The private `sourceStructures` block comprises:

| Subobject | Bytes | Count |
| --- | ---: | ---: |
| Scope metadata, `sources` | 65,687 | 249 shared scopes |
| Exact authored content, `authoredContent` | 31,002 | 236 entries |
| Complete quotations, `quotations` | 40,817 | 208 entries |
| Enclosing keys and JSON punctuation | 45 | — |
| Total | 137,551 | — |

The original raw body is not simply copied once. Normalized selected text, authored dependencies and complete quotations serve different purposes. Unit/record assertions and raw dependency spans can overlap even when strings or scopes are individually deduplicated. There are 1,135 interned parser/closure structure inputs before readable transport projection.

Root-plus-section bindings contain 35,119 selected-text bytes, but only 20,548 distinct selected-text bytes. The root-only selected-text total is 20,839 bytes. Root/section aliases increase bindings by **34,391 bytes** and the complete request by **37,147 bytes**, while shared structures and schema sizes stay constant. That is a real multiplier, but the root-only request already exceeds the ceiling.

The two transport fields are JSON strings. Their combined private length is 221,293 bytes before they are rendered into the Ax user message. The Ax chat-message array is 249,725 serialized bytes before host prefix insertion, and 251,913 afterward. The native response-format wrapper contributes 5,870 bytes, of which 5,797 is schema. Outer field names, punctuation, model configuration and model name account for the remainder to 257,897.

Do not add every table row to the final total: rows represent nested objects and different escaping layers. Escaping and JSON keys add bytes; they do not necessarily correspond one-for-one to model tokens.

The probe also reports an empty-source baseline, 14,033 final bytes for the private-case options. That branch uses a shorter empty-source claim description and schema. It is a qualitative capacity control, **not an identical fixed-overhead baseline to subtract** from a nonempty request.

## Code walkthrough and ownership of the expansion

1. **Stored TOC becomes root and section citation metadata.** `server/agents/actions/page-reads.ts:250–275`, `tocSections` / `pageCitation`. A supplied TOC entry is not automatically a distinct admitted body representation; section matching and completeness still apply.
2. **Source text becomes assertion units and owned closures.** `server/agents/providers/source-document.ts:253–917`, `parseSourceDocument`; `engine.ts:991–1114`, `projectedSourceUnits`. Closures retain own units/record fields, governing contexts, links and exact source dependencies. These constraints prevent unrelated adjacent facts from becoming support.
3. **Page and matching section evidence are registered independently.** `engine.ts:1587–1644`, `collectPageEvidence`: root gets all applicable units; sections get subsets. `engine.ts:4451–4510`, dispatch evidence snapshot, selects by evidence identity rather than globally collapsing native unit IDs.
4. **Typed synthesis visits every eligible evidence/unit pair.** `engine.ts:6042–6119`, `#synthesisTurn` source construction. Complete nonopaque units become source bindings; page-title metadata receives its own binding. Parser structures are interned, while original evidence/revision/unit triples remain distinct.
5. **Readable transport retains several source representations.** `wiki-synthesis.ts:52–160`, `encodeWikiSynthesisSources`: exact authored strings, quotations and identical scopes are shared, but each projection still writes `source.text` at lines 145–153. This deduplication does not remove root/section binding multiplicity or all overlapping authored/quoted content.
6. **Ax adds signature instructions and structured output.** `wiki-synthesis.ts:700–821`, `createWikiSynthesisProgram`. Inspect the captured field sizes and installed Ax prompt generation. Output descriptions appear in the Ax system output instructions and native response schema. This is fixed overhead for the nonempty cases, not a per-unit growing schema enumeration.
7. **The final frame gets the host prefix and a late capacity check.** `engine.ts:6207–6272`, `admittedChat`, especially 6220–6228. The prefix is prepended, the complete serialized Ax frame is measured, then context and budget output allowances are calculated.

At the investigated revision, the `sourceRef` output schema uses the fixed pattern `^s[A-Za-z0-9_-]{16}$` (`wiki-synthesis.ts:789–797`). It does **not** enumerate all 437 source bindings in the schema. A proposed diagnosis or fix based on a growing per-source schema enum would be addressing the wrong representation at this revision. Ax's separate `fieldDescriptions` metadata is not another populated copy for these fields in the captured requests.

## Accounting, admission and why retrieval passes first

The exact size helper at `engine.ts:3639–3645` is:

```ts
Buffer.byteLength(JSON.stringify(providerRequestFor(...)), 'utf8')
```

The final typed check at `engine.ts:6220–6228` effectively computes:

```text
contextOutputAllowance = maxContextTokens - serializedRequestBytes
budgetOutputAllowance  = remainingDispatchAllowance - serializedRequestBytes
```

For the private reconstruction, `128000 - 257897 = -129897`: it fails before any output allowance is possible. The requested input-plus-output comparison is 266,089 against 128,000. The provider does not get a chance to tokenize that typed request.

This byte-as-token exposure convention also exists in ordinary request admission and compaction (`engine.ts:3654–3686`, `3714–3730`, `7203–7205`). It is intentionally conservative exposure accounting, separate from reported usage. Treat changing it as a policy/accounting decision rather than casually replacing bytes with a divisor.

Ordinary tool-result fit and the initial publication reserve use the ordinary prompt (`engine.ts:4645–4660`, `4738–4763`). The fully expanded typed payload/schema is constructed later. Thus accepting and reading a page does not prove the final typed frame will fit. The ordinary-history compactor's view is not a reliable capacity model for this separate frame; deleting user chat history cannot remove source-dependent expansion.

A correction-capable synthesis sequence can reserve twice its typed exposure plus 8,000 units (`engine.ts:6230–6242`). That reserve is **not** proof of two requests or two charges. Likewise Jev's independent 64,000-unit conservative decision reservation is distinct from this Gemini frame. Raising only the profile context ceiling can expose the remaining-run/correction-reservation limits next, and must not silently relax quotas or revise historical accounting.

## Suggested investigation and fix boundaries

The following were the original handoff's review directions, not claims about completed current behavior or instructions to weaken integrity checks:

1. Add private, numeric pre-dispatch telemetry for the actual rejected typed frame: body bytes, binding/structure bytes, projection count versus unique-unit count, schema bytes, prefix bytes and the exact context/budget reason. Do not persist page content, full prompts, credentials or rejected drafts merely to collect sizes.
2. Separate representation efficiency from admission units. Establish a model-appropriate context estimate or native token count for the converted request, and retain explicit conservative unknown-exposure/settlement policy. Document whether each ceiling is tokens, serialized bytes or policy exposure units. A generic bytes/4 conversion is not a demonstrated Gemini tokenizer or safe accounting migration.
3. Explore canonical shared scopes/selected text with compact binding aliases that retain exact evidence/revision/unit ownership. Measure root-only and root-plus-section variants; section dedup alone is insufficient here.
4. Review overlapping dependency and quotation storage. Preserve complete record fields, source-stated qualifications, link definitions, original span/revision binding and publication/freshness checks. Do not clip packets or combine unrelated records to get under a cap.
5. Evaluate task-relevant complete closure selection before synthesis. A contact question need not require all product, freight, discount and policy assertions, but removing an unread or needed qualification changes evidence eligibility. Keep an explicit insufficient-evidence/capacity outcome when required closure cannot fit.
6. Make admission and compaction account for the actual typed representation before a successful read leaves no finalization path. Preserve authoritative history and avoid repeated paid generation followed by the same unresolvable local rejection.
7. Review repeated signature/schema descriptions only after measuring them. Here the source structures dominate, and a 5.8 KB schema cannot explain or repair the whole approximately 258 KB frame.

Do not use an arbitrarily larger profile window, disabled Jev verification, removed citation gates, shortened source qualifications, cleared histories or fabricated usage/prices as proof of a fix.

## Acceptance work for the developing agent

- Re-run the committed offline fixture at the investigated revision, retain the topology counts, and explain any changed sizes after a fix.
- Exercise the **actual new admission path**, not only this probe's reproduction of the old byte equation. Keep the 128,000/8,192 test profile for the original failing case; add meaningful boundary checks for both input and output admission.
- Cover page-only and overlapping page/section bindings; several complete records sharing authored text; nested disclosures; tables; links/reference definitions; non-ASCII text; truncated dependencies; and very large required closures.
- Verify a fresh contact question can reach a source-bound answer without losing ownership, exact literals, governing qualifications or citations. The anonymized fixture alone cannot prove semantic contact selection; create synthetic meaningful contact records or a consented local corpus for that check.
- Verify history, personal memory, optional skill text, corrections and native schema overhead are counted consistently. Include a case where ordinary retrieval fits but expanded synthesis would not, and reject/adapt before wasted dispatch.
- Preserve quotas, lease fencing, reservations, declared usage reconciliation, paid failed-attempt usage and unknown exposure across cancellation and retries. Native provider checks remain separate from mock capacity evidence.
- Validate the user's exact query with an authorized real provider/corpus after the offline fix. Do not claim that a narrower quotation prompt or a higher-cap profile fixes the original question.

Relevant existing suites to examine: `server/test/agents/wiki-synthesis.test.ts`, `agent-engine.test.ts`, `agent-engine-orchestration.test.ts`, `agent-compaction-engine.test.ts`, `agent-grounding.test.ts`, `wiki-verification.test.ts`, `source-document.test.ts`, and the evaluation code at `server/agents/providers/wiki-synthesis-evaluation.ts`. Existing evaluation fixtures are available under `server/test/agents/fixtures/`; distinguish their semantic evaluation from this structural byte diagnostic.

## Remaining uncertainty

The historical investigation proves sufficient structural expansion and the local units comparison to reproduce failure. It does not provide the exact rejected live frame, native Gemini token count, a provider context-limit error, a completed answer fix or a new pricing/quota policy. Current compact-wire measurements must be reported separately, and offline mock results do not remove the engine/native/live verification requirements above. The separate Formica summary previously exhausted evidence validation; that semantic failure is outside this Falcon capacity reproduction and should not be conflated with it.
