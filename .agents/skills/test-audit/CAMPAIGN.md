# Test Audit Campaign

Use this workflow for an explicitly scoped audit of a subsystem's complete test
surface. Apply the value, retention, evidence, and validation criteria in
[SKILL.md](SKILL.md). Choose delivery batches and review depth to fit the scope
and repository policy; a campaign need not be one pull request.

## 1. Establish scope and baseline

Identify the subsystem, shared-boundary cases, support code, and applicable
integration or manual scenarios. Record the source revision and relevant
uncommitted changes so results identify the code actually tested.

Record each in-scope suite's baseline result. Distinguish failures from skipped,
blocked, or unrun checks. Diagnose failures without assuming they are stale
tests or product defects. Run external or live checks only within existing
authorization. Record test and support size if useful for measuring the audit.

Proceed when the inventory and baseline limitations are explicit.

## 2. Group by behavior ownership

Group tests by the production component responsible for their contracts,
including cases located outside the subsystem directory. Assign each test or
scenario one primary review group and note shared dependencies.

Review groups sequentially, or delegate independent groups when available and
permitted. Delegation is optional; coordinate shared files and resources.

## 3. Record test decisions

Read every in-scope test, including parameter cases. Inspect relevant production
owners, callers, history, overlapping coverage, and CI routing. Record one
decision and its evidence for each declaration; split parameter cases when they
need different decisions:

- **Retain:** Name the contract and regression it protects.
- **Repair:** Preserve the contract while correcting a weak or misleading
  assertion.
- **Consolidate:** Name the retained suite that will absorb needed assertions.
- **Delete:** Identify remaining coverage or explain why no supported contract
  needs protection.

Judge assertions and exercised paths, not test names. Keep unresolved candidates
until evidence supports a decision.

## 4. Plan coverage preservation

Review decisions across groups for redundant layers and missing contracts.
Name the retained coverage for each contract, assertions to transfer, files to
retire, and support or production code that may become unnecessary.

Prefer the boundary that exposes the relevant failure with realistic inputs
and controlled dependencies. A broader integration test does not automatically
replace focused coverage of distinct edge cases or failure modes.

Proceed with removals only when each affected contract has a justified plan.

## 5. Apply coherent batches

Transfer needed assertions before removing their former suites. Coordinate
changes to shared fixtures and support files. Remove unnecessary production
seams only after checking supported callers and compatibility requirements.
Update existing CI routing, inventories, or size baselines when affected; do
not introduce new tracking machinery solely for the campaign.

Validate retained coverage for each coherent batch according to repository
policy. Record reusable ownership guidance only when it resolves a demonstrated
recurring ambiguity.

## 6. Review preservation

Compare removed coverage with retained suites to find contracts that lost their
only protection. Check repaired and transferred assertions for vacuous success,
unrelated failure causes, and unreachable paths. Use independent review when
the risk warrants it and the environment permits it; otherwise record the
review limitation.

For uncertain or restored coverage, use a focused negative control or deliberate
mutation to show that the test detects the intended regression. Perform this on
an isolated copy or preserve the exact starting state, then restore temporary
changes without overwriting concurrent work.

Resolve each material gap with restored coverage or evidence that the contract
is unsupported. Record any remaining uncertainty before claiming completion.

## 7. Handle discovered defects

Investigate baseline and new failures separately. They may reflect product bugs,
test defects, environment problems, or changed requirements. Do not delete a
valid test to hide a failure.

Repair product defects only within authorized scope; otherwise record actionable
follow-ups. For a repair, demonstrate a failing control and passing candidate
on the same harness when feasible, and state any reproduction limitation.

## 8. Reconcile and hand off

Follow the repository's integration policy. When the base changes, reassess
contracts added or modified since the baseline. Resolve conflicts by preserving
supported behavior and its coverage; do not automatically favor either a file
deletion or the incoming version.

Rerun affected validation on the integrated candidate, including the subsystem
suite when needed to support the completion claim. Report external or live
checks separately, with their authorization and availability limits. Ensure
review covers the complete changed scope even if a tool truncates its output.

Use the handoff in [SKILL.md](SKILL.md), adding:

- Reviewed scope, baseline revision, and unreviewed or unverified areas.
- Retired layers and retained coverage for their contracts.
- Preservation gaps, resolutions, and controls actually exercised.
- Discovered defects and their repair or follow-up status.
- Baseline and final size, if measured, separating production, tests, and support.
