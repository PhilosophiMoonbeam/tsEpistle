# OMP Self-Reconfiguration Recipe

Configure a tiered multi-agent workflow. Preserve existing repository rules and user changes. Apply only settings supported by the installed OMP version.

## 1. Inspect and back up

1. Identify the OMP version, active configuration paths, agent discovery paths, available tools, model registry, and supported reasoning levels.
2. Read the effective configuration and applicable `AGENTS.md` files.
3. Back up each file before changing it. Record files created during this operation.
4. Treat the supplied model identifiers, configuration keys, and runtime claims as **unverified**. Check them against installed schemas, source code, or matching official documentation.
5. Do not install dependencies, change credentials, upgrade OMP, or modify application code.

## 2. Set model assignments

Use these assignments **only if the provider exposes the specified models and effort levels**:

| Role | Model | Effort | Scope |
|---|---|---|---|
| Primary / coder | `openai/gpt-5.6-sol` | `medium` | Implementation and refactoring |
| Architect | `openai/gpt-6-astra` | `low` | Planning, dependencies, interfaces |
| Scout | `openai/gpt-5.6-luna` | `low` | File discovery and symbol inspection |
| Mechanical runner | `openai/gpt-5.6-luna` | Lowest supported | Tests and approved Git commands |
| Tester | `openai/gpt-5.6-luna` | `high` | Test design and failure analysis |
| Debug escalation | `openai/gpt-5.6-sol` | `high` | Unresolved semantic defects |
| Docwriter | `openai/gpt-5.6-terra` | `low` | Specifications and documentation |
| Reviewer | `openai/gpt-6-astra` | `xhigh` | Final correctness and security review |
| Advisor | `openai/gpt-5.6-terra` | `low` | Milestone consultation |
| Subagent advisor | `openai/gpt-5.6-luna` | `low` | Bounded worker consultation |

Do not assume `off` and `none` are interchangeable. Do not substitute unavailable models without approval. Preserve the working configuration for any blocked assignment.

## 3. Apply runtime controls

Use verified native settings. Where a setting does not exist, enforce the rule through orchestration if possible and report the limitation.

- Limit concurrent workers to **8**, or a lower existing limit.
- Limit delegation depth to **2**.
- Set idle-worker expiry to **300,000 ms**, if supported.
- Set the soft request budget to **50**, with wrap-up notices.
- Preserve existing hard spending, time, and request limits. A soft budget is not a hard cap.
- Give each write-enabled task an isolated Git worktree. Parallel writers must have separate worktrees and non-overlapping assignments.
- Use `minimal-task` for scout, coder, tester, and docwriter. Explicitly include applicable repository rules.
- Use the default preset for architect and reviewer.
- Require strict structured output from every worker, including tester.
- Disable continuous advisor execution. Consult at planning completion, major structural changes, and final review, as needed.
- If phase-gated advisor mode is unavailable, disable automatic advice and use explicit bounded consultations.
- Enable supported LSP diagnostics and rename support. Check resulting edits; do not assume symbol or file renames update all references.
- Use the native shell when available. Do not assume external commands execute in-process.
- Disable automatic context expansion if supported. Pass bounded excerpts and compact results instead of full transcripts.

## 4. Create or update six agents

Use the installed agent-file format, valid YAML frontmatter, and actual tool names. Preserve unrelated agent settings.

| Agent | Permissions | Required result |
|---|---|---|
| `architect` | Read and search | Scope, dependencies, interfaces, ordered work packets, acceptance checks |
| `scout` | Read and search only | File paths, line ranges, exact signatures, call sites, dependencies |
| `coder` | Scoped file creation/editing and approved checks | Changed files, patch reference, diagnostics, check results |
| `tester` | Test-file edits, test commands, available debugger | Tests changed, commands, exit codes, failures, escalation reason |
| `docwriter` | Read access; writes limited to approved documentation paths | Updated paths and change summary |
| `reviewer` | Read/search and approved validation commands; no source edits | Reviewed revision, verdict, blocking findings, verification limits |

Apply these common rules:

- Work only within the assigned scope.
- Read bounded file ranges. Expand context only when necessary.
- Use hash-anchored edits where supported. On an anchor mismatch, re-read and retry. Never force an overwrite.
- Use an approved creation tool for new files. Do not replace existing files to bypass edit checks.
- Restrict shell commands separately. Shell access is not read-only enforcement.
- Run repository-defined checks. Do not assume Bun or OMP-specific package paths apply.
- Distinguish pre-existing diagnostics from new failures. Report unresolved failures.
- Do not create commits, merge, or push without authorization.
- Do not let docwriter edit source files for inline documentation unless explicitly authorized.
- Follow the repository’s documentation and changelog conventions.

## 5. Define structured handoffs

Use the installed equivalent of `outputSchema` and strict schema validation. Use `yield` only if the runtime provides it.

Every result must contain:

- `status`: `COMPLETE`, `BLOCKED`, or `FAILED`
- `summary`: short factual result
- `artifacts`: file paths and patch or revision references
- `checks`: commands, exit codes, and evidence locations
- `blockers`: unresolved issues

Add the role-specific fields listed above. Reject invalid payloads.

Every work packet must specify the objective, base revision, allowed paths, dependencies, acceptance checks, and execution limits.

The reviewer must return `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED`. Approval requires no unresolved blocking findings. An LLM review is not formal verification.

## 6. Enforce the workflow

1. Architect creates bounded work packets.
2. Scouts inspect independent areas in parallel.
3. Coders implement independent packets in isolated worktrees.
4. Testers add behavioral tests and run applicable checks.
5. Escalate unresolved semantic debugging to Sol. Stop and report when execution limits are reached.
6. Integrate worker changes into an isolated integration branch or worktree.
7. Run checks on the combined changes.
8. Update documentation.
9. Reviewer evaluates the final combined revision against the original requirements and check results.
10. Permit merge only after `APPROVED`, passing required checks, and explicit merge authorization. Any subsequent change invalidates the approval.

## 7. Validate and activate

1. Validate configuration syntax and supported keys.
2. Confirm agent discovery, model resolution, and reasoning settings.
3. Run minimal smoke tests for tool restrictions, worktree isolation, structured output, and advisor behavior.
4. Check that workers receive applicable repository rules without inheriting full conversation history.
5. Reload OMP using its supported procedure.
6. If validation or activation fails, restore changed files from backup and remove only files created by this operation.

Return a short report containing:

- Files changed
- Effective model assignments and limits
- Validation results
- Unsupported or blocked requirements
- Backup location and rollback command or procedure