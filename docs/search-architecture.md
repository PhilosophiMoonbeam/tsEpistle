# Search architecture

PostgreSQL Advanced is the sole production search engine. `operations.search` is the implemented unified lexical-plus-knowledge owner for browser, Agent, MCP, and API search; focused implementation and benchmark evidence is recorded in [the foundation audit](search-foundation-audit.md). This is not a deployment or complete-release claim.

## Design decisions

- **PostgreSQL full-text search is the primary retriever.** Weighted `tsvector` fields and `websearch_to_tsquery` provide stemming, quoted phrases, negation, and forgiving user syntax.
- **Cover-density ranking instead of a BM25 extension.** `ts_rank_cd` rewards dense term coverage and preserves PostgreSQL's built-in GIN execution path. A BM25 extension would add deployment, upgrade, backup, and availability coupling without improving the Wiki-specific title, tag, path, and link signals that dominate useful ranking.
- **Metadata-aware reranking.** Exact title, exact tag, exact path, title prefix, tag prefix, and trigram similarity add deterministic boosts above the lexical score.
- **Bounded graph support.** A recursive CTE traverses links only between the top lexical candidates, to depth two. It can distinguish a coherent linked cluster without turning every query into a whole-wiki graph walk or returning unrelated neighbors.
- **Fuzzy retrieval is a fallback.** Exact lexical and substring candidates run first. Trigram word similarity runs only when fewer than five exact candidates exist. This preserves typo tolerance without making common tag or keyword queries scan a broad fuzzy set.
- **Stable, inspectable rank signals.** Results carry final `score`, normalized `tags`, and lexical/graph `matchedFields`. The unified contract additionally permits `knowledge`, labeled **knowledge hints** in user interfaces; it is neither verified fact nor citation evidence. Scores have deterministic title and page-ID tie breakers.

## Engine contract and invariants

PostgreSQL Advanced applies an exact locale filter and an exact path-or-descendant filter before ranking and before the configured `search.maxHits` window. A path scope includes only the selected path or values beginning with `path/`; `%` and `_` are literal scope characters. The engine returns no more than the configured limit.

Rebuild success means the derived index is an authoritative replacement, including removal of documents absent from the canonical page corpus. Rebuild runs in one transaction: transactional truncation and all replacement writes commit together, while a failed rebuild rolls back to the prior derived state. The transaction-scoped `wiki.search.postgres.derived-index` lock is exclusive for startup/configuration/rebuild and shared for incremental mutations and reads. Startup waits for ownership and samples fresh saved configuration under that lock; an explicit concurrent rebuild fails promptly. Lock order is index, page advisory identity, canonical row, then effect row. Rebuild already holds the exclusive index fence, so it does not accumulate one advisory lock per page.

The engine key is `postgres`. Fresh installations, upgraded deployments, browser configuration, Agent search, and MCP search all reconcile to this single provider; no alternate engine is selectable.

## Derived schema

`pagesVector` contains one row per published, searchable public page whose inclusive publication window is open:

`pages` is authoritative. Search tables are derived projections and may be discarded and rebuilt.

| Column | Purpose |
| --- | --- |
| `pageId` | Canonical page identity and primary key |
| `sourceRevision` | Exact authoritative page revision represented by this vector |
| `path`, `locale` | Stable routing identity and scope filters |
| `title`, `description` | Result metadata and field-specific evidence |
| `tags` | Normalized tag values returned with results |
| `facets` | Title, path, description, and tags for substring/trigram retrieval |
| `tokens` | Weighted full-text vector |

Weights are: title and tags `A`, path and description `B`, content `C`. The index has:

- a GIN index on `tokens` for full-text retrieval;
- a GIN array index on normalized `tags` for bounded exact-tag retrieval;
- a trigram GIN index on `facets` for substring and typo retrieval;
- a unique locale/path identity index.

`pagesWords` stores per-page, unstemmed metadata terms. Its trigram GIN index supports spelling suggestions while page identity makes mutation-time replacement bounded and exact.

`pagesSearchMetadata` is the singleton schema contract. Contract ID `1` records search schema version `2` and the configured PostgreSQL text-search dictionary. Initialization validates the complete column, primary-key, index validity/readiness, access-method, indexed-column, and operator-class contract. Any mismatch recreates the derived schema before rebuilding; a dictionary change also forces a rebuild. Startup additionally compares every eligible page's `sourceRevision` with `pagesVector.sourceRevision` and removes orphaned or ineligible vectors through the same rebuild path.

The database-owned dictionary is read inside the index lock for every lexical/knowledge read and write. A configuration change commits saved configuration, rebuilt vectors/vocabulary, and index metadata together; runtime replacement follows commit. Failed initialization preserves the prior saved configuration, derived index, and runtime. Registry refresh loads filesystem definitions first, then rereads and patches only missing defaults under the same exclusive lock, without overwriting concurrent administrator changes.

The PostgreSQL engine also ensures source-side indexes on `pageLinks.pageId`, `pageTags.pageId`, and `pageTags.tagId`. Existing target path/locale and page identity indexes resolve graph edges without denormalizing the link graph.

## Query pipeline

### Unified pipeline

```mermaid
flowchart LR
    Q[User query and scope] --> P[Normalize and classify structured syntax]
    P --> A[Operations: prefilter ACL, publication, protection, locale, path, selected IDs]
    A --> L[PostgreSQL lexical and graph candidates]
    A --> K[Revision-matched knowledge candidates]
    L --> U[One bounded deterministic union]
    K --> U
    U --> H[Hydrate matching page ID and source revision]
    H --> R[Current-access recheck and result]
    R --> S[Browser, Agent, and MCP]
```

`operations.search` supplies bounded authorized public IDs to PostgreSQL, asks the knowledge repository for candidates constrained by the same public/private and selected-page scope, and orders the combined candidates once. The Agent no longer maintains a local knowledge union, cap, ranking, or access path.

The engine owns query classification. Quotes, standalone case-insensitive `OR`, and token-boundary negation are structured input. Structured input does not enter raw substring, fuzzy, acronym, or generated-hint fallbacks that change its semantics; ordinary hyphenated identifiers remain ordinary input. Blank trimmed input is empty across public, private, and knowledge retrieval. Locale/path (including literal `%`/`_`), selected page IDs, ACL, current publication window, and protection filter before a candidate cap. The raw 500-candidate cutoff cannot hide an authorized result inside an earlier unauthorized window.

The graph score is capped at `1.25`: explicit links may settle close lexical candidates but must never let graph support alone outrank an exact title or tag. The protected-bridge violation (public 71 → protected 70 → public 69) is corrected and native-retested: protected related output/knowledge disappeared, public scores dropped 7.4925 → 6.75, and a public direct link restored the expected distance-one graph signal. The stale-edge worker-stall repair is also verified: during page 70 revision 2's held running `links` receipt, `links[]` was empty and depth-one related returned only public incoming 71; after lease release, a real worker recorded a succeeded receipt and removed old 70 edges. Engine candidates pin the authorized revision map before caps, source edges require current succeeded link receipts, and raw edge revision/routes are compared with that snapshot. In session observation, deleted synthetic page 69 render/links receipts were recreated by a normal worker at exact revision 1, proving bounded legacy backfill; the retained benchmark artifact (`docs/benchmarks/search-graph-boundary-2026-09-07.json`) records this recovery under `legacyRenderAndLinksRecovered: true` alongside an empty `receipts: []` array rather than retaining individual receipt rows. Public lexical candidates still honor empty dates as open bounds where the page contract permits, compare offset-bearing ISO dates as instants, and fail closed for invalid dates/windows. Private pages remain outside the shared index, use the owner-or-system-manager `canReadPage` authority for direct path reads, and contribute at most 50 results regardless of the public window.

## Wiki content as Agent and MCP memory

Wiki pages are shared, mutable, citable external knowledge. They complement the Wiki Agent's bounded personal memory rather than replacing it. Durable preferences and stable user-specific facts belong in dedicated memory; facts that can be rediscovered from Wiki pages stay in the Wiki and are retrieved when needed.

### OpenWiki comparison boundary

OpenWiki's Code Wiki Claims use stable claim IDs, resolver-owned versioned evidence, stale/unresolved state, and confirm/update/retract reconciliation; its provenance discipline preserves extensions and competing credible sources. tsEpistle deliberately does not implement Claims sidecars, evidence IDs, or contradiction reconciliation. Its authoritative layer is database-backed pages/history, dynamic ACL, `pageTags`, and server-owned OKF authority; projections and generated hints are revisioned retrieval data only. They never become citation authority or automatically enter the separate owner-scoped personal-memory snapshot.

Agent chat and MCP use the grounded retrieval sequence below. The shared search operation is the implemented candidate path; it is still selection metadata rather than page-read evidence:

1. `pages.search` / `wiki_search_pages` finds lexical, tag, path, and graph-supported seeds, including spelling suggestions.
2. `pages.searchTags` / `wiki_search_tags` searches the existing taxonomy while `pages.listTags` / `wiki_list_tags` pages through it deterministically.
3. `pages.discover` / `wiki_discover_pages` browses authorized page summaries by locale, descendants beneath a path, nested depth, exact tags, and stable path, title, or update order.
4. `pages.related` / `wiki_get_related_pages` optionally expands a seed through explicit internal Wiki links and backlinks.
5. `pages.get` / `wiki_get_page` reads each promising page before its content is used.
6. Answers cite the retrieved page evidence.

`pages.related` is deliberately separate from the latency-sensitive search reranker. Its required contract is an undirected adjacency graph built only from current, published, publication-window-open, unprotected pages authorized for the requester; every returned node and every bridge must satisfy those conditions. Traversal remains deterministic breadth-first with at most 100 pages, opaque requester/seed/depth-bound cursor state, optional `maxDepth` 1..32, shortest-distance then title/path/ID order, edge direction, and predecessor ID. Current body-read authorization must be rechecked before related knowledge is attached.

[`search-graph-boundary-2026-09-07.json`](benchmarks/search-graph-boundary-2026-09-07.json) records the protected-bridge score drop, visible-link control, held-receipt `links[]` result, no stale 69 traversal, released-lease edge deletion, and legacy receipt recovery (attested via `legacyRenderAndLinksRecovered: true` with empty `receipts: []`, reflecting session observation of exact revision-1 recreation). Graph admission now requires preauthorized revision pins and current succeeded link receipts before cap/ranking, then compares raw edge revision/routes to the authorization snapshot. Public metadata lexical behavior remains separate while protected endpoints never contribute graph score, graph traversal, or body-derived knowledge attachment.

Internal Wiki links are durable graph edges derived from canonical authored content. A page mutation records a `links` projection intent alongside the authoritative page revision; the projection worker replaces `pageLinks` only after validating that immutable intent against the current page identity and source hash. Agent instructions and Agent/MCP proposal descriptions therefore require authors to search and read related pages before a knowledge-changing create or patch, then add canonical links and precise tags only when supported by the page content. Links remain visible, reviewable, and reproducible from page history; the Agent must not invent invisible edges merely to influence retrieval.

`pages.listLinks` / `wiki_list_page_links` reports only canonical internal page links. External URLs and rendered asset references are not stored in `pageLinks` and are therefore not advertised by this contract.

## Mutation and rebuild lifecycle

- Page mutations persist authoritative page state and immutable `render`, `links`, `search`, and `knowledge` intents in the durable `pageMutationOutbox`. Each intent is keyed by page, source revision, desired presence, and effect kind; its canonical payload and SHA-256 hash are validated fail-closed before execution or repair.
- Workers claim bounded batches with expiring leases and heartbeats. Editorial and dependent-page rerenders use durable admitted effects, not numeric bypass jobs. Render publication and caching require the exact immutable source identity and live lease token; reclaimed or superseded attempts cannot certify bytes. The separate authorized immediate-administrator worker path remains explicit.
- A `search` intent waits for exact certified render provenance when an eligible unprotected body is indexed. Ineligible-page cleanup does not require a successful render. Private, unpublished, opted-out, future, expired, and absent pages have both `pagesVector` and `pagesWords` removed; temporal activation is recovered by bounded maintenance. Claims, reconciliation, query admission, suggestions, inspection, and metrics use the same inclusive window policy, including empty dates and timezone offsets.
- Search maintenance scans bounded sets for missing current-revision intents, revision mismatches, orphan vectors, and stale suggestion rows. It re-arms only an immutable payload that still matches the current page revision, identity, and source hash. Payload or hash corruption remains terminal evidence rather than being silently rewritten.
- Same-revision rerender admission clears HTML, TOC, render certification, and dependent projections, and revokes already-running dependent leases. Cache reads validate the current source/route identity, render certification, exact HTML, and TOC; a delayed stale cache write cannot restore invalidated output. Uncertified current pages return `PAGE_RENDER_PENDING` rather than stale rendered content.
- Knowledge projection is independently maintained repairable state, never a second access-control or citation system. `operations.search` queries only exact-current projections with the same publication, ACL, selected-ID, locale/path, private-owner/system-manager, and protected-source constraints as lexical candidates before cap/union. Projection schema 2 persists normalized `searchTokens` using the configured dictionary and a GIN index; a dictionary change invalidates/rebuilds this derived search state. `searchVisible` returns no projection candidates for structured syntax, preventing summary/hint matches from bypassing quoted/negated/`OR` source semantics. Lifecycle discovers missing current/history projections, schema/version mismatch, revision mismatch, and repairable utility absence from validated immutable intent. A requested exact revision that is absent or mismatched fails closed; it never falls back to current data. Markdown link extraction excludes code spans/fences, bounds labels, and preserves an unavailable source line as nullable/unknown rather than inventing it.

Utility enrichment is outside requester-scoped retrieval. The configured conformed profile is an operator-approved shared-content processor: preflight checks current revision/source hash, public visibility, publication window, and password/protection state, not requester/page-rule/anonymous-read ACL. It may receive published shared ACL-restricted pages; a private, protected, unpublished, scheduled, expired, or invalid-window source found at preflight is not dispatched. Retrieval still enforces requester ACL. Utility has no tools, accepts strict bounded schema output only for declared projection gaps, and cannot write authority/source/tags/verification; neither that prompt nor generated text is an injection-proof or semantic-truth guarantee. Post-dispatch eligibility changes discard output but cannot retract bytes already transmitted. Schema-2 `searchTerms` backfill may invoke it once per eligible current page; operators must approve the shared corpus/provider and review total budget because there is no total backfill-cost quota.
- Rename and delete intents carry the prior identity or desired absence, so stale link/search identities are evicted without treating a derived row as source truth.
- Activation validates or recreates the search schema and performs a rebuild when its schema, dictionary, or source revisions are stale. An explicit rebuild truncates the derived tables inside the advisory-locked transaction, then walks published public page identities in bounded keyset-cursor batches. Each canonical rendered document is indexed before the next identity batch is loaded; rollback restores the prior derived state on any failure.

Protected pages do not contribute content tokens during indexing or rebuild. Protected body-derived projection hints are barred from direct lexical/knowledge retrieval; the graph-path exception was resolved by protected-endpoint/current-body fencing and exact-current-revision succeeded-receipt gating. Visible metadata is evaluated only if product policy permits it and under the same structured semantics. Private pages stay outside the shared index and are searched locally for the owner or authorized system manager. The fixed private contribution is at most 50 results regardless of the requested public window.

Password protection withdraws existing vectors and suggestion vocabulary in the protection transaction before commit and retains rearmed durable search repair intent. A delayed or failed immediate callback therefore cannot expose body membership through negative-only queries. Repair restores metadata-only search without changing authored content, render, source revisions, credentials, grants, or protected assets.

## Wiki Agent contract

`pages.search` is the Agent projection of the shared operation, not a second retriever. It returns bounded hydrated summaries with:

- canonical page identity and the matching source revision;
- tags, numeric rank, lexical/graph/`knowledge` matched fields, and spelling suggestions;
- `totalInWindow`, `windowLimit`, and `windowTruncated` for the bounded candidate window rather than a whole-wiki total; and
- `nextOffset`, which advances raw candidates even if a page disappears during hydration.

Hydration rejects a candidate whose page ID/source revision no longer identifies the returned route. A projection is attached only when it shares the hydrated page revision. Expected locked/unavailable candidates are omitted without aborting unrelated results. The public/default candidate limit is 100 and the independent private contribution limit is 50.

Preview excerpts require a render certificate matching the current source revision and anchor only on positive structured-query terms. Match offsets remain coordinates in the original Unicode text. Literal `%`, `_`, and backslash are not ranking/tag wildcard operators, and ignored punctuation after a negation dash does not turn an exclusion into a positive term.

`pages.searchTags` returns at most 20 normalized matching tag values. `pages.listTags` returns at most 100 stable tag records per call with `nextOffset`.

`pages.discover` returns authorized summaries without requiring a keyword. Its candidate traversal includes published, publication-window-open public pages plus private pages admitted by the requester's owner or system-manager scope; unpublished public pages are never candidates. It supports one locale, descendants beneath a path, up to five additional nested levels below direct children (`depth: 0` returns direct children), up to 20 exact normalized tags that must all match, and stable path, title, or update order with page-ID tie breakers. Each response contains at most 100 pages. Keyset scanning loads complete tags and applies eligibility and tag-aware ACL before counting the 5,000-page safety budget; denied rows cannot hide a later readable page or cause `PAGE_INDEX_TOO_BROAD`. Hydration rechecks current revision/eligibility, and emitted summaries contain at most 50 normalized tags.

`pages.related` returns bounded hydrated graph neighbors with:

- citations, canonical identity, and tags;
- shortest link distance;
- incoming, outgoing, or bidirectional edge direction;
- the preceding page ID on the deterministic breadth-first route;
- opaque signed `nextCursor` continuation state instead of a client-controlled offset.

The cursor is bound to the requester, seed page, and optional `maxDepth`. Tampering or reusing it with a different traversal returns `INVALID_RELATED_CURSOR`.

Omitting `maxDepth` permits traversal distances beyond 32 while retaining the 100-page result bound and signed continuation contract. Only an explicitly requested depth is restricted to 1..32.

The action descriptions instruct the model to use search evidence to select seeds, expand explicit relationships when useful, and call `pages.get` before answering. Search and graph evidence guide selection; page content remains the citable source of truth.

### Citation evidence gate

Search, discovery, and related-page outputs are candidate metadata. Their evidence IDs cannot enter a final answer until the same page has been read by `pages.get` or `pages.getVersion` during the active run. Historical `pages.listRecent` metadata has the same restriction. A delivered current `kind: "recent-page-evidence"` result is different: each row contains an exact, revision-bound opening source excerpt and may enter the evidence gate directly. Evidence from prior conversation turns remains ineligible because the page may have changed.

Final drafts are buffered before publication and checked as follows:

1. Every `[[cite:...]]` marker must resolve to successful active-run source evidence.
2. The immediately preceding clause is retained as the claim associated with that marker.
3. Complete page reads use their parsed source-backed units; recent-page evidence uses only its exact bounded opening excerpt and page-level citation. Canonical OKF contributes its Markdown body, not frontmatter or derived knowledge. Parsed heading ancestry binds section claims; unread suffixes and revision diffs remain unavailable.
4. Each factual clause needs a complete local assertion or explicitly owned record with intact dependencies, preserved field/value associations, identity, numbers, links, polarity, and applicable qualifiers. Only then does the unchanged 60-percent significant-term alignment threshold apply. Nested lists, labeled records, tables, and supported Markdown-embedded HTML share this structural path; unrelated prose cannot be pooled. This deterministic gate is not general semantic entailment and adds no provider call. See the [grounding and partial-delivery contract](agents-deployment.md#catch-up-and-result-capacity) for closure and EOF rules.
5. Verification language such as “I verified,” “I checked,” or “the page says” requires both a completed page read and an associated citation.
6. A final answer may contain at most 20 citation markers.

An invalid draft is never streamed to the user. The provider receives bounded correction feedback and may read the missing page, select the correct section, or rewrite the claim within the normal turn limit. Adjacent claims from one page should remain in one readable sentence or paragraph, with each section marker immediately following its own supported clause.

Every checked draft emits a bounded `evidence.provenance` event. It records whether the draft was accepted, ordered retrieval action IDs and evidence IDs, each claim's page and section evidence, the originating read action, matched terms, validation issues, and final citation order. Existing `tool.completed` events retain the full ordered tool outputs, so debugging can distinguish candidate discovery, page retrieval, claim attribution, and final rendering.

## Performance envelope

Two executable benchmarks cover different contracts and must not be compared as if they measured the same path:

- `bun run benchmark:page-index` measures the discovery repository's bounded page-index candidate read, principals, overflow sentinel, query count, connection use, heap growth, and PostgreSQL plan counters. It does not invoke the search engine.
- `bun run benchmark:postgres-search` uses an isolated PostgreSQL 17 container and a deterministic 20,000-page corpus (seed `20_260_831`) to measure rebuild and warmed engine distributions. It must never write to a production database.

The retained lexical baseline in [`search-foundation-before-2026-09-07.json`](benchmarks/search-foundation-before-2026-09-07.json) recorded recall@5 `0.8181818181818182` and zero-result rate `0.18181818181818182` over 11 seeded queries; it preserves the `AFR` and held-out paraphrase misses as diagnostics. The final isolated PostgreSQL 17.10 report, [`search-foundation-after-2026-09-07.json`](benchmarks/search-foundation-after-2026-09-07.json), passed with no threshold violations: its required four-case lexical acceptance scope passed, and its separate revisioned augmented fixture scored recall@5/MRR@5/nDCG@5 `1.0` with zero-result rate `0` across the same 11-query corpus. Rebuild time was **25,772.876510 ms**, with query p95 latencies of **26.583659 ms** for exact title/content (p50 23.742542 ms), **24.870621 ms** for typo/fuzzy (p50 24.150178 ms), **31.693809 ms** for multi-term description (p50 26.985204 ms), and **62.194827 ms** for common tag queries (p50 60.943106 ms), all well below the 200 ms threshold. The fixture is deterministic repository/union evidence, not actual utility-model output.

The 2026-10-05 refinement run on isolated PostgreSQL 17.11 passed the same 20,000-page benchmark with no threshold violations: rebuild **41,528 ms**; query p95 **30.464 ms** exact title/content, **32.043 ms** typo/fuzzy, **31.260 ms** multi-term description, and **74.870 ms** common tag. This run includes canonical row-lock/relation resampling and current publication-policy checks; it is not a claim that rebuild became faster. A large-corpus run caught and corrected redundant per-page advisory locks exhausting PostgreSQL's default lock table, without changing database configuration. Augmented relevance remains deterministic-fixture evidence, not a live-provider or general semantic-recall claim.

Actual configured-utility evidence is separately retained in `docs/benchmarks/search-utility-before-2026-09-07.json` and `docs/benchmarks/search-utility-after-2026-09-07.json`. The latter successful `gpt-5.6-luna` request generated four novel terms and passed term-ingestion, `AFR`, selected-scope, structured-query, and absent-query controls, but `restore the ultraviolet verification code` still returned no result. The reports must not be compared as if they measured one path, and neither makes a universal semantic-recall or model-equivalence claim.

## Projection observability

- `wiki_page_mutation_effects` reports durable render, links, search, and knowledge effects by lifecycle status, including superseded renders. `wiki_page_mutation_oldest_eligible_age_seconds` excludes render-blocked work; `wiki_page_mutation_expired_running_leases` exposes abandoned work.
- `wiki_page_search_documents{kind="eligible_pages"}` and `{kind="indexed_vectors"}` expose authoritative/derived counts; eligibility includes `isSearchable` and the current publication window.
- `wiki_page_search_vector_anomalies{kind="revision_mismatch"}` detects vectors whose `sourceRevision` differs from an eligible authoritative page, while `{kind="orphan"}` includes missing, private, unpublished, opted-out, scheduled, and expired pages.
- `wiki_page_knowledge_projection_gaps` counts authoritative pages without a knowledge projection for the current source revision.

Search document counts are not a sufficient correctness check by themselves: equal counts can still hide a revision mismatch and an orphan. Alerting should evaluate the vector anomaly gauges together with durable-effect age and failure status. Derived-state repair may re-arm matching immutable intent; operators must investigate payload/hash validation failures rather than bypassing them.

## Operational evidence and remaining record

The 2026-10-05 refinement gate passed **11 native PostgreSQL files / 123 executed cases with zero skips**, **19 ordinary isolated files**, server/shared/client typechecks, scoped lint, the 20,000-page search benchmark, and the 7,200-page discovery benchmark. Controlled actual PostgreSQL smokes reproduced and corrected protection callback-failure body membership, concurrent startup/configuration lost updates, stale certified-body admission, dictionary cutover/rollback, and startup lock contention. A real pre-fix application served stale cached HTML after same-revision canonical replacement; the binary-cache regression rejects that publication mismatch. These are focused Sprint gates, not a current full-suite or live-utility-provider claim.

The admin evaluator accepts the reader API's 256-character query boundary. Configuration save/rebuild invalidates outstanding inspection requests, preventing stale responses from restoring an obsolete report. Downloaded search invalidates its prepared corpus and reruns the unchanged current query after a committed corpus revision change, including revision drift detected during asynchronous ranking.


Historical 2026-09-07 implementation gates included four real PostgreSQL suites (**21 cases / 61 assertions**: knowledge search 4/10, utility admission 3/5, search foundation 12/37, and search graph rank 2/9), server and shared/client types, and all scoped files; that historical full test suite passed **472/472 isolated files**. The isolated report, migrated MCP-focused tests (7/7), native reader/browser accessibility, continuation, search/tree/preview/focus proof, least-privilege MCP read/resource/revocation proof, and resolved graph-boundary proof are recorded in [the foundation audit](search-foundation-audit.md). These observations do not describe the current refinement gate.

The historical audit build used explicit supported `WIKI_BUILD_REVISION` content fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a`, not a Git revision, and was not deployed. Its retained `docs/benchmarks/search-foundation-live-2026-09-07.json` records unchanged maintained pages/history/settings and completed disposable cleanup. Current Development Sprint changes use the tested committed application revision and affected-service deployment contract in `AGENTS.md`; they do not create release attestations.

The former monolithic `Covered source` mechanism and the external-review release prerequisite are historical and superseded. The 2026-09-04 legacy baseline and 2026-09-07 search audit retain their historical `SEC-EXT-001` finding and release-ineligible status; schema-2 migration changes only record representation, preserving those findings and statuses. Those records preserve what was observed under the former policy and do not define the current gate. The search audit is a `working-tree-audit` with fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a` (base `d3d5a63326c056bb847fdb2552be0a1cf1eb7020`), not a release attestation.

Enterprise Release qualification, when explicitly activated, follows [`docs/security/threat-model.md`](security/threat-model.md), [`docs/security/review-attestations.json`](security/review-attestations.json), and the mode-scoped contribution instructions. Historical working-tree audits remain release-ineligible and are not the gate for routine Sprint refinement or local-tailnet deployment.


No embedding generation or document-chunk synchronization is required. Search vectors and knowledge records remain asynchronous, repairable projections from durable mutation intent and authoritative pages/history.
