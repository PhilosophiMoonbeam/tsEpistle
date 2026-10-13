# Falcon context inflation: developer handoff

## Historical finding

A roughly 5,000-token page is not being rejected by Google as a 128,000-token document. The failing tsEpistle guard counts **UTF-8 bytes of the complete serialized Ax request**, then subtracts that byte count from a profile field called `maxContextTokens`.

The source also expands substantially before that check. In an offline reconstruction using the production parser, evidence registration, synthesis encoder and Ax prompt/schema generator, the 16,443-byte private page produces a **257,897-byte** typed request. That is approximately **15.68 times the page's byte size**, not a measured 51.86-fold increase in model tokens. Comparing 257,897 bytes with the operator's approximately 4,973 page tokens mixes units.

This is a local admission failure, before typed synthesis dispatch. There is no provider-reported token count for the rejected final request. The report does not assert that Google received it, exhausted its context window, or billed that hypothetical final request.

The portable anonymized fixture reproduces the same structural problem without this Wiki, database, page, credentials, browser, or an AI service. Removing section aliases alone does **not** solve it: the root-only reconstruction is still 220,750 bytes.

## Scope and files

Investigated application revision: `252b8c465a8fabecde430431561e95316225dd65`, Bun 1.4.2, `@ax-llm/ax` 25.2.1, Gemini profile model `gemini-3.8-flash`. All original findings, tables, live observations and source line references below describe that historical revision, not the compact implementation. Historical metric files are retained unchanged.

| File | Purpose |
| --- | --- |
| [observed-live-trace.json](observed-live-trace.json) | Fresh failing interaction, chronological events, reported ordinary model usage; no source text or authentication material |
| [private-page-metrics.json](private-page-metrics.json) | Numeric offline reconstruction from the private original page; no page content |
| [fixture-metrics.json](fixture-metrics.json) | Numeric reconstruction from the committed anonymized fixture |
| [falcon-like.md](falcon-like.md) | Portable 440-line Markdown capacity specimen, including lists, records, disclosures, tables, links and code blocks |
| [fixture.json](fixture.json) | Stored TOC, page metadata and exact question for that specimen |
| [reproduce.py](reproduce.py), [prepare.py](prepare.py), [probe.ts](probe.ts) | Offline reproduction using the checkout's actual production functions |

The fixture consistently pseudonymizes words and numbers with a private salted mapping while retaining Markdown/HTML syntax and parsing-sensitive continuation keywords. HTTP and email destinations use `example.invalid`. It contains no original people, contact details, working share URLs, share keys, credentials, cookies, login state or personal memories. The salt is not exported. Some labels are intentionally nonsensical: this is a **capacity/binding topology fixture**, not a semantic-answer benchmark.

## Explicit numeric references and current compact measurement

The current encoder emits lossless `sourceStructures` as `{texts: Record<number,string>, sources: Record<number,SourceRow>}` with explicit generated decimal numeric JSON keys in both dictionaries. Scalar numeric text references select a text dictionary key; UTF-16 `[poolKey,start,endExclusive]` references select an exact slice. Numeric scope references select a source dictionary key whose value remains the same nine-field tuple. Explicit keys let the model resolve references directly instead of counting hundreds of anonymous array positions. `sourceBindings` retains its outer groups, entries and projections, all admitted evidence/revision aliases and unchanged host-issued source references; sharing storage does not merge authority or discard complete quotations, authored dependencies or qualifications.

The parent-verified current dictionary measurement (`/tmp/wiki-context-keyed.json`) measures the committed 16,426-byte fixture with all 259 complete projected body units, 6 registered evidence identities, 260 root projections, 437 root-plus-section evidence/revision aliases and 260 distinct native unit IDs preserved. The source still has 11 parsed sections and 12 supplied TOC citations. Historical metric files remain unchanged; the before/after comparison below uses the portable fixture, not the private original.

| Quantity | Historical fixture | Current explicit-key fixture |
| --- | ---: | ---: |
| Complete root-only serialized Ax request bytes | 221,151 | 102,765 |
| Complete root + sections serialized Ax request bytes | 258,525 | 108,588 |
| Root-only input bytes + 8,192 output allowance | 229,343 | 110,957 |
| Root + sections input bytes + 8,192 output allowance | 266,717 | 116,780 |
| Fits the diagnostic 128,000 ceiling, root / sections | no / no | yes / yes |
| Root-only `sourceBindings` JSON bytes | 49,588 | 7,720 |
| Root + sections `sourceBindings` JSON bytes | 84,206 | 13,169 |
| `sourceStructures` JSON bytes, either variant | 137,715 | 78,677 |

The final serialized frame shrank by 118,386 bytes (53.53%) for root-only and 149,937 bytes (58.00%) for root plus sections. Current frame-to-source **byte** ratios are 6.26× and 6.61× respectively; these are not model-token ratios or provider usage. Both diagnostic sums fit without changing the 128,000 ceiling or 8,192 output allowance.

In either current nonempty variant, the physical pool contains 355 strings: 49,070 UTF-8 text bytes and 52,576 JSON bytes including explicit keys. Its 260 keyed scope rows occupy 26,080 JSON bytes; the complete `sourceStructures` object occupies 78,677 bytes including enclosing syntax. Remaining storage includes complete authored and quoted roles whose exact strings can overlap without being identical: substring reuse does not eliminate every duplicated passage, nor may those roles be clipped or silently pruned to improve fit. Compared with the prior anonymous-array frame at `13abb59d4`, explicit keys add 4,743 serialized request bytes; this trades a small amount of storage for direct, unambiguous lookup while retaining headroom.

Substring reuse is bounded to 32 Mi UTF-16 code units of cumulative search work, an optimization limit rather than a source-length or context-capacity limit. Once that budget is exhausted, complete exact strings remain as whole pool entries; exact deduplication is unconditional. No admitted alias, body unit, complete quotation, authored dependency or qualification is removed by that limit.

The engine orders complete sources using existing generic request relevance, but does not select a smaller evidence universe: unmatched units, aliases and governing qualifications remain in the frame with their unchanged host references. This order is orientation, not authority or proof of exhaustive coverage. The synthesis contract prioritizes requested facts and necessary source-written qualifications rather than an unrequested page inventory; shortening repeated instructions reduces the output schema from 5,797 to 2,180 JSON bytes.

Read-only offline inspection of the exact owned page 76 source established that the first four eligible body quotations already contain the complete qualified contact record. Task ordering is therefore already correct offline; this dictionary change addresses explicit reference resolution, not an invented engine-ranking defect. Native relevant publication remains unproven: the fresh exact contact question still returned an unrelated company address despite retrieval, with the original contact fields absent. No native QnA success is claimed.

The probe decodes only the explicit-key dictionary wire, iterates its actual keys for physical text/scope counts, and reports physical `pooledTextUtf8Bytes`, `pooledTextJsonBytes` and `scopeJsonBytes`, plus binding and complete generated Ax-frame bytes. `sourceUtf8Bytes` is the original page size, not a physical pool subtotal. Unique selected-text, quotation and authored-dependency counts/UTF-8 bytes are computed by decoding exact locator uses. Those semantic categories can overlap one another and the physical pool: they are **not disjoint storage buckets** and must not be summed to explain pool size.

`requestedInputPlusOutput` and `passesRequestedContext` retain the conservative serialized-frame-byte + 8,192 comparison at 128,000. The observed fits above establish **offline byte-capacity proof only**, not a native token count or proof of the new admission path. Actual generated-frame preflight, provider-native context counting, quota accounting and successful publication require engine tests and an authorized live smoke; a mock establishes none of those. Engine/native/live gates are not claimed successful here. Native/public quota policy is unchanged. The read-only offline diagnostic emits numeric metrics (sizes/counts, model configuration and a source hash), never source text or credentials; it does not dispatch to a provider or perform network fetches, and the metrics file is created with private `0600` permissions. Run the launcher below against the current checkout to produce a separate numeric metrics file, without overwriting the historical baselines.


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

This is a reconstruction, **not a production capture of the rejected full frame**. Assumptions are empty memory/skills, all-Wiki scope, one literal request facet, no observations, no correction feedback and the stated model/output allowance. The measured production host prefix is included (2,140 bytes in the historical reconstruction). Ordinary conversation messages are not appended to this typed generation, matching its production construction. Different live request options can change fixed overhead; the historical failed frame's byte breakdown was not logged. At the investigated revision, even the minimal/root-only case established failure without prior chat history.

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
