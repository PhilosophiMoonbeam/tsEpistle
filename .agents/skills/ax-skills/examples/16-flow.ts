import assert from 'node:assert/strict';
import {
  ax, f, flow, runControl, AxMockAIService,
  type AxAIServiceOptions, type AxChatRequest, type AxChatResponse,
  type AxChatSession, type AxChatSessionEvent, type AxGenOut, type AxRunControlEvent,
} from '@ax-llm/ax';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { options, scriptedAI, type Example } from './support.js';

// These are deterministic model outputs, not evidence of model quality. All
// orchestration, signature parsing and state transitions below are real Ax APIs.
const reply = (content: string): AxChatResponse => ({
  results: [{ index: 0, content, finishReason: 'stop' }],
});

export const examples: readonly Example[] = [
  {
    id: '16-flow/serial-contracts',
    title: 'Typed nodes: normalize → extract → explain with an actual dependency',
    features: ['flow', 'typed-nodes', 'input-mapping', 'serial-dependencies', 'extended-nodes'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const extraction = ax('documentText:string -> orderCode:string');
      extraction.addAssert(({ orderCode }) => /^ORD-\d{3}$/.test(orderCode), 'Use the exact ORD-000 identifier from the document');
      const pipeline = flow<{ document: string }, { orderCode: string; explanation: string }>()
        .node('extractOrder', extraction)
        .nodeExtended('explainOrder', 'orderCode:string -> explanation:string', {
          appendInputs: [{ name: 'audience', type: f.string() }],
        })
        .map((state) => ({ ...state, normalizedDocument: state.document.trim() }))
        .execute('extractOrder', (state) => ({ documentText: state.normalizedDocument }))
        .execute('explainOrder', (state) => ({ orderCode: state.extractOrderResult.orderCode, audience: 'customer support' }))
        .returns((state) => {
          const explanation = state.explainOrderResult.explanation;
          assert.equal(typeof explanation, 'string');
          if (typeof explanation !== 'string') throw new Error('Expected a textual explanation');
          return { orderCode: state.extractOrderResult.orderCode, explanation };
        });
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI([
        reply('Order Code: ORD-104'),
        reply('Explanation: ORD-104 is the order identifier support should use.'),
      ]);
      const result = await pipeline.forward(ai, { document: '  Customer order ORD-104 is ready.  ' }, options(ctx));
      assert.equal(result.orderCode, 'ORD-104');
      assert.ok(result.explanation.includes(result.orderCode));
      return { ...result, ownership: 'Application owns the DAG; no agent chooses the next step and no business write occurs.' };
    },
  },
  {
    id: '16-flow/branch-boundaries',
    title: 'Application-owned routing executes only the selected branch',
    features: ['flow', 'branch', 'when', 'merge', 'untaken-branch-boundary'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const visited: string[] = [];
      const workflow = flow<{ question: string; detailed: boolean }, { answer: string; hasSimple: boolean; hasDetailed: boolean }>()
        .node('simpleReply', 'question:string -> answer:string')
        .node('detailedReply', 'question:string -> answer:string')
        .branch((state) => state.detailed)
        .when(true)
        .execute('detailedReply', (state) => {
          visited.push('detailed');
          return { question: state.question };
        })
        .when(false)
        .execute('simpleReply', (state) => {
          visited.push('simple');
          return { question: state.question };
        })
        .merge()
        .returns((state) => ({
          answer: state.detailedReplyResult?.answer ?? state.simpleReplyResult?.answer ?? '',
          hasSimple: state.simpleReplyResult !== undefined,
          hasDetailed: state.detailedReplyResult !== undefined,
        }));
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI([
        reply('Answer: Backups allow recovery after data loss.'),
        reply('Answer: Backups preserve independent copies; restore tests check recovery.'),
      ]);
      const simple = await workflow.forward(ai, { question: 'Why keep backups?', detailed: false }, options(ctx));
      const detailed = await workflow.forward(ai, { question: 'Why keep backups? Give two facts.', detailed: true }, options(ctx));
      assert.deepEqual(visited, ['simple', 'detailed']);
      assert.deepEqual([simple.hasSimple, simple.hasDetailed], [true, false]);
      assert.deepEqual([detailed.hasSimple, detailed.hasDetailed], [false, true]);
      assert.ok(simple.answer.length > 0 && detailed.answer.length > 0);
      return { simple, detailed, boundary: 'Results are per run, not sticky branch state or durable records.' };
    },
  },
  {
    id: '16-flow/parallel-merge',
    title: 'Independent reviews fan out through Ax parallel and join explicitly',
    features: ['flow', 'parallel', 'merge', 'execution-plan'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const workflow = flow<{ releaseNote: string }, { review: { customer: string; operator: string } }>()
        .node('customerReview', 'releaseNote:string -> customerImpact:string')
        .node('operatorReview', 'releaseNote:string -> operatorAction:string')
        .parallel([
          (sub) => sub.execute('customerReview', (state) => ({ releaseNote: state.releaseNote })),
          (sub) => sub.execute('operatorReview', (state) => ({ releaseNote: state.releaseNote })),
        ])
        .merge('joinedReview', (customer, operator) => {
          assert.ok(customer && typeof customer === 'object' && 'customerReviewResult' in customer);
          assert.ok(operator && typeof operator === 'object' && 'operatorReviewResult' in operator);
          const customerResult = customer.customerReviewResult;
          const operatorResult = operator.operatorReviewResult;
          assert.ok(customerResult && typeof customerResult === 'object' && 'customerImpact' in customerResult);
          assert.ok(operatorResult && typeof operatorResult === 'object' && 'operatorAction' in operatorResult);
          assert.equal(typeof customerResult.customerImpact, 'string');
          assert.equal(typeof operatorResult.operatorAction, 'string');
          return { customer: String(customerResult.customerImpact), operator: String(operatorResult.operatorAction) };
        })
        .returns((state) => ({ review: state.joinedReview }));
      // Distinct signature labels select fixtures independently of scheduler order.
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI((request) => {
        const prompt = JSON.stringify(request.chatPrompt);
        return prompt.includes('Customer Impact')
          ? reply('Customer Impact: The maintenance window interrupts checkout for five minutes.')
          : reply('Operator Action: Monitor checkout errors during the maintenance window.');
      });
      const result = await workflow.forward(ai, { releaseNote: 'Checkout maintenance lasts five minutes; operators must monitor errors.' }, options(ctx));
      assert.ok(result.review.customer.length > 0);
      assert.ok(result.review.operator.length > 0);
      return { ...result, plan: workflow.getExecutionPlan(), ownership: 'Parallel read-only reviews; merge is a barrier, not a transaction.' };
    },
  },
  {
    id: '16-flow/map-reduce',
    title: 'Bounded array derivation and deterministic business reduction',
    features: ['flow', 'derive', 'batch-size', 'map', 'reduce', 'state-transformation'],
    modes: ['offline'],
    async run(ctx) {
      const workflow = flow<{ quantities: number[]; unitCents: number }, { lineCents: number[]; totalCents: number }>({ batchSize: 2 })
        .map((state) => ({ ...state, lineCents: [] as number[] }))
        .derive('lineCents', 'quantities', (quantity: number, _index, state) => {
          assert.ok(state);
          return quantity * state.unitCents;
        }, { batchSize: 2 })
        .map((state) => ({ ...state, totalCents: state.lineCents.reduce((sum, cents) => sum + cents, 0) }))
        .returns((state) => ({ lineCents: state.lineCents, totalCents: state.totalCents }));
      // No model is needed for arithmetic. Exhaustion detects an accidental call.
      const result = await workflow.forward(scriptedAI([]), { quantities: [2, 1, 3], unitCents: 125 }, options(ctx));
      assert.deepEqual(result.lineCents, [250, 125, 375]);
      assert.equal(result.totalCents, 750);
      const empty = await workflow.forward(scriptedAI([]), { quantities: [], unitCents: 125 }, options(ctx));
      assert.deepEqual(empty, { lineCents: [], totalCents: 0 });
      return { result, empty, reason: 'Use Ax derive for batched work, host integer arithmetic for money; no LLM arithmetic or custom Promise.all.' };
    },
  },
  {
    id: '16-flow/async-parallel-map',
    title: 'Async order lookup and parallel owned reads merge into a typed fulfillment decision',
    features: ['flow', 'async-map', 'parallel-map-array', 'typed-state-merge', 'overlap-barrier'],
    modes: ['offline'],
    async run(ctx) {
      const events: string[] = [];
      const orderRows: Record<string, { sku: string; requestedUnits: number } | undefined> = {
        'ORD-104': { sku: 'BACKUP-DRIVE', requestedUnits: 3 },
      };
      const inventoryRows: Record<string, number | undefined> = { 'BACKUP-DRIVE': 4 };
      const priceRows: Record<string, number | undefined> = { 'BACKUP-DRIVE': 12500 };
      const bothReadsStarted = Promise.withResolvers<void>();
      let startedReads = 0;
      let activeReads = 0;
      let peakReads = 0;
      const abortBarrier = () => bothReadsStarted.reject(ctx.signal.reason);
      ctx.signal.throwIfAborted();
      ctx.signal.addEventListener('abort', abortBarrier, { once: true });
      const beginRead = async (name: string) => {
        events.push(`${name}:start`);
        activeReads++;
        peakReads = Math.max(peakReads, activeReads);
        if (++startedReads === 2) bothReadsStarted.resolve();
        try {
          // Neither read can finish until the SDK starts the other transform.
          await bothReadsStarted.promise;
        } finally {
          activeReads--;
          events.push(`${name}:end`);
        }
      };
      const readOrder = async (orderId: string) => {
        events.push('order:start');
        const order = await Promise.resolve(orderRows[orderId]);
        assert.ok(order);
        events.push('order:end');
        return order;
      };
      const readInventory = async (sku: string) => {
        await beginRead('inventory');
        const availableUnits = inventoryRows[sku];
        assert.notEqual(availableUnits, undefined);
        return availableUnits;
      };
      const readPrice = async (sku: string) => {
        await beginRead('price');
        const unitCents = priceRows[sku];
        assert.notEqual(unitCents, undefined);
        return unitCents;
      };
      type EnrichedOrder = {
        orderId: string;
        sku: string;
        requestedUnits: number;
        availableUnits?: number;
        unitCents?: number;
      };
      const workflow = flow<{ orderId: string }>({ batchSize: 2 })
        .map(async (state) => ({ ...state, ...await readOrder(state.orderId) }))
        // Each callback owns one new key; neither mutates the shared input state.
        // Optional fields model partial results honestly until the join validates them.
        .map<EnrichedOrder>([
          async (state) => ({ ...state, availableUnits: await readInventory(state.sku) }),
          async (state) => ({ ...state, unitCents: await readPrice(state.sku) }),
        ], { parallel: true })
        .returns((state) => {
          assert.equal(typeof state.availableUnits, 'number');
          assert.equal(typeof state.unitCents, 'number');
          if (state.availableUnits === undefined || state.unitCents === undefined) {
            throw new Error('Both owned reads must complete before fulfillment');
          }
          events.push('fulfillment');
          return {
            orderId: state.orderId,
            canFulfill: state.availableUnits >= state.requestedUnits,
            totalCents: state.requestedUnits * state.unitCents,
            remainingUnits: state.availableUnits - state.requestedUnits,
          };
        });
      let result;
      try {
        result = await workflow.forward(scriptedAI([]), { orderId: 'ORD-104' }, options(ctx));
      } finally {
        ctx.signal.removeEventListener('abort', abortBarrier);
      }
      assert.deepEqual(result, { orderId: 'ORD-104', canFulfill: true, totalCents: 37500, remainingUnits: 1 });
      assert.equal(peakReads, 2);
      assert.equal(startedReads, 2);
      assert.equal(activeReads, 0);
      assert.deepEqual(events.slice(0, 2), ['order:start', 'order:end']);
      const lastStart = Math.max(events.indexOf('inventory:start'), events.indexOf('price:start'));
      assert.ok(lastStart < events.indexOf('inventory:end') && lastStart < events.indexOf('price:end'));
      assert.equal(events.at(-1), 'fulfillment');
      return { result, events, peakReads, ownership: 'Finite application-owned read fixtures; Ax awaits the async map and joins parallel transforms. No model call, external write or sleep-based timing claim.' };
    },
  },
  {
    id: '16-flow/bounded-state-loops',
    title: 'While and feedback mutate explicit flat state with hard iteration limits',
    features: ['flow', 'while', 'endWhile', 'label', 'feedback', 'program-state'],
    modes: ['offline'],
    async run(ctx) {
      const counter = flow<{ target: number }, { count: number; attempts: number }>()
        .map((state) => ({ ...state, count: 0, attempts: 0 }))
        .while((state) => state.count < state.target && state.count < 3)
        .map((state) => ({ ...state, count: state.count + 1 }))
        .endWhile()
        .label('retryBudget')
        .map((state) => ({ ...state, attempts: state.attempts + 1 }))
        .feedback((state) => state.attempts < 2, 'retryBudget')
        .returns((state) => ({ count: state.count, attempts: state.attempts }));
      const capped = await counter.forward(scriptedAI([]), { target: 100 }, options(ctx));
      assert.deepEqual(capped, { count: 3, attempts: 2 });
      const fresh = await counter.forward(scriptedAI([]), { target: 1 }, options(ctx));
      assert.deepEqual(fresh, { count: 1, attempts: 2 });
      return { capped, fresh, boundary: 'Flat run state resets; these loops do not persist checkpoints or retry external writes.' };
    },
  },
  {
    id: '16-flow/program-cache',
    title: 'Named programs, demos, application-owned cache and flow tool schema',
    features: ['flow', 'namedPrograms', 'setDemos', 'cachingFunction', 'toFunction', 'chat-log'],
    modes: ['offline'],
    async run(ctx) {
      let calls = 0;
      const cache = new Map<string, AxGenOut>();
      const workflow = flow<{ question: string }, { answer: string }>()
        .node('answerQuestion', 'question:string -> answer:string')
        .execute('answerQuestion', (state) => ({ question: state.question }))
        .returns((state) => ({ answer: state.answerQuestionResult.answer }))
        .description('Answer Question', 'Read-only answer from an explicit question.');
      const programs = workflow.namedPrograms();
      assert.ok(programs.some((program) => program.id.endsWith('answerQuestion')));
      workflow.setDemos([{ programId: 'root.answerQuestion', traces: [{ question: 'What is a backup?', answer: 'An independent recovery copy.' }] }]);
      const ai = scriptedAI(() => {
        calls++;
        return reply('Answer: A backup is an independent recovery copy.');
      });
      const forwardOptions = {
        ...options(ctx),
        cachingFunction: async (key: string, value?: AxGenOut): Promise<AxGenOut | undefined> => {
          if (value === undefined) return cache.get(key);
          cache.set(key, value);
          return undefined;
        },
      };
      const first = await workflow.forward(ai, { question: 'What is a backup?' }, forwardOptions);
      const chatLogEntries = workflow.getChatLog().length;
      assert.ok(chatLogEntries > 0);
      const second = await workflow.forward(ai, { question: 'What is a backup?' }, forwardOptions);
      assert.deepEqual(first, second);
      assert.equal(calls, 1);
      const tool = workflow.toFunction();
      assert.ok(tool.name.length > 0 && tool.parameters);
      return { first, modelCalls: calls, cacheEntries: cache.size, chatLogEntries, programs: programs.map(({ id }) => id), toolName: tool.name, boundary: 'Volatile cache stores accepted output, not authorization, durability or an exactly-once effect ledger.' };
    },
  },
  {
    id: '16-flow/automatic-session-control',
    title: 'Node-scoped session updates preserve completed work and bypass cached Flow results',
    features: ['flow', 'runControl', 'automatic-sessions', 'executionPath', 'targeted-updates', 'completed-node-boundary', 'cache-bypass'],
    modes: ['offline'],
    async run(ctx) {
      const control = runControl();
      const rootInstruction = 'Include the shared retention policy.';
      const reviewInstruction = 'Review only: include the operator warning.';
      const completedInstruction = 'Do not replay this completed baseline.';
      const events: AxRunControlEvent[] = [];
      type SessionRecord = {
        path: string;
        steering: string[];
        thinking: string[];
        continuations: number;
        closed: number;
      };
      const sessions: SessionRecord[] = [];
      let updatesQueued = false;
      const unsubscribe = control.onEvent((event) => {
        events.push(event);
        if (event.type !== 'model.output' || event.path !== 'root/review' || updatesQueued) return;
        updatesQueued = true;
        // The first review response is an event barrier, not a sleep. Baseline
        // has finished; review is active; archive cannot start until review joins.
        control.steer(completedInstruction, { target: 'root/baseline' });
        control.steer(reviewInstruction, { target: 'root/review' });
        control.setThinkingTokenBudget('low', { target: 'root/review' });
        control.steer(rootInstruction);
      });
      class FlowSessionFixture extends AxMockAIService<string> {
        constructor() {
          super({
            name: 'flow-session-transport-fixture',
            features: { functions: true, streaming: true },
            chatResponse: async () => { throw new Error('Controlled Flow nodes must open sessions, not fall back to chat'); },
          });
        }
        override getFeatures() { return { ...super.getFeatures(), asyncTools: true }; }
        async openChatSession(
          request: Readonly<AxChatRequest<unknown>>,
          serviceOptions?: Readonly<AxAIServiceOptions>,
        ): Promise<AxChatSession> {
          const path = serviceOptions?.executionPath;
          assert.ok(path === 'root/baseline' || path === 'root/review' || path === 'root/archive');
          assert.ok(!sessions.some((record) => record.path === path), 'A completed node must not reopen');
          // Each SDK-opened conversation starts with its own mapped inputs,
          // rather than inheriting another node's assistant messages.
          assert.ok(!request.chatPrompt.some((message) => message.role === 'assistant'));
          const prompt = JSON.stringify(request.chatPrompt);
          if (path === 'root/review') assert.ok(prompt.includes('BASELINE-104'));
          if (path === 'root/archive') assert.ok(prompt.includes('reviewed with operator warning and retention policy'));
          const record: SessionRecord = { path, steering: [], thinking: [], continuations: 0, closed: 0 };
          sessions.push(record);
          const session: AxChatSession = {
            model: 'finite-flow-session-fixture',
            signal: ctx.signal,
            async *events(): AsyncIterable<AxChatSessionEvent> {
              ctx.signal.throwIfAborted();
              const first = path === 'root/baseline'
                ? reply('Baseline Text: BASELINE-104')
                : path === 'root/review'
                  ? reply('Review Text: Provisional review')
                  : reply('Archive Text: Provisional archive');
              yield { type: 'response', responseId: `${path}/first`, response: first };
              yield { type: 'response.completed', responseId: `${path}/first`, response: first };
              if (path === 'root/baseline') throw new Error('Baseline must finish at its first boundary');
              // Ax must deliver matching controls and request a successor before
              // this finite transport script supplies its revised response.
              assert.equal(record.continuations, 1);
              assert.deepEqual(record.steering, path === 'root/review'
                ? [reviewInstruction, rootInstruction] : [rootInstruction]);
              assert.deepEqual(record.thinking, path === 'root/review' ? ['low'] : []);
              const final = path === 'root/review'
                ? reply('Review Text: BASELINE-104 reviewed with operator warning and retention policy')
                : reply('Archive Text: Retention policy recorded without the review-only instruction');
              ctx.signal.throwIfAborted();
              yield { type: 'response', responseId: `${path}/final`, response: final };
              yield { type: 'response.completed', responseId: `${path}/final`, response: final };
              throw new Error('Final response must finish the node without another continuation');
            },
            async submitToolResults() { throw new Error('This fixture has no tool calls'); },
            async continue() { assert.equal(record.closed, 0); record.continuations++; },
            async steer(instruction) {
              assert.equal(record.closed, 0);
              record.steering.push(instruction);
              return 'next-response';
            },
            async setThinkingTokenBudget(level) {
              assert.equal(record.closed, 0);
              record.thinking.push(level);
              return 'next-response';
            },
            close() { if (record.closed === 0) record.closed++; },
          };
          return session;
        }
      }
      // `flow` is the public typed builder; there is no typedFlow export in 25.4.9.
      const typedFlow = flow<{ releaseNote: string }, { baselineText: string; reviewText: string; archiveText: string }>()
        .node('baseline', ax('releaseNote:string -> baselineText:string'))
        .node('review', ax('baselineText:string -> reviewText:string'))
        .node('archive', ax('reviewText:string -> archiveText:string'))
        .execute('baseline', (state) => ({ releaseNote: state.releaseNote }))
        .execute('review', (state) => ({ baselineText: state.baselineResult.baselineText }))
        .execute('archive', (state) => ({ reviewText: state.reviewResult.reviewText }))
        .returns((state) => ({
          baselineText: state.baselineResult.baselineText,
          reviewText: state.reviewResult.reviewText,
          archiveText: state.archiveResult.archiveText,
        }));
      const cached = { baselineText: 'Cached baseline', reviewText: 'Cached review', archiveText: 'Cached archive' };
      let cacheReads = 0;
      let cacheWrites = 0;
      const forwardOptions = {
        ...options(ctx),
        cachingFunction: async (_key: string, value?: AxGenOut): Promise<AxGenOut | undefined> => {
          if (value !== undefined) { cacheWrites++; return undefined; }
          cacheReads++;
          return cached;
        },
      };
      const input = { releaseNote: 'Release 104 requires an operator review and a retention record.' };
      try {
        ctx.signal.throwIfAborted();
        const ai = new FlowSessionFixture();
        // Negative control: the same callback can short-circuit this Flow.
        assert.deepEqual(await typedFlow.forward(ai, input, forwardOptions), cached);
        assert.equal(cacheReads, 1);
        assert.equal(sessions.length, 0);
        const result = await typedFlow.forward(ai, input, { ...forwardOptions, control });
        assert.deepEqual(result, {
          baselineText: 'BASELINE-104',
          reviewText: 'BASELINE-104 reviewed with operator warning and retention policy',
          archiveText: 'Retention policy recorded without the review-only instruction',
        });
        assert.equal(updatesQueued, true);
        assert.deepEqual(sessions.map(({ path }) => path), ['root/baseline', 'root/review', 'root/archive']);
        assert.deepEqual(sessions.map(({ continuations, closed }) => [continuations, closed]), [[0, 1], [1, 1], [1, 1]]);
        assert.deepEqual(sessions[0]?.steering, []);
        assert.deepEqual(sessions[0]?.thinking, []);
        const applied = events.filter((event) => event.type === 'applied');
        assert.deepEqual([...new Set(applied.map(({ path }) => path))], ['root/review', 'root/archive']);
        assert.equal(events.filter((event) => event.type === 'completed' && event.path === 'root/baseline').length, 1);
        assert.ok(events.findIndex((event) => event.type === 'completed' && event.path === 'root/baseline')
          < events.findIndex((event) => event.type === 'queued'));
        assert.equal(cacheReads, 1, 'Controlled run must not read even the existing cached result');
        assert.equal(cacheWrites, 0, 'Controlled run must not populate either Flow or node caches');
        return { result, sessions, applied, cacheReads, cacheWrites,
          boundary: 'Finite scripted provider-session I/O; Ax owns node scheduling, path matching, continuation, cache bypass and cleanup. Revised text is fixture output, not evidence of model compliance or provider transport support.' };
      } finally {
        unsubscribe();
      }
    },
  },
  {
    id: '16-flow/mermaid-roundtrip',
    title: 'Compile a declarative graph and serialize its contracts',
    features: ['flow', 'mermaid', 'serialization', 'auto-wiring'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const workflow = flow<{ documentText: string }, { summaryText: string }>(`
flowchart TD
  %%ax summarize: documentText:string -> summaryText:string(max 300)
  summarize[Summarize document]
`);
      const serialized = String(workflow);
      assert.ok(serialized.includes('summaryText'));
      const restored = flow<{ documentText: string }, { summaryText: string }>(serialized);
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI([reply('Summary Text: Checkout maintenance lasts five minutes.')]);
      const result = await restored.forward(ai, { documentText: 'Checkout will be unavailable for a five-minute maintenance window.' }, options(ctx));
      assert.ok(result.summaryText.length > 0 && result.summaryText.length <= 300);
      return { result, serialized, boundary: 'Diagram serialization is a graph contract, not a running-session checkpoint.' };
    },
  },
  {
    id: '16-flow/automatic-planning',
    title: 'Auto-parallel read dependencies with a per-node AI override and shared limiter',
    features: ['flow', 'auto-parallel', 'execution-plan', 'dynamic-ai-context', 'rate-limiter'],
    modes: ['offline', 'live'],
    async run(ctx) {
      let limitedCalls = 0;
      const topicModel = ctx.mode === 'live' ? ctx.ai : scriptedAI([reply('Topic: maintenance')]);
      const impactModel = ctx.mode === 'live' ? ctx.ai : scriptedAI([reply('Impact: Checkout is unavailable for five minutes.')]);
      const workflow = flow<{ releaseNote: string }, { topic: string; impact: string }>()
        .node('classifyTopic', 'releaseNote:string -> topic:class "maintenance, feature"')
        .node('describeImpact', 'releaseNote:string -> impact:string')
        .execute('classifyTopic', (state) => ({ releaseNote: state.releaseNote }))
        .execute('describeImpact', (state) => ({ releaseNote: state.releaseNote }), { ai: impactModel })
        .returns((state) => ({ topic: state.classifyTopicResult.topic, impact: state.describeImpactResult.impact }));
      const plan = workflow.getExecutionPlan();
      assert.equal(plan.autoParallelEnabled, true);
      assert.ok(plan.maxParallelism >= 2);
      const result = await workflow.forward(topicModel, { releaseNote: 'Maintenance: checkout will be unavailable for five minutes.' }, {
        ...options(ctx),
        rateLimiter: async (next) => { limitedCalls++; return next(); },
      });
      assert.equal(result.topic, 'maintenance');
      assert.ok(result.impact.length > 0);
      return { result, plan, limitedCalls, ownership: 'Host selects providers; metadata drives independent execution. This limiter counts calls, not token cost or semantic quality.' };
    },
  },
  {
    id: '16-flow/opentelemetry-lifecycle',
    title: 'Export completed Flow and AxGen spans with explicit parent context and bounded retention',
    features: ['flow', 'AxGen', 'tracer', 'traceContext', 'opentelemetry-export', 'trace-privacy', 'tracer-lifecycle'],
    modes: ['offline'],
    async run(ctx) {
      // Requires @opentelemetry/api 1.9.0 and sdk-trace-base 2.0.1.
      // This is the SDK's real in-memory exporter, not an external collector.
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const tracer = provider.getTracer('ax-flow-offline-example', '1.0.0');
      // Local injection avoids registering an OTel global or changing axGlobals.
      const parent = tracer.startSpan('fulfillment-request', {}, ROOT_CONTEXT);
      const privateRequest = 'PRIVATE-ORDER-104: approve shipment of three backup drives.';
      const privateRationale = 'PRIVATE-NOTE-104: sufficient verified inventory.';
      const decisionProgram = ax('requestText:string -> decision:class "approve, reject", rationale:string');
      const workflow = flow<{ requestText: string }>()
        .node('shipmentDecision', decisionProgram)
        .execute('shipmentDecision', (state) => ({ requestText: state.requestText }))
        .returns((state) => ({ ship: state.shipmentDecisionResult.decision === 'approve' }));
      let summary: { ship: boolean; spanNames: string[]; chatLogEntries: number } | undefined;
      try {
        let result;
        try {
          result = await workflow.forward(scriptedAI([
            reply(`Decision: approve\nRationale: ${privateRationale}`),
          ]), { requestText: privateRequest }, {
            ...options(ctx),
            tracer,
            traceContext: trace.setSpan(ROOT_CONTEXT, parent),
            excludeContentFromTrace: true,
          });
        } finally {
          parent.end();
          await provider.forceFlush();
        }
        assert.deepEqual(result, { ship: true });
        const spans = exporter.getFinishedSpans();
        const flowSpan = spans.find((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId);
        assert.ok(flowSpan);
        const genSpan = spans.find((span) => span.parentSpanContext?.spanId === flowSpan.spanContext().spanId);
        const requestSpan = spans.find((span) => span.spanContext().spanId === parent.spanContext().spanId);
        assert.ok(flowSpan && genSpan && requestSpan);
        assert.ok(spans.every((span) => span.ended && span.spanContext().traceId === parent.spanContext().traceId));
        assert.equal(flowSpan.parentSpanContext?.spanId, parent.spanContext().spanId);
        assert.equal(genSpan.parentSpanContext?.spanId, flowSpan.spanContext().spanId);
        assert.ok(genSpan.events.length >= 2);
        assert.ok(genSpan.events.some((event) => event.attributes?.field_count === 1));
        const tracePayload = JSON.stringify(spans.map((span) => ({
          name: span.name, attributes: span.attributes, events: span.events, status: span.status,
        })));
        assert.ok(!tracePayload.includes('PRIVATE-ORDER-104') && !tracePayload.includes('PRIVATE-NOTE-104'));
        // Trace exclusion is NOT chat-log erasure. Do not export this log as telemetry.
        const chatLog = workflow.getChatLog();
        const retainedChat = JSON.stringify(chatLog);
        assert.ok(retainedChat.includes(privateRequest) && retainedChat.includes(privateRationale));
        summary = { ship: result.ship, spanNames: spans.map((span) => span.name), chatLogEntries: chatLog.length };
      } finally {
        // Ends the processor/exporter; this exporter also drops its retained spans.
        await provider.shutdown();
      }
      assert.equal(exporter.getFinishedSpans().length, 0);
      assert.ok(summary);
      return { ...summary, exporterRetainedAfterShutdown: 0, boundary: 'Successful-run trace metadata excludes these content sentinels; chat logs still retain content. This flag is not universal redaction of errors, custom attributes, debug logs or provider retention. No network collector or global tracer is installed.' };
    },
  },
];
