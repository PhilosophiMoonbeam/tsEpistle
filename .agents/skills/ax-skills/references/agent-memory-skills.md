# AxAgent Context Maps, Memory Retrieval, and Dynamic Skills

Source API snapshot: `@ax-llm/ax` 25.4.3. Use for `contextMap` / `AxAgentContextMap`, memory catalogs/search/recall, `inputs.memories`, memory carryover and preloading, skill catalogs/search/discovery/preloading, loaded/used IDs and observers, and `relevanceRanking`. For ordinary setup see [agent setup](references/agent.md); for execution and replay policy see [RLM runtime](references/agent-rlm.md); for callbacks/telemetry see [observability](references/agent-observability.md).

`contextMap` persists prompt-resident corpus orientation across successful runs; `contextPolicy` compresses within-run actor replay without deleting runtime state; memories are retrieved task context whose loaded collection resets each run. Loaded skills are system-prompt guides retained on the agent across runs. None is a substitute for the others.

## Retrieval Defaults and Stage Ownership

- Use `skillsCatalog` / `memoriesCatalog` for plain arrays, not host callbacks that merely scan them; built-in deterministic lexical search requires no host search callback. Use `onSkillsSearch` / `onMemoriesSearch` for vector DB, BM25, KV, or other external retrieval. Host callbacks take precedence over catalog search.
- `recall(...)` is available to distiller and executor with a callback or non-empty memory catalog. `discover({ skills })` is advertised to the executor with a callback or non-empty skill catalog; the Skills Search section records the source's additional distiller behavior. Do not call either API from the responder stage.
- Both return `void`; do not assign their results. Loaded content appears next turn. Batch all searches of each kind into one call per turn: never loop calls or wrap them in `Promise.all(...)`.
- Child agents inherit neither search callback; configure each agent explicitly. Use `recall(...)`, not shared fields, to deliver search results.
- `onLoadedMemories` / `onLoadedSkills` report retrieval, not evidence of actor reliance. `onUsedMemories` / `onUsedSkills` track the actor's declared reliance, not independent proof of use.

## Context Map

Use `contextMap` when repeated runs ask different questions over the same long context, document set, or repository. The map is prompt-resident orientation knowledge: structure, concepts, constants, parsing schema, reusable aggregate results, and concrete error patterns. It is not a task-specific answer cache.

Runnable example: [`src/examples/rlm-context-map-live.ts`](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-context-map-live.ts) demonstrates a provider-backed context-map update, `onUpdate` snapshot persistence, finite evolve, and frozen map reuse.

When `contextMap` is configured:

- Ax injects the current map into the distiller prompt.
- Ax updates the map once after each successful completed `forward(...)`.
- By default the map evolves forever. For a finite warmup, create the map with `{ infiniteEvolve: false, evolveSteps: N }`; after `N` successful updates it is still injected but no longer updated.
- Failed runs, aborts, and clarification requests do not update the map.
- Use `onUpdate` to persist `result.map.snapshot()` outside the agent.

```typescript
import { agent, AxAgentContextMap } from '@ax-llm/ax';

const map = new AxAgentContextMap(savedSnapshot, {
  maxChars: 4000,
  infiniteEvolve: false,
  evolveSteps: 10,
});

const myAgent = agent('context:string, query:string -> answer:string', {
  contextFields: ['context'],
  contextMap: {
    map,
    onUpdate: ({ map }) => saveSnapshot(map.snapshot()),
  },
});
```

Types:

```typescript
type AxAgentContextMapConfig = {
  map?: AxAgentContextMap | AxAgentContextMapSnapshot | string;
  onUpdate?: (result: AxAgentContextMapUpdateResult) => void | Promise<void>;
};

type AxAgentContextMapOptions = {
  maxChars?: number;
  infiniteEvolve?: boolean;
  evolveSteps?: number;
};
```

## Memory Search

Use `onMemoriesSearch` when the agent needs to pull task-relevant context such as user preferences, prior decisions, project facts, or past conversations from an external store (vector DB, BM25, KV). The actor decides what to load, when, and how much.

When `onMemoriesSearch` is set, the distiller and executor stages gain:

1. An `inputs.memories` field. In JS this is an array of `{ id, content }` entries the actor reads directly. In the prompt, the same entries render as markdown blocks with `ID: \`...\`` lines, matching the Loaded Skills ID style. Each `content` is opaque markdown; frontmatter is not parsed.
2. A `recall(searches: string[]): void` global the actor `await`s to load more entries. Recalled entries are appended to `inputs.memories` and visible from the next turn onward. `recall()` returns nothing.

The responder stage does not receive memories.

### Enabling

```typescript
import { agent } from '@ax-llm/ax';
import type { AxAgentMemoriesSearchFn } from '@ax-llm/ax';

const onMemoriesSearch: AxAgentMemoriesSearchFn = async (
  searches,
  alreadyLoaded
) => {
  // `searches` is the full array passed to recall(...). Batch your
  // store lookup in one round-trip.
  // `alreadyLoaded` is the current inputs.memories snapshot. Filter
  // against it to skip duplicates.
  const skip = new Set(alreadyLoaded.map((m) => m.id));
  const fresh = await myVectorDB.searchBatch(searches, { topK: 3 });
  return fresh.filter((m) => !skip.has(m.id));
};

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onMemoriesSearch,
});
```

Each memory result must be:

```typescript
type AxAgentMemoryResult = {
  id: string;
  content: string;
};
```

### Static catalog (no callback)

If the memory set fits in a plain array, skip the callback entirely: pass `memoriesCatalog` and Ax backs `recall(...)` with a built-in deterministic local search (idf-weighted token overlap over `id` + content; not regex, not embeddings). The `alreadyLoaded` contract is preserved — entries already on `inputs.memories` are excluded before ranking.

```typescript
const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  memoriesCatalog: [
    { id: 'deploy-window', content: 'Prod deploys only on Tuesday afternoons.' },
    { id: 'user-prefs', content: 'User prefers concise answers.' },
  ],
});
```

Rules:

- If both `memoriesCatalog` and `onMemoriesSearch` are set, the host callback handles all `recall(...)` searches; the catalog still powers the advisory `relevanceRanking` hint.
- Catalog content is NOT preloaded into the prompt; entries load only when recalled.
- The built-in search is lexical. For semantic retrieval over large stores, supply `onMemoriesSearch` instead.

### Preloading memories at forward time

To seed specific memories for one run (no recall round-trip), pass them as the `memories` input value. They render on `inputs.memories` from the first turn and merge with anything recalled later (deduped by `id`).

```typescript
await myAgent.forward(ai, {
  task: 'Plan the deploy',
  memories: [{ id: 'deploy-window', content: 'Prod deploys only on Tuesday afternoons.' }],
});
```

### Actor usage

```javascript
// Turn 1: kick off one batched lookup.
await recall(['user preferences', 'project constraints']);

// Turn 2+: matched entries are now visible on inputs.memories.
const prefs = inputs.memories.find((m) => m.id === 'user-prefs-v2');
```

Rules:

- Read `inputs.memories` on the next turn to see what landed.
- `recall()` invokes `onMemoriesSearch` with `(searches, alreadyLoaded)` and returns `void`.
- Results land on `inputs.memories` for subsequent turns and render in the prompt as:

```markdown
### Memory

ID: `mem:user-prefs-v2`

...
```

- Entries are deduped by `id` (last-write-wins) and sorted by `id` for prefix-cache stability.
- Memories loaded by the distiller thread automatically to the executor. No second `recall()` is needed for those entries.
- `recall()` may be called multiple times across turns; results accumulate for that run.
- `inputs.memories` lifetime is one `.forward()` call. It resets between calls.

## Carrying Memories Across `.forward()` Calls

To preserve continuity across calls, persist memories in your store and recall them again on the next call. If you want to replay anything loaded on a prior run, observe loads with `onLoadedMemories`.

```typescript
const carried = new Map<string, string>();

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onMemoriesSearch: async (searches) => {
    const fresh = await myVectorDB.searchBatch(searches, { topK: 3 });
    const carriedAsResults = [...carried.entries()].map(([id, content]) => ({
      id,
      content,
    }));
    return [...carriedAsResults, ...fresh];
  },
  onLoadedMemories: (results) => {
    for (const r of results) carried.set(r.id, r.content);
  },
});
```

## Skills Search

Use `onSkillsSearch` when the agent needs to load skill guides such as usage instructions, operational guides, or domain conventions into the executor's system prompt on demand. The actor decides which skills to fetch and when, so you do not pre-render every skill into every prompt.

Stage caveat: the source defaults describe skill discovery as executor-available, while this callback-specific contract explicitly includes the distiller and its carryover behavior. Preserve that distinction; do not infer skill discovery availability for a catalog-only distiller from the executor catalog rule.

When `onSkillsSearch` is set, the distiller and executor stages gain:

1. A "Loaded Skills" section in the system prompt that renders matched skill bodies with stable `ID:` values sorted by `id`.
2. A `discover({ skills })` path the actor `await`s to load more skills. Loaded entries appear in the next turn's prompt. `discover(...)` returns nothing.

Skills the distiller loads carry over to the executor automatically. The responder does not see skills.

### Enabling

```typescript
import { agent } from '@ax-llm/ax';
import type { AxAgentSkillsSearchFn } from '@ax-llm/ax';

// Each result is { id?: string; name: string; content: string }.
// If id is omitted, Ax falls back to name.
const onSkillsSearch: AxAgentSkillsSearchFn = async (searches) => {
  return mySkillStore.resolveBatch(searches, {
    // Recommended backend order: exact id, exact name, then broader search.
    // This lets the actor pass one simple string and keeps lookup policy host-side.
    strategy: ['id', 'name', 'search'],
    topK: 2,
  });
};

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  onSkillsSearch,
});
```

Each skill result is:

```typescript
type AxAgentSkillResult = {
  id?: string;
  name: string;
  content: string;
};
```

### Static catalog (no callback)

If the skill set fits in a plain array, skip the callback entirely: pass `skillsCatalog` and Ax backs `discover({ skills })` with a built-in deterministic local search (idf-weighted token overlap over `id` + `name`×2 + `description`×2 + the first 600 chars of `content`; not regex, not embeddings). The executor prompt also gains a static, cache-stable `### Available Skills` index (id + name + description, sorted by id), so the actor searches by known ids instead of guessing.

```typescript
import type { AxAgentCatalogSkill } from '@ax-llm/ax';

const catalog: AxAgentCatalogSkill[] = [
  {
    id: 'release-checklist',
    name: 'Release checklist',
    description: 'Steps for shipping a package release safely', // high-signal for matching
    content: '1. Bump version\n2. Run tests\n3. Tag and publish',
  },
];

const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  skillsCatalog: catalog,
});
```

```typescript
type AxAgentCatalogSkill = {
  id: string;
  name: string;
  description?: string;
  content: string;
};
```

Rules:

- If both `skillsCatalog` and `onSkillsSearch` are set, the host callback handles all `discover({ skills })` searches; the catalog still powers the `### Available Skills` index and the advisory `relevanceRanking` hint.
- Catalog content is NOT preloaded into the prompt (unlike `skills`); entries load only when matched. Use `skills` for guides that must always be in context, `skillsCatalog` for a larger set loaded on demand.
- The built-in search is lexical. For semantic retrieval over large stores, supply `onSkillsSearch` instead.

### Actor usage

```javascript
// Pass all skill queries in one call.
await discover({ skills: ['release-checklist', 'incident-response'] });

// Next turn: loaded skill bodies render under the "Loaded Skills"
// system-prompt section.
```

Rules:

- `discover({ skills })` invokes `onSkillsSearch` with the raw search strings and returns `void`.
- Resolve each raw string backend-side: prefer an exact `id` match, then an exact `name` match, then fuzzy/full-text search. The actor should not have to choose `id:` vs `name:` syntax.
- Matched skills land under "Loaded Skills" for the next turn.
- Entries are deduped by `id` (last-write-wins) and sorted by `id` for prefix-cache stability.
- If a skill result omits `id`, its trimmed `name` is used as the id for backwards compatibility.
- Skills persist on the agent's `currentSkillsPromptState` across `.forward()` calls, unlike memories.
- Use `agent.getState()` / `setState(...)` to serialize/restore loaded skills.
- `discover({ skills })` may be called multiple times across turns.

## Preloading Skills

If the caller already knows which skills are relevant, pass them up front instead of round-tripping through `discover({ skills })`.

- Init-time: `skills` on `AxAgentOptions` seeds the executor prompt at agent creation. They survive `setState(...)` resets.
- Forward-time: `skills` on `forward(ai, values, { skills })` merge in at the start of that call. Distiller and responder ignore forward-time skills.

Both accept the same shape `onSkillsSearch` returns: `readonly AxAgentSkillResult[]`. Forward-time skills override init-time skills by `id`. `onLoadedSkills` is not fired for preset skills; that callback is for runtime `discover({ skills })` analytics.

```typescript
const releaseAgent = agent('task:string -> answer:string', {
  contextFields: [],
  skills: [
    {
      id: 'release-checklist',
      name: 'release-checklist',
      content: '...',
    },
  ],
});

await releaseAgent.forward(
  ai,
  { task: 'Prepare release notes' },
  {
    skills: [
      {
        id: 'incident-response',
        name: 'incident-response',
        content: '...',
      },
    ],
  }
);
```

You can use `skills` without setting `onSkillsSearch` at all. That is useful for static guides where the actor never needs to fetch more. Without `onSkillsSearch` or a `skillsCatalog` the executor prompt shows the loaded guides but doesn't advertise `discover({ skills })`, because the runtime has no skills search to back it.

## Advisory Relevance Hints (`relevanceRanking`)

`relevanceRanking` is ON by default — leave it unset; set `relevanceRanking: false` to opt out. The default was flipped after its A/B gate passed (substance-judged, 49 runs per variant per model: small-model first-lookup precision 24%→90% and answer accuracy 14%→29%; frontier-model control accuracy 63%→88% with fewer turns). The generated language ports implement the same advisory hint contract through AxIR Core.

When enabled, a deterministic local ranker scores the agent's discoverable capabilities against the task once per `forward(...)` and injects a short advisory `### Likely Relevant` shortlist into the executor turn — modules (needs `functionDiscovery`), catalog skills (needs `skillsCatalog`), and catalog memories (needs `memoriesCatalog`). The hint is non-authoritative: the full lists still apply and the actor may `discover`/`recall` anything else.

```typescript
const myAgent = agent('task:string -> answer:string', {
  contextFields: [],
  functionDiscovery: true,
  skillsCatalog: catalog,
  relevanceRanking: true, // or { topK: 3, minScore: 0.08 }
});
```

Rules:

- Default is ON across TypeScript and generated language ports; domains still self-gate on their prerequisites (`functionDiscovery` for modules, catalogs for skills/memories), so agents without those see no change. Everything else in this skill (catalog search, the Available Skills index) is independent of the flag.
- The shortlist rides a dynamic, non-cached prompt field; the cached system prompt stays byte-stable across tasks.
- On low confidence the ranker emits nothing rather than guessing.
- Memory hint entries include an ~80-char content snippet; very short memories may be usable from the hint alone without a `recall(...)` (such use is not visible to `onUsedMemories`).
- Observe outcomes via the `relevance_ranking` context event (see [observability](references/agent-observability.md)).

## Loaded And Used Tracking

`onLoadedMemories` reports what `recall(...)` loaded. `onLoadedSkills` reports what `discover({ skills })` loaded. To track what the actor says it actually relied on, use `onUsedMemories` / `onUsedSkills`.

```typescript
const used: AxAgentUsedMemory[] = [];

await myAgent.forward(
  ai,
  { task: 'Make a personal plan' },
  {
    onUsedMemories: (items) => used.push(...items),
  }
);

used; // [{ id, reason, stage }]
```

Rules:

- The actor can only report memory IDs already present in `inputs.memories`.
- The actor can only report skill IDs already present in Loaded Skills.
- Unknown values are dropped.
- When tracking is enabled, the actor sees `await used(id, reason?)`; this is the actor-side declaration mechanism.
- `used(...)` resolves against loaded memory IDs and loaded skill IDs.
- If memory IDs and skill IDs can collide, namespace them in your application, for example `mem:abc` and `skill:planning`.
- Python, Go, and Java accept these observers directly in their agent option maps. C++ wraps them with `register_agent_observer(...)`; Rust wraps them with `agent_observer(...)`. The returned marker can be used in constructor or forward option maps, and observer failures are ignored in every language.

Types:

```typescript
onMemoriesSearch?: AxAgentMemoriesSearchFn;
onLoadedMemories?: (
  results: readonly AxAgentMemoryResult[]
) => void | Promise<void>;
onUsedMemories?: (
  usedMemories: readonly AxAgentUsedMemory[]
) => void | Promise<void>;

onSkillsSearch?: AxAgentSkillsSearchFn;
onLoadedSkills?: (
  results: readonly AxAgentSkillResult[]
) => void | Promise<void>;
onUsedSkills?: (
  usedSkills: readonly AxAgentUsedSkill[]
) => void | Promise<void>;

contextMap?: AxAgentContextMapConfig;
skills?: readonly AxAgentSkillResult[];
skillsCatalog?: readonly AxAgentCatalogSkill[];
memoriesCatalog?: readonly AxAgentMemoryResult[];
relevanceRanking?: boolean | { topK?: number; minScore?: number };
```

## Persisting Agent State Across Languages

TypeScript uses `getState()` / `setState()` for the actor runtime snapshot. The generated packages keep their legacy `GetState` / `SetState` (or language-shaped equivalents) as bare-runtime compatibility methods. Use `ExportRuntimeState` / `RestoreRuntimeState` in generated packages when you need the complete portable agent snapshot, including loaded skills and constructor-preset reapplication after restore. Do not interchange the two snapshot shapes.

## Examples

Full working examples:

- [RLM Memories and Skills](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/rlm-memories-and-skills.ts) - `onMemoriesSearch` + `recall()` and `onSkillsSearch` + `discover({ skills })` with load observability and actual usage tracking via `onUsedMemories` / `onUsedSkills`
- [Skills + Memory Ops Assistant](https://raw.githubusercontent.com/ax-llm/ax/refs/heads/main/src/examples/typescript/long-agents/skills-and-memory-assistant.ts) - an on-call assistant that recalls past decisions from a memory store and loads the right runbook skill on demand (also ported to Python, Go, Rust, Java, and C++ under `src/examples/<lang>/long-agents/`). All six languages support the native `onMemoriesSearch` / `onSkillsSearch` host callbacks, passed in the agent options at construction (Go/Java use native function values, Rust a `agent_with_search_callbacks` constructor, C++ a `register_*_search` helper); a static `memory_search_results` / `skill_search_results` config is also available.
