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
- Consult the planner once before implementing a choice that introduces or materially changes architecture, establishes or changes a shared interface or ownership boundary, changes schema/persistence behavior or a trust boundary, or sets a design assumption shared by multiple workers. If unsure whether a choice crosses this boundary, consult rather than guess. The planner remains read-only; ordinary local implementation, sequencing, debugging, and verification choices stay with Main.
- Reconsult the planner only when evidence invalidates the approved architecture, changes a shared/persistent/security contract, or requires a scope tradeoff. Return implementation-local failures to the responsible agent or resolve them within the approved contract.
- Delegate only when independent ownership enables real parallel progress or specialist review materially reduces risk. Several files alone do not require a mandatory planner/scout/reviewer/security-reviewer chain.
- When agents are used, give them exact ownership and shared interfaces. Implementation agents follow the approved contract; scouts gather evidence without deciding architecture; subagents must not spawn subagents.

## Goal Budgets

- Set goal token budgets generously so budget pressure never narrows the requested work.
- Use an unlimited goal budget for open-ended work.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
