# Agent Roles and Authority

## Operating modes

**Development Sprint is the default mode for tsEpistle.** It covers routine feature work, fixes, branches, pull requests, commits, and deployment to the maintained local tailnet.

**Enterprise Release is opt-in.** Activate it only after an explicit user or maintainer instruction such as `Activate Enterprise Release for <named release or compliance milestone>`. An unambiguous request to publish an official beta or production release or complete a named compliance certification is equivalent authorization. A request to deploy or ship a fix, use a canary, make a local commit, or respond to a security finding does not activate Enterprise Release. State the activated scope before beginning; return to Development Sprint when that milestone completes or is cancelled. Clarify an ambiguous production target rather than escalating automatically.

This mode section governs whether repository contribution, deployment, recovery, and attestation procedures apply. Runtime authorization, security boundaries, accounting integrity, and preservation of existing data remain mandatory in both modes.

## Development Sprint contract

- Design only the architecture and API behavior the current feature requires. Prefer existing patterns, small reversible changes, and stable interfaces. Do not add speculative abstractions, compatibility layers, compliance machinery, migration frameworks, or release documentation.
- Do not create immutable source/attestation (`S`/`A`) pairs, review-evidence documents, review records, attestation manifests, release tags, provenance records, or certification artifacts. Commit, build, and deploy the current tested feature revision. Ordinary revision/image identification and truthful check results are sufficient Sprint evidence.
- After a completed feature or fix, build and deploy only the affected application service to the maintained local tailnet, then exercise the changed behavior. Preserve PostgreSQL, data, configuration, secrets, keyrings, volumes, service identities, network, ports, and enabled capabilities. Do not recreate PostgreSQL or unrelated services.
- Require a full recovery point, broad writer drain, or restore rehearsal only for a destructive or irreversible migration or a material change to persistent state, storage layout, key handling, or writer compatibility. Preserve any unique writable-layer data before replacing its container. Normal feature-created rows do not trigger production recovery ceremony.
- Default verification is changed-path tests, applicable typechecks, a successful affected-service build, and one focused runtime smoke on the deployed application. For UI changes, exercise the affected flow. Expand only for relevant authentication, authorization, secrets/provider-egress, destructive-data, shared-infrastructure, concurrency/accounting, or external-interface risks. A health response alone is not behavioral proof.
- Inspect only governing instructions and the changed surface and dependencies. Reuse valid findings and checks. Avoid repeated planning, duplicated evidence, broad audits, and documentation that does not change a decision.
- Stop when the requested behavior and relevant checks pass, the tested revision is deployed locally, the focused smoke succeeds, and material residual risks are reported. An unresolved authorization, secret-exposure, data-loss, or accounting-corruption defect still blocks its affected deployment.

See `.github/CONTRIBUTING.md` for mode-scoped contribution checks and `docs/agents-deployment.md` for Sprint deployment and risk-selected recovery.

## Enterprise Release contract

Enterprise Release retains the repository's immutable source review, attestation, clean qualification, artifact provenance, publication, and comprehensive recovery procedures. Those procedures are prerequisites only for the explicitly named release or compliance milestone.

## Agent authority

- Main owns decomposition, routine implementation, sequencing, verification, deployment, and delivery within the active mode. Main may implement a bounded cohesive change directly.
- Delegate only when independent ownership enables real parallel progress or specialist review materially reduces risk. Several files alone do not require a mandatory planner/scout/reviewer/security-reviewer chain.
- When agents are used, give them exact ownership and shared interfaces. Implementation agents follow the approved contract; scouts gather evidence without deciding architecture; subagents must not spawn subagents.

<!-- graft:start -->
## Trail-Code — repo context graph

Install the CLI with `npm install -g @trailhq/trail-code`.

This repo is indexed in `graft/`: small linked markdown nodes that explain each
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
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- graft:end -->

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
