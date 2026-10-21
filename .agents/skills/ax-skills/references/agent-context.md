# AxAgent Context Tool Selection

Use this decision guide when choosing a context feature, distinguishing `contextMap` from `contextPolicy` or memory, or designing long-context agents. Select the tool, then use the exact implementation reference below; this is not a core-agent or runtime-code guide. Prefer a direct recommendation over tutorial prose. Source API snapshot: `@ax-llm/ax` 25.4.5.

## Select by Need and Scope

| Need | Context object | Scope | API | Implementation reference |
| --- | --- | --- | --- | --- |
| Many tasks over one large repository, document set, or dataset | Context map | Recurring corpus; persists across runs | `contextMap` | [RLM and context maps](references/agent-rlm.md) |
| One long run whose own history needs compaction | Trajectory compaction | This run only | `contextPolicy: { preset, budget }` | [RLM context policies](references/agent-rlm.md) |
| Evolve task strategy from examples or live feedback | Context playbook | A stage; offline evolution and online update | `agent.playbook(...)` | [Agent optimization](references/agent-optimize.md) and [playbooks](references/playbook.md) |
| Tune prompts, instructions, or demonstrations offline | Instruction text | A program; offline | `agent.optimize(...)` (GEPA) | [Agent optimization](references/agent-optimize.md) |
| Retrieve task-relevant facts or guides | Retrieval | One turn | `recall(...)` / skills | [Memory and runtime skills](references/agent-memory-skills.md) |

## Defaults

- Recurring corpus with many different questions: `contextMap`, a persistent orientation cache.
- One long multi-turn run under prompt pressure: `contextPolicy: { preset: 'checkpointed', budget: 'balanced' }`. Move to `lean` for very long runs with strong models; use `full` for short tasks or weak models.
- Evolving strategy: `agent.playbook(...)`, offline from examples or online from live feedback.
- Offline instruction/demo tuning: `agent.optimize(...)` (GEPA).
- On-demand facts: `recall(...)` for memories; `discover({ skills })` for runtime skill guides.
- One oversized input, such as a pasted document or large JSON value: normally do nothing. `autoUpgrade` is on by default and keeps the full value runtime-only with a prompt preview. Use `contextFields` for a specific inline policy or a large required non-string field; see [RLM input policies](references/agent-rlm.md).

## Boundaries and Anti-Patterns

- Do not use `contextMap` to compact a single run's history; use `contextPolicy`.
- Do not use `contextPolicy` to carry knowledge across runs; use `contextMap`.
- Do not hand-build a strategy playbook in the prompt; evolve it with `agent.playbook(...)`.
- Do not put the full corpus into every run's prompt; combine a context map with on-demand `recall(...)`.
- Runtime skills loaded with `discover({ skills })` are guides for the running agent, not this installable code-generation reference collection.

## Companion References

- [RLM](references/agent-rlm.md): `contextPolicy` presets, context maps, and runtime sessions.
- [Memory and runtime skills](references/agent-memory-skills.md): recall, memories, and dynamic guide loading.
- [Agent optimization](references/agent-optimize.md): GEPA via `agent.optimize(...)` and optimization hand-off for `agent.playbook(...)`; [playbooks](references/playbook.md) supplies the dedicated evolution/update contract.
- [Core agents](references/agent.md): agent construction and final/clarification protocols.
