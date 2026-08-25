# Search architecture

Wiki search is a PostgreSQL-native hybrid lexical system. It deliberately uses no embeddings and requires no external search service. Page mutations update one compact derived index synchronously; an index rebuild reconstructs the same state directly from canonical Wiki tables.

## Design decisions

- **PostgreSQL full-text search is the primary retriever.** Weighted `tsvector` fields and `websearch_to_tsquery` provide stemming, quoted phrases, negation, and forgiving user syntax.
- **Cover-density ranking instead of a BM25 extension.** `ts_rank_cd` rewards dense term coverage and preserves PostgreSQL's built-in GIN execution path. A BM25 extension would add deployment, upgrade, backup, and availability coupling without improving the Wiki-specific title, tag, path, and link signals that dominate useful ranking.
- **Metadata-aware reranking.** Exact title, exact tag, exact path, title prefix, tag prefix, and trigram similarity add deterministic boosts above the lexical score.
- **Bounded graph support.** A recursive CTE traverses links only between the top lexical candidates, to depth two. It can distinguish a coherent linked cluster without turning every query into a whole-wiki graph walk or returning unrelated neighbors.
- **Fuzzy retrieval is a fallback.** Exact lexical and substring candidates run first. Trigram word similarity runs only when fewer than five exact candidates exist. This preserves typo tolerance without making common tag or keyword queries scan a broad fuzzy set.
- **Stable, inspectable evidence.** Every result carries its final `score`, normalized `tags`, and `matchedFields` (`title`, `tag`, `path`, `description`, `content`, or `graph`). Scores have deterministic title and page-ID tie breakers.

## Derived schema

`pagesVector` contains one row per published public page:

| Column | Purpose |
| --- | --- |
| `pageId` | Canonical page identity and primary key |
| `path`, `locale` | Stable routing identity and scope filters |
| `title`, `description` | Result metadata and field-specific evidence |
| `tags` | Normalized tag values returned with results |
| `facets` | Title, path, description, and tags for substring/trigram retrieval |
| `tokens` | Weighted full-text vector |

Weights are: title and tags `A`, path and description `B`, content `C`. The index has:

- a GIN index on `tokens` for full-text retrieval;
- a trigram GIN index on `facets` for substring and typo retrieval;
- a unique locale/path identity index.

`pagesWords` stores per-page, unstemmed metadata terms. Its trigram GIN index supports spelling suggestions while page identity makes mutation-time replacement bounded and exact.

The PostgreSQL engine also ensures source-side indexes on `pageLinks.pageId`, `pageTags.pageId`, and `pageTags.tagId`. Existing target path/locale and page identity indexes resolve graph edges without denormalizing the link graph.

## Query pipeline

```mermaid
flowchart LR
    Q[User query] --> P[websearch_to_tsquery]
    P --> E[GIN lexical and substring candidates]
    E -->|fewer than 5| F[Trigram fuzzy fallback]
    E --> R[Field-aware lexical rerank]
    F --> R
    R --> C[Top 100 candidates]
    C --> G[Depth-2 recursive link CTE]
    G --> S[Stable final score]
    S --> A[ACL and protected-page filter]
    A --> U[UI and Wiki Agent]
```

The graph score is deliberately capped at `1.25`. Links can settle close lexical results, but cannot outrank an exact title or exact tag by themselves.

Locale and path filters are part of both exact and fuzzy candidate selection. Path scope means the selected path itself or descendants under `path/`; wildcard characters remain literal.

## Wiki content as Agent and MCP memory

Wiki pages are shared, mutable, citable external knowledge. They complement the Wiki Agent's bounded personal memory rather than replacing it. Durable preferences and stable user-specific facts belong in dedicated memory; facts that can be rediscovered from Wiki pages stay in the Wiki and are retrieved when needed.

Both Agent chat and MCP expose the same grounded retrieval sequence:

1. `pages.search` / `wiki_search_pages` finds lexical, tag, path, and graph-supported seeds.
2. `pages.related` / `wiki_get_related_pages` optionally expands a seed through explicit internal Wiki links and backlinks.
3. `pages.get` / `wiki_get_page` reads each promising page before its content is used.
4. Answers cite the retrieved page evidence.

`pages.related` is deliberately separate from the latency-sensitive search reranker. It constructs an undirected adjacency graph from canonical `pageLinks`, then performs deterministic breadth-first traversal:

- every directly linked page is distance one; traversal depth counts edges, not the number of neighbors;
- pagination bounds each response while an omitted `maxDepth` allows traversal to continue until the connected component is exhausted;
- an optional `maxDepth` from 1 through 32 supports deliberately local exploration;
- ordering is shortest distance, then title, path, and page ID;
- results include distance, incoming/outgoing/bidirectional direction, and the preceding page ID;
- only published public pages authorized for the requester enter the adjacency graph, so an inaccessible page can neither appear nor act as a hidden bridge.

The breadth-first walk runs over a set-based PostgreSQL edge read rather than inside the search CTE. Authorization rules can depend on live path, locale, and tags, so filtering nodes before constructing adjacency is safer than traversing the database graph first and filtering results afterward. The search CTE remains a candidate-only depth-two reranker; `pages.related` provides intentional broad graph retrieval.

Internal Wiki links are durable graph edges. Rendering a created or patched page synchronously replaces its `pageLinks` records from the canonical authored content. Agent instructions and Agent/MCP proposal descriptions therefore require authors to search and read related pages before a knowledge-changing create or patch, then add canonical links and precise tags only when supported by the page content. Links remain visible, reviewable, and reproducible from page history; the Agent must not invent invisible edges merely to influence retrieval.

## Mutation and rebuild lifecycle

- Create and update events upsert the page vector and replace only that page's suggestion terms in one transaction.
- Rename events upsert the complete destination identity and current metadata; no stale title or path remains.
- Delete events remove the vector and suggestion terms in one transaction.
- Activation detects the legacy search schema, replaces the derived tables, creates the required indexes, and performs one rebuild.
- Rebuild truncates and repopulates both derived tables in one transaction. It uses set-based SQL rather than one insert per page.

Protected pages never contribute content tokens during either incremental indexing or rebuild. Their visible title, path, description, and tags remain searchable. Private pages stay outside the shared index and are searched only inside the requester's owner scope before being merged into the same deterministic result ordering.

## Wiki Agent contract

`pages.search` returns bounded hydrated page summaries with:

- citations and canonical page identity;
- tags;
- numeric rank;
- matched fields;
- total and truncation state.

`pages.related` returns bounded hydrated graph neighbors with:

- citations, canonical identity, and tags;
- shortest link distance;
- incoming, outgoing, or bidirectional edge direction;
- the preceding page ID on the deterministic breadth-first route;
- continuation state for exhaustive pagination.

The action descriptions instruct the model to use search evidence to select seeds, expand explicit relationships when useful, and call `pages.get` before answering. Search and graph evidence guide selection; page content remains the citable source of truth.

## Performance envelope

Measured on PostgreSQL 17.11 with 20,000 synthetic published pages, 20,001 links, and 20,000 page-tag relations:

- full set-based index build: **2.724 s**;
- exact title/content query p95: **24.90 ms**;
- typo-tolerant query p95: **22.47 ms**;
- multi-term description query p95: **20.08 ms**;
- common tag query p95: **24.59 ms**.

Each query was warmed once and measured over 30 sequential executions with a 100-result cap. These numbers are a regression reference, not a universal capacity guarantee; production latency also includes authorization and page hydration.

## Operational checks

After activating or upgrading the PostgreSQL engine:

1. Rebuild the search index once if activation did not already replace the legacy schema.
2. Confirm `pagesVector` has one row per published public page.
3. Confirm the `pages_vector_tokens_idx` and `pages_vector_facets_trgm_idx` indexes are valid.
4. Search an exact title, a tag, a content-only phrase, and a misspelling.
5. Confirm a protected content-only term is absent while the protected page's visible metadata remains searchable.
6. Confirm `pages.related` returns authorized direct links and backlinks, paginates a connected component, and does not traverse through a denied page.
7. Confirm the Wiki Agent calls `pages.search`, optionally `pages.related`, then `pages.get`, and emits a page citation.

No embedding generation, asynchronous vector queue, or document chunk synchronization is required.
