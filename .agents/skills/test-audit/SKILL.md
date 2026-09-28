---
name: test-audit
description: "Evaluate test value when writing, changing, reviewing, or auditing tests. Identify redundant or implementation-coupled coverage and unnecessary test-only production code."
---

# Test Audit

Protect useful coverage while reducing unnecessary maintenance. Optimize for
confidence, not deletion counts or line reduction.

Use the authoring gate for new or changed tests and the audit workflow for
existing coverage. Use [CAMPAIGN.md](CAMPAIGN.md) only for an explicitly scoped
subsystem-wide audit. Ordinary test edits do not require a campaign.

Follow applicable repository instructions for test tools, validation, review,
and delivery. This skill supplies evaluation criteria, not project commands
or permission to expand the task.

## Authoring gate

Before adding or materially changing a test, establish:

1. The observable behavior, invariant, or independent contract it protects.
2. A credible regression that would make it fail.
3. Why existing coverage would not catch that regression. Prefer extending an
   existing case when appropriate; another test layer needs a distinct risk.
4. Whether it requires an export, flag, wrapper, or injection hook solely for
   testing. Prefer an existing boundary; justify any added seam by the risk it
   makes testable and its maintenance cost.

Check the patterns below against the retention criteria. Prefer tests that
survive behavior-preserving refactoring. Implementation-sensitive assertions
need an independent contract, such as a required dependency direction.

For a bug regression, demonstrate failure for the intended reason before the
fix and success afterward when feasible. If the original failure cannot be
reproduced, report that limitation; a passing test alone does not prove the fix.
Avoid replaying the same regression at every layer without a distinct purpose.

## Low-value patterns

These patterns warrant investigation, not automatic rejection or deletion:

- Execution that proves neither an asserted outcome nor a meaningful implicit
  condition, such as completing without an unexpected exception.
- Self-comparisons or expected values computed by the code under test.
- Copied fixtures, inventories, manifests, or export lists that merely restate
  the implementation.
- Source-text, import, private-helper, or call-shape assertions without an
  independent contract.
- Repeated scenarios already covered at a more representative boundary.
- Tests that preserve unused production code or unnecessary test-only seams.
- Mocks that implement the behavior being asserted or conceal meaningful
  differences between dependencies.
- Fixtures that supply the result or ordering the production code must produce.
- Persistence assertions against a store the exercised path never writes.
- Capability checks that repeat declarations without exercising their promise.
- Negative cases that pass because of an unrelated guard or unreachable path.
- Names that promise behavior the inputs and assertions do not exercise.

## Retention criteria

Keep tests that independently protect supported behavior, a credible
regression, or an external or architectural contract. Examples include API,
protocol, configuration, storage, migration, security, packaging, and platform
requirements. Exact bytes, call order, or source structure may be contractual;
retain those checks when their precision is necessary and independently grounded.

Static, slow, private, or superficially duplicative tests are not automatically
low-value. Distinct failure boundaries can justify coverage at several layers.
A failing baseline test requires diagnosis, not deletion to obtain a pass.

## Audit workflow

Keep discovery read-only until candidates have supporting evidence. Inspect
complete candidate tests, including parameter cases, and the production code
that owns the claimed behavior. Trace relevant entry points, callers, shared
implementations, overlapping tests, CI routing, and history. Inspect dependency
contracts when a claim depends on them. Scale this work to the affected scope.

Before deleting or consolidating a candidate, record:

- Test name and location, and the failure it can detect.
- Remaining coverage for its contract, or evidence that no supported contract
  needs protection.
- Relevant callers and history, including external consumers where applicable.
- Production or support code made unnecessary, if any.
- Risk and focused validation to perform.

Prefer a few well-supported changes over a speculative inventory. Group edits
by the behavior they protect. Move needed assertions into retained coverage
before removing duplicates. Remove obsolete support code only after checking
its consumers and the repository's compatibility policy. Do not turn uncertain
findings into deletions or broaden the task into unrelated production repairs.

## Validation

Use the repository's documented runner and required checks. Validate a stable
candidate; do not edit files being exercised by a running check.

- Run focused tests for affected behavior and shared consumers.
- When replacing source inspection with behavioral coverage, exercise the
  executable contract before removing its former guard.
- Confirm repaired assertions can fail for the intended reason. Use a targeted
  negative control or mutation when needed; isolate temporary changes and
  restore them without overwriting other work.
- Run applicable formatting, diff, and review checks. Broaden validation when
  changed boundaries or observed failures justify it.

Record commands, results, baseline failures, and unavailable evidence. Do not
weaken gates or claim coverage from checks that did not run.

## Delivery and handoff

Follow the user's scope and repository delivery policy; do not assume a branch
name, pull request requirement, merge strategy, or external review service.
Refresh evidence if integration changes the tested behavior.

Report the changed scope, removed or consolidated categories, retained
contracts, production simplifications, validation results, limitations, and
follow-ups. For broad audits, distinguish production, test, and support-code
changes. Report commit, push, or review status only when applicable.
