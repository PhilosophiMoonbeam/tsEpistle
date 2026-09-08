# PostgreSQL / OKF search foundation — audit closeout record

## Closeout status and audit summary

The tsEpistle PostgreSQL/OKF search foundation audit is complete. All six todo items transferred at the earlier safe pause have been reconciled and closed from authoritative evidence. The implementation and its final behavioral verification are complete; disposable audit tooling, sensitive restored artifacts, and clone test infrastructure have been removed. The worktree remains uncommitted and undeployed; release and model-quality limitations remain explicitly documented and enforced. Do not claim that the repository-wide release attestation or arbitrary semantic recall is solved: the historical 55f baseline is represented by a non-independent, release-ineligible structured record, and the staged search audit by a non-independent, release-ineligible working-tree-audit record using fingerprint 3adffcba7255a3f88ec490ceffefe6f826e9508a, so release remains blocked until committed exact source receives independent review and a release-eligible source-review record.
Original user objective: orchestrate agent roles to audit tsEpistle's opinionated PostgreSQL/Open Knowledge Format search, compare the different OKF needs of `/home/bbferko/repos/openwiki`, improve human Wiki discovery and organizational/private LLM memory retrieval, include automation through the configured utility LLM, make a detailed assessment then a plan then concurrent implementation, and verify production-like behavior using the maintained deployment associated with `https://agents8c48g.tail41a24a.ts.net:10443/`. The user prefers coherent, aesthetically refined solutions.

## Repository and ownership state

- Repository: `/home/bbferko/repos/tsEpistle`.
- Branch: `main`, base/HEAD **`d3d5a63326c056bb847fdb2552be0a1cf1eb7020`**; no commits were made during this audit.
- The initial tree was clean. The changes listed below are this audit's uncommitted work. Nothing is staged.
- `git worktree list` showed **only this main worktree**. No worktrees, stashes, or dangling commits were created by this session. Do not infer anything about unrelated historical Git objects.
- All writing agents have yielded and were told to stop for the user-requested pause. No in-flight source edits or test/build jobs remain.
- `continue.md` replaces the old Administration handoff intentionally; that older work is not the current task.
- The maintained container was **not rebuilt, replaced, or deployed**; it has zero repository bind mounts into this repository, and no host build altered its assets (`docs/benchmarks/search-foundation-live-2026-09-07.json` attests `source.deployedToMaintainedInstance: false` and `maintainedAuthoritativeState.repositoryBindMounts: 0`).

## Reconciled todo closeout — all six items completed

All six items transferred at pause have been verified and closed based on authoritative evidence and completed cleanup:
1. **Run lint API release and build gates** (Closed / verified).
   - Final individual checks passed: dependency policy, 800 dependency license records, lint, shared/client/server typechecks, OpenAPI compatibility/lint, production-placeholder check, Agent release gate, Vite build and bundle budgets.
   - Final full suite also passed **472/472 isolated test files**.
   - `ci:static` itself remains blocked solely by the **manifest-driven attestation gate** (`docs/security/review-attestations.json`), which replaces the former monolithic Covered source mechanism in `threat-model.md`. The historical `55f30709cd4b8de0ec1fd498cac7174f1cacd084` baseline is represented by a non-independent, release-ineligible structured record with blocking finding `SEC-EXT-001` (external reviewer unassigned). The current search audit is represented by a `working-tree-audit` record using fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a` (base `d3d5a63326c056bb847fdb2552be0a1cf1eb7020`), which is non-independent and release-ineligible staged evidence rather than a release attestation; release remains blocked until committed exact source receives independent review and a release-eligible `source-review` record.
   - Recheck if source is modified; otherwise update documentation/todo accurately from retained evidence.
2. **Verify browser knowledge hints and scoped continuation** (Closed / verified).
   - Completed native clone proof: canonical page create; `AFR` knowledge-only hit; current revision/source preview; Escape restores Preview-button focus and preserves the query; page-tree scoped 25-result search loads 20 then 5 through native More results.
   - Independent real mutation continuation: delete first and last snapshot entries and insert a new matching page; continuation returned the exact four surviving tail identities, no duplicate or new insertion, snapshot-visible count 23; query/session cursor mismatch returned 409.
   - Reader search passed scoped aXe WCAG2 A/AA and WCAG2.1 AA at 1365px and 320px in light/dark, zero violations and no horizontal overflow. Admin evaluator light/dark also had zero scoped violations and displayed `knowledge hints` correctly.
   - See live evidence JSON and ignored screenshots. No primary Agent chat inference was claimed; actual utility inference and native MCP were exercised separately.
3. **Confirm maintained wiki content and settings unchanged** (Closed / verified).
   - Repeated aggregate comparisons of maintained `pages`, `pageHistory`, and `settings` matched initial fingerprints exactly during the audit session, including the final check before pause. Raw private fingerprints were deliberately omitted from repository artifacts; the retained redacted attestation is in `docs/benchmarks/search-foundation-live-2026-09-07.json` (`maintainedAuthoritativeState.pagesUnchanged: true`, `pageHistoryUnchanged: true`, `settingsUnchanged: true`, and `repositoryBindMounts: 0`).
   - No maintained content, settings, schema, provider profile, signing key, or deployment change was made (`source.deployedToMaintainedInstance: false`). Ordinary initial read-only browsing may have normal read/session effects; do not claim every database row is immutable.
4. **Remove obsolete imports and throwaway verification tooling** (Closed / completed).
   - Obsolete `PageAuthority` import was removed with an LSP code action.
   - Disposable throwaway files were verified removed:
     - `temp/search-foundation-utility-smoke.ts` (removed)
     - `temp/search-foundation-smoke-report.json` (removed)
     - `/tmp/tsepistle-search-audit-before.json` and `/tmp/tsepistle-search-audit-after.json` (removed)
   - Retained JSON evidence preserved under `docs/benchmarks`.
5. **Finalize audit evidence and explicit release limitations** (Closed / completed).
   - Reconciled documentation across `docs/search-foundation-audit.md`, `docs/search-architecture.md`, `docs/agents-deployment.md`, `docs/search-agent-next-steps.md`, and `docs/security/threat-model.md` with authoritative evidence:
     - Receipt-fenced graph repair proof (protected bridge closed, worker-stall edge repair proved; session observation of exact revision-1 recovery distinguished from retained `legacyRenderAndLinksRecovered: true` and empty `receipts: []`).
     - Final 472/472 isolated test files.
     - 4 real PostgreSQL suites (21 cases / 61 assertions).
     - Final benchmark timings: rebuild 25,772.876510 ms; query p95s (exact 26.58 ms, typo 24.87 ms, multi-term 31.69 ms, common tag 62.19 ms).
     - Preview build content fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a`.
     - Explicit release limitations: manifest-driven attestation gate blocker (historical 55f baseline represented by a non-independent, release-ineligible structured record with blocking finding SEC-EXT-001; search audit represented by a non-independent, release-ineligible working-tree-audit record using fingerprint 3adffcba7255a3f88ec490ceffefe6f826e9508a; release remains blocked until committed exact source receives independent review and a release-eligible source-review record), actual `gpt-5.6-luna` held-out miss (`restore the ultraviolet verification code`), no universal semantic recall claim, operator-approved shared-content egress policy, separate background concurrency accounting, uncommitted worktree, and no deployment.
   - Preserved the full detailed before-state assessment, historical executed plan, and OpenWiki comparison.
6. **Remove isolated services credentials and fixtures** (Closed / completed).
   - `search-audit-preview` stopped cleanly, exit 0.
   - `search-audit-postgres` stopped cleanly, exit 0; Docker `--rm` removed `tsepistle-search-audit-postgres`. `docker ps -a --filter name=tsepistle-search-audit-postgres` returned nothing.
   - All managed audit browser tabs and main database handles were closed. Tool-owned shared browser/LSP infrastructure may remain; those are not application/database services and must not be confused with a deployment.
   - Deleted **`/tmp/tsepistle-search-audit-nCIKhy`** completely. It contained the sensitive mode-0600 restored-data dump, clone config, generated keys/config material, and clone page caches. Do not attempt to reuse it.
   - Temporary clone API keys were revoked or became unusable when the isolated database/signing authority was removed. The held synthetic graph lease was released and its real worker completed; the temporary fault-injection trigger/function were dropped.
   - All fixture pages, clone groups, clone credentials, and disposable databases disappeared with that container. No maintained keyring or backup was deleted.
   - `docs/benchmarks/search-foundation-live-2026-09-07.json` attests `cleanup.completed: true` with `remaining: []` and all resource booleans (`previewStopped: true`, `disposablePostgresStopped: true`, `sensitiveSnapshotAndConfigRemoved: true`, `browserAndDatabaseHandlesClosed: true`).

## Implemented design and important invariants

### One retrieval path

`server/operations/pages.ts::search` owns lexical plus revisioned knowledge fusion for browser/REST/GraphQL/Agent/MCP. Agent-local projection fusion was removed. Public permission/publication/selected-ID and requested knowledge filters apply before candidate caps; private retrieval is owner/system-manager scoped with an aggregate maximum of 50 private results. Current id/sourceRevision/route checks prevent stale rows being relabeled by a reused URL. Missing identity/revision evidence fails closed.

The engine accepts internal `pageRevisions` pins, computed from authorized metadata by operations and not trusted from the caller. Vectors must match those revisions before exact, lexical and fuzzy limits. This prevents a fresh unauthorized revision using an older authorized ID list.

PostgreSQL remains the sole index. Structured quoted/OR/negation queries do not use fuzzy/substring/generated-hint broadening or spelling suggestions. Ordinary hyphenated identifiers and literal stop-word titles still work. PostgreSQL negative-only complements are supported without inventing positive field evidence. Real SQL regressions cover spaced negation, mixed OR-negation and phrase field evidence.

### Knowledge schema and utility

- Knowledge schema **2**, deterministic producer **`wiki-knowledge-v2`**; strict required bounded `searchTerms` (20 terms, 120 characters each).
- Migration **`tsepistle-000027-knowledge-search.ts`** adds `searchDictionary`, `searchTokens` and its GIN index. No migration 28 was added.
- Tokens use the configured dictionary, default English. Obsolete schema/dictionary projections are unavailable until validated immutable-intent repair, not silently adapted.
- Deterministic title acronyms and optional utility-generated linguistic alternatives are retrieval hints, not page tags, authority, verification, claims or citation evidence.
- Public publication dates are checked as real instants with empty bounds allowed and invalid dates closed. A live test caught empty-string end dates being incorrectly rejected by SQL; that was fixed. Bounded keyset batches do not impose a hidden 500-raw-row cutoff before permission/publication filtering. The regression has 501 excluded leading matches.
- Markdown sections/links use markdown-it semantics; code blocks/spans/images do not manufacture links. Derived bounds support Unicode routes. Unknown exact link line positions are nullable rather than fabricated.
- OKF verification/staleness chronology handles timezone offsets and accepted sub-millisecond precision.
- Background utility is an **operator-approved shared-content processor**: the enabled/conformed global profile may receive currently published, unprotected shared/public pages, **including pages restricted by page ACLs**. It is not requester/anonymous-ACL-filtered egress. Private, password-protected, unpublished/closed/invalid-window pages are withheld at preflight. Later source/eligibility changes discard output; already transmitted bytes cannot be retracted.
- Source is treated as untrusted; enforceable controls are no tools, strict output schema, declared-gap-only merge, source/hash/revision fencing, and no authoritative writes. Prompt text is not an injection-proof or semantic-truth guarantee.
- Input/output respect provider capabilities. Cross-worker `maxActive` caps knowledge leases using configured `globalConcurrency`, **separately** from Agent-run slots; there is no combined chat/background pool or shared per-user background cost/total quota. Backfill may invoke utility once per eligible current page; operators must review corpus/provider budget before deployment.
- Personal memory remains owner-scoped and frozen per conversation. No automatic Wiki/OKF/claim promotion into personal memory.

### Graph privacy and revision repair — two actual native findings fixed

1. Public Seed71 → protected Bridge70 → public Tail69 exposed Bridge metadata/derived body entity and Tail through MCP related traversal despite direct read70 being denied; protected edges also boosted public search scores. Fixed graph endpoint eligibility and current body-read fencing. Native retest omitted protected Bridge/Tail; legitimate public direct71→69 still worked.
2. Under a **controlled clone-only stalled links worker**, Bridge70 was canonically redacted/unprotected at revision2 while links2 remained running. Current read70 correctly said no outgoing references, but old formerly protected70→69 was still listed. Fixed by requiring a **succeeded, present links projection receipt for the source's exact current revision** before using an edge. Raw source/target identities/revisions/routes must also match authorized metadata snapshots. Targets need not have their own completed outgoing receipt.
   - Native retest while links2 was still held running: outgoing links empty; depth1 related contained only legitimate public incoming71, not stale69.
   - Releasing the lease let the real worker finish links2 and remove old rows.
   - In session observation, deleting synthetic page 69's derived render/link receipts proved bounded maintenance recreated and executed real render+links work at revision 1 with satisfied postconditions (no succeeded receipt was fabricated). The retained benchmark artifact (`docs/benchmarks/search-graph-boundary-2026-09-07.json`) records this recovery under `legacyRenderAndLinksRecovered: true` alongside an empty `receipts: []` array rather than retaining individual receipt rows.
- `PageProjectionLifecycle` maintains missing graph receipts from canonical data, reuses valid existing render dependency, creates real render work only when absent, preserves immutable/corrupt/terminal records, and advances a bounded per-instance keyset cursor to avoid starvation.
- Graphs remain public/published/open-window/unprotected/current-ACL only. Protected metadata can still be found lexically. No private graph feature or new graph storage service was introduced.

## Authoritative retained evidence

All these files are in the working tree and must be retained as part of this audit:

- `docs/search-foundation-audit.md` — detailed assessment, OpenWiki comparison, executed plan and results (finalized authoritative audit record, not replaced with a short recap).
- `docs/benchmarks/search-foundation-before-2026-09-07.json`
- `docs/benchmarks/search-foundation-after-2026-09-07.json`
- `docs/benchmarks/search-foundation-live-2026-09-07.json`
- `docs/benchmarks/search-graph-boundary-2026-09-07.json`
- `docs/benchmarks/search-utility-before-2026-09-07.json`
- `docs/benchmarks/search-utility-after-2026-09-07.json`

Final deterministic benchmark: PostgreSQL 17.10 / pg_trgm 1.6, 20,000 pages, 30 samples after five warmups, no threshold violations. Same 11 queries: lexical recall@5 **0.8181818181818182**, fixture-augmented recall/MRR/nDCG **1.0**, zero-result rate **0**. Final rebuild **25,772.876510 ms**; query p95 in ms: exact title/content **26.583659**, typo/fuzzy **24.870621**, multi-term description **31.693809**, common tag **62.194827**. This measures the engine/fixture union, not whole-request 20k HTTP authorization latency or live-model generalization.

Actual configured utility: **`gpt-5.6-luna`**, profile version `3b2c09ac-a6e6-4463-904a-dd51a7ee00ac`, invoked only with synthetic source. Generic prompt refinement produced four non-verbatim hints; hint ingestion and acronym retrieval passed. **The fixed held-out query `restore the ultraviolet verification code` still missed.** Do not claim universal semantic search or substitute the deterministic fixture's 1.0 result for model quality. Reports include synthetic fixture context, token counts, provenance hashes, actual terms and the miss.

Final current source checks:

- `bun run test`: **472/472 isolated files passed**.
- Four explicitly enabled PostgreSQL suites: **21 cases / 61 assertions**, all passed:
  - `server/test/knowledge-search.postgres.test.ts`: 4 cases / 10 assertions.
  - `server/test/utility-admission.postgres.test.ts`: 3 / 5.
  - `server/test/search-foundation.postgres.test.ts`: 12 / 37.
  - `server/test/search-graph-rank.postgres.test.ts`: 2 / 9.
- Shared/client/server typechecks, dependency/license checks, lint, OpenAPI compatibility/lint, placeholder check, Agent release gate, Vite and bundle budgets passed.
- LSP checks passed for changed Vue/source except its known missing-ambient-`WIKI` diagnostics in `server/modules/types.ts` and `server/operations/pages.ts`; actual server tsc repeatedly passed. This tool/config discrepancy was reported, not suppressed with declarations.

Local visual evidence (ignored, intentionally retained):

```
.playwright-cli/search-foundation-audit/desktop-light.webp
.playwright-cli/search-foundation-audit/desktop-dark.webp
.playwright-cli/search-foundation-audit/mobile-light.webp
.playwright-cli/search-foundation-audit/mobile-dark.webp
```

## Release / deployment constraints

- Maintained URL: `https://agents8c48g.tail41a24a.ts.net:10443/`; maintained services `wiki-tailnet` and `wiki-postgres` were not changed. Existing compose is `/home/bbferko/.local/state/wiki-tailnet/compose.yml`. Read configs cautiously; never print secrets. Retained live attestation in `docs/benchmarks/search-foundation-live-2026-09-07.json` confirms `source.deployedToMaintainedInstance: false` and `maintainedAuthoritativeState.repositoryBindMounts: 0`.
- Under the manifest-driven attestation framework (`docs/security/review-attestations.json`), the former monolithic Covered source mechanism in `threat-model.md` has been replaced by structured review records. The historical **`55f30709cd4b8de0ec1fd498cac7174f1cacd084`** baseline is represented by a non-independent, release-ineligible structured record with blocking finding `SEC-EXT-001` (external reviewer unassigned). The current search audit is represented by a `working-tree-audit` record using fingerprint **`3adffcba7255a3f88ec490ceffefe6f826e9508a`** (base `d3d5a63326c056bb847fdb2552be0a1cf1eb7020`), which is non-independent and release-ineligible staged evidence. Release remains blocked until committed exact source receives independent review and a release-eligible `source-review` record.
- The normal build refuses a dirty tree unless given explicit provenance. Preview builds used supported `WIKI_BUILD_REVISION`/`WIKI_BUILD_DATE` overrides with a **content-derived fingerprint, not a Git commit**. Final fingerprint: **`3adffcba7255a3f88ec490ceffefe6f826e9508a`**. This staged working-tree fingerprint provides build and audit provenance only and is not a release attestation. Generated assets and `server/.build-metadata.json` are ignored and remain locally built. Do not deploy them as a committed release.
- Fingerprint recipe used: SHA-1 over `tsepistle-isolated-preview-v1\0` + base HEAD + `\0`, then each sorted unique changed/new source/test file under client/server: path + `\0` + byte length + `\0` + file bytes. Documentation is excluded; unchanged files are represented by base HEAD. Recompute if source changes; do not reuse an old fingerprint for different inputs.
- No production deployment was requested or made; do not replace the maintained image as a closeout shortcut (`docs/benchmarks/search-foundation-live-2026-09-07.json` records `source.deployedToMaintainedInstance: false`).

## Commands if revalidation is needed

Use project scripts, not a guessed `bun check`:

```sh
bun run test
bun run dependencies:check
bun run licenses:check
bun run lint
bun run typecheck:shared
bun run typecheck:client
bun run typecheck:server
bun run openapi:check
bun run placeholders:check
bun run agents:release-check
# Manifest-driven attestation gate (replaces former monolithic covered-source check; release remains blocked by unassigned external review SEC-EXT-001 and uncommitted working-tree state):
bun run threat-model:check
```

Build only with honest provenance: clean committed inputs, or an explicitly identified unreleased content fingerprint via `WIKI_BUILD_REVISION` plus `WIKI_BUILD_DATE`. Never disable the dirty-tree guard.

The benchmark launcher creates and removes its own isolated PostgreSQL 17 container:

```sh
POSTGRES_SEARCH_BENCHMARK_FILE=/tmp/tsepistle-search-audit-after.json \
POSTGRES_SEARCH_BENCHMARK_ITERATIONS=30 POSTGRES_SEARCH_BENCHMARK_WARMUPS=5 \
bun run benchmark:postgres-search
```

Real PG tests need fresh disposable databases; **the old clone container/databases no longer exist**. Their guards require these database names/suffixes:

- `wiki_knowledge_search_test`
- `wiki_search_foundation_test`
- `wiki_search_graph_rank_test`
- `wiki_search_audit` for utility admission (test uses isolated schemas).

Set `WIKI_TEST_POSTGRES_HOST`, `WIKI_TEST_POSTGRES_PORT`, `WIKI_TEST_POSTGRES_USER`, `WIKI_TEST_POSTGRES_PASSWORD` (or `_PASSWORD_FILE`), `WIKI_TEST_POSTGRES_DATABASE`, and `WIKI_TEST_POSTGRES_REQUIRED=1`, then `bun test <file>`. Never point these fixtures at the maintained `wiki` database. Tests skip appropriately in the ordinary isolated full-suite runner; the explicit real-PG runs above are separate evidence.

No rerun is needed for closeout, and retained JSON remains the evidence source. Any future utility inference requires a newly created safe harness plus dedicated clone/config/credential setup; it requires a dedicated audit clone DB URL and `AGENT_PROVIDER_SECRET_KEYS_FILE`, rejects inline keys, uses synthetic content only, and removes its fixture. The original keyring file was only read, never copied into the repository or changed. A new session must establish its own safe clone/config/credentials; none of the previous Eval variables or credentials are a handoff dependency.

## Complete uncommitted file inventory

At pause before this handoff replacement: 33 modified tracked files, 13 untracked files, no staged files. `continue.md` is additionally modified by this handoff. Inspect `git status` for any later user changes before acting.

Modified tracked files:

```
client/components/admin/admin-search-evaluate.vue
client/components/common/search-results.vue
client/helpers/pages-api.test.js
client/helpers/pages-api.ts
docs/agents-deployment.md
docs/search-agent-next-steps.md
docs/search-architecture.md
docs/security/threat-model.md
server/agents/actions/page-reads.ts
server/agents/providers/utility.ts
server/core/page-mutation-outbox.ts
server/knowledge/lifecycle.ts
server/knowledge/projection.ts
server/master.ts
server/modules/search/postgres/engine.ts
server/modules/types.ts
server/okf/format.ts
server/operations/pages.ts
server/scripts/benchmark-postgres-search.ts
server/scripts/search-relevance.ts
server/test/agents/mcp.test.ts
server/test/agents/page-read-actions.test.ts
server/test/agents/utility-model.test.ts
server/test/controllers/api.pages.test.js
server/test/core/page-mutation-outbox.test.ts
server/test/knowledge-lifecycle.test.ts
server/test/knowledge-projection.test.ts
server/test/modules.search.postgres.test.js
server/test/okf-format.test.ts
server/test/operations.pages.preview.test.ts
server/test/operations.pages.related.test.js
server/test/operations.pages.search.test.js
server/test/scripts/benchmark-postgres-search.test.ts
```

Untracked files to retain:

```
docs/benchmarks/search-foundation-after-2026-09-07.json
docs/benchmarks/search-foundation-before-2026-09-07.json
docs/benchmarks/search-foundation-live-2026-09-07.json
docs/benchmarks/search-graph-boundary-2026-09-07.json
docs/benchmarks/search-utility-after-2026-09-07.json
docs/benchmarks/search-utility-before-2026-09-07.json
docs/search-foundation-audit.md
server/db/migrations/tsepistle-000027-knowledge-search.ts
server/helpers/search-query.ts
server/test/knowledge-search.postgres.test.ts
server/test/search-foundation.postgres.test.ts
server/test/search-graph-rank.postgres.test.ts
server/test/utility-admission.postgres.test.ts
```

Other local state:

- Ignored screenshots listed above remain under `.playwright-cli/search-foundation-audit/`.
- Ignored rebuilt `/assets` and `server/.build-metadata.json` remain; they are not deployed release artifacts.
- The disposable utility smoke files (`temp/search-foundation-utility-smoke.ts`, `temp/search-foundation-smoke-report.json`) and redundant `/tmp` benchmark files were removed.
- The sensitive `/tmp/tsepistle-search-audit-nCIKhy` directory was removed at pause.

## Closeout execution summary

1. Read this file, inspected Git status, and verified 472/472 test files and 21 real PostgreSQL cases (61 assertions) passed.
2. Reconciled all six todos using authoritative evidence; marked all items closed and verified.
3. Updated documentation and evidence cleanup state (`docs/benchmarks/search-foundation-live-2026-09-07.json` records `cleanup.completed: true`, all resource cleanup booleans true, and `remaining: []`).
4. Verified removal of all disposable utility smoke tooling, redundant `/tmp` benchmark files, sensitive dump directories, and isolated containers.
5. Preserved the full detailed assessment, executed plan, OpenWiki comparison, receipt-fenced graph repair proof (distinguishing session-observed exact revision-1 recovery from retained `legacyRenderAndLinksRecovered: true` and empty `receipts: []`), benchmark figures, fingerprint `3adffcba7255a3f88ec490ceffefe6f826e9508a` (recorded as a non-independent, release-ineligible working-tree-audit record, not a release attestation), actual `gpt-5.6-luna` held-out miss, manifest-driven attestation gate blocker (historical 55f baseline non-independent and release-ineligible with SEC-EXT-001 blocking; release blocked until committed exact source receives independent review and a release-eligible source-review record), and uncommitted/undeployed workspace state.
