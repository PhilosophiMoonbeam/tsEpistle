import assert from 'node:assert/strict';
import { agent, AxJSRuntime, f, fn, type AxChatResponse } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const code = (javascriptCode: string): AxChatResponse => ({ results: [{ index: 0, content: JSON.stringify({ javascriptCode }), finishReason: 'stop' }] });
const answer = (content: string): AxChatResponse => ({ results: [{ index: 0, content: `Answer: ${content}`, finishReason: 'stop' }] });

export const examples: readonly Example[] = [
  {
    id: '32-executor-context/prompt-detail-comparison',
    title: 'Inspect the real executor: 25.4.9 promptLevel declaration has no effect in bundled templates',
    features: ['promptLevel pinned-template boundary', 'liveRuntimeState', 'executor request inspection', 'distiller handoff'],
    modes: ['offline'],
    async run(ctx) {
      const results: { level: string; systemChars: number; total: number }[] = [];
      const executorPrompts: string[] = [];
      for (const level of ['default', 'detailed'] as const) {
        let executorSystem = '', continuingPrompt = '', calls = 0;
        const worker = agent('task:string -> answer:string', {
          runtime: new AxJSRuntime(), promptLevel: level, maxTurns: 4, directResponse: 'off',
          contextOptions: { model: 'fixture-distiller' },
          executorOptions: { model: 'fixture-executor' },
          responderOptions: { model: 'fixture-responder' },
          contextPolicy: { preset: 'adaptive', budget: 'balanced' },
        });
        const responses = [
          code('await final("Compute the invoice sum from these amounts", { amounts: [9, 4] })'),
          code('const amounts = inputs.distilledContext.amounts; console.log(amounts.length)'),
          code('const sum = amounts.reduce((a, b) => a + b, 0); console.log(sum)'),
          code('await final("Report the observed invoice total", { sum })'), answer('13'),
        ];
        // The distiller request is not the executor prompt. Explicit model routes
        // identify the stage without injecting or modifying its SDK instructions.
        const stages = ['fixture-distiller', 'fixture-executor', 'fixture-executor', 'fixture-executor', 'fixture-responder'];
        const model = scriptedAI((request, index) => {
          calls++;
          assert.equal(request.model, stages[index]);
          if (index === 1) executorSystem = request.chatPrompt.flatMap(message => message.role === 'system' ? [message.content] : []).join('\n');
          if (index === 2) continuingPrompt = JSON.stringify(request.chatPrompt);
          const response = responses[index]; assert.ok(response, 'unexpected extra stage request'); return response;
        }, { structuredOutputs: true });
        const result = await worker.forward(model, { task: 'Compute the invoice sum.' }, options(ctx));
        assert.equal(result.answer, '13');
        assert.equal(calls, responses.length);
        assert.match(executorSystem, /## Executor/);
        assert.match(continuingPrompt, /Live Runtime State/); assert.match(continuingPrompt, /amounts/);
        const bindings = worker.getState()?.runtimeBindings;
        assert.deepEqual(bindings?.amounts, [9, 4]);
        const total = bindings?.sum;
        assert.ok(typeof total === 'number');
        assert.equal(total, 13);
        executorPrompts.push(executorSystem);
        results.push({ level, systemChars: executorSystem.length, total });
      }
      // Pinned source: index.js.map sourcesContent, agent/templates.generated.ts
      // lines 8–9 contain no promptLevel branch, although agent/rlm.ts lines
      // 658 and 866 pass the setting to both actor template renderers.
      assert.equal(executorPrompts[1], executorPrompts[0], '25.4.9 bundled executor templates ignore promptLevel; this is a pinned boundary, not intended extra scaffolding');
      return { results, selection: '25.4.9 accepts default/detailed but ships identical executor scaffolding; do not rely on promptLevel to reduce context or add weak-model teaching. Replay policy separately controls old-action visibility, not worker variable lifetime.', proof: 'actual executor system prompts, typed responder output and retained runtime business state under scripted code; not comparative model accuracy' };
    },
  },
  {
    id: '32-executor-context/executor-only-model-upgrades',
    title: 'Recover after an error, discover a billing function, and upgrade only the executor',
    features: ['executorModelPolicy ordered rules', 'aboveErrorTurns', 'namespaces', 'functionDiscovery', 'executorOptions', 'contextOptions', 'responderOptions', 'actorTurnCallback model'],
    modes: ['offline'],
    async run(ctx) {
      const models: unknown[] = [];
      const events: { stage: string; turn: number; model?: string; error: boolean }[] = [];
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 5, promptLevel: 'detailed', directResponse: 'off', functionDiscovery: true,
        contextPolicy: { preset: 'full' },
        contextOptions: { model: 'fixture-context', description: 'Normalize invoice requests without executing billing tools.' },
        executorOptions: { model: 'fixture-cheap', description: 'Compute via billing tools and report actual results.' },
        responderOptions: { model: 'fixture-synthesis', description: 'Return only the observed numeric total.' },
        executorModelPolicy: [
          { model: 'fixture-recovery', aboveErrorTurns: 1 },
          { model: 'fixture-specialist', namespaces: ['billing'] },
        ],
        functions: [fn('total').namespace('billing').description('Sum invoice amounts').arg('amounts', f.number('Amount').array()).returns(f.number('Sum')).handler(({ amounts }) => amounts.reduce((a, b) => a + b, 0)).build()],
        actorTurnCallback: turn => { events.push({ stage: turn.stage, turn: turn.turn, model: turn.model, error: turn.isError }); },
      });
      const responses = [
        code('await final("Compute invoice total using billing.total", { amounts: [4, 6] })'),
        code('throw new Error("Invoice schema needs the billing function docs")'),
        code('await discover(["billing.total"])'),
        code('const total = await billing.total({ amounts: inputs.distilledContext.amounts }); console.log(total)'),
        code('await final("Return the observed total", { total })'), answer('10'),
      ];
      const fixture = scriptedAI((request, index) => { models.push(request.model); const response = responses[index]; assert.ok(response); return response; }, { structuredOutputs: true });
      const result = await worker.forward(fixture, { task: 'Compute the total for invoices of 4 and 6.' }, options(ctx));
      assert.equal(result.answer, '10');
      assert.deepEqual(models, ['fixture-context', 'fixture-cheap', 'fixture-recovery', 'fixture-specialist', 'fixture-specialist', 'fixture-synthesis']);
      assert.ok(events.some(event => event.stage === 'executor' && event.error));
      assert.ok(events.some(event => event.model === 'fixture-specialist'));
      return { answer: result.answer, models, events, boundary: 'fixture model IDs inspect SDK routing, not real deployed model identifiers; production requires valid model mappings. Ordered last matching executor rule wins; responder routing is independent.' };
    },
  },
  {
    id: '32-executor-context/dynamic-output-truncation',
    title: 'Watch replay shrink as history grows while the complete runtime value stays usable',
    features: ['maxRuntimeChars', 'dynamic budget-proportional truncation', 'raw versus replay output', 'contextPolicy compact budget', 'live runtime value'],
    modes: ['offline'],
    async run(ctx) {
      const turns: { rawChars: number; replayChars: number; error: boolean }[] = [];
      const pressure: { mutable: number; target: number }[] = [];
      const ceiling = 2400;
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 8, maxRuntimeChars: ceiling, directResponse: 'off',
        contextPolicy: { preset: 'full', budget: 'compact' },
        // Explicit handoff below makes the real executor own these runtime turns.
        actorTurnCallback: turn => { if (turn.stage === 'executor' && turn.result !== undefined) turns.push({ rawChars: String(turn.result).length, replayChars: turn.output.length, error: turn.isError }); },
        onContextEvent: event => { if (event.stage === 'executor' && event.kind === 'budget_check') pressure.push({ mutable: event.mutablePromptChars, target: event.targetPromptChars }); },
      });
      const model = scriptedAI([
        code('await final("Inspect the invoice-detail payload repeatedly, then report its full retained character count", {})'),
        code('const fullPayload = "invoice-detail-".repeat(1200); console.log(fullPayload)'),
        code('console.log(fullPayload)'),
        code('console.log(fullPayload)'),
        code('console.log(fullPayload)'),
        code('console.log(fullPayload)'),
        code('const completeLength = fullPayload.length; console.log(completeLength)'),
        code('await final("Report the complete retained payload length, not the truncated replay length", { completeLength })'),
        answer('18000'),
      ], { structuredOutputs: true });
      const result = await worker.forward(model, { task: 'Inspect repeated invoice details, then report their full retained character count.' }, options(ctx));
      assert.equal(result.answer, '18000');
      assert.equal(worker.getState()?.runtimeBindings.completeLength, 18000);
      const large = turns.filter(turn => turn.rawChars > ceiling);
      assert.ok(large.length > 1, 'multiple real executor outputs are needed to compare replay pressure');
      assert.ok(turns.every(turn => !turn.error));
      assert.ok(large.every(turn => turn.rawChars === worker.getState()?.runtimeBindings.completeLength && turn.replayChars < turn.rawChars));
      assert.ok((large.at(-1)?.replayChars ?? Infinity) < (large[0]?.replayChars ?? 0));
      assert.ok(pressure.length > 0);
      return { retainedLength: 18000, configuredCeiling: ceiling, replaySizes: large.map(turn => turn.replayChars), rawSizes: large.map(turn => turn.rawChars), pressureChecks: pressure.length, boundary: 'runtime output limits bound replay, not the underlying value; do not use this as a token, cost or host-memory enforcement mechanism', proof: 'real SDK truncation across scripted normal actor turns' };
    },
  },
];
