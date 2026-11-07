import assert from 'node:assert/strict';
import { agent, f, fn, type AxChatResponse } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

// These are deterministic MODEL replies, not a replacement runtime. Ax still
// parses javascriptCode, executes its sandbox, calls host functions and runs the
// responder. Offline success establishes wiring/authority, not model quality.
const reply = (content: string): AxChatResponse => ({
  results: [{ index: 0, content, finishReason: 'stop' }],
});
const code = (javascriptCode: string): AxChatResponse =>
  reply(JSON.stringify({ javascriptCode }));

class InventoryUnavailable extends Error {
  override name = 'InventoryUnavailable';
}

export const examples: readonly Example[] = [
  {
    id: '09-agents/tool-forward',
    title: 'A namespaced fn owns inventory truth; the responder reports it',
    features: ['agent.forward', 'fn', 'namespace', 'distiller', 'executor', 'responder'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const reads: string[] = [];
      const inventory: Readonly<Record<string, number>> = { tea: 7 };
      const stock = fn('stock')
        .description('Read current authorized inventory units for a product SKU')
        .namespace('warehouse')
        .arg('sku', f.string())
        .returns(f.number())
        .handler(async ({ sku }) => {
          reads.push(sku);
          const units = inventory[sku];
          if (units === undefined) throw new Error(`Unknown SKU: ${sku}`);
          return units;
        })
        .build();
      const assistant = agent('query:string -> availableUnits:number', {
        contextFields: [], functions: [stock], directResponse: 'off', maxTurns: 4,
      });
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI([
        code('await final("Read current tea inventory using warehouse.stock; report availableUnits", { sku: "tea" });'),
        code('const units = await warehouse.stock({ sku: "tea" }); console.log(units);'),
        code('await final("Report availableUnits from the tool result", { availableUnits: units });'),
        reply('Available Units: 7'),
      ], { structuredOutputs: true });
      try {
        const result = await assistant.forward(model, {
          query: 'Use warehouse.stock to read current inventory for SKU tea. Return its exact availableUnits.',
        }, options(ctx));
        assert.ok(reads.length > 0, 'A plausible answer without an authorized read is not success');
        assert.ok(reads.every((sku) => sku === 'tea'));
        assert.equal(result.availableUnits, inventory.tea);
        return { ...result, authorizedReads: reads, proof: 'real host inventory read via executor' };
      } finally {
        // forward owns/closes its runtime session in its own finally; stop also
        // cancels outstanding stage work if the caller exits abnormally.
        assistant.stop();
      }
    },
  },
  {
    id: '09-agents/direct-response',
    title: 'Static context synthesis skips the executor; off forces all stages',
    features: ['directResponse:auto', 'directResponse:off', 'respond', 'final'],
    modes: ['offline'],
    async run(ctx) {
      const calls: Record<string, number> = { auto: 0, off: 0 };
      const outputs: number[] = [];
      for (const policy of ['auto', 'off'] as const) {
        const assistant = agent('query:string -> total:number', {
          contextFields: [], directResponse: policy, maxTurns: 2,
        });
        const turns = policy === 'auto' ? [
          code('await respond("Report the sum of the supplied numbers", { total: 5 });'),
          reply('Total: 5'),
        ] : [
          code('await final("Report the sum of 2 and 3", { total: 5 });'),
          code('await final("Report total", inputs.distilledContext);'),
          reply('Total: 5'),
        ];
        const model = scriptedAI((_request, index) => {
          calls[policy]++;
          const response = turns[index];
          assert.ok(response, 'Unexpected extra stage/model call');
          return response;
        }, { structuredOutputs: true });
        try {
          const result = await assistant.forward(model, { query: 'What is 2 + 3?' }, options(ctx));
          assert.equal(result.total, 5);
          outputs.push(result.total);
        } finally { assistant.stop(); }
      }
      assert.deepEqual(calls, { auto: 2, off: 3 });
      return { outputs, modelCalls: calls, proof: 'auto omitted exactly one executor call' };
    },
  },
  {
    id: '09-agents/stage-instructions',
    title: 'Replace executor guidance, append a rule, then reapply owned guidance after a signature change',
    features: ['executor.setInstruction', 'addActorInstruction', 'getOptimizableComponents', 'setSignature', 'stage-owned-guidance'],
    modes: ['offline'],
    async run(ctx) {
      const inventory = Object.freeze({ tea: 7 });
      const reads: string[] = [];
      const proposals: { phase: string; sku: string; units: number }[] = [];
      const baseline = 'HOST_READ_ONLY: Read authorized stock; propose replenishment only; never place orders.';
      const initial = 'TARGET_TEN: Propose enough units to reach ten units in stock.';
      const replacement = 'TARGET_TWELVE: Propose enough units to reach twelve units in stock.';
      const packing = 'WHOLE_CASES: Round the proposed units up to a multiple of four.';
      const stock = fn('stock').namespace('warehouse')
        .description('Read authorized tea stock without modifying inventory or placing an order')
        .arg('sku', f.string()).returns(f.number())
        .handler(async ({ sku }) => {
          assert.equal(sku, 'tea');
          reads.push(sku);
          return inventory.tea;
        }).build();
      const signature = 'query:string -> reorderUnits:number';
      const assistant = agent(signature, {
        contextFields: [], functions: [stock], directResponse: 'off', maxTurns: 3,
        executorOptions: { description: baseline },
      });
      // The pipeline has no setInstruction method in 25.4.9: the public
      // executor stage owns this replaceable rule, not every agent stage.
      // Keep the canonical rule in application state, not an optimizer snapshot.
      let executorRule = initial;
      assistant.executor.setInstruction(executorRule);
      let rebuildBoundary: {
        sameExecutor: boolean;
        instructionBeforeReapply: string | undefined;
        signatureChanged: boolean;
      } | undefined;
      const phases = [
        { name: 'initial', rule: initial, packed: false, expected: 3 },
        { name: 'replaced', rule: replacement, packed: false, expected: 5 },
        { name: 'appended', rule: replacement, packed: true, expected: 8 },
        { name: 'rebuilt', rule: replacement, packed: true, expected: 8 },
      ] as const;
      const observed: { phase: string; stage: string; baseline: boolean; instruction: boolean; packing: boolean }[] = [];
      try {
        for (const phase of phases) {
          if (phase.name === 'replaced') {
            executorRule = replacement;
            assistant.executor.setInstruction(executorRule); // replace, not append
          }
          if (phase.name === 'appended') assistant.addActorInstruction(packing);
          if (phase.name === 'rebuilt') {
            const previousExecutor = assistant.executor;
            const previousSignature = assistant.getSignature().toString();
            // A real schema change, not setSignature with the original string.
            assistant.setSignature('query:string, requestTag?:string -> reorderUnits:number');
            rebuildBoundary = {
              sameExecutor: assistant.executor === previousExecutor,
              instructionBeforeReapply: assistant.executor.getInstruction(),
              signatureChanged: assistant.getSignature().toString() !== previousSignature,
            };
            assert.equal(rebuildBoundary.signatureChanged, true);
            // Reassert the application-owned replacement through the public stage.
            // Do not call addActorInstruction again on the same executor: that
            // appends another copy. Its existing addendum is checked in prompts.
            assistant.executor.setInstruction(executorRule);
          }
          assert.equal(assistant.executor.getInstruction(), phase.rule);
          // Pipeline components concatenate stages; their default IDs can
          // collide. An aggregate .find(key) can read another stage's empty
          // instruction. Inspect the owning executor, then prove actual prompts.
          const instructionKey = `${assistant.executor.getId()}::instruction`;
          const component = assistant.executor.getOptimizableComponents().find(
            (entry) => entry.key === instructionKey && entry.kind === 'instruction',
          );
          assert.ok(component, 'The executor rule must be a real owned optimization component');
          assert.equal(component.current, phase.rule);
          let calls = 0;
          const model = scriptedAI((request, index) => {
            calls++;
            assert.ok(index < 4, 'Each phase has exactly four finite model replies');
            const stage = index === 0 ? 'distiller' : index === 3 ? 'responder' : 'executor';
            const system = request.chatPrompt
              .filter((message) => message.role === 'system')
              .map((message) => message.content).join('\n');
            const executor = stage === 'executor';
            const snapshot = {
              phase: phase.name, stage,
              baseline: system.includes(baseline),
              instruction: system.includes(phase.rule),
              packing: system.includes(packing),
            };
            observed.push(snapshot);
            assert.equal(snapshot.baseline, executor);
            assert.equal(snapshot.instruction, executor);
            assert.equal(snapshot.packing, executor && phase.packed);
            assert.equal(system.split(packing).length - 1, executor && phase.packed ? 1 : 0,
              'Appending once must not become a duplicate rule after setSignature');
            assert.equal(system.includes(phase.rule === initial ? replacement : initial), false,
              'Replacement removes the prior rule, rather than appending it');
            if (stage !== 'responder') {
              assert.ok(JSON.stringify(request.responseFormat).includes('javascriptCode'),
                'Actor fixtures answer the actual structured code contract');
            }
            if (index === 0) {
              return code('await final("Read tea stock and propose replenishment under the executor rules; do not order anything", { sku: "tea" });');
            }
            if (index === 1) {
              // Deterministic fixture policy, not a claim about model reasoning:
              // select code from the rules actually present in this request.
              const target = system.includes(replacement) ? 12 : 10;
              const pack = system.includes(packing) ? 4 : 1;
              return code(`const stockUnits = await warehouse.stock({ sku: inputs.distilledContext.sku }); const proposedUnits = Math.ceil(Math.max(0, ${target} - stockUnits) / ${pack}) * ${pack}; console.log(proposedUnits);`);
            }
            if (index === 2) {
              return code('await final("Report the proposed reorderUnits without placing an order", { proposal: `REORDER_TEA_UNITS=${proposedUnits}` });');
            }
            // The responder consumes evidence computed in the real sandbox
            // after the owned stock read, not a hard-coded expected answer.
            const evidence = [...JSON.stringify(request.chatPrompt).matchAll(/REORDER_TEA_UNITS=(\d+)/g)];
            assert.ok(evidence.length > 0, 'The responder must receive the computed proposal');
            const reorderUnits = Number(evidence[0]![1]);
            assert.ok(evidence.every((match) => Number(match[1]) === reorderUnits));
            return reply(request.responseFormat?.type === 'json_schema' || request.responseFormat?.type === 'json_object'
              ? JSON.stringify({ reorderUnits })
              : `Reorder Units: ${reorderUnits}`);
          }, { structuredOutputs: true });
          const result = await assistant.forward(model, {
            query: 'Prepare a replenishment proposal for tea from current authorized stock. Do not place an order.',
          }, options(ctx));
          assert.equal(calls, 4);
          assert.equal(result.reorderUnits, phase.expected);
          // This is a local proposal list, deliberately not an order-writing tool.
          proposals.push({ phase: phase.name, sku: 'tea', units: result.reorderUnits });
        }
        assert.deepEqual(reads, ['tea', 'tea', 'tea', 'tea']);
        assert.deepEqual(inventory, { tea: 7 });
        return {
          proposals, authorizedReads: reads, stagePrompts: observed, rebuildBoundary,
          boundary: 'executor-only guidance explicitly reapplied after schema change; existing append checked once; read-only authority unchanged',
          fixture: 'finite scripted model replies demonstrate prompt ownership and runtime arithmetic, not reasoning quality',
        };
      } finally { assistant.stop(); }
    },
  },
  {
    id: '09-agents/discovery-modules',
    title: 'Discover a grouped catalog before invoking its exact callable',
    features: ['functionDiscovery', 'AxAgentFunctionGroup', 'selectionCriteria', 'alwaysInclude', 'discover'],
    modes: ['offline'],
    async run(ctx) {
      const reads: string[] = [];
      let nextPromptHadDocs = false;
      const lookup = fn('lookup')
        .description('Read a handbook rule by exact key')
        .arg('key', f.string()).returns(f.string())
        .handler(async ({ key }) => {
          reads.push(key);
          assert.equal(key, 'returns');
          return 'Returns accepted within 30 days.';
        }).build();
      const normalize = fn('normalize')
        .description('Normalize a handbook key; safe and always visible')
        .arg('key', f.string()).returns(f.string())
        .handler(async ({ key }) => key.trim().toLowerCase()).build();
      const assistant = agent('query:string -> answer:string', {
        contextFields: [], directResponse: 'off', maxTurns: 4,
        functionDiscovery: true,
        functions: [
          { namespace: 'handbook', title: 'Handbook', description: 'Business policy rules', selectionCriteria: 'Use for return-policy questions', functions: [lookup] },
          { namespace: 'workflow', title: 'Key helpers', description: 'Safe text helpers', alwaysInclude: true, functions: [normalize] },
        ],
      });
      const turns = [
        code('await final("Look up the returns policy with handbook tools", { key: " RETURNS " });'),
        code('await discover(["handbook", "handbook.lookup"]);'),
        code('const rule = await handbook.lookup({ key: await workflow.normalize({ key: inputs.distilledContext.key }) }); console.log(rule);'),
        code('await final("Answer with the retrieved return policy", { rule });'),
        reply('Answer: Returns accepted within 30 days.'),
      ];
      const model = scriptedAI((request, index) => {
        if (index === 2) {
          const prompt = JSON.stringify(request.chatPrompt);
          nextPromptHadDocs = prompt.includes('handbook.lookup') && prompt.includes('Read a handbook rule by exact key');
          assert.ok(nextPromptHadDocs, 'discover returns void; callable docs must arrive in the next prompt');
        }
        const response = turns[index];
        assert.ok(response, 'Discovery should not require an additional model call');
        return response;
      }, { structuredOutputs: true });
      try {
        const result = await assistant.forward(model, { query: 'Find the return policy.' }, options(ctx));
        assert.deepEqual(reads, ['returns']);
        assert.match(result.answer, /30 days/);
        assert.ok(nextPromptHadDocs);
        return { ...result, reads, nextPromptHadDocs };
      } finally { assistant.stop(); }
    },
  },
  {
    id: '09-agents/recoverable-tool-error',
    title: 'An ordinary tool error stays inside the actor recovery boundary',
    features: ['tool-error-recovery', 'actionLog', 'agent.forward'],
    modes: ['offline'],
    async run(ctx) {
      const attempted: string[] = [];
      const lookup = fn('lookup').namespace('warehouse')
        .description('Read tea inventory; reject unknown SKUs')
        .arg('sku', f.string()).returns(f.number())
        .handler(async ({ sku }) => {
          attempted.push(sku);
          if (sku !== 'tea') throw new RangeError(`Unknown SKU ${sku}; authorized SKU is tea`);
          return 7;
        }).build();
      const assistant = agent('query:string -> availableUnits:number', {
        contextFields: [], functions: [lookup], directResponse: 'off', maxTurns: 4,
      });
      const model = scriptedAI([
        code('await final("Read tea inventory", {});'),
        code('const failedRead = await warehouse.lookup({ sku: "teaa" }); console.log(failedRead);'),
        code('const correctedRead = await warehouse.lookup({ sku: "tea" }); console.log(correctedRead);'),
        code('await final("Report the corrected inventory, not the failed read", { availableUnits: correctedRead });'),
        reply('Available Units: 7'),
      ], { structuredOutputs: true });
      try {
        const result = await assistant.forward(model, { query: 'Read tea inventory.' }, options(ctx));
        assert.deepEqual(attempted, ['teaa', 'tea']);
        assert.equal(result.availableUnits, 7);
        return { ...result, attempted, boundary: 'ordinary RangeError recovered inside the actor loop' };
      } finally { assistant.stop(); }
    },
  },
  {
    id: '09-agents/fatal-bubble-errors',
    title: 'An explicitly fatal infrastructure error escapes forward unchanged',
    features: ['bubbleErrors', 'fatal-error-boundary'],
    modes: ['offline'],
    async run(ctx) {
      const fatal = new InventoryUnavailable('In-memory inventory service is deliberately unavailable');
      let attempted = 0;
      let modelCalls = 0;
      const lookup = fn('lookup').namespace('warehouse')
        .description('Read current inventory; unavailable in this failure fixture')
        .arg('sku', f.string()).returns(f.number())
        .handler(async () => { attempted++; throw fatal; }).build();
      const assistant = agent('query:string -> availableUnits:number', {
        contextFields: [], functions: [lookup], directResponse: 'off',
        bubbleErrors: [InventoryUnavailable], maxTurns: 3,
      });
      const turns = [
        code('await final("Read tea inventory", {});'),
        code('const units = await warehouse.lookup({ sku: "tea" }); console.log(units);'),
      ];
      const model = scriptedAI((_request, index) => {
        modelCalls++;
        const response = turns[index];
        assert.ok(response, 'Fatal failure must not trigger recovery or the responder');
        return response;
      }, { structuredOutputs: true });
      try {
        await assert.rejects(assistant.forward(model, { query: 'Read tea inventory.' }, options(ctx)), (error: unknown) => error === fatal);
        assert.equal(attempted, 1);
        assert.equal(modelCalls, 2);
        return { error: fatal.name, attempted, modelCalls, boundary: 'same host error identity; no responder' };
      } finally { assistant.stop(); }
    },
  },
];
