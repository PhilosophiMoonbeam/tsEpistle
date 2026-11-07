import assert from 'node:assert/strict';
import {
  ax, f, fn, runControl, AxEvalUtil, AxAIServiceAbortedError, AxMockAIService,
  type AxChatRequest, type AxChatResponse, type AxGenOut, type AxProgramForwardOptions,
  type AxAIServiceOptions, type AxChatSession, type AxChatSessionEvent, type AxFunctionResult,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const reply = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const toolCall = (name: string, params: object): AxChatResponse => ({ results: [{ index: 0,
  functionCalls: [{ id: `call-${name}`, type: 'function', function: { name, params } }], finishReason: 'function_call' }] });
function stream(content: string): ReadableStream<AxChatResponse> {
  return new ReadableStream({ start(controller) { controller.enqueue(reply(content)); controller.close(); } });
}

export const examples: readonly Example[] = [
  {
    id: '28-advanced-generation/processors',
    title: 'Processors return feedback, not transformed field values',
    features: ['addFieldProcessor', 'addStreamingFieldProcessor', 'replacement versions', 'feedback order'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax('requestText:string -> summaryText:string');
      const completedFields: string[] = [];
      gen.addFieldProcessor('summaryText', (value) => {
        completedFields.push(value);
        return value.length > 20 ? 'Use at most 20 characters.' : null;
      });
      const result = await gen.forward(scriptedAI([
        reply('Summary Text: This draft is intentionally much too long.'), reply('Summary Text: Invoice paid.'),
      ]), { requestText: 'Summarize a paid invoice concisely' }, options(ctx));
      assert.equal(result.summaryText, 'Invoice paid.');
      assert.equal(completedFields.length, 2);
      assert.equal(gen.getChatLog().length, 2);
      const streamed = ax('requestText:string -> summaryText:string');
      streamed.addStreamingFieldProcessor('summaryText', (partial) => partial.includes('DRAFT') ? 'Remove the DRAFT marker.' : null);
      streamed.addFieldProcessor('summaryText', (value) => value.includes('DRAFT') ? 'Return a final customer-facing summary.' : null);
      let version = -1;
      let summary = '';
      const versions: number[] = [];
      let feedbackSeen = false;
      const ai = scriptedAI((request, index) => {
        if (index === 1) {
          const history = JSON.stringify(request.chatPrompt);
          assert(history.includes('Remove the DRAFT marker.'));
          assert(history.includes('Return a final customer-facing summary.'));
          assert(history.indexOf('Remove the DRAFT marker.') < history.indexOf('Return a final customer-facing summary.'));
          feedbackSeen = true;
        }
        return stream(index === 0 ? 'Summary Text: DRAFT invoice paid.' : 'Summary Text: Invoice paid.');
      });
      for await (const chunk of streamed.streamingForward(ai, { requestText: 'Finalize a paid invoice summary' }, options(ctx))) {
        if (chunk.version !== version) { version = chunk.version; versions.push(version); summary = ''; }
        summary += chunk.delta.summaryText ?? '';
      }
      assert.equal(summary, 'Invoice paid.');
      assert(versions.length >= 2);
      assert(feedbackSeen);
      return { result, completedFields, summary, versions,
        proof: 'Processor feedback causes another real Ax step; first-step text is provisional' };
    },
  },
  {
    id: '28-advanced-generation/pending-hooks',
    title: 'Tool-result hooks schedule model, parameter and tool changes for the next call',
    features: ['stepHooks', 'afterFunctionExecution', 'beforeStep', 'afterStep', 'pending mutations', 'state'],
    modes: ['offline'],
    async run(ctx) {
      const requests: Readonly<AxChatRequest<unknown>>[] = [];
      const hookOrder: string[] = [];
      const readPolicy = fn('readPolicy').description('Read owned refund policy').handler(async () => ({ refundDays: 30 })).build();
      const explainPolicy = fn('explainPolicy').description('Explain policy without external effects').handler(async () => 'Refunds within 30 days').build();
      const gen = ax('questionText:string -> answerText:string', { model: 'fixture-start', modelConfig: { temperature: 0.8 } });
      const result = await gen.forward(scriptedAI((request, index) => {
        requests.push(request);
        return index === 0 ? toolCall('readPolicy', {}) : reply('Answer Text: Refunds are allowed within 30 days.');
      }), { questionText: 'Read refund policy and explain its deadline' }, {
        ...options(ctx), functions: [readPolicy],
        stepHooks: {
          beforeStep(step) { hookOrder.push(`before:${step.stepIndex}`); step.state.set('questionOwner', 'example'); },
          afterFunctionExecution(step) {
            assert(step.lastFunctionCalls.length > 0);
            hookOrder.push(`tool:${step.stepIndex}`);
            step.setModel('fixture-next'); step.setThinkingBudget('low'); step.setTemperature(0.1); step.setMaxTokens(96);
            step.setOptions({ customLabels: { phase: 'answer' } });
            step.addFunctions([explainPolicy]); step.removeFunctions('readPolicy');
          },
          afterStep(step) {
            hookOrder.push(`after:${step.stepIndex}`);
            assert.equal(step.state.get('questionOwner'), 'example');
          },
        },
      });
      assert.equal(requests[0]?.model, 'fixture-start');
      assert.equal(requests[0]?.modelConfig?.temperature, 0.8);
      assert.equal(requests[1]?.model, 'fixture-next');
      assert.equal(requests[1]?.modelConfig?.temperature, 0.1);
      assert.equal(requests[1]?.modelConfig?.maxTokens, 96);
      assert(requests[1]?.functions?.some((tool) => tool.name === 'explainPolicy'));
      assert.equal(requests[1]?.functions?.some((tool) => tool.name === 'readPolicy') ?? false, false);
      assert.match(result.answerText, /30 days/);
      return { result, models: requests.map((request) => request.model), hookOrder,
        proof: 'afterFunctionExecution mutations apply on next call; beforeStep mutations in 25.4.9 are applied before that same call' };
    },
  },
  {
    id: '28-advanced-generation/self-tuning',
    title: 'Self-tuning is an injected adjustment tool, not an invisible optimizer',
    features: ['selfTuning true', 'granular selfTuning', 'adjustGeneration', 'dynamic function pool'],
    modes: ['offline'],
    async run(ctx) {
      const results = [];
      const calculateTotal = fn('calculateTotal').description('Add an owned invoice net and tax')
        .arg('netAmount', f.number()).arg('taxAmount', f.number())
        .returnsField('totalAmount', f.number()).handler(async ({ netAmount, taxAmount }) => ({ totalAmount: netAmount + taxAmount })).build();
      for (const granular of [false, true]) {
        const requests: Readonly<AxChatRequest<unknown>>[] = [];
        const ai = new AxMockAIService<string>({
          name: 'owned-self-tuning-fixture',
          features: { functions: true, streaming: true },
          models: [
            { key: 'fixture-fast', model: 'gpt-5.4-mini', description: 'Fast chat model for simple extraction' },
            { key: 'fixture-capable', model: 'gpt-5.4', description: 'Capable chat model for multi-step arithmetic' },
          ],
          chatResponse: async (request: Readonly<AxChatRequest<unknown>>) => {
            const index = requests.length;
            requests.push(request);
            if (index === 0) {
              assert(request.functions?.some((tool) => tool.name === 'adjustGeneration'));
              return toolCall('adjustGeneration', granular
                ? { model: 'fixture-capable', thinkingBudget: 'low', temperature: 0.1, addFunctions: ['calculateTotal'] }
                : { model: 'fixture-capable', thinkingBudget: 'low' });
            }
            if (granular && index === 1) {
              assert(request.functions?.some((tool) => tool.name === 'calculateTotal'));
              return toolCall('calculateTotal', { netAmount: 20, taxAmount: 4 });
            }
            return reply('Total Amount: 24');
          },
        });
        const result = await ax('invoiceText:string -> totalAmount:number').forward(ai,
          { invoiceText: 'Net 20 and tax 4. Calculate total.' }, { ...options(ctx), model: 'fixture-fast',
            selfTuning: granular ? { model: true, thinkingBudget: true, temperature: true, functions: [calculateTotal] } : true,
          });
        assert.equal(result.totalAmount, 24);
        assert.equal(requests[0]?.model, 'fixture-fast');
        assert.equal(requests[1]?.model, 'fixture-capable');
        if (granular) assert.equal(requests[1]?.modelConfig?.temperature, 0.1);
        results.push({ granular, result, models: requests.map((request) => request.model), requests: requests.length });
      }
      return { results, prerequisite: 'Model selection requires at least two configured chat entries; these fixture entries perform no provider calls',
        proof: 'Script chooses adjustments; no evidence these choices improve model quality or cost' };
    },
  },
  {
    id: '28-advanced-generation/cache-and-control',
    title: 'Response caching stores completed values; active run control bypasses cache',
    features: ['cachingFunction', 'contextCache', 'runControl', 'steer', 'reasoning updates', 'stream cache'],
    modes: ['offline'],
    async run(ctx) {
      const cache = new Map<string, AxGenOut>();
      let requests = 0;
      let writes = 0;
      const cachingFunction: NonNullable<AxProgramForwardOptions<string>['cachingFunction']> = (key, value) => {
        if (value !== undefined) { cache.set(key, value); writes++; return undefined; }
        return cache.get(key);
      };
      const gen = ax('policyText:string(cache), questionText:string -> answerText:string', { cachingFunction });
      const input = { policyText: 'Returns are accepted for 30 days.', questionText: 'How long can I return an item?' };
      const ai = scriptedAI((request) => {
        requests++;
        if (requests === 2) assert(JSON.stringify(request.chatPrompt).includes('Answer in a short sentence.'));
        return reply('Answer Text: You have 30 days.');
      });
      const first = await gen.forward(ai, input, { ...options(ctx), contextCache: { cacheBreakpoint: 'after-examples' } });
      const second = await gen.forward(ai, input, options(ctx));
      assert.deepEqual(second, first);
      assert.equal(requests, 1);
      assert.equal(writes, 1);
      const control = runControl();
      const events: string[] = [];
      const unsubscribe = control.onEvent((event) => { events.push(event.type); });
      try {
        control.steer('Answer in a short sentence.'); control.setThinkingTokenBudget('low');
        const controlled = await gen.forward(ai, input, { ...options(ctx), control, asyncMode: 'off' });
        assert.equal(controlled.answerText, first.answerText);
        assert.equal(requests, 2);
        assert.equal(writes, 1);
        assert(events.includes('applied'));
      } finally { unsubscribe(); }
      const streamed = ax('questionText:string -> answerText:string', { cachingFunction });
      let streamRequests = 0;
      const streamAI = scriptedAI(() => { streamRequests++; return stream('Answer Text: Four.'); });
      for (let attempt = 0; attempt < 2; attempt++) {
        let text = '';
        for await (const chunk of streamed.streamingForward(streamAI, { questionText: '2+2?' }, options(ctx))) text += chunk.delta.answerText ?? '';
        assert.equal(text, 'Four.');
      }
      assert.equal(streamRequests, 1);
      return { first, requests, streamRequests, cacheEntries: cache.size, events,
        proof: 'Response-cache behavior only; synthetic fixture does not establish provider prompt-cache hits' };
    },
  },
  {
    id: '28-advanced-generation/sampling-and-novel-f1',
    title: 'Select complete sampled outputs by lexical reward, separate from hard invariants',
    features: ['sampleCount', 'resultPicker', 'novelF1ScoreOptimized', 'multiset overlap', 'recall'],
    modes: ['offline'],
    async run(ctx) {
      const history = 'invoice';
      const truth = 'invoice paid today';
      const gen = ax('questionText:string -> summaryText:string');
      gen.addAssert((value) => !value.summaryText.includes('SECRET') || 'Never expose a secret');
      let candidates = 0;
      const result = await gen.forward(scriptedAI((request) => {
        assert.equal(request.modelConfig?.n, 3);
        return { results: ['Summary Text: invoice paid', 'Summary Text: invoice paid today', 'Summary Text: invoice paid paid paid']
          .map((content, index) => ({ index, content, finishReason: 'stop' as const })) };
      }), { questionText: 'Summarize: invoice paid today' }, { ...options(ctx), sampleCount: 3,
        resultPicker(data) {
          assert.equal(data.type, 'fields');
          if (data.type !== 'fields') throw new Error('Expected parsed field candidates');
          candidates = data.results.length;
          let best = -1;
          let bestScore = -1;
          for (const candidate of data.results) {
            assert.equal(typeof candidate.sample.summaryText, 'string');
            const score = AxEvalUtil.novelF1ScoreOptimized(history, String(candidate.sample.summaryText), truth);
            if (score > bestScore) { best = candidate.index; bestScore = score; }
          }
          return best;
        },
      });
      assert.equal(candidates, 3);
      assert.equal(result.summaryText, 'invoice paid today');
      const repeated = AxEvalUtil.novelF1ScoreOptimized('', 'paid paid paid', 'paid');
      assert.equal(repeated, 0.5);
      assert.equal(AxEvalUtil.novelF1ScoreOptimized('', 'paid', 'paid today', true), 0.5);
      assert.equal(AxEvalUtil.novelF1ScoreOptimized('invoice', 'invoice', 'invoice'), 1);
      assert.equal(AxEvalUtil.novelF1ScoreOptimized('', '', 'paid'), 0);
      return { result, candidates, repeatedWordF1: repeated,
        proof: 'Novel F1 measures filtered lexical overlap, not factual correctness, safety or confidence' };
    },
  },
  {
    id: '28-advanced-generation/hook-timing',
    title: 'Capture beforeStep current-call changes versus afterStep next-call changes',
    features: ['beforeStep timing', 'afterStep timing', 'pending mutations', 'provider request capture'],
    modes: ['offline'],
    async run(ctx) {
      const requests: Readonly<AxChatRequest<unknown>>[] = [];
      const gen = ax('requestText:string -> summaryText:string', { model: 'constructor-model' });
      gen.addFieldProcessor('summaryText', (value) => value === 'Draft' ? 'Finalize the summary.' : null);
      const result = await gen.forward(scriptedAI((request, index) => {
        requests.push(request); return reply(index === 0 ? 'Summary Text: Draft' : 'Summary Text: Final');
      }), { requestText: 'Summarize the owned example' }, { ...options(ctx), stepHooks: {
        beforeStep(step) {
          if (step.isFirstStep) { step.setModel('before-current'); step.setTemperature(0.3); }
        },
        afterStep(step) {
          if (step.isFirstStep) { step.setModel('after-next'); step.setTemperature(0.1); }
        },
      } });
      assert.equal(requests[0]?.model, 'before-current');
      assert.equal(requests[0]?.modelConfig?.temperature, 0.3);
      assert.equal(requests[1]?.model, 'after-next');
      assert.equal(requests[1]?.modelConfig?.temperature, 0.1);
      assert.equal(result.summaryText, 'Final');
      return { result, requests: requests.map((request) => ({ model: request.model, temperature: request.modelConfig?.temperature })),
        proof: 'Pinned TypeScript 25.4.9 behavior contradicts the official guide blanket next-step wording' };
    },
  },
  {
    id: '28-advanced-generation/background-sessions',
    title: 'Automatic sessions run background host tools once and replace provisional answers',
    features: ['AxChatSession', 'background tools', 'automatic sessions', 'session streaming', 'version resets', 'session cleanup'],
    modes: ['offline'],
    async run(ctx) {
      // This isolated provider-session fixture owns transport events only.
      // Ax owns session selection, host execution, submission, continuation and validation.
      const outcomes = [];
      for (const streaming of [false, true]) {
        let executions = 0;
        let closed = 0;
        let opens = 0;
        let continuations = 0;
        const submitted: AxFunctionResult[] = [];
        const readStock = fn('readStock').description('Read owned Notebook stock in the background')
          .execution('background').arg('productName', f.string())
          .returnsField('available', f.number()).handler(async ({ productName }) => {
            assert.equal(productName, 'Notebook'); executions++;
            await Promise.resolve();
            return { available: 7 };
          }).build();
        const stockCall = { id: 'stock-call', type: 'function' as const,
          function: { name: 'readStock', params: { productName: 'Notebook' } } };
        class FixtureSessionAI extends AxMockAIService<string> {
          constructor() { super({ name: 'owned-session-fixture', features: { functions: true, streaming: true },
            chatResponse: async () => { throw new Error('Automatic session must not fall back to chat'); } }); }
          override getFeatures() { return { ...super.getFeatures(), asyncTools: true }; }
          async openChatSession(request: Readonly<AxChatRequest<unknown>>, _options?: Readonly<AxAIServiceOptions>): Promise<AxChatSession> {
            opens++;
            assert.equal(request.functions?.find((tool) => tool.name === 'readStock')?.execution, 'background');
            let sessionClosed = false;
            const session: AxChatSession = {
              model: 'owned-session-model',
              async *events(): AsyncIterable<AxChatSessionEvent> {
                assert(!sessionClosed);
                yield { type: 'tool.call', responseId: 'response-1', call: stockCall };
                yield { type: 'response', responseId: 'response-1', response: reply('Answer Text: Pending inventory.') };
                yield { type: 'response.completed', responseId: 'response-1', response: {
                  results: [{ index: 0, content: 'Answer Text: Pending inventory.',
                    functionCalls: [stockCall], finishReason: 'function_call' }],
                } };
                assert.equal(submitted.length, 1);
                assert.equal(submitted[0]?.functionId, 'stock-call');
                assert.match(submitted[0]?.result ?? '', /7/);
                assert.equal(continuations, 1);
                yield { type: 'response', responseId: 'response-2', response: reply('Answer Text: 7 notebooks available.') };
                yield { type: 'response.completed', responseId: 'response-2', response: reply('Answer Text: 7 notebooks available.') };
              },
              async submitToolResults(results) { submitted.push(...results); },
              async continue() { assert(submitted.length > 0); continuations++; },
              async steer() { throw new Error('This fixture covers tool sessions; control steering has a separate case'); },
              async setThinkingTokenBudget() { throw new Error('This fixture does not advertise session reasoning updates'); },
              close() { if (!sessionClosed) { sessionClosed = true; closed++; } },
            };
            return session;
          }
        }
        const gen = ax('questionText:string -> answerText:string');
        gen.addAssert((value) => value.answerText.includes('7') || 'Final answer must incorporate the inventory result');
        let answerText = '';
        const versions: number[] = [];
        if (streaming) {
          let version = -1;
          for await (const chunk of gen.streamingForward(new FixtureSessionAI(), { questionText: 'Read Notebook stock and answer' },
            { ...options(ctx), functions: [readStock] })) {
            if (chunk.version !== version) { version = chunk.version; versions.push(version); answerText = ''; }
            answerText += chunk.delta.answerText ?? '';
          }
          assert(versions.length >= 2);
        } else answerText = (await gen.forward(new FixtureSessionAI(), { questionText: 'Read Notebook stock and answer' },
          { ...options(ctx), functions: [readStock] })).answerText;
        assert.equal(answerText, '7 notebooks available.');
        assert.equal(executions, 1);
        assert.equal(opens, 1);
        assert.equal(closed, 1);
        outcomes.push({ streaming, answerText, executions, continuations, versions, closed });
      }
      return { outcomes, prerequisite: 'Real transport requires an AI service advertising asyncTools and implementing openChatSession',
        proof: 'Actual Ax session algorithms over fixture events, not proof of a provider transport or real concurrency latency' };
    },
  },
  {
    id: '28-advanced-generation/cancellation',
    title: 'Host cancellation and generator stop terminate execution at safe boundaries',
    features: ['abortSignal', 'gen.stop', 'AxAIServiceAbortedError', 'hook stop'],
    modes: ['offline'],
    async run(ctx) {
      const readPolicy = fn('readPolicy').description('Read owned policy').handler(async () => '30 days').build();
      let requests = 0;
      const gen = ax('questionText:string -> answerText:string');
      const ai = scriptedAI(() => { requests++; return toolCall('readPolicy', {}); });
      await assert.rejects(() => gen.forward(ai, { questionText: 'Read policy' }, { ...options(ctx), functions: [readPolicy],
        stepHooks: { afterFunctionExecution() { gen.stop(); } },
      }), (error: unknown) => error instanceof AxAIServiceAbortedError);
      assert.equal(requests, 1);
      const control = runControl();
      control.abort();
      await assert.rejects(() => ax('questionText:string -> answerText:string').forward(scriptedAI([]),
        { questionText: 'Cancelled before model call' }, { ...options(ctx), control }),
        (error: unknown) => error instanceof AxAIServiceAbortedError);
      // A non-aborted run of the same generator must still complete normally.
      const completed = await gen.forward(scriptedAI([reply('Answer Text: Normal completion')]),
        { questionText: 'Complete normally' }, { ...options(ctx), control: runControl() });
      assert.equal(completed.answerText, 'Normal completion');
      // Pinned defect: beforeStep stop breaks out to the max-steps error, and
      // step.stop(resultValues) stores values the generator never consumes.
      let earlyRequests = 0;
      await assert.rejects(() => ax('questionText:string -> answerText:string').forward(scriptedAI(() => {
        earlyRequests++; throw new Error('beforeStep stop must avoid the model');
      }), { questionText: 'Host already knows the answer' }, { ...options(ctx), stepHooks: { beforeStep(step) {
        step.stop({ answerText: 'Host-owned completion' });
      } } }), /Max steps reached/);
      assert.equal(earlyRequests, 0);
      // afterStep stop does terminate further work, retaining the emitted answer
      // rather than substituting the unsupported host-provided stop values.
      const stoppedGen = ax('questionText:string -> answerText:string');
      stoppedGen.addFieldProcessor('answerText', () => 'Continue with another answer.');
      const stopped = await stoppedGen.forward(scriptedAI([reply('Answer Text: Model-owned completion')]),
        { questionText: 'Finish at the first safe hook boundary' }, { ...options(ctx), stepHooks: { afterStep(step) {
          step.stop({ answerText: 'Host-owned completion' });
        } } });
      assert.equal(stopped.answerText, 'Model-owned completion');
      assert.equal(stoppedGen.getChatLog().length, 1);
      return { requestsBeforeStop: requests, preAbortedRejected: true, completed, stopped,
        beforeStepStopRejected: true, hostStopValuesIgnored: true,
        proof: 'Actual aborts and normal completion are distinct; afterStep stop retains generated values, while beforeStep stop/result overrides are broken in 25.4.9' };
    },
  },
];
