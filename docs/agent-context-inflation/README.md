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

## Complete raw reads and a compact citation index

The synthesis input is now `sourceText` plus `sourceReferences`. `sourceText` contains each complete original registered read once, with its title, revision, representation and full/truncated status. It includes facts not requested in the current question, rather than replacing them with a narrow answer-oriented projection. Markdown, HTML, code, links, whitespace and Unicode are unchanged.

`sourceReferences` is a small named index, not a closure/proof packet:

```ts
{
  scopes: { [scopeKey]: { readRef, evidenceId } },
  units: {
    [originalSourceRef]: {
      scope, text,
      preview?: true,
      record?: recordKey,
      rawSpans?: [{ start, end }],
      title?: true,
      aliases?: { [originalScopeKey]: "originalAliasRef originalAliasRef" }
    }
  }
}
```

Short selected text remains beside its exact original reference. Long units use a Unicode-safe exact preview and original raw spans into the unchanged complete read, rather than repeating their full text in the selector. Normalized HTML is not reconstructed from guessed raw offsets. Scope metadata appears once; each space-separated alias is an individually selectable original reference under its explicit original scope. Root/section aliases and repeated assertions of the same native unit can share display text without merging authority. Distinct records, rows and matrix columns never merge by equal values. Only complete nonopaque bindings are selectable. Incomplete or opaque read bodies remain present and truthfully labelled. Immutable host units, owned dependencies, quotations and closures remain private validation data.

The portable fixture still has 16,426 original UTF-8 bytes, all 259 complete projected body units, 260 distinct native unit IDs and all 437 original root/section bindings. The current index has 260 primary rows and 177 original scope aliases over one physical read. The 11 parsed sections and 12 supplied TOC citations are unchanged. Historical metric files remain unchanged.

| Quantity | Previous named-row transport | First complete-read iteration | Current complete-read index |
| --- | ---: | ---: | ---: |
| Root-only serialized Ax request bytes | 159,534 | 95,519 | 70,108 |
| Root + sections serialized Ax request bytes | 165,023 | 113,233 | 77,834 |
| Root + sections input bytes + 8,192 output allowance | 173,215 | 121,425 | 86,026 |
| Root + sections selector/index JSON bytes | 12,070 bindings + 129,833 structures | 74,562 | 39,906 |
| Complete original read bytes | 16,426 | 16,426 | 16,426 |
| Selectable original root/section bindings | 437 | 437 | 440 |

The current request is 56.05% smaller root-only and 52.83% smaller with sections than the previous transport. These are measured byte reductions, **not measured model-token reductions**. All 437 earlier references remain selectable; three additional projections expose two genuine original multi-sentence units that artificial atomic splitting had hidden. Their index cost is 622 bytes. The small portable fixture has no long-unit previews and mostly one alias per scope. Grouped alias strings remove the measured admission failure for a separate 74,821-byte pair of complete child reads with 1,748 repeated original aliases: punctuation no longer dominates the unchanged context bound. The engine retains its existing real output resizing; neither source text nor selector identities are dropped to fit. Raw-content bytes, full selected text, previews and selector overhead are reported separately.

Fresh pre-change native measurements on an owned fictional fixture confirmed the follow-up problem independently of the offline capacity specimen. A role-only answer took 34.450 seconds; its typed generation reported 75,759 input tokens. The ordinary same-session delivery follow-up fetched the same page again, made five separate roughly 11,000-input-token verification calls, attempted a repair and ended partial. Those calls were real accounted application requests, not an offline tokenizer estimate.

Prior complete same-owned-session page observations are now available through existing persisted `tool.completed` events. Reuse requires the original receipt and fresh current authorization, scope, revision and expiry validation. A prior run's delivery is not proof of delivery in this run. Full fresh reads enter the new request under real admission; only actual overflow invokes the existing bounded restoration/compaction path. No new store, migration, enlarged provider window or weakened publication checks is introduced.

Mechanical binding eligibility remains separate from semantic proof. Complete own paragraphs, native lists and non-table records can admit paraphrases without requiring copied qualifier words. Exact original binding, revision, dependency closure, protected identifiers, numeric values, destinations and record/column associations remain mandatory; the existing native Jev check decides entailment, polarity and governing qualifications from the complete read. A complete non-table record can make its own Role field eligible even when the selected immutable binding is Name. Every required nonliteral verdict must pass with confidence and probability strictly above 0.8; missing, negative, uncertain or unavailable verdicts never publish.

Genuine complete multi-sentence paragraph/list-item bodies retain their native identity, text and existing closure alongside every unchanged atomic reference. A full-original selector can summarize multiple facts within that body; an atomic selector remains limited to its displayed assertion, even when its private dependency contains neighboring sentences. Native proof treats that narrow text as factual authority while still checking governing conditions against the full read. Numeric witnesses and identifier neighborhoods for a full-original prose body use its existing sentence boundaries rather than attaching unrelated later sentences to one amount or inventing a replacement across sentences. Independently scoped anonymous list-policy clauses require original protected field-label/value associations; named owners and ambiguous/pronominal continuations retain the connected-record fence. All-Wiki summaries without a current-page hint do not acquire current-page coverage authority or crash on the normal null hint.

Heading capitalization does not turn a word already used as a lowercase body noun into an immutable proper identifier. This preserves normal inflection such as “commercial accounts” under `Account contacts` without permitting stem changes to actual scalar names, IDs or protected values.

The first deployed complete-read iteration exposed a second defect independently of context size. Its role-only query fell from 34.450 to 13.055 seconds and from 75,759 to 32,832 typed input tokens, but a native-quotation shortcut published a full contact record despite explicit email/phone exclusions. Its follow-up reused all 17,212 original bytes with zero retrieval calls, yet still ended partial because a host-expanded whole-list quotation failed final scope assessment. Those performance results are not quality successes.

The current contract removes that shortcut: every model statement is explicit and nonempty, with no empty-to-full-record expansion or automatic `Source quotations` presentation. Literal wording stays private validation data. A selected atomic statement never acquires neighboring paragraph assertions. Canonical alignment grants structural eligibility, not a semantic exemption: paragraph subsets still require the existing independent check against the complete original read, including qualifications outside the selected sentence. Explicit complete owned record/list quotations remain supported.

The live follow-up also exposed missing model orientation: field selectors did not say which fields belong to one complete owned record. The index now adds only a compact `record` number for complete non-table multi-field records. It costs 482 index bytes on the portable fixture and communicates existing field ownership, not new authority. Requested values and their own Scope/Exception belong in the same source-bound statement; separate qualifying claims do not repair bare values. Equal-valued records and matrix columns do not merge. An explicitly emitted exact complete native list may acquire only its existing governing prefix; its raw body is never expanded, changed or reordered.

Adjacent inline claims under the exact same original citation scope share a prose paragraph, retaining every immediate per-claim citation and statement boundary. Different scopes and block/table/list statements remain separate. This removes field-per-paragraph output structure without introducing model layout metadata or pooling evidence.

Complete authored Markdown tables have their own conservative parser-native binding, appended without renumbering existing row, field or list identities. Requested complete tables retain original header, separator and all row/column associations. An explicitly emitted exact body can acquire only its existing governing context and required owned reference-definition dependencies; no omitted fields are invented. Harmless LF/CRLF and surrounding line-break differences canonicalize to the private original body; row text, columns, values, prefixes and definitions remain exact. The host renders genuine Markdown tables, locally resolving owned reference links without cross-table label collisions. Missing, malformed, masked, truncated or mixed-scope dependencies decline native whole-table admission; existing exact row/column guards remain. Engine statement matching and streaming/final rendering use the same serialization.

Exact original native-list bodies use the same conservative LF/CRLF and surrounding line-break equivalence, never changed item text, indentation, order, prefix or links. Ordinary single-paragraph soft wraps normalize to spaces after Markdown shape validation; hard breaks, protected-syntax breaks and additional blocks remain rejected. Binding and native semantic validation still follow normalization. Existing repair feedback distinguishes output-byte bounds from unsupported statement/native-body shape without exposing statement text. Directly matching displayed fact/record-field refs are preferred over an indirect identity ref; complete-record authority is unchanged.

A native completed status is not an independent quality pass. Revision `592006be2` completed all eight owned meaningful-page cases without repairs, but its “concise” summary was 6,366 output bytes for a 5,149-byte source and copied full lists/contact details. The trace also recorded an 888-output-token ordinary summary followed by 1,289 typed output tokens. Collection guidance now directs the model to finish instead of drafting an answer before source-bound synthesis. Concise synthesis treats original bodies as factual authority rather than formatting templates, selects section-appropriate scopes and omits unrequested attributes; no fixed section/claim cap or publication exemption is introduced.

Native Jev checks share the complete original read and common policy within a bounded batch. Long duplicate textual leaves in selected-source/closure records refer to whole strings in the request's `readTexts`; short structural ownership remains explicit. Host expansion validates every original source/claim index and immutable closure before publication. Every required verdict still has to pass independently; an oversized native batch splits rather than pruning claims or weakening thresholds.

The probe reports `physicalReadCount`, `rawReadUtf8Bytes`, `sourceTextBytes`, `sourceReferencesBytes`, primary/alias counts and the complete generated Ax request. `projectionCount` counts selectable original references; `bindingGroups` counts original host `(evidenceId, sourceRevision)` identities. Selected-text and raw-read metrics overlap and must not be summed as disjoint content buckets. `requestedInputPlusOutput` retains the conservative byte comparison; both current nonempty variants fit 128,000/8,192 without relying on a token estimate.

Default diagnostic output contains only numeric metrics, assumptions and a source hash; it does not fetch or dispatch to a provider. Optional `PROBE_REQUEST_FILE=/private/path/request.json` writes the complete captured request with mode `0600` for a controlled authorized native comparison. That file contains source content; do not publish it.

The earlier `ec3d62990` native smoke and exact Gemini `countTokens` result describe the previous named-row transport: 72,090 input tokens for its complete portable root-plus-section frame, not for the new index. Its owned temporary page 76 was deleted, existing pages/users returned to 31/12, and the original checked page remained 1,105 bytes with SHA-256 `113c967750999dac6f7a07dbfb14067cb182b7c7ed0bfd955b4089121f19d84b`. Its literal contact fidelity passed; independent Who relevance was inconclusive, so neither old result establishes current universal QnA reliability.

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
