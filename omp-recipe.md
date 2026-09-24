# OMP Robust-Rapid Development Recipe

Configure OMP for fast, reliable development across small and very large projects. Keep **32-worker capacity**, actively decompose substantial implementation into concurrently runnable ownership units, and budget an integration pass for their combined result. Spend reasoning and verification where they reduce defects or rework. This is an evidence-based starting configuration, not a claim that one model/effort combination is optimal for every project.

**This recipe configures the harness; it does not authorize application changes, credential changes, dependency installation, OMP upgrades, commits, deployment, or remote Git operations.** Subsequent development follows the user's task authorization and the repository's active operating mode.

## 1. Inspect once; change only what is needed

- Identify the installed OMP version, effective settings, active configuration layers, discovered agents, and registered provider/model selectors. Reuse current evidence instead of repeatedly auditing the same configuration.
- Read applicable repository rules. Preserve user changes, unrelated settings, existing hard spending/time/request limits, and security/data-preservation boundaries.
- Verify keys and model effort levels against the installed schema/source or matching documentation. The mappings below were assessed against OMP 18.2.6 and the implementation routing against 18.3.0; another version must be checked for relevant differences.
- Before editing configuration, retain a recoverable copy of only the files being changed and record any newly created paths. No release records, attestation packages, or broad backup ceremony for ordinary configuration edits.
- Prefer the narrowest appropriate configuration scope. `omp config set` normally writes global settings; project settings and CLI/runtime overrides can take precedence. Never dump credentials into reports or backups with permissive access.
- Apply supported improvements independently. A missing optional agent or model should leave that assignment unchanged, not block unrelated work or trigger an unapproved substitution.

Useful read-only inspection commands:

```sh
omp --version
omp config path
omp config list --json
omp models find gpt-6 --json
omp models find gpt-5.6-sol --json
```

Inspect output privately and report only relevant, non-secret fields.

## 2. Use a strong coordinator and economical workers

Use exact provider-qualified selectors. The assessed installation registers the assigned models under **`openai-codex/`**, not `openai/` or `openrouter/`. Confirm availability and the resolved model; a catalog entry is not proof of successful inference or account billing.

| Function | Agent / routing | Starting model and effort | Use |
|---|---|---|---|
| Main | `modelRoles.default` | `openai-codex/gpt-6-sol:medium` | Own requirements, decomposition, integration, and delivery; implement small cohesive changes directly |
| Implementation | Existing `task`; `modelRoles.task` | `openai-codex/gpt-6-luna:max` | Decompose substantial work into bounded independent code-writing units, implement concurrently in isolated worktrees, and integrate the combined result |
| Architecture | Custom `planner` defined below; `modelRoles.plan` | `openai-codex/gpt-6-astra:high` | Material architecture, shared contracts, schema/data transitions, or trust-boundary decisions |
| Discovery | Existing `scout` | `openai-codex/gpt-6-luna:medium` | Unmapped subsystems, independent research, exact source/tool evidence |
| Mechanical work | Existing `sonic` | `openai-codex/gpt-6-luna:medium` | Substantial mechanical batches; run already-known commands directly without an extra agent |
| Debug escalation | Existing implementation owner; `modelRoles.slow` if used | `openai-codex/gpt-6-astra:low` | Semantic failures, contradictory evidence, or a concrete failed hypothesis requiring deeper reasoning |
| Test specialist | Optional `tester` | `openai-codex/gpt-5.6-sol:high` | Difficult behavioral test design or failure analysis; routine tests remain with the implementer |
| Documentation | Optional `docwriter` | `openai-codex/gpt-6-sol:low` | Large independent documentation work; small updates remain with the implementer |
| Independent review | Existing `reviewer` / `security-reviewer` | `openai-codex/gpt-6-sol:high` | Risk-selected correctness/security review; use `xhigh` for genuinely difficult high-risk changes |

These are starting assignments, not mandatory participants in every task. Implementation uses Luna at `max`; reserve `gpt-6-astra:low` for **Debug escalation**, not routine implementation or the optional tester. Raise other roles' effort when evidence warrants it; do not automatically run every reviewer at maximum effort. The optional tester's existing `gpt-5.6-sol:high` assignment is unchanged. Difficult semantic diagnosis can still require escalation despite Luna's maximum effort.

- Reuse bundled agents and intentionally maintained custom definitions. `planner` is **not bundled**: install the definition below on a fresh setup. Keep that name as the recipe's stable dispatch identifier; its description and instructions narrow it to architectural decisions, while Main owns ordinary planning. Do not also create an `architect` alias or force every project to maintain six custom agents.
- Keep routing centralized through `modelRoles` and quoted aliases such as `"@plan"`, referenced by agent frontmatter or `task.agentModelOverrides`. Model roles alone do not create agents or guarantee that bundled agents use those roles.
- Align agent thinking settings with the intended selector; remove conflicting effort overrides when intentionally changing that assignment. Verify actual resolution rather than assuming a role suffix wins every precedence layer.
- The assessed GPT-6 models and the retained optional tester model advertise `low`, `medium`, `high`, `xhigh`, and `max`; their lowest advertised level is `low`. Do not treat `off`, `none`, and `minimal` as interchangeable.
- Do not silently substitute unavailable models. Check startup/auth fallback, retry fallback, and prewalk handoffs as well as initial selection. Permit only explicitly approved fallback routes; if exact routing cannot be enforced, retain the working assignment and report the limitation.
- Preserve unrelated roles such as vision, commit, and tiny. A new advisor model is unnecessary when automatic advice is disabled.

For the current recipe assignments, merge these role and dispatch routes into the active scope; keep unrelated provider-qualified roles (commit, vision, tiny, smol, judge) and other user settings unless they conflict with the requested single-provider routing. An optional tester or docwriter is not installed merely by adding a model role.

```yaml
modelRoles:
  default: openai-codex/gpt-6-sol:medium
  task: openai-codex/gpt-6-luna:max
  plan: openai-codex/gpt-6-astra:high
  discovery: openai-codex/gpt-6-luna:medium
  slow: openai-codex/gpt-6-astra:low
  review: openai-codex/gpt-6-sol:high
task:
  agentModelOverrides:
    task: "@task"
    planner: "@plan"
    scout: "@discovery"
    sonic: "@discovery"
    reviewer: "@review"
    security-reviewer: "@review"
```

Preserve `task.agentAdvisor` and `task.agentPrewalk` opt-outs for all discovered agents. A bare provider/model override without its effort suffix is not equivalent to the intended review assignment. Do not invent a `tester` or `docwriter` alias in place of a missing agent.

### Reproducible custom `planner`

The earlier custom planner claimed all technical implementation, sequencing, and verification decisions, requested broad document reading, forced high effort, and disabled read summarization. Those defaults give a consultant too much authority and encourage duplicate planning. Replace that definition when applying this recipe: retain evidence-backed architectural decisions, but leave routine implementation and scheduling with Main. A rename to `architect` would describe the specialty more literally but provides no behavioral benefit and breaks existing dispatch/rule references; use one canonical name, `planner`, on both existing and fresh installations.

Install the complete file below at `<active agent directory>/agents/planner.md`; `omp config path` identifies the directory, normally `~/.omp/agent`. For a repository-only definition, use `.omp/agents/planner.md` instead. Choose one scope: a same-named project agent overrides the user agent. Preserve any project-specific restrictions when reconciling an existing definition.

````markdown
---
name: planner
description: Resolve a bounded architectural decision with source evidence; Main retains routine planning, implementation, and delivery.
model: "@plan"
tools:
  - read
  - grep
  - glob
  - web_search
advisor: false
prewalk: false
output:
  type: object
  additionalProperties: false
  required: [status, summary, artifacts, checks, blockers, decision, acceptance]
  properties:
    status:
      type: string
      enum: [COMPLETE, BLOCKED, FAILED]
    summary:
      type: string
      minLength: 1
    artifacts:
      type: array
      items:
        type: string
    checks:
      type: array
      items:
        type: string
      maxItems: 0
    blockers:
      type: array
      items:
        type: string
    decision:
      type: string
      minLength: 1
    acceptance:
      type: array
      items:
        type: string
---

You are a read-only architectural consultant for the specific decision Main
assigned. Resolve material architecture, shared interfaces, schema/data
transitions, trust boundaries, or conflicting ownership. You are not a second
coordinator, implementation owner, or mandatory approval gate for routine work.

Main retains the objective, decomposition, scheduling, implementation-local
choices, validation execution, integration, and delivery. Honor supplied
repository rules and the active operating mode; do not expand your authority.

Read the supplied constraints and relevant implementation before deciding.
Reuse current evidence; inspect only dependencies needed for this decision.
Follow source references beyond summaries when necessary for correctness.
Use web research only for missing external facts; never send private source
or secrets in queries. If required evidence needs execution or unavailable
tools, identify the exact gap for Main rather than inventing a result.

Choose the smallest sufficient design using existing project patterns.
State the selected contract, rationale, material tradeoff, invariants, and
any ownership/dependency boundary needed for safe parallel implementation.
Do not enumerate speculative alternatives, design unrelated future features,
produce a second project-wide work plan, or require release ceremony.

Decide technical choices within the assigned scope. Escalate only a genuine
user/product/risk tradeoff or missing prerequisite that available evidence
cannot resolve. Identify the exact blocked decision and what would unblock it.
Return one actionable recommendation; reconsultation is warranted only when
new evidence invalidates its assumptions or changes the material contract.

Do not edit files, run commands/builds/tests/formatters, manage processes,
spawn agents, or claim that proposed verification has executed. Request only
the behavioral checks that would expose a plausible failure of this design.

Return the declared structured result through the native yield mechanism.
Use artifacts for source path/line or document/URL references, not fabricated
patches. Keep checks empty: this role does not execute validation commands.
Put the chosen contract and any material tradeoff in decision; put proposed
observable checks in acceptance. COMPLETE means the consultation is complete,
not that the feature is implemented, tested, approved for release, or merged.
For BLOCKED/FAILED, explain the unresolved decision and populate blockers.
````

Merge the following routing into the chosen configuration scope; preserve other roles and agent overrides:

```yaml
modelRoles:
  plan: openai-codex/gpt-6-astra:high
task:
  agentModelOverrides:
    planner: "@plan"
  agentAdvisor:
    planner: "off"
  agentPrewalk:
    planner: "off"
```

There is deliberately no separate `thinking-level`, `read-summarize: false`, or `blocking: true` in the agent file: effort belongs to the role selector, structural summaries remain useful, and Main can continue independent work while the consultation runs. Verify runtime/per-invocation overrides before assuming the selector is effective. If the provider/model is unavailable, follow the no-silent-substitution rule rather than installing a broken route.

Dispatch with `agent: "planner"` and `schemaMode: "strict"`; omit invocation `outputSchema` to use the file's `output` schema. Supply one concrete decision, applicable repository rules, relevant source/evidence, constraints/non-goals, and the question blocking implementation. Main does the initial scoping and owns the work packets; do not delegate top-level orchestration to the planner. Resume dependent work when the decision is settled, not after an additional ceremonial approval pass.

The declared built-in tools omit shell, eval, writing, LSP mutation, and delegation. This is capability minimization, not a sandbox: inspect custom/MCP tools and effective permissions as described in section 5. Main can supply indexed/LSP evidence collected with tools the planner lacks; do not grant arbitrary execution merely to let a read-only consultant gather it.

## 3. Keep full concurrency; control ownership, not arbitrary fan-out

Use the following supported settings as a **targeted merge**, not a replacement for the existing configuration:

```yaml
task:
  maxConcurrency: 32
  maxRecursionDepth: 2
  batch: true
  enableLsp: true
  isolation:
    enabled: true
    apply: false
    merge: patch
advisor:
  enabled: false
lsp:
  enabled: true
```

### Scheduling

- Keep `task.maxConcurrency` at **32**. Do not lower it to 8 or another arbitrary ceiling, reserve idle slots by policy, or manufacture workers merely to fill capacity.
- Main owns a flat work queue and keeps up to 32 useful delegated workers active when independent work exists. Workers do not spawn or manage other workers. Depth 2 is a backstop, not an instruction to introduce nested delegation; preserve stricter repository restrictions.
- `task.maxConcurrency` is not a process-wide semaphore: task sessions have separate limits, workpools have per-pool limits, and eval `agent()` does not acquire the TaskTool semaphore. Main must account for all active workers across launch surfaces rather than multiplying capacity through nested sessions or extra pools.
- Before implementing a substantial task, identify independently writable ownership units, their shared contract, and the integration owner. Favor concurrent `task` implementers over serializing separable work merely to avoid an integration pass; keep small cohesive tasks inline and avoid contrived micro-slices.
- Dispatch independent ready packets together and keep the queue moving as prerequisites clear. Main integrates completed deltas against the evolving candidate, including an explicit cross-slice integration pass when interfaces or behavior meet; do not wait for unrelated workers to finish an entire phase.
- Parallelize by ownership and dependency, not file count alone. Disjoint files can still share an API, generated output, database, test fixture, or service. Decide shared interfaces before dispatch and give shared mutations one owner.

### Budgets and lifecycle

- Preserve existing request-budget and idle-TTL settings unless observed behavior justifies tuning. Do not impose a universal 50-request budget or shorten idle retention simply to appear economical.
- Keep `task.softRequestBudgetNotice` enabled when a request budget is active. The assessed default budget is 200; the default idle TTL is 420,000 ms. Idle TTL parks workers for later revival; it is not task expiry or deletion.
- A soft budget counts assistant requests per worker run, not commands, tokens, money, or total tree usage. At 1.5 times the effective budget OMP stops free-running work for a final yield, with five further requests of grace before hard abort if necessary. For a budget of 50, that means notice at 50, stop at 75, and hard abort at 80. Bundled agent ceilings may lower the effective budget.
- Preserve hard limits and report their scope. `task.maxRuntimeMs` is a per-worker wall-clock limit; zero disables it. Do not invent a global spending cap from a per-worker request setting.
- When a worker hits a limit, retain its evidence and partial patch, mark the assignment incomplete, and resolve the blocker or repartition remaining work. Do not bypass limits by repeatedly respawning the same failing assignment.

## 4. Isolate parallel writers without creating a merge bureaucracy

- Main can edit a bounded cohesive task inline in the normal checkout. For substantial implementation, first seek independent ownership units that can be coded concurrently; an eventual integration pass is a normal cost, not a reason to serialize all code writing.
- Every delegated write-enabled worker uses `isolated: true` and an explicit ownership scope. Read-only research does not need checkout isolation.
- `task.isolation.enabled` only enables the option; omitting `isolated: true` leaves the worker non-isolated. Verify the dispatch, not just the setting.
- OMP 18.3.0 names the isolated checkout a task worktree and captures its baseline/delta; the selected isolation backend may materialize it through copy-on-write, overlay, or a Git-worktree fallback. Require a separate isolated working tree for every code writer, but do not imply all backends are literally `git worktree add` or that checkout isolation is an OS security sandbox.
- Keep task auto-application disabled so completion order does not mutate Main's checkout unexpectedly. For an isolated eval `agent()` invocation, explicitly pass **`apply: false`** as well: its default is not governed by `task.isolation.apply`.
- Main is the integration owner. Accept worker deltas against their actual baseline, then apply compatible changes to the working candidate as dependencies become ready. Integrate shared interfaces and cross-slice behavior before combined validation. This local patch integration is not authorization to commit, merge a protected branch, push, or deploy.
- Use a dedicated integration workspace only when concurrent WIP, branch policy, or the change's risk benefits from it. Do not require a separate branch merely to collect disjoint patches.
- A base commit does not identify uncommitted user changes. Preserve the starting dirty state and identify the worker delta with its patch/artifact reference; never reset, force-overwrite, or discard unrelated work to make a patch apply.
- Resolve conflicts against current source and the agreed interface; do not blindly retry application. Revalidate affected behavior after integration. Successful worker checks do not establish correctness of combined changes.
- Isolation does not isolate external services, credentials, home directories, or network access. Never let parallel checks mutate shared production/development data unintentionally.

## 5. Keep worker context small, sufficient, and truthful

Use the installed agent-file format and actual tool names. **There is no `minimal-task` preset in the assessed version.** Retain the native system/tool guidance and use concise agent instructions instead of replacing the system prompt to simulate one.

Every packet contains:

- Objective and observable acceptance criteria.
- Owned paths/symbols, relevant baseline or candidate patch, and explicit non-goals.
- Shared interfaces, dependencies, and who owns integration or shared resources.
- Applicable repository rules, required tools/skills, and execution limits.
- Expected result shape and which checks the worker owns or must leave to Main.

Do not copy the full conversation. Pass bounded excerpts and artifact references with a recovery path to original source. Read complete relevant definitions when abbreviated output is insufficient; never edit unseen elisions.

**Explicitly carry applicable repository instructions.** In the assessed implementation, child dispatch filters `AGENTS.md` from inherited context files; other rules and skills follow separate inheritance paths. Do not assume either full instruction inheritance or complete context isolation.

Use indexed discovery and LSP where available. Re-ground edits and references after relevant changes; scout line numbers and signatures are navigation aids, not permanently valid snapshots. Use hash-anchored edits for existing files and the supported creation tool for new files. On mismatch, re-read; never bypass guards by overwriting the whole file.

### Tool access is not a path sandbox

- Give workers only the capabilities their assignments require. Keep planners, scouts, and reviewers non-writing by policy and tool selection.
- Agent frontmatter does not provide a native allowed-path filesystem sandbox. Coder/tester/docwriter path scopes are workflow constraints unless separately enforced.
- Inspect the effective tool surface, including custom/MCP tools. An ordinary `tools:` list does not guarantee a restricted SDK session or exclude all extension tools.
- Bash patterns govern Bash approval, not shells launched through eval. Eval, process-capable hub operations, mutating LSP actions, custom tools, and MCP can exceed a nominal read-only role.
- Headless workers use `yolo` approval mode. Explicit tool denies still apply; prompts cannot be answered headlessly and reject. Do not rely on the parent's interactive approval mode to confirm each worker operation.
- Where a real trust boundary requires hard restrictions, use verified restricted-tool admission and filesystem/process/network controls. Otherwise describe the boundary honestly as orchestration policy, not containment.

### Compact handoffs

Use a small, constraining `outputSchema` and per-invocation `schemaMode: "strict"` for delegated worker results. Agent frontmatter `output` can define the schema; do not assume it also enables strict mode. Use native `yield` when available.

Require only useful fields:

- `status`: `COMPLETE`, `BLOCKED`, or `FAILED`.
- `summary`: short factual outcome.
- `artifacts`: changed paths and retrievable patch/candidate/evidence references; empty when none.
- `checks`: actual commands with `PASSED`, `FAILED`, or `NOT_RUN`, exit code when executed, evidence, and reasons for skipped checks.
- `blockers`: unresolved issues; empty when none.

Add findings, interface decisions, or test details only when that role needs them. A reviewer adds `verdict`: `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED`, tied to the actual candidate and review scope. A completed review can request changes.

Reject schema-invalid results, but preserve evidence for recovery. Schema validity is not proof that a command ran, a patch is correct, or a task is complete; strict failure does not undo prior side effects. Verify relevant artifacts and acceptance evidence before accepting the work.

## 6. Execute the shortest sufficient development path

1. **Scope and decompose inline.** Main identifies the affected surface, governing mode, acceptance criteria, and independent implementation units. Keep small cohesive changes with Main; for substantial work, define shared interfaces and an integration owner before dispatch.
2. **Consult only at material decision points.** Use the custom planner defined in section 2 for architecture, shared-contract, schema/data, trust-boundary, or substantial ownership decisions. Reconsult only when evidence invalidates that decision, not for implementation-local failures.
3. **Implement concurrently where useful.** Dispatch independent code-writing units together in isolated worktrees; let implementers investigate and edit their own slices in one pass. Budget an integration pass rather than serializing separable slices to avoid one. Add scouts only for genuinely unmapped or separately useful research. Do not require a scout → coder → tester → docwriter chain.
4. **Keep the queue moving.** Dispatch ready work up to full capacity, integrate completed dependencies, and continue useful Main work. Do not poll agents or repeatedly request status when completion is delivered automatically.
5. **Debug from evidence.** The owner reproduces the failure, tests a concrete hypothesis, and changes course or escalates when it fails. Do not repeat the same attempt with more ceremony or a new agent name.
6. **Validate the candidate once per relevant boundary.** Workers do not run formatters, linters, builds, or test suites while a concurrent editing batch is in flight. Main owns combined validation after integration. Once an affected candidate is stable, an explicitly assigned focused check can run alongside unrelated work only when resources and ownership are independent.
7. **Match proof to behavior.** Use repository-defined checks, applicable typechecks/builds, and focused runtime smoke. Exercise UI changes on the actual surface and bugs through their failing scenario. Keep permanent tests for meaningful behavior, boundaries, concurrency, or plausible regressions—not wiring, wording, or ceremonial coverage.
8. **Review by risk.** Main checks every accepted change. Add independent reviewer/security-reviewer work when it materially reduces risk or repository policy requires it; no mandatory maximal-effort review for every edit. Re-review changed assumptions or affected scope after fixes, not unrelated unchanged work.
9. **Finish the real task.** Update existing docs/changelog only where the change or repository convention requires it; small updates stay with the implementer. Complete any mode-required deployment and changed-path smoke on the tested candidate, preserving data and unrelated services. Do not substitute health-only checks for behavioral proof.

Do not create permanent review records, elaborate handoff documents, release gates, or attestation artifacts unless the active repository mode explicitly requires them. User/maintainer authorization still governs commits, protected-branch merges, pushes, and deployment; do not ask again when that authorization is already clear.

Keep continuous advice disabled, including per-agent frontmatter and `task.agentAdvisor` opt-ins that could re-enable it. `advisor.syncBacklog: off` does not disable advice. There is no native phase-gated advisor mode in the assessed version: use an explicit bounded consultation only when it answers a question the planner or reviewer is not already answering.

Retain native shell execution and useful context maintenance. Not every external command runs in-process. Do not conflate larger-window opt-in, overflow model promotion, compaction, and source retrieval: preserve compaction, avoid unapproved model promotion, and retrieve enough source for correctness. Do not invent an `autoContextExpansion` key.

## 7. Activate with focused proof; tune from real work

- Validate only changed settings/agent definitions and confirm effective discovery, model/effort resolution, and override precedence. Successful startup alone is insufficient: invalid custom agents can be skipped and invalid model configuration can leave built-in models active.
- Reuse existing valid checks. For newly changed controls, exercise a small disposable fixture: a writer's isolated patch must not auto-apply; an invalid structured result must fail; explicit denied actions must stay denied through the exposed tool surface; relevant repository rules must reach the worker; disabled automatic advice must remain off. Test only the launch surfaces actually used, including eval when applicable. Keep fixture checks away from real credentials, services, and user WIP.
- Do not launch 32 paid agents just to prove a numeric setting, or run a benchmark campaign as an activation gate. Verify scheduler scope from the installed implementation and inspect actual fan-out as useful work exercises it.
- New task/eval dispatches reload persisted settings and rediscover agents, while runtime overrides remain authoritative. This is not a universal hot-reload guarantee. Start a fresh OMP session when needed to activate changed primary-session facilities; never invent `omp reload` or interrupt unrelated live work.
- If activation fails, restore only the recipe's changes from the retained copies and remove only its own newly created files. If another actor has edited a touched file since backup, reconcile the specific changes instead of blindly restoring over their work.
- Report changed files, effective routing/capacity, focused check results, limitations, and the recovery location/procedure in a short factual response. No standalone evidence document is required.

**Recovery:** original setup copies of `config.yml`, `agents/planner.md`, and `AGENTS.md` are in `~/.omp/recipe-backups/2026-09-20T02-22-47-807Z/`. Pre-routing-repair `config.yml` is in `~/.omp/recipe-backups/2026-09-24-routing/`; the pre-plan/review-adjustment copy is in `~/.omp/recipe-backups/2026-09-24-plan-review/`. The planner definition immediately before this schema validation is in `~/.omp/recipe-backups/2026-09-24-validation/planner.md`. Pre-Luna implementation copies of `config.yml`, `AGENTS.md`, and `omp-recipe.md` are in `~/.omp/recipe-backups/2026-09-24-luna-implementation/`. Restore only the affected file if routing fails, reconciling any intervening edits first.

During normal development, compare accepted-change quality, end-to-end latency, total model usage/cost, rework, conflicts, budget stops, and human interventions. Tune routing or effort when repeated evidence warrants it; change one policy dimension at a time when attribution matters. Keep **32-worker capacity** while improving packet sizing and scheduling. Optimize for reliable completed work per unit time and cost—not the fewest tokens, the most agents, or the most process steps.