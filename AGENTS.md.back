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
- Consult the planner once for a materially new or changed architecture, shared contract, schema/data transition, trust boundary, or substantial ownership conflict. The planner remains read-only and owns those material decisions, not every local technical choice.
- Reconsult the planner only when evidence invalidates the approved architecture, changes a shared/persistent/security contract, or requires a scope tradeoff. Return implementation-local failures to the responsible agent or resolve them within the approved contract.
- Delegate only when independent ownership enables real parallel progress or specialist review materially reduces risk. Several files alone do not require a mandatory planner/scout/reviewer/security-reviewer chain.
- When agents are used, give them exact ownership and shared interfaces. Implementation agents follow the approved contract; scouts gather evidence without deciding architecture; subagents must not spawn subagents.

## Goal Budgets

- Set goal token budgets generously so budget pressure never narrows the requested work.
- Use an unlimited goal budget for open-ended work.
