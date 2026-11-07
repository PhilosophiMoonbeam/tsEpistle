import assert from 'node:assert/strict';
import { agent, AxAgentContextMap, AxJSRuntime, type AxChatResponse, type AxContextPolicyPreset, type AxAgentContextMapSnapshot } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const code = (javascriptCode: string): AxChatResponse => ({ results: [{ index: 0, content: JSON.stringify({ javascriptCode }), finishReason: 'stop' }] });
const text = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });

export const examples: readonly Example[] = [
  {
    id: '13-context/replay-versus-state',
    title: 'Run the same retained-variable task under all four replay presets',
    features: ['full', 'adaptive', 'checkpointed', 'lean', 'budget', 'liveRuntimeState', 'onContextEvent', 'getState'],
    modes: ['offline'],
    async run(ctx) {
      const results = [];
      for (const preset of ['full', 'adaptive', 'checkpointed', 'lean'] satisfies AxContextPolicyPreset[]) {
        const turns: { output: string; prompt: string }[] = [];
        let budgetChecks = 0, compactedActions = 0;
        const worker = agent('task:string -> answer:string', {
          runtime: new AxJSRuntime(), maxTurns: 4, directResponse: 'off',
          contextPolicy: { preset, budget: 'compact' },
          // Top-level turn telemetry observes the executor; final() hands the task to it.
          actorTurnCallback: t => {
            if (t.stage === 'executor') turns.push({ output: t.output, prompt: JSON.stringify(t.chatLogMessages?.filter(message => message.role === 'system' || message.role === 'user') ?? []) });
          },
          onContextEvent: e => {
            if (e.stage !== 'executor') return;
            if (e.kind === 'budget_check') budgetChecks++;
            if (e.kind === 'action_compacted') compactedActions++;
          },
        });
        const model = scriptedAI([
          code('await final("Inspect and sum the supplied invoice amounts, retaining the array between turns", { amounts: [10, 20, 30] })'),
          code('const invoiceAmounts = inputs.distilledContext.amounts; console.log(invoiceAmounts.length)'),
          // A bounded, deliberately verbose inspection gives lean replay something real to compact.
          code('console.log(invoiceAmounts.map((amount, index) => `invoice ${index + 1}: ${amount}`).join("\\n").repeat(16))'),
          code('const invoiceTotal = invoiceAmounts.reduce((a, b) => a + b, 0); console.log(invoiceTotal)'),
          code('await final("Report total", { invoiceTotal })'), text('Answer: 60'),
        ], { structuredOutputs: true });
        assert.equal((await worker.forward(model, { task: 'Sum the invoice amounts.' }, options(ctx))).answer, '60');
        assert.ok(turns.some(turn => turn.output.includes('60')));
        assert.equal(worker.getState()?.runtimeBindings.invoiceTotal, 60);
        assert.ok(budgetChecks > 0);
        const continuingPrompt = turns[1]?.prompt ?? '';
        assert.match(continuingPrompt, /invoiceAmounts/);
        if (preset !== 'full') assert.match(continuingPrompt, /Live Runtime State/);
        const compactedReplay = turns.some(turn => turn.prompt.includes('[COMPACT:'));
        if (preset === 'lean') {
          assert.ok(compactedActions > 0);
          assert.ok(compactedReplay);
        }
        assert.deepEqual(worker.getState()?.runtimeBindings.invoiceAmounts, [10, 20, 30]);
        results.push({ preset, total: 60, budgetChecks, compactedActions, compactedReplay, liveStateVisible: continuingPrompt.includes('Live Runtime State'), retainedActions: worker.getState()?.actionLogEntries.length });
      }
      return { results, selection: 'full for exact debugging; checkpointed for conservative compaction; adaptive/lean for earlier reduced replay', boundary: 'scripted actor decisions exercise real executor prompts, lean compact replay and retained values, not model checkpoint quality; replay does not own variable lifetime' };
    },
  },
  {
    id: '13-context/pressure-checkpoint-retains-values',
    title: 'Checkpoint an oversized trajectory and continue computing from live variables',
    features: ['checkpoint_created', 'Checkpoint Summary', 'checkpointed compact budget', 'summarizerOptions', 'runtime persistence under pressure'],
    modes: ['offline'],
    async run(ctx) {
      const events: string[] = [], prompts: string[] = [];
      let actorIndex = 0, summaries = 0;
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 6, maxRuntimeChars: 20000, directResponse: 'off',
        contextPolicy: { preset: 'checkpointed', budget: 'compact' },
        summarizerOptions: { model: 'fixture-checkpoint', modelConfig: { maxTokens: 150 } },
        onContextEvent: event => { if (event.stage === 'executor') events.push(event.kind); },
        actorTurnCallback: turn => {
          if (turn.stage === 'executor') prompts.push(JSON.stringify(turn.chatLogMessages?.filter(message => message.role === 'system' || message.role === 'user') ?? []));
        },
      });
      // Intentionally verbose audit output is a pressure fixture, not recommended actor style.
      // Model replies are scripted; checkpoint selection, replay and retained values use real SDK paths.
      const responses = [
        code('await final("Inspect a verbose invoice audit and compute invoice count, maximum and total from retained amounts", {})'),
        code('const amounts = [9, 4]; const auditText = "invoice audit detail ".repeat(1600); console.log(auditText)'),
        code('const invoiceCount = amounts.length; console.log({ invoiceCount })'),
        code('const maximum = Math.max(...amounts); console.log({ maximum })'),
        code('const invoiceTotal = amounts.reduce((a, b) => a + b, 0); console.log({ invoiceTotal })'),
        code('await final("Report the invoice count, maximum and total", { invoiceCount, maximum, invoiceTotal })'),
        text('Answer: 2 invoices, maximum 9, total 13'),
      ];
      const fixture = scriptedAI((request) => {
        if (request.model === 'fixture-checkpoint') {
          summaries++;
          return text('Checkpoint Summary: amounts remains [9,4] in the runtime. The verbose audit inspection completed successfully. Reuse existing values; do not regenerate the audit transcript.');
        }
        const response = responses[actorIndex++]; assert.ok(response); return response;
      }, { structuredOutputs: true });
      const result = await worker.forward(fixture, { task: 'Inspect a verbose invoice audit, then calculate count, maximum and total.' }, options(ctx));
      assert.match(result.answer, /13/);
      assert.equal(worker.getState()?.runtimeBindings.invoiceTotal, 13);
      assert.deepEqual(worker.getState()?.runtimeBindings.amounts, [9, 4]);
      assert.equal(worker.getState()?.runtimeBindings.invoiceCount, 2);
      assert.equal(worker.getState()?.runtimeBindings.maximum, 9);
      assert.ok(events.includes('checkpoint_created'));
      assert.ok(prompts.some(prompt => prompt.includes('Checkpoint Summary')));
      assert.ok(prompts.some(prompt => prompt.includes('Live Runtime State') && prompt.includes('amounts')));
      return { answer: result.answer, summaries, checkpoints: events.filter(kind => kind === 'checkpoint_created').length, retainedTotal: 13,
        boundary: summaries === 0
          ? 'The SDK checkpointed without invoking the configured summary-model fixture. Runtime values survive; this does not qualify model-generated summary fidelity.'
          : 'Checkpoint replay is lossy; runtime values survive. Scripted summary responses do not qualify model-generated summary fidelity.' };
    },
  },
  {
    id: '13-context/persisted-corpus-orientation',
    title: 'Evolve an orientation map on success, persist a tenant/corpus snapshot, then freeze and reuse it',
    features: ['contextMap', 'AxAgentContextMap', 'onUpdate', 'snapshot', 'fromSnapshot', 'finite evolve', 'failure/abort boundary', 'application persistence'],
    modes: ['offline'],
    async run(ctx) {
      // Application-owned store: in production replace this map with durable storage.
      // Corpus version belongs in the key; a different tenant must never inherit orientation.
      const key = 'tenant:demo/corpus:invoices/v3';
      const store = new Map<string, string>();
      const map = new AxAgentContextMap(undefined, { maxChars: 1800, infiniteEvolve: false, evolveSteps: 1 });
      const worker = agent('task:string, corpus:string -> answer:string', {
        runtime: new AxJSRuntime(), contextFields: ['corpus'], maxTurns: 2,
        contextMap: { map, onUpdate: ({ map: updated }) => { store.set(key, JSON.stringify(updated.snapshot())); } },
      });
      const firstModel = scriptedAI([
        code('const rows = inputs.corpus.split("\\n").map(line => line.split("|")); await respond("Report paid count", { count: rows.filter(row => row[1] === "paid").length })'),
        text('Answer: 2 paid invoices'),
        text('Diagnosis: The corpus uses pipe separated id, status, amount columns.\nItem Tags: {}\nCache Candidates: [{"section":"parsing_schema","value":"Each line is id|status|amount","transferability":"all invoice queries","rationale":"schema"}]'),
        text('Operations: [{"type":"ADD","section":"parsing_schema","content":"Each invoice line is id|status|amount; amount is numeric."}]'),
      ], { structuredOutputs: true });
      const corpus = 'inv-a|paid|12\ninv-b|pending|8\ninv-c|paid|5';
      assert.match((await worker.forward(firstModel, { task: 'How many invoices are paid?', corpus }, options(ctx))).answer, /2/);
      const serialized = store.get(key);
      assert.ok(serialized);
      const saved: AxAgentContextMapSnapshot = JSON.parse(serialized);
      assert.match(saved.text, /id\|status\|amount/);
      assert.equal(saved.steps, 1);
      assert.equal(store.has('tenant:other/corpus:invoices/v3'), false);
      // Fresh agent: map orientation survives, runtime variable rows deliberately does not.
      const restoredMap = AxAgentContextMap.fromSnapshot(saved);
      let secondPrompt = '';
      const restored = agent('task:string, corpus:string -> answer:string', {
        runtime: new AxJSRuntime(), contextFields: ['corpus'], maxTurns: 2,
        contextMap: { map: restoredMap, onUpdate: ({ map: updated }) => { store.set(key, JSON.stringify(updated.snapshot())); } },
      });
      const secondModel = scriptedAI((request, index) => {
        if (index === 0) {
          secondPrompt = JSON.stringify(request.chatPrompt);
          return code('if (typeof rows !== "undefined") throw new Error("runtime leaked"); const pending = inputs.corpus.split("\\n").find(line => line.split("|")[1] === "pending"); await respond("Report pending invoice", { pending })');
        }
        assert.equal(index, 1, 'frozen map must not consume updater model calls');
        return text('Answer: inv-b is pending for 8');
      }, { structuredOutputs: true });
      assert.match((await restored.forward(secondModel, { task: 'Which invoice is pending?', corpus }, options(ctx))).answer, /inv-b/);
      assert.match(secondPrompt, /Each invoice line is id\|status\|amount/);
      assert.equal(restoredMap.snapshot().steps, 1);
      const beforeFailure = JSON.stringify(restoredMap.snapshot());
      const failing = scriptedAI(() => { throw new Error('isolated provider failure'); });
      await assert.rejects(() => restored.forward(failing, { task: 'This provider fails.', corpus }, options(ctx)), /isolated provider failure/);
      assert.equal(JSON.stringify(restoredMap.snapshot()), beforeFailure);
      const aborted = new AbortController(); aborted.abort('caller cancelled');
      await assert.rejects(() => restored.forward(failing, { task: 'Cancelled before completion.', corpus }, { ...options(ctx), abortSignal: aborted.signal }));
      assert.equal(JSON.stringify(restoredMap.snapshot()), beforeFailure);
      return { answers: ['2 paid invoices', 'inv-b is pending for 8'], persistedKey: key, evolveSteps: saved.steps, restoredSchema: true, failedAndAbortedRunsUnchanged: true, proof: 'scripted updater proposals; real map update, persistence injection and freeze gates, not model cartography quality' };
    },
  },
];
