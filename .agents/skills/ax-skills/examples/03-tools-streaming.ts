import assert from 'node:assert/strict';
import { ax, f, fn, AxAIRefusalError, AxMemory, type AxChatResponse, type AxChatResponseResult } from '@ax-llm/ax';
import { z } from 'zod';
import { options, scriptedAI, type Example } from './support.js';

const reply = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const call = (name: string, params: object, id = 'call-1'): NonNullable<AxChatResponseResult['functionCalls']>[number] =>
  ({ id, type: 'function', function: { name, params } });
function chunks(results: readonly AxChatResponseResult[]): ReadableStream<AxChatResponse> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    const result = results[index++];
    if (result) controller.enqueue({ results: [result] });
    else controller.close();
  } });
}

export const examples: readonly Example[] = [
  {
    id: '03-tools-streaming/tool-extraction',
    title: 'Typed read-only inventory tool, then a grounded answer',
    features: ['fn', 'StandardSchema tool args', 'returns', 'native tools', 'forced function', 'onFunctionCall'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const inventory: Record<string, { priceUsd: number; available: number }> = { Notebook: { priceUsd: 12, available: 7 } };
      let reads = 0;
      // Application code, not the model, owns inventory facts and authorization.
      const lookupProduct = fn('lookupProduct').description('Read the owned example inventory for an exact product name')
        .arg(z.object({ productName: z.string().min(1) }))
        .returns(z.object({ priceUsd: z.number().min(0), available: z.number().min(0) }))
        .handler(async ({ productName }) => {
          reads++;
          const found = inventory[productName];
          if (!found) throw new Error(`Product not found: ${productName}`);
          return found;
        }).build();
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI((_request, index) => index === 0
        ? { results: [{ index: 0, functionCalls: [call('lookupProduct', { productName: 'Notebook' })], finishReason: 'function_call' }] }
        : reply('Price Usd: 12\nAvailable: 7'));
      const traces: string[] = [];
      const gen = ax('questionText:string -> priceUsd:number, available:number');
      const result = await gen.forward(ai, { questionText: 'Use lookupProduct for Notebook. Return its price and available count.' }, {
        ...options(ctx), functions: [lookupProduct], functionCallMode: 'native',
        functionCall: { type: 'function', function: { name: 'lookupProduct' } },
        onFunctionCall: (trace) => { traces.push(`${trace.fn}:${trace.ok}`); },
      });
      assert.equal(result.priceUsd, 12);
      assert.equal(result.available, 7);
      assert.equal(reads, 1);
      assert(traces.some((trace) => trace.includes('true')));
      return { result, inventoryReads: reads, traces, prerequisite: 'Live provider with native tool calling' };
    },
  },
  {
    id: '03-tools-streaming/unknown-tool-recovery',
    title: 'Unknown calls receive plain errors while valid siblings execute once',
    features: ['unknown tool names', 'formatter bypass', 'batch call IDs', 'forward', 'streamingForward'],
    modes: ['offline'],
    async run(ctx) {
      const outcomes = [];
      for (const streaming of [false, true]) {
        let executions = 0;
        let formats = 0;
        let requests = 0;
        const lookupStock = fn('lookupStock').description('Read owned stock').arg('productName', f.string())
          .returnsField('available', f.number()).handler(async () => { executions++; return { available: 7 }; }).build();
        const ai = scriptedAI((request, index) => {
          requests++;
          if (index === 0) {
            const result: AxChatResponseResult = { index: 0, functionCalls: [
              call('misspelledStock', {}, 'unknown-id'), call('lookupStock', { productName: 'Notebook' }, 'valid-id'),
            ], finishReason: 'function_call' };
            return streaming ? chunks([result]) : { results: [result] };
          }
          const toolResults = request.chatPrompt.filter((message) => message.role === 'function');
          const unknown = toolResults.find((message) => message.functionId === 'unknown-id');
          const valid = toolResults.find((message) => message.functionId === 'valid-id');
          assert(unknown && valid);
          assert.equal(unknown.isError, true);
          assert.match(unknown.result, /^Function not found:/);
          assert.match(unknown.result, /lookupStock/);
          assert.equal(valid.result, 'FORMATTED:{"available":7}');
          const result: AxChatResponseResult = { index: 0, content: 'Available: 7', finishReason: 'stop' };
          return streaming ? chunks([result]) : { results: [result] };
        });
        const gen = ax('questionText:string -> available:number');
        const opts = { ...options(ctx), functions: [lookupStock], functionResultFormatter: (value: unknown) => {
          formats++; return `FORMATTED:${JSON.stringify(value)}`;
        } };
        let available: number | undefined;
        if (streaming) {
          for await (const chunk of gen.streamingForward(ai, { questionText: 'Read Notebook stock' }, opts)) {
            if (chunk.delta.available !== undefined) available = chunk.delta.available;
          }
        } else available = (await gen.forward(ai, { questionText: 'Read Notebook stock' }, opts)).available;
        assert.equal(available, 7);
        assert.equal(executions, 1);
        assert.equal(formats, 1);
        assert.equal(requests, 2);
        outcomes.push({ streaming, available, executions, formats, requests });
      }
      return { outcomes, proof: 'Unknown names are recoverable; arbitrary handler/formatter errors are not swallowed' };
    },
  },
  {
    id: '03-tools-streaming/prompt-tools',
    title: 'Prompt-tool boundaries and a native host-execution control',
    features: ['functionCallMode prompt', 'tool emulation'],
    modes: ['offline'],
    async run(ctx) {
      let reads = 0;
      const lookupPrice = fn('lookupPrice').description('Read owned product price').arg('productName', f.string())
        .returnsField('priceUsd', f.number()).handler(async ({ productName }) => {
          assert.equal(productName, 'Notebook'); reads++; return { priceUsd: 12 };
        }).build();
      // Use the requested wire keys, not the human-readable field titles.
      const toolOutput = 'lookup_price_product_name: Notebook';
      const mem = new AxMemory();
      const missing = await ax('questionText:string -> priceUsd:number').forward(scriptedAI((request) => {
        assert.equal(request.functions?.length ?? 0, 0);
        const system = request.chatPrompt.find((message) => message.role === 'system');
        assert(system && system.role === 'system');
        assert.match(system.content, /wire key: `lookup_price_product_name`/);
        return reply(toolOutput);
      }, { functions: false }), { questionText: 'Look up Notebook price' },
      { ...options(ctx), mem, functions: [lookupPrice], functionCallMode: 'prompt' });
      const parsedCalls = mem.history(0).flatMap((message) => message.role === 'assistant' ? message.functionCalls ?? [] : []);
      assert.equal(parsedCalls.length, 1);
      assert.equal(parsedCalls[0]?.function.name, 'lookupPrice');
      const parsedParams = parsedCalls[0]?.function.params;
      assert.deepEqual(typeof parsedParams === 'string' ? JSON.parse(parsedParams) : parsedParams, { productName: 'Notebook' });
      // Only classify the pinned non-streaming boundary after proving parsing.
      assert.equal(reads, 0);
      assert.equal(mem.history(0).some((message) => message.role === 'function'), false);
      assert.equal('priceUsd' in missing && missing.priceUsd !== undefined, false);
      const streamMem = new AxMemory();
      let streamedPrice: number | undefined;
      let promptRequests = 0;
      const promptAI = scriptedAI((request) => {
        promptRequests++;
        assert.equal(request.functions?.length ?? 0, 0);
        return chunks([{ index: 0, content: toolOutput, finishReason: 'stop' }]);
      }, { functions: false });
      for await (const chunk of ax('questionText:string -> priceUsd:number').streamingForward(promptAI,
        { questionText: 'Look up Notebook price' }, { ...options(ctx), mem: streamMem, functions: [lookupPrice], functionCallMode: 'prompt' })) {
        if (chunk.delta.priceUsd !== undefined) streamedPrice = chunk.delta.priceUsd;
      }
      const streamCalls = streamMem.history(0).flatMap((message) => message.role === 'assistant' ? message.functionCalls ?? [] : []);
      const streamedCall = streamCalls.find((entry) => entry.function.name === 'lookupPrice');
      assert(streamedCall);
      const streamedParams = streamedCall.function.params;
      assert.deepEqual(typeof streamedParams === 'string' ? JSON.parse(streamedParams) : streamedParams, { productName: 'Notebook' });
      const streamedResult = streamMem.history(0).find((message) => message.role === 'function' && message.functionId === streamedCall.id);
      assert(streamedResult && streamedResult.role === 'function');
      assert.match(streamedResult.result, /"priceUsd"\s*:\s*12/);
      assert.equal(reads, 1);
      assert.equal(promptRequests, 1);
      assert.equal(streamedPrice, undefined);
      // In 25.4.9 the emulated assistant update follows the tool result, ending continuation.
      let priceUsd: number | undefined;
      let toolResultSeen = false;
      const ai = scriptedAI((request, index) => {
        assert.equal(request.functions?.[0]?.name, 'lookupPrice');
        if (index === 0) return chunks([{ index: 0, functionCalls: [call('lookupPrice', { productName: 'Notebook' })], finishReason: 'function_call' }]);
        const assistantCalls = request.chatPrompt.flatMap((message) => message.role === 'assistant' ? message.functionCalls ?? [] : []);
        const priceCall = assistantCalls.find((entry) => entry.function.name === 'lookupPrice');
        assert(priceCall);
        const priceParams = priceCall.function.params;
        assert.deepEqual(typeof priceParams === 'string' ? JSON.parse(priceParams) : priceParams, { productName: 'Notebook' });
        const toolResult = request.chatPrompt.find((message) => message.role === 'function' && message.functionId === priceCall.id);
        assert(toolResult && toolResult.role === 'function');
        assert.match(toolResult.result, /"priceUsd"\s*:\s*12/);
        assert.equal(reads, 2);
        toolResultSeen = true;
        return chunks([{ index: 0, content: 'priceUsd: 12', finishReason: 'stop' }]);
      });
      for await (const chunk of ax('questionText:string -> priceUsd:number').streamingForward(ai,
        { questionText: 'Look up Notebook price' }, { ...options(ctx), functions: [lookupPrice], functionCallMode: 'native' })) {
        if (chunk.delta.priceUsd !== undefined) priceUsd = chunk.delta.priceUsd;
      }
      assert.equal(priceUsd, 12);
      assert.equal(reads, 2);
      assert(toolResultSeen);
      return { result: { priceUsd }, reads, toolResultSeen, parsedPromptCalls: parsedCalls.length, promptRequests,
        nonStreamingPromptExecutionMissing: true, streamingPromptContinuationMissing: true,
        proof: '25.4.9 records non-streaming prompt calls without execution; streaming executes and correlates its result but does not continue. Native functions execute the same handler and produce the grounded final price.' };
    },
  },
  {
    id: '03-tools-streaming/stop-functions',
    title: 'Stop tools finish a host workflow without inventing a final answer',
    features: ['stopFunction string', 'stopFunction array', 'thought preservation'],
    modes: ['offline'],
    async run(ctx) {
      const outcomes = [];
      for (const stopFunction of ['finishReview', ['finishReview', 'escalateReview']]) {
        let submitted = 0;
        const finishReview = fn('finishReview').description('Complete the owned in-memory review')
          .arg('reviewId', f.string()).handler(async ({ reviewId }) => {
            assert.equal(reviewId, 'review-42'); submitted++; return { accepted: true };
          }).build();
        const gen = ax('reviewText:string -> decisionText:string');
        const result = await gen.forward(scriptedAI([{ results: [{ index: 0, thought: 'The review is complete.',
          functionCalls: [call('finishReview', { reviewId: 'review-42' })], finishReason: 'function_call' }] }]),
          { reviewText: 'Complete review-42 in memory' }, { ...options(ctx), functions: [finishReview], stopFunction, showThoughts: true });
        assert.equal(submitted, 1);
        assert.equal(result.decisionText, undefined);
        assert.match(result.thought ?? '', /review is complete/);
        outcomes.push({ stopFunction, submitted, result });
      }
      return { outcomes, proof: 'Stop is workflow completion, not validated answer generation' };
    },
  },
  {
    id: '03-tools-streaming/stream-validation',
    title: 'Streaming guards reject unsafe partial output and reset provisional UI state',
    features: ['streamingForward', 'addStreamingAssert', 'version resets', 'provisional output'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax('requestText:string -> replyText:string');
      // A hard no-secret invariant, never a reward to maximize.
      gen.addStreamingAssert('replyText', (partial) => !partial.includes('SECRET'), 'Do not disclose SECRET');
      const ai = scriptedAI((_request, index) => index === 0
        ? chunks([{ index: 0, content: 'Reply Text: Public preface. ' }, { index: 0, content: 'SECRET' }, { index: 0, finishReason: 'stop' }])
        : chunks([{ index: 0, content: 'Reply Text: Safe ' }, { index: 0, content: 'response.', finishReason: 'stop' }]));
      let version = -1;
      let replyText = '';
      const versions: number[] = [];
      for await (const chunk of gen.streamingForward(ai, { requestText: 'Write a public response without secrets' }, options(ctx))) {
        assert(chunk.version >= version);
        if (chunk.version !== version) {
          version = chunk.version; versions.push(version); replyText = ''; // Replace the provisional UI, never concatenate attempts.
        }
        replyText += chunk.delta.replyText ?? '';
        assert(!replyText.includes('SECRET'));
      }
      assert.equal(replyText, 'Safe response.');
      assert(versions.length >= 2);
      return { replyText, versions, proof: 'Text before final completion is provisional; guards do not make arbitrary text safe' };
    },
  },
  {
    id: '03-tools-streaming/code-and-json-deltas',
    title: 'Merge per sample, preserve punctuation, strip split code fences and Unicode boundaries',
    features: ['streamed code fences', 'partial JSON repair', 'array deltas', 'surrogate pairs', 'sample index'],
    modes: ['offline'],
    async run(ctx) {
      const codeGen = ax('taskBrief:string -> javascriptCode:code(javascript)');
      let code = '';
      for await (const chunk of codeGen.streamingForward(scriptedAI(() => chunks([
        { index: 0, content: 'Javascript Code: ``' }, { index: 0, content: '`javascript\nconsole.log("' },
        { index: 0, content: '\ud83d' }, { index: 0, content: '\ude00");\n``' }, { index: 0, content: '`', finishReason: 'stop' },
      ])), { taskBrief: 'Print a smile' }, options(ctx))) {
        const delta = chunk.delta.javascriptCode ?? '';
        assert(!/[\uD800-\uDBFF]$/.test(delta));
        code += delta;
      }
      assert.equal(code.trim(), 'console.log("😀");');
      const signature = f().input('sourceText', f.string()).output('summaryText', f.string())
        .output('tags', f.string().array()).useStructured().build();
      const samples = new Map<number, { version: number; summaryText: string; tags: string[] }>();
      for await (const chunk of ax(signature).streamingForward(scriptedAI(() => chunks([
        { index: 0, content: '{"summaryText":"literal, t' },
        { index: 0, content: ', n, ] 😀","tags":["alpha",' },
        { index: 0, content: '"beta"]}', finishReason: 'stop' },
      ]), { structuredOutputs: true }), { sourceText: 'Preserve punctuation and two tags' }, options(ctx))) {
        let state = samples.get(chunk.index);
        if (!state || state.version !== chunk.version) {
          state = { version: chunk.version, summaryText: '', tags: [] }; samples.set(chunk.index, state);
        }
        state.summaryText += chunk.delta.summaryText ?? '';
        state.tags.push(...(chunk.delta.tags ?? []));
      }
      assert.equal(samples.get(0)?.summaryText, 'literal, t, n, ] 😀');
      assert.deepEqual(samples.get(0)?.tags, ['alpha', 'beta']);
      return { code, samples: [...samples], proof: 'Real Ax incremental parsing over explicitly scripted chunks' };
    },
  },
  {
    id: '03-tools-streaming/refusal-retry',
    title: 'A refusal after partial text retries from the user turn and resets output version',
    features: ['refusal retries', 'request history cleanup', 'stream versions'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax('questionText:string -> answerText:string');
      let requestCount = 0;
      const ai = scriptedAI((request, index) => {
        requestCount++;
        if (index === 0) {
          let emitted = false;
          return new ReadableStream<AxChatResponse>({ pull(controller) {
            if (!emitted) { emitted = true; controller.enqueue({ results: [{ index: 0, content: 'Answer Text: Provisional ' }] }); }
            else controller.error(new AxAIRefusalError('Owned refusal fixture'));
          } });
        }
        assert.equal(request.chatPrompt.at(-1)?.role, 'user');
        assert.equal(request.chatPrompt.filter((message) => message.role === 'assistant').length, 0);
        return chunks([{ index: 0, content: 'Answer Text: Four.', finishReason: 'stop' }]);
      });
      let version = -1;
      let text = '';
      const versions: number[] = [];
      for await (const chunk of gen.streamingForward(ai, { questionText: 'What is two plus two?' }, options(ctx))) {
        if (chunk.version !== version) { version = chunk.version; versions.push(version); text = ''; }
        text += chunk.delta.answerText ?? '';
      }
      assert.equal(requestCount, 2);
      assert.equal(text, 'Four.');
      assert(versions.length >= 2);
      return { text, requestCount, versions, proof: 'Reset UI state; removing refused history does not undo already presented text' };
    },
  },
  {
    id: '03-tools-streaming/terminal-errors',
    title: 'A valid-looking partial answer is not success after token limit or transport error',
    features: ['terminal streaming errors', 'token limits', 'error wrapping', 'handler failure'],
    modes: ['offline'],
    async run(ctx) {
      for (const finishReason of ['length', 'error'] as const) {
        const gen = ax('questionText:string -> answerText:string');
        await assert.rejects(async () => {
          for await (const _chunk of gen.streamingForward(scriptedAI(() => chunks([
            { index: 0, content: 'Answer Text: four' }, { index: 0, finishReason },
          ])), { questionText: '2+2?' }, { ...options(ctx), maxRetries: 0 })) {
            // A UI may render this delta provisionally, but must not commit it yet.
          }
        }, /Max tokens|error|failed/i);
      }
      const failing = fn('readInventory').description('Demonstrate a host failure').handler(async () => {
        throw new Error('Owned fixture inventory unavailable');
      }).build();
      await assert.rejects(() => ax('questionText:string -> answerText:string').forward(scriptedAI([{ results: [{ index: 0,
        functionCalls: [call('readInventory', {})], finishReason: 'function_call' }] }]), { questionText: 'Read inventory' },
        { ...options(ctx), maxRetries: 0, functions: [failing] }), /inventory unavailable/);
      const valid = fn('readOwnedPolicy').description('Return an owned policy').handler(async () => ({ days: 30 })).build();
      await assert.rejects(() => ax('questionText:string -> answerText:string').forward(scriptedAI([{ results: [{ index: 0,
        functionCalls: [call('readOwnedPolicy', {})], finishReason: 'function_call' }] }]), { questionText: 'Read policy' },
        { ...options(ctx), maxRetries: 0, functions: [valid], functionResultFormatter() { throw new Error('Owned formatter failed'); } }),
        /Owned formatter failed/);
      return { terminalFailuresRejected: ['length', 'error'], handlerFailurePropagated: true };
    },
  },
];
