# Agent Roles and Authority

## Operating modes

**Development Sprint is the default mode for tsEpistle.** It covers routine feature work, fixes, branches, pull requests, commits, and deployment to the maintained local tailnet.

**Enterprise Release is opt-in.** Activate it only on explicit user or maintainer instruction for a named release or compliance milestone; an unambiguous request to publish an official beta or production release or complete a named certification qualifies. Deploying or shipping a fix, canary use, a local commit, security response, or calling a beta consumer production does not activate it. State the activated scope before beginning; return to Development Sprint when it completes or is cancelled. Clarify ambiguous production targets rather than escalating automatically.

This mode section governs whether repository contribution, deployment, recovery, and attestation procedures apply. Runtime authorization, security boundaries, accounting integrity, and preservation of existing data remain mandatory in both modes.

## Read before acting

- Before implementation or verification, read [Development Sprint](.github/CONTRIBUTING.md#development-sprint) for scope, checks, CI, toolchain, evidence, and completion requirements.
- Before tracking, handoff, sync, or profile decisions, read [Beads project policy](.github/CONTRIBUTING.md#beads-project-policy).
- Before deployment or recovery, read the relevant procedure in [Agent deployment](docs/agents-deployment.md).
- Only for activated Enterprise Release, read [Enterprise Release — security review and attestation workflow](.github/CONTRIBUTING.md#enterprise-release--security-review-and-attestation-workflow) before release work.

## Agent authority

- Main owns decomposition, routine implementation, sequencing, verification, deployment, and delivery within the active mode. Main may implement a bounded cohesive change directly.
- Delegate only when independent ownership enables real parallel progress or specialist review materially reduces risk. Several files alone do not require a mandatory planner/scout/reviewer/security-reviewer chain.
- When agents are used, give them exact ownership and shared interfaces. Implementation agents follow the approved contract; scouts gather evidence without deciding architecture; subagents must not spawn subagents.

Git commits, pushes, and Dolt remote sync require explicit user authorization or explicit repository team-maintainer opt-in. Current no-commit/no-push instructions override opt-in. A deployment request, Sprint workflow, or Beads guidance grants no such permission.

Read the `URL`, `USER`, and `PASS` key-values from: `.agent-ready_login` to access the relevant container.

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->

## Beads bootstrap

Use `bd` for all project task tracking, not TodoWrite, TaskCreate, or Markdown TODO lists. Read the `beads` skill at `.agents/skills/beads/SKILL.md`, falling back to `~/.agents/skills/beads/SKILL.md`. Run `bd prime` when Beads context is missing or stale. Keep persistent project knowledge in Beads with `bd remember`, not `MEMORY.md` or ad hoc memory files.

<!-- resource-lifecycle:start -->
## Resource lifecycle and disk usage

Reuse compatible build trees, dependency caches, environments and development
containers without compromising isolation; avoid per-run clones and copies.
Treat per-run resources as disposable unless persistence is explicitly required.
Namespace or label owned containers, volumes, worktrees, browser profiles and
scratch; register cleanup before acquisition, clean up on success, failure and
interruption, and reconcile verified inactive leftovers on startup. Replacing
owned disposable containers must retire the old containers and anonymous volumes;
remove named volumes only with verified ownership and explicit disposable status.
Preserve active/shared services, persistent data, secrets, unique work and required
backups; never use broad host-wide pruning. Put large scratch on verified
disk-backed storage, not RAM-backed `/tmp`. Set size, age and count budgets for
caches, logs, captures and retained runs; keep compact evidence, bound concurrency,
verify cleanup and space afterward, and report intentional retention with its
purpose and expiry.
<!-- resource-lifecycle:end -->
