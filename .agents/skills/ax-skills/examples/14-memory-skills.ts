import assert from 'node:assert/strict';
import { agent, AxJSRuntime, f, fn, type AxChatResponse, type AxAgentActorTurnCallback, type AxAgentMemoryResult, type AxAgentSkillResult } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const code = (javascriptCode: string): AxChatResponse => ({ results: [{ index: 0, content: JSON.stringify({ javascriptCode }), finishReason: 'stop' }] });
const answer = (value: string): AxChatResponse => ({ results: [{ index: 0, content: `Answer: ${value}`, finishReason: 'stop' }] });
const planTool = (plans: string[]) => fn('plan').namespace('ops')
  .description('Create an in-memory deployment proposal, never deploy production')
  .arg('window', f.string('Permitted deployment window'))
  .returns(f.string('Recorded proposal'))
  .handler(({ window }) => { const proposal = `Proposed deployment: ${window}`; plans.push(proposal); return proposal; }).build();

export const examples: readonly Example[] = [
  {
    id: '14-memory-skills/catalog-recall-discover',
    title: 'Retrieve a deployment constraint and load its runbook on the executor',
    features: ['memoriesCatalog lexical search', 'skillsCatalog lexical search', 'recall', 'discover skills', 'relevanceRanking', 'loaded/used IDs', 'distiller to executor memories'],
    modes: ['offline'],
    async run(ctx) {
      const plans: string[] = [];
      const loadedMemories: string[] = [], loadedSkills: string[] = [], usedMemories: string[] = [], usedSkills: string[] = [];
      const ranked: string[] = [];
      const memoryObservations: { stage: string; hostLoaded: boolean; workerLoaded: boolean }[] = [];
      const observeMemory: AxAgentActorTurnCallback = turn => {
        const present = /worker-memory-present=(true|false)/.exec(turn.output)?.[1];
        if (present !== undefined) memoryObservations.push({ stage: turn.stage, hostLoaded: loadedMemories.includes('mem:deploy-window'), workerLoaded: present === 'true' });
      };
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 5, directResponse: 'off', functions: [planTool(plans)],
        // Top-level actor callbacks observe the executor; distiller control uses its actual model request below.
        actorTurnCallback: observeMemory,
        memoriesCatalog: [
          { id: 'mem:deploy-window', content: 'Deployment window: Tuesday 14:00 UTC.' },
          { id: 'mem:lunch', content: 'Catering orders close at noon.' },
        ],
        skillsCatalog: [
          { id: 'skill:deployment', name: 'Deployment runbook', description: 'Plan a deployment using the permitted deployment window', content: 'Read the deployment-window memory. Call ops.plan with its permitted window. Report the proposal, not a completed production deployment.' },
          { id: 'skill:catering', name: 'Catering guide', content: 'Order lunch before noon.' },
        ],
        onLoadedMemories: items => { loadedMemories.push(...items.map(item => item.id)); },
        onLoadedSkills: items => { loadedSkills.push(...items.map(item => item.id ?? item.name)); },
        onUsedMemories: items => { usedMemories.push(...items.map(item => item.id)); },
        onUsedSkills: items => { usedSkills.push(...items.map(item => item.id)); },
        onContextEvent: event => { if (event.kind === 'relevance_ranking') ranked.push(event.domain); },
      });
      const prompts: string[] = [];
      const responses = [
        code('await recall(["deployment window"])'),
        // 25.4.9 updates the host/prompt snapshot, but not this stage's worker inputs.
        // Keep this control visible rather than silently treating recalled content as worker-resident.
        code('console.log("worker-memory-present=" + inputs.memories.some(item => item.id === "mem:deploy-window"))'),
        code('await final("Create a proposal using the recalled deployment-window memory and deployment runbook", { proposalOnly: true })'),
        // The executor phase receives the host's loaded memories at handoff.
        code('console.log("worker-memory-present=" + inputs.memories.some(item => item.id === "mem:deploy-window")); await discover({ skills: ["skill:deployment"] })'),
        code('const windowMemory = inputs.memories.find(item => item.id === "mem:deploy-window"); if (!windowMemory) throw new Error("missing recalled window at executor handoff"); await used("mem:deploy-window", "authoritative permitted window"); await used("skill:deployment", "proposal-only safety rule"); await used("unknown-id", "must be ignored"); const proposal = await ops.plan({ window: windowMemory.content }); console.log(proposal)'),
        code('await final("Report the proposal without claiming a deployment happened", { proposal })'),
        answer('Proposed deployment: Tuesday 14:00 UTC; no deployment was executed.'),
      ];
      const model = scriptedAI((request, index) => {
        const prompt = JSON.stringify(request.chatPrompt);
        prompts.push(prompt);
        if (index === 2) {
          const present = /worker-memory-present=(true|false)/.exec(prompt)?.[1];
          assert.ok(present, 'the distiller action log must report its actual worker-memory observation');
          memoryObservations.push({ stage: 'distiller', hostLoaded: loadedMemories.includes('mem:deploy-window'), workerLoaded: present === 'true' });
        }
        const response = responses[index]; assert.ok(response, 'finite fixture exhausted'); return response;
      }, { structuredOutputs: true });
      try {
      const result = await worker.forward(model, { task: 'Plan a deployment within the deployment window using the deployment runbook.' }, options(ctx));
      assert.equal(plans.length, 1); assert.match(plans[0] ?? '', /Tuesday/);
      assert.ok(loadedMemories.includes('mem:deploy-window'));
      assert.ok(loadedSkills.includes('skill:deployment'));
      assert.deepEqual(usedMemories, ['mem:deploy-window']); assert.deepEqual(usedSkills, ['skill:deployment']);
      assert.ok(ranked.includes('skills') && ranked.includes('memories'));
      assert.deepEqual(memoryObservations, [
        { stage: 'distiller', hostLoaded: true, workerLoaded: false },
        { stage: 'executor', hostLoaded: true, workerLoaded: true },
      ], '25.4.9 host-loaded memory reaches the executor worker at the phase boundary');
      assert.match(prompts[1] ?? '', /Deployment window: Tuesday 14:00 UTC/);
      assert.doesNotMatch(prompts[3] ?? '', /Report the proposal, not a completed production deployment/);
      assert.match(prompts[4] ?? '', /Report the proposal, not a completed production deployment/);
      assert.ok(worker.getState()?.skillsPromptState?.loaded?.some(item => item.id === 'skill:deployment'));
      assert.match(result.answer, /Tuesday/);
      return { answer: result.answer, loadedMemories, loadedSkills, usedMemories, usedSkills, ranked, memoryObservations, boundary: '25.4.9 recall updates host/prompt memories before same-stage worker inputs; executor handoff synchronizes them', proof: 'real deterministic lexical retrieval and runtime callback paths; scripted reliance declarations are not independent proof of reasoning' };
      } finally { worker.stop(); }
    },
  },
  {
    id: '14-memory-skills/scoped-carryover-and-preloading',
    title: 'Own tenant/conversation retrieval, memory carryover, and serialized skill lifetime',
    features: ['onMemoriesSearch', 'onSkillsSearch', 'callback precedence', 'preloaded memories', 'init and forward skills', 'getState/setState skills', 'memory reset', 'tenant/conversation scope', 'stable IDs'],
    modes: ['offline'],
    async run(ctx) {
      const scope = 'tenant:alpha/conversation:42';
      const records = new Map<string, readonly AxAgentMemoryResult[]>([
        [scope, [{ id: 'mem:alpha-42-window', content: 'Tuesday 14:00 UTC' }]],
        ['tenant:beta/conversation:42', [{ id: 'mem:beta-42-window', content: 'Friday 09:00 UTC' }]],
      ]);
      const carry = new Map<string, Map<string, AxAgentMemoryResult>>();
      const plans: string[] = [], lookups: string[][] = [], skillLoads: string[] = [];
      const runbook: AxAgentSkillResult = { id: 'skill:deployment', name: 'Deployment', content: 'Only create an ops.plan proposal; never claim production deployment.' };
      const makeWorker = (key: string) => agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 4, directResponse: 'off', functions: [planTool(plans)],
        skills: [{ id: 'skill:privacy', name: 'Privacy', content: 'Keep tenant identifiers out of the user-facing proposal.' }],
        // Host filtering, not prompt instructions, is the isolation boundary.
        memoriesCatalog: [{ id: 'mem:wrong-catalog', content: 'MUST NOT LOAD: catalog loses to host callback' }],
        onMemoriesSearch: async (searches, alreadyLoaded) => {
          lookups.push([...searches]);
          const skip = new Set(alreadyLoaded.map(item => item.id));
          return (records.get(key) ?? []).filter(item => !skip.has(item.id));
        },
        onLoadedMemories: items => {
          const owned = carry.get(key) ?? new Map<string, AxAgentMemoryResult>();
          for (const item of items) owned.set(item.id, item);
          carry.set(key, owned);
        },
        onSkillsSearch: async searches => searches.includes('skill:deployment') ? [runbook] : [],
        onLoadedSkills: items => { skillLoads.push(...items.map(item => item.id ?? item.name)); },
      });
      const first = makeWorker(scope);
      const workers = [first];
      try {
      const firstModel = scriptedAI([
        // Callback-backed discovery is explicitly supported on the distiller; loaded skills carry to executor.
        code('await recall(["deployment window"]); await discover({ skills: ["skill:deployment"] })'),
        code('await final("Use the scoped recalled memory to record a proposal for this conversation", { proposalOnly: true })'),
        code('if (inputs.memories.some(item => item.id.includes("beta"))) throw new Error("tenant leak after handoff"); const window = inputs.memories.find(item => item.id === "mem:alpha-42-window").content; const proposal = await ops.plan({ window }); console.log(proposal)'),
        code('await final("Report proposal", { proposal })'), answer('Proposed Tuesday 14:00 UTC'),
      ], { structuredOutputs: true });
      await first.forward(firstModel, { task: 'Plan the scoped deployment.', memories: [{ id: 'mem:request', content: 'This request is proposal-only.' }] }, { ...options(ctx), skills: [{ id: 'skill:privacy', name: 'Privacy', content: 'Only output the deployment window, never tenant or conversation IDs.' }] });
      const state = first.getState(); assert.ok(state);
      assert.ok(state.skillsPromptState?.loaded?.some(item => item.id === 'skill:deployment'));
      assert.deepEqual(skillLoads, ['skill:deployment'], 'preset skills must not fire dynamic load analytics');
      assert.equal(lookups.length, 1);
      // Application persists only the intended snapshot in this isolated demo. Real stores must enforce ACLs.
      const restored = makeWorker(scope); workers.push(restored); restored.setState(JSON.parse(JSON.stringify(state)));
      let resetPrompt = '';
      const resetResponses = [
        code('if (inputs.memories.length !== 0) throw new Error("memories leaked across calls"); await final("Inspect empty per-run memories", { empty: true })'),
        code('console.log("loaded skill retained, memories reset")'),
        code('await final("Confirm memory reset", { empty: true })'), answer('Memories reset'),
      ];
      await restored.forward(scriptedAI((request, index) => { if (index === 1) resetPrompt = JSON.stringify(request.chatPrompt); const response = resetResponses[index]; assert.ok(response); return response; }, { structuredOutputs: true }), { task: 'Inspect memory lifetime, do not retrieve.' }, options(ctx));
      assert.match(resetPrompt, /Only create an ops.plan proposal/);
      assert.equal(lookups.length, 1, 'restoring skill state must not implicitly recall memories');
      const carried = [...(carry.get(scope)?.values() ?? [])];
      assert.deepEqual(carried.map(item => item.id), ['mem:alpha-42-window']);
      const replay = scriptedAI([
        code('if (inputs.memories.some(item => item.id.includes("beta"))) throw new Error("tenant leak"); await final("Create another scoped proposal", { windows: inputs.memories })'),
        code('const nextProposal = await ops.plan({ window: inputs.memories.find(item => item.id === "mem:alpha-42-window").content }); console.log(nextProposal)'),
        code('await final("Report proposal", { nextProposal })'), answer('Proposed Tuesday 14:00 UTC'),
      ], { structuredOutputs: true });
      await restored.forward(replay, { task: 'Use the application-carried memory without a search.', memories: carried }, options(ctx));
      assert.equal(lookups.length, 1); assert.equal(plans.length, 2);
      assert.ok(plans.every(item => item.includes('Tuesday') && !item.includes('Friday')));
      const betaScope = 'tenant:beta/conversation:42';
      const beta = makeWorker(betaScope); workers.push(beta);
      await beta.forward(scriptedAI([
        code('await recall(["deployment window"])'),
        code('await final("Create this tenant proposal using its recalled memory", { proposalOnly: true })'),
        code('if (inputs.memories.some(item => item.id.includes("alpha"))) throw new Error("cross-tenant memory leak after handoff"); const proposal = await ops.plan({ window: inputs.memories.find(item => item.id === "mem:beta-42-window").content }); console.log(proposal)'),
        code('await final("Report this tenant proposal", { proposal })'), answer('Proposed Friday 09:00 UTC'),
      ], { structuredOutputs: true }), { task: 'Plan the beta conversation deployment.' }, options(ctx));
      assert.equal(lookups.length, 2);
      assert.match(plans[2] ?? '', /Friday/);
      assert.deepEqual([...(carry.get(betaScope)?.keys() ?? [])], ['mem:beta-42-window']);
      return { scope, lookups: lookups.length, proposals: plans, carriedIDs: carried.map(item => item.id), restoredSkills: skillLoads, memoryScope: 'one forward; explicit per-scope carry store', skillScope: 'agent state; restored explicitly', proof: 'scripted code; real callback retrieval, preloading, reset and state restoration, not a substitute for storage authorization' };
      } finally { for (const worker of workers) worker.stop(); }
    },
  },
];
