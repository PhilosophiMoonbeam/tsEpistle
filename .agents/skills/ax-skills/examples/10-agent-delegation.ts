import assert from 'node:assert/strict';
import { agent, f, fn, type AxChatResponse } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const reply = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const code = (javascriptCode: string): AxChatResponse => reply(JSON.stringify({ javascriptCode }));

export const examples: readonly Example[] = [
  {
    id: '10-agent-delegation/specialist-ownership',
    title: 'Delegate an authorized hold to a child; use llmQuery only for semantic wording',
    features: ['child-agent', 'agentIdentity', 'namespace', 'explicit-child-inputs', 'child-tool-ownership', 'llmQuery', 'onFunctionCall:internal'],
    modes: ['offline'],
    async run(ctx) {
      // Only the child receives this effectful capability. This ledger is owned
      // by this invocation, never a production order or a real account write.
      const holds: { receipt: string; accountId: string; sku: string; audience: string }[] = [];
      const calls: { qualifiedName: string; kind: string }[] = [];
      const reserve = fn('reserve').namespace('inventory')
        .description('Create one authorized in-memory tea hold for account acct-demo and operations audience')
        .arg('accountId', f.string()).arg('sku', f.string()).arg('audience', f.string())
        .returns(f.string())
        .handler(async ({ accountId, sku, audience }) => {
          // Host authorization, not an LLM claim, owns the effect boundary.
          assert.equal(accountId, 'acct-demo');
          assert.equal(sku, 'tea');
          assert.equal(audience, 'operations');
          assert.equal(holds.length, 0, 'This task authorizes exactly one hold');
          const receipt = 'H-001';
          holds.push({ receipt, accountId, sku, audience });
          return receipt;
        }).build();
      const specialist = agent('accountId:string, sku:string, audience:string -> receipt:string, summary:string', {
        agentIdentity: { name: 'Stock Clerk', namespace: 'team', description: 'Owns inventory holds with its own inventory.reserve capability; requires explicit accountId, sku, audience' },
        contextFields: [], functions: [reserve], directResponse: 'off', maxTurns: 3,
        onFunctionCall: (event) => { calls.push({ qualifiedName: event.qualifiedName, kind: event.kind }); },
      });
      const coordinator = agent('query:string, accountId:string, audience:string -> receipt:string, summary:string', {
        contextFields: [], functions: [specialist], directResponse: 'off', maxTurns: 4,
        onFunctionCall: (event) => { calls.push({ qualifiedName: event.qualifiedName, kind: event.kind }); },
      });
      let semanticInputWasNarrow = false;
      const turns = [
        // Public child functions return title-labelled text, not the child's
        // structured output object. Preserve that evidence as childReply.
        code('await final("Ask team.stockClerk to hold tea for the explicit account and audience, then summarize its receipt", { sku: "tea" });'),
        code('const childReply = await team.stockClerk({ accountId: inputs.accountId, sku: inputs.distilledContext.sku, audience: inputs.audience }); console.log(childReply);'),
        code('await final("Create one tea hold with inventory.reserve using these exact child inputs", { accountId: inputs.accountId, sku: inputs.sku, audience: inputs.audience });'),
        code('const holdReceipt = await inventory.reserve({ accountId: inputs.accountId, sku: inputs.sku, audience: inputs.audience }); console.log(holdReceipt);'),
        code('await final("Report the actual hold receipt and a short operations summary", { receipt: holdReceipt, audience: inputs.audience });'),
        reply('Receipt: H-001\nSummary: Tea hold H-001 is ready for operations.'),
        code('const wording = await llmQuery("Summarize this completed receipt for operations. Do not perform actions.", { completedChildReply: childReply }); console.log(wording);'),
        reply('Answer: Tea hold H-001 is ready for operations.'),
        code('await final("Report the child-owned receipt and semantic summary", { childReply, summary: wording });'),
        reply('Receipt: H-001\nSummary: Tea hold H-001 is ready for operations.'),
      ];
      const model = scriptedAI((request, index) => {
        if (index === 7) {
          const prompt = JSON.stringify(request.chatPrompt);
          semanticInputWasNarrow = prompt.includes('completedChildReply') && !prompt.includes('acct-demo');
          assert.ok(semanticInputWasNarrow, 'llmQuery receives only explicit narrow context, not parent account inputs');
          assert.equal(holds.length, 1, 'Child must have completed the effect before the semantic query');
          assert.ok(!request.functions?.some((entry) => entry.name === 'reserve'), 'A semantic subquery is not a tool-owning child');
        }
        const response = turns[index];
        assert.ok(response, 'Unexpected extra delegation stage');
        return response;
      }, { structuredOutputs: true });
      try {
        const result = await coordinator.forward(model, {
          query: 'Place one tea hold for this account through Stock Clerk; summarize for the audience.',
          accountId: 'acct-demo', audience: 'operations',
        }, options(ctx));
        assert.deepEqual(holds, [{ receipt: 'H-001', accountId: 'acct-demo', sku: 'tea', audience: 'operations' }]);
        assert.equal(result.receipt, holds[0]?.receipt);
        assert.match(result.summary, /operations/);
        assert.ok(calls.some((entry) => entry.qualifiedName === 'team.stockClerk' && entry.kind === 'internal'));
        assert.ok(calls.some((entry) => entry.qualifiedName === 'inventory.reserve' && entry.kind === 'external'));
        assert.ok(semanticInputWasNarrow);
        return { ...result, holds, calls, semanticInputWasNarrow, proof: 'real child pipeline and host effect; scripted wording is not model-quality evidence' };
      } finally {
        coordinator.stop();
        specialist.stop();
      }
    },
  },
  {
    id: '10-agent-delegation/grouped-child-function',
    title: 'A child getFunction wrapper can belong to a discoverable function group',
    features: ['child.getFunction', 'AxAgentFunctionGroup', 'functionDiscovery', 'explicit-child-inputs', 'child-directResponse'],
    modes: ['offline'],
    async run(ctx) {
      const editor = agent('draft:string, audience:string -> revision:string', {
        agentIdentity: { name: 'Editor', description: 'Rewrites the explicitly supplied draft for the explicitly supplied audience' },
        contextFields: [], maxTurns: 2,
      });
      // The child has no namespace override: its public function defaults to
      // utils when flat. Here the group deliberately owns the editorial module.
      const parent = agent('draft:string, audience:string -> answer:string', {
        contextFields: [], directResponse: 'off', functionDiscovery: true, maxTurns: 4,
        functions: [{ namespace: 'editorial', title: 'Editorial desk', description: 'Audience-specific draft revision', functions: [editor.getFunction()] }],
      });
      let childReceivedBothFields = false;
      const turns = [
        code('await final("Have editorial.editor revise the supplied draft for the supplied audience", {});'),
        code('await discover("editorial.editor");'),
        code('const edited = await editorial.editor({ draft: inputs.draft, audience: inputs.audience }); console.log(edited);'),
        code('await respond("Rewrite the draft for operations without inventing facts", { draft: inputs.draft, audience: inputs.audience });'),
        reply('Revision: Operations: tea stock is seven units.'),
        code('await final("Return the delegated revision", { edited });'),
        reply('Answer: Operations: tea stock is seven units.'),
      ];
      const model = scriptedAI((request, index) => {
        if (index === 3) {
          const prompt = JSON.stringify(request.chatPrompt);
          childReceivedBothFields = prompt.includes('tea stock is seven units') && prompt.includes('operations');
          assert.ok(childReceivedBothFields);
        }
        const response = turns[index];
        assert.ok(response);
        return response;
      }, { structuredOutputs: true });
      try {
        const result = await parent.forward(model, { draft: 'tea stock is seven units', audience: 'operations' }, options(ctx));
        assert.match(result.answer, /Operations: tea stock is seven units/);
        assert.ok(childReceivedBothFields);
        return { ...result, childReceivedBothFields, childFunctionName: editor.getFunction().name };
      } finally { parent.stop(); editor.stop(); }
    },
  },
];
