# Homepage cited-summary repair — historical handoff

> Historical handoff from the 2026-09-20 user-requested pause. The numbered acceptance criteria below remain the goal, but historical observations and next-step instructions describe the state at that pause, not the current deployment. The subsequent user attested that the homepage is synthetic and explicitly authorized reading it directly. The deployed application source revision is `94888b97577d697e3c2f7e2e9d0fa474703fcdd0`; the corrected starter passed its authenticated tailnet UI smoke on 2026-09-25. Never reproduce credential-like page content in this handoff.

**Current deployed result (2026-09-25):** The first fresh temporary conversation on `553bf989` submitted the exact starter once, but its successful run `f8172b77-5dd6-4122-911a-6cd1d6b98fdf` was an unacceptable heading/link inventory (135526 consumed tokens / 151204 µcost). `94888b97` added a regression-tested page-summary body-fact gate and prompt guidance; a second fresh temporary conversation submitted the exact starter once and run `a4b198c8-49cb-4ef2-9da8-4f8598dc2c7a` succeeded. Its rendered answer cited concrete General Info terms and distinct Geiger, Hickory Contract and Montisa discount/terms facts, with four current-page section links; clicking one opened the source-excerpt dialog with an Open page link. There was one `pages.get`, seven rejected drafts followed by one accepted draft, no hidden replay; final run accounting reconciled **267063 tokens / 326658 µcost**. High correction cost remains a performance risk. The two owned temporary conversations were deleted through the authenticated API (204 then 404); automatic cleanup purged their per-run records/reservations, while the durable daily aggregate retained **402589 consumed tokens / 477862 µcost**, exactly the sum of both runs. Owned smoke account 23 was deactivated, password erased, admin membership removed and auth version advanced; its prior browser session returned 401. The privately held auth fixture and screenshot were removed; data recovery archives were retained. On initial database inspection **before these interventions**, the original user run `ea14fa18-9724-4b39-b3c9-3e29cbd7a8db` and all three historical failed runs/sessions were already absent, contrary to the 2026-09-20 handoff. They were not modified or restored by this work; do not claim they remain preserved. Account 22 had also independently changed to an inactive user with different name/auth version; it was untouched. Only the application service was rebuilt/redeployed, PostgreSQL ID/start time, env, mounts, network, ports and mounted data remained unchanged. Current backup: `/home/bbferko/.local/state/wiki-tailnet/before-homepage-94888b97-20260925/wiki-data.tar` (SHA256 `05ba91db615370d159891ea8a7e8d6a2106b52b7289941a865c6f170e5d3b72e`).

## Standalone goal and acceptance criteria

**This file is the complete task handoff. No previous chat, agent memory, active goal record, or persistent Eval kernel is required.** Read this goal first, then the concrete state and evidence below. Follow the repository's governing instructions when resuming.

**User objective:** Fix the broken homepage Wiki Agent cited-summary flow in tsEpistle. The user reported that the homepage flow was still not fully working and requested orchestration to fix it. The intended behavior is: an authenticated user opens the Wiki homepage, opens Wiki Agent, and clicks **Understand This Page / Key ideas, with sources**. This submits **“Summarize the current Wiki page and cite the key sections.”** The application must return a substantive, useful summary of the actual homepage with valid, clickable citations to delivered page/section evidence—not fail during provider tool handling, citation repair, compaction, or context admission.

**Completion requires all of the following:**
1. The exact original starter succeeds through the deployed real UI on `https://agents8c48g.tail41a24a.ts.net:10443/en/home`, in a fresh temporary conversation with one submission.
2. The answer covers the homepage's substantive **General Info and MFG Directory** topics. A refusal, heading inventory, single quotation, or false claim that delivered sections are unavailable is not an acceptable substitute.
3. Citations are supported by successfully delivered evidence. Preserve source-local numbers, manufacturer/subject assignments, qualifiers, polarity, temporal restrictions, and actual structural membership. Fix false negatives without accepting fabricated claims, unrelated pooled facts, or code literals promoted to facts.
4. Provider history, admitted tool permissions, and fail-closed behavior remain safe. Preserve approved **maxOutputTokens 32768 / maxContextTokens 160000**, existing model/profile, compaction policy, and quota/accounting. No unaccounted provider replay, hidden retry, cap increase, or state reset.
5. The actual corrected candidate passes appropriate reproductions, regression checks, typechecks, affected-service build, and live behavioral smoke. Commit and deploy the tested revision **only to the maintained local application service**; preserve PostgreSQL, existing Wiki data, secrets, configuration, mounts, network, ports, and identities.
6. Report the real final result and material residual risks. Reconcile run accounting, revoke temporary smoke-test access, and remove owned temporary test sessions/artifacts after proof while retaining recovery archives and preserving the original user run.

Resume implementation and useful worker orchestration where independent ownership warrants it. Keep work bounded to this goal; do not add speculative infrastructure, broad parser rewrites, release certification, unrelated refactors, or a replacement summary feature. If no goal record exists in the new session, initialize one from this standalone objective rather than inventing a different scope.

**Historical status at 2026-09-20 pause, superseded by the current result above:** Three deployed candidates had failed the original live request. The then-latest local source correction passed its narrow reproduction but had two unresolved security-review counterexamples; no further implementation or deployment was performed during that handoff.

Repo: `/home/bbferko/repos/tsEpistle`. Development Sprint rules in the loaded AGENTS.md apply. Use graph-first discovery (`graft ask ... --source`, exact source ranges), LSP for symbol work, existing patterns, proportional checks. No Enterprise Release ceremony, cap changes, model switches, migrations, remote push, or PostgreSQL recreation.

## Current deployed and working state

- Latest commit and deployed revision: **a887f1207d84b989e36ae29107cc6e8a8cd21cc6**.
- Deployed image: **local/tsepistle:homepage-a887f120**.
- Latest commit: `fix(agents): align summary generation with source-local evidence rules`.
- Earlier repair commits: `3b32b8578e04acc44b30cd8cb03d21cf94898b24`, `69438f721952c7914f4b2cd2aa1415b1a3717b25`.
- **Uncommitted Main changes:** `server/agents/providers/engine.ts`; last read snapshot `7DAF`, approximately 4085 lines. Read fresh before editing. No new source edits were made after that snapshot during pause.
- **Unapplied isolated test patch:** `SentenceScopeRegressions.patch`, path below. It changes only `server/test/agents/agent-engine.test.ts`; inspect and integrate compatible deltas without overwriting the engine changes.
- No workers remain running. `SentenceScopeReview` completed with **FAIL**; `SentenceScopeRegressions` completed its test-only assignment without running checks.
- This handoff file is intentionally new; no `CONTINUEmd` file was created.

### Current uncommitted engine changes

1. `sentenceBoundaryEnds` around 505–517 recognizes sentence starts after bold/italic delimiters:
   ```ts
   /([.!?][*_]*)\s+(?=[*_]*\p{Lu})/gu
   ```
   It includes closing emphasis markers in the prior sentence and checks abbreviations before accepting a boundary. **It does not yet protect inline-code spans.**
2. `sourceUnits` list branch around 650–655 retains the original full list item and structural labels, then adds complete sentence units without structural labels:
   ```ts
   const member = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
   addUnit(line, structuralLabels(member))
   const sentences = sourceSentences(member)
   if (sentences.length > 1) for (const sentence of sentences) addUnit(sentence)
   ```
3. `evidenceCorrectionFragments` around 1389–1456 selects distinct citation scopes first, then further clauses from already represented scopes. Existing maximum four fragments / three ranked units per clause / **1200 serialized UTF-16 characters** remain. Incremental JSON accounting includes brackets, escaped strings, and commas. No unit truncation.
4. Repair instructions explicitly explain that omission from the small correction packet does not revoke already delivered evidence or make other sections unavailable for citation.

Do not weaken `unitSupportsClause`: lexical threshold 0.6, exact source-local numbers, identifier assignment, polarity and qualifier attachment, temporal constraints, and structural scope remain mandatory.

## Immediate remaining work

1. **Reproduce and fix the two reviewer counterexamples below**, preserving the exact freight positive and existing integrity controls. Add meaningful regressions to the existing engine test fixtures. The review was static; Main had NOT run these two repros yet.
2. **Make bounded repair feedback useful on the actual rejected draft.** Distinct-scope ordering alone did not fix actual coverage: its first selected unit still consumes almost the whole allowance. See evidence and ranking investigation below. Do not increase the bound or fabricate/truncate source units.
3. Inspect and apply the isolated test patch. It was reviewed as a diff by Main but NOT applied or executed.
4. Run focused reproductions, existing changed-path tests, shared/server typechecks as applicable, and formatter once after integration. Review any concrete newly exposed guard failures.
5. Update existing deployment documentation if behavior warrants; refresh graft after substantial changes; commit the verified candidate; build it.
6. Perform another **app-only, data-preserving cutover** using the established procedure below.
7. Reactivate the dedicated temporary fixture safely with fresh random credentials; submit the exact original starter **once** in a fresh temporary UI conversation. Wait for final result, verify substantive coverage and live citations, and verify accounting. A health check or one accepted quote is not success.
8. After successful live proof, remove owned temporary sessions, revoke fixture credentials/membership, stop browser, remove owned temporary artifacts/venv/profile; retain recovery archives and useful worker patches. Preserve the original user run.

Do not simply repeat deployment on the current unreviewed candidate. Do not treat earlier narrow tests as proof of the complete flow.

## Unresolved security review: candidate 7DAF

Reviewer: `SentenceScopeReview`, runtime model `openai-codex/gpt-6-astra`; effective reasoning effort was not independently visible. Result at `agent://SentenceScopeReview`, transcript `history://SentenceScopeReview`. Both findings are static deductions, not executed tests.

### 1. Inline-code fragment promoted into factual evidence

Source:
```md
- Display only the literal `Banner. _Shipping is free._` as a test string.
```
Claim, with a valid citation scoped to that source:
```md
Shipping is free.[[cite:E]]
```
New sentence splitting finds the period inside the inline code and adds a unit beginning `_Shipping is free._`, followed by the closing backtick and ` as a test string.`. That fragment has lost `only`; lexical/identifier checks can accept it. The retained full list item would reject it. Sentence boundaries must not split within inline-code spans.

Graph discovery found an existing robust delimiter-run parser to reuse rather than invent another convention:
- `server/okf/format.ts:482–485`: private `CodeSpan` interface `{start,end}`.
- `server/okf/format.ts:487–518`: private `codeSpans(markdown)`.
- `server/okf/format.ts:519–528`: `rewriteInlineMarkdownLinks`, calls `codeSpans` at **520**, not 521.
- `server/knowledge/projection.ts:288`: another private `codeSpans`; usage in `inlineLinkLines` around 341–361.
- `client/components/agents/agent-citations.ts:67–73`: simpler private `skipInlineCode`; avoid importing a client module into the server.

The OKF parser scans backtick runs, records lengths and whether an opener is escaped, builds next-run-by-length links backwards, and emits matching spans in linear time. It handles arbitrary delimiter lengths. No parser export/refactor/import was performed yet. Before modifying an exported symbol, use LSP references. Choose the smallest safe reuse; do not launch a broad parser refactor without need.

### 2. Unlabeled factual fragment bypasses structural membership

Source:
```md
- Alpha routing. Orders ship only today.
```
Claim:
```md
Alpha routing is listed.[[cite:E]]
```
The new `Alpha routing.` unit has empty structural labels, but `membershipAssessment` around 1131–1137 returns null for an unmatched single passive subject. `assessClaimClauses` around 1195–1202 falls back to factual matching; alpha/routing match two of three terms, above 0.6, without the original `only`/`today` restriction.

Preserve legitimate passive factual assertions such as `OM chairs are provided.`. A possible bounded direction is to allow factual fallback only when an intact source unit explicitly states the corresponding passive subject/predicate, rather than allowing a sentence fragment to acquire `is listed` through lexical overlap. This is an investigation direction, **not an implemented or approved new rule**. Keep actual exact structural membership behavior intact.

Reviewer otherwise found the incremental JSON accounting, four-fragment limit, source/context ownership, and two-pass scope selection sound. It did **not** approve the overall candidate.

## Actual false negative and feedback findings

Latest live failure exposed this exact source sentence:
> Freight quotes should be rechecked before placing an order due to potential fluctuations.

It is the last sentence of a long Markdown list item; an earlier sentence has unrelated `only`. Before the local correction, the source was one unit with qualifiers `only,before`, and this exact freight claim failed. After the local correction it is four sentences, the selected factual sentence retains `before` only, and the exact claim passes. All 32 existing integrity probes also still passed at that point.

Main then exercised the real rejected drafts against the current candidate:
- Turn 2: invalid, 19 unsupported, feedback 1177 characters, **only section 1 represented**.
- Turn 5: invalid, 10 unsupported, feedback 1195 characters, **only section 1 represented**.
- Turn 6: valid, zero unsupported, empty feedback (`[]`). **That late draft was not an adequate full summary; it wrongly implied other source topics unavailable.**
- Turn 7: invalid, one unsupported, feedback 1171 characters, only section 1 represented.

Why actual feedback remains poor:
- First failed draft fragment (154 chars): `Quick reference links connect to Contract Pricing, Quick Ship programs, SPIFs, the Discounts Chart, shipping and logistics information, and Spec/CET tools`.
- Selected unit body is 414 chars of a tariff/price-update list item, not the concise navigation heading.
- Its context is 489 chars of raw Markdown heading ancestry and link destinations. Full packet is 1177 chars, leaving no room for a distinct scope.
- `relevantSourceUnits` around 1371–1387 currently sorts by structural matches, then **all body+context matches**, then body matches, then source order. Shared heading-context terms can outrank a more directly relevant body unit.
- **Potential next experiment:** rank actual body matches before context matches, retaining structural matching priority. Test against actual drafts and synthetic integrity cases. No ranking change or context normalization was applied. Do not silently alter source context/identifiers or loosen provenance to make feedback fit.
- Many first-draft failures are genuine pooled facts/paraphrases, not false negatives. Do not accept broad pooled price/territory/discount claims or synonym guesses merely to make the run pass.

## Retained worker patch

Session artifact root:
`/home/bbferko/.omp/agent/sessions/-repos-tsEpistle/2026-09-20T03-09-51-254Z_01a0bcca-a116-7402-9064-2d4cf25eb442/`

Patch:
`SentenceScopeRegressions.patch` (also `artifact://1081`; durable filesystem path is preferred next session).

Only `server/test/agents/agent-engine.test.ts`, 22 insertions / 8 deletions:
- Synthetic compound list: `Northstar ships only 12 crates per order. **Aster freight is rechecked before confirmation.** _Boreal invoices are archived._`.
- Accepts the complete Aster and Boreal sentences; rejects removal/relocation of the Northstar qualifier.
- Adds repeated failed clauses in first scope and an escaped quoted source unit in later scope; checks both complete source units survive bounded feedback.
- Replaces weaker substring source assertion with an exact intact heading unit assertion.
- Checks NOT_RUN by explicit concurrent-batch policy.

## Executable reproduction artifacts

Saved at pause, directory mode 0700 and files 0600:
`/home/bbferko/.local/state/wiki-tailnet/homepage-repair-pause/`

- `integrity-probes.js`: 32 synthetic citation-integrity cases.
- `actual-freight-probe.js`: real-source exact freight reproduction; exit 1 if rejected.
- `actual-feedback-probe.js`: assesses captured real rejected drafts, reports only outcomes/counts/scopes/unit lengths, checks 1200-character bound.
- `faithful-source-probes.js`: five real-source faithful claims.

These scripts use a Bun onLoad plugin to expose private engine functions, and import the engine relative to repository cwd. Run from repo root via `bun -e` with the saved file contents passed as the argument (e.g. Eval reads script privately and `Bun.spawn(['bun','-e',script], {cwd: repo,...})`). Do not assume executing the external script path directly will resolve its relative engine import correctly.

Real-source scripts depend on the private artifact:
`<session-root>/local/homepage-live-failure.json` (0600, 148244 bytes).
It contains delivered Wiki source and should not be pasted into chat or committed. Other owned private artifacts in that local directory:
- `homepage-repair-evidence.json`
- `homepage-structural-probes.json`
- `homepage-integration-probes.json`
- `homepage-sentence-graft.txt`
Retain until final verification; remove owned private diagnostic/probe files during final cleanup. Keep recovery archives and worker patches.

The previous Eval kernel had many helpers; **do not depend on those variables surviving a new session**. Recreate SQL/browser helpers from repository conventions. Never print provider secrets, cookie tokens, temporary passwords, or whole diagnostics tool outputs.

## Verification already performed — exact scope

On 69438 candidate:
- 59/59 isolated Agent + shared-fence test files passed.
- Biome for five changed TS files passed.
- Shared and server typechecks passed.
- 32 integrity probes + five faithful actual-page claims passed.
- Image build and all asset-budget gates passed.

On deployed a887 candidate:
- Engine instruction Biome/server typecheck passed.
- Full 59-file invocation: 58/59 files passed; the sole failure was an incidental 12000-context synthetic prompt-tool fixture after instruction growth.
- Fixture changed to 100000 (test-only; production cap unchanged), brittle English/mock-echo assertions removed; engine file rerun passed. Other 58 results reusable, but do not claim a single 59/59 run on a887.
- Image build passed.
- Proper Markdown heading form accepted; plain prose label folding into a claim rejected, as intended.

On current uncommitted candidate:
- Exact freight reproduction fails pre-fix / passes post-fix.
- 32 integrity probes pass.
- Actual feedback measurements above completed.
- **No full test/typecheck/formatter run yet. Two reviewer counterexamples not executed or fixed.**

Agent PDF tests require the existing temporary Python environment:
`PATH=/tmp/wiki-homepage-pdf-313/bin:/home/bbferko/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
Python 3.13 + pikepdf 9.5.2. Without it six PDF cases fail for environment.

Runner detail: `bun run test server/test/agents shared/markdown-code-fence.test.ts` counts as two entries, not 59 isolated files. Enumerate the 58 Agent test paths plus shared fence file to reproduce actual isolation. Rebuild shared declarations with `bun run typecheck:shared` before server typecheck when shared exports change.

## Live runs and accounting — preserve failures honestly

**Historical preservation requirement:** Original user run `ea14fa18-9724-4b39-b3c9-3e29cbd7a8db` was recorded at pause, but was already absent when current database inspection began on 2026-09-25. No current restore source for that record has been verified.

Owned temporary smoke sessions/runs:
1. Session `c809d774-6812-4a6b-a0cb-9f46480b6e53`, run `70041e88-8e29-4e21-ba90-88a124c0893c`, image 3b32: `UNEXPECTED_PROVIDER_TOOL_CALL`. Reservation consumed/reconciled 227991 tokens / 389386 micros.
2. Session `42618da8-79a7-4111-80a5-7d4519447f15`, run `393b49b8-9a40-46cf-b4a8-61e903197f8a`, image 69438: `UNEXPECTED_PROVIDER_TOOL_CALL`. Reservation consumed/reconciled 206863 tokens / 320222 micros.
3. Session `92ad6957-c5b9-4247-9467-c38b59395648`, run `b05d9463-44f1-40f7-8280-737a56069ea2`, image a887: **AGENT_CONTEXT_TOO_LARGE**, 2026-09-20 23:03:13–23:05:36 UTC. Reservation verified at pause: **consumed 189199 tokens / 242737 micros, reconciled 2026-09-20T23:05:36.713Z**.

Each starter was submitted once, accepted HTTP 202. Latest run went through repeated answer rejection/compaction, not an unexpected no-tools call. A transient diagnostic GET failed; it was retried read-only, never resubmitted.

Do not zero/reset failed reservations or replay provider calls outside accounting. At this historical pause the sessions were still retained for diagnosis; at the later 2026-09-25 inspection they and the original user run were already absent before any new smoke. The two later owned temporary sessions were removed after proof; do not delete unrelated user sessions/runs.

## Provider and architecture constraints

Profile `dc7a1c3c-0d4c-4a08-92db-c334f3204105`, immutable version `8b06a7a9-4336-4bbb-84d7-e6bd52e13730`:
- gemini-api / **gemini-3.8-flash**
- maxOutputTokens **32768**
- maxContextTokens **160000**, conservative serialized-byte exposure
- adaptive compaction 4096; no reasoning override

No profile/quota/policy/credential changes have been made. Compare complete immutable profile version across cutovers, parsing string-valued JSON columns where needed.

Existing planner contract (`NoToolsContractRecheck`, `LiveCitationContract`): keep transport and fail-closed unexpected-call guard; use source-local assertions and real Markdown headings; preserve substantive requested coverage; page-level citation does not permit pooling unrelated factual units; narrow exact structural membership only; bounded exact-unit feedback; no state resets, hidden retries, cap increases, model switches, host-written summaries, or inventory-only substitutes.

The Gemini transport already sets `generation_config.tool_choice: 'none'` when no declarations exist and omits `tools`; guarded fetch forwards body unchanged. There is no raw wire capture proving provider noncompliance. Do not attribute prior unexpected calls to vendor noncompliance without bounded private capture during an ordinary accounted run. Official enum reference: https://ai.google.dev/api/interactions-api.md.txt .

## Deployment topology and invariants

- Application container **wiki-tailnet**.
- Compose project **wiki-tailnet-6629be44**, service **wiki**.
- Compose file `/home/bbferko/.local/state/wiki-tailnet/compose.yml`; image scalar line 4, last snapshot `71BF` (read fresh).
- User/group 1000:1000; network `wiki-pg-migration-net`.
- Local health `http://127.0.0.1:3014/healthz`.
- Real origin **https://agents8c48g.tail41a24a.ts.net:10443**.
- PostgreSQL **wiki-postgres**, ID `c6e9eefe177df2527f3177289a013dc2ad58960d065ccc21cb15d96bbe2c8e66`, StartedAt `2026-09-19T15:55:31.790187292Z`. **Never recreate it.**
- Baseline 16 pages / 56 pageHistory / 2 assets / 5 users. Browser capability false, goals enabled. Preserve all env, secrets/keyrings, mounts, ports, network, identities, flags, data, volumes.
- Compose warns a pre-existing repo volume belongs to old project `wiki-tailnet-41580a4f`; preserve it, do not “fix” ownership.

### Data-preserving app-only cutover

Read governing `docs/agents-deployment.md` and `.github/CONTRIBUTING.md` Sprint sections when resuming deployment.
1. Commit tested candidate. Build `dev/build/Dockerfile` using the original five product identity build args plus revision/date, tag `local/tsepistle:homepage-<shortsha>`. Preserve original identity values from deployed image/env. No push.
2. Verify revision label and User 1000:1000. Capture fresh app+PG baseline, env as maps, mounts, ports, network/restart, complete immutable profile row, data counts, original run.
3. Ensure zero active runs (terminal statuses: succeeded, partial, failed, cancelled). Inspect writable-layer diff for unique data outside mounts/archive.
4. Fresh private directory 0700 with compose backup and `/wiki/data` tar 0600. **Stop only wiki**, then export the complete data directory. Earlier archives were 113664 bytes. Verify changed data paths covered.
5. Change only image scalar. `up --no-start --no-deps --force-recreate wiki` under the maintained compose project.
6. Restore tar using `docker cp -a - wiki-tailnet:/wiki` with tar stdin. Re-export and compare complete tar SHA before starting. Preserve ownership.
7. Compare env maps (array order can differ), mounts, ports, user, restart, network, unchanged PG ID/start.
8. Start app. Health curl with retry-all-errors (initial resets can occur), then profile/data/original-run checks and real changed-flow UI proof.

Latest retained recovery archive (DO NOT DELETE):
`/home/bbferko/.local/state/wiki-tailnet/before-homepage-repair-2026-09-20T22-59-40.742Z/wiki-data.tar`
SHA256 `8ed3a8bd90dccf9161316e2a05b402d8a56f0c2e5683129cc7e08b8937e49e49`, 113664 bytes, 8 entries. Restore after latest cutover was byte-identical.

Earlier retained archives:
- `before-homepage-repair-2026-09-20T22-30-50.672Z/wiki-data.tar`, SHA `7233c1c1ea898ec7582616a3effd3f62a0fa30a9ef608ede6a1bfbe43f03ece2`.
- `before-homepage-repair-2026-09-20T21-21-37.241Z/wiki-data.tar`, SHA `e604f6445f645c7d7e44f91bfc4bb87ff54b3dcd9c0c0f89a486a7948ca6e03f`.
All under `/home/bbferko/.local/state/wiki-tailnet/`, with compose backups. No PG recovery/migration is required for this source-only fix.

## Pause safety and next live UI attempt

**Temporary admin was revoked at pause, verified:**
- User 22, `Agent Shakedown Temporary Admin`.
- Inactive, empty password, zero group memberships, authVersion **11**.
- Atomic guarded deactivation matched owned password hash, authVersion 10, and activation revision; incremented authVersion, changed adminRevision, set sessionsRevokedAt, removed only group 1 membership.
- Old authenticated browser GET `/_api/agents/sessions` returned **401 Unauthorized**.
- Browser managed tab released; supervised process **homepage-repair-browser** stopped, exit 143.
- Profile directory `/tmp/wiki-homepage-repair-resumed-chrome` remains for later owned cleanup; existing cookies are revoked. No temporary password was written into this handoff.

**Superseded historical next-smoke instruction:** Do not reactivate user 22. By 2026-09-25 it had independently changed identity and auth state; this work used a separate newly owned user 23, now inactive with password erased and admin access removed.

Use system `/usr/bin/google-chrome` headless-new with sandbox intact, dedicated profile, CDP 127.0.0.1:9225, supervised with hub; do not use sandbox-disable flags. Open real origin via browser. Explicitly set actual viewport to 1365x900; a prior browser metadata/actual viewport mismatch occurred.

Flow:
1. Load `/en/home`, open Wiki Agent.
2. If old failed conversation restored, choose New conversation.
3. Toggle Temporary conversation true; it removes the newly created blank saved conversation. Confirm pressed=true and ready UI.
4. Click **Understand This Page Key ideas, with sources** once. It SUBMITS, not prefills.
5. Confirm exactly one accepted 202 POST to `/_api/agents/sessions/:id/messages`; derive session ID and GET projection, user message/run ID.
6. Exact user prompt must be **Summarize the current Wiki page and cite the key sections.** Page 1 / en / home / revision 9 / Homepage / content length 37286 at prior runs.
7. Observe final substantive General Info + MFG Directory coverage and citations, including qualifiers such as `None known of at this time` and `We No Longer Represent`. No refusal, heading echo, or single-quote substitute.
8. Inspect final diagnostics and reconciled reservation. Capture actual rendered evidence; no long-running browser callback polling.

Authenticated mutation API uses same-origin browser credentials plus `x-wiki-csrf` from `window.siteConfig.agentCsrfToken`. Never send authenticated mutations to localhost. Routes: GET session/run, GET `/_api/agents/admin/sessions/:id/diagnostics.json`, DELETE owned session then verify 404. Diagnostics toolCalls contain full private source; print only bounded outcomes/counts. `tool.completed.data.result` is a JSON string and must be parsed before evidence collection.

## Historical todo continuity at the 2026-09-20 pause (superseded)

Earlier diagnosis/implementation/deployment tasks were completed for previous candidates, not overall success. Remaining tasks are blocked for the explicit user-requested pause; unblock the implementation tasks when authorized to resume:
- Correct sentence-local evidence in compound list items — paused, previously in progress.
- Preserve citation-scope coverage in bounded repair feedback — paused, previously pending.
- Verify and deploy the sentence-local correction — paused, previously pending.
- Prove the original cited homepage request succeeds — blocked on above corrections.

The old paused todos above were superseded by the deployed result at the top of this file; do not re-run those reported failures just to confirm them. The older user-run record was absent before the current intervention and cannot be claimed preserved.
