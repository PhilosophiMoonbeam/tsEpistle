import assert from 'node:assert/strict';
import { ai, type AxAIChromeAIArgs, type AxChatResponse } from '@ax-llm/ax';
import type { Example } from './support.js';

type LanguageModelFixture = NonNullable<AxAIChromeAIArgs['languageModel']>;
type CreateOptions = Parameters<LanguageModelFixture['create']>[0];
type PromptOptions = { responseConstraint?: object; signal?: AbortSignal } | undefined;
const prompt = [{ role: 'user' as const, content: 'What is two plus two?' }];
const noNetwork = async (): Promise<Response> => { throw new Error('Chrome AI must use localCall, not HTTP'); };
function completed(value: AxChatResponse | ReadableStream<AxChatResponse>): AxChatResponse {
  assert.ok(!(value instanceof ReadableStream));
  return value;
}

// Explicit LanguageModel fixtures script browser I/O only. The real public Ax adapter
// maps requests, native schema, successive text, errors and session cleanup in Node.
// They do NOT install/download Gemini Nano or establish browser/model compatibility.
// For the actual button-driven browser path, see browser/chrome-ai.html + chrome-ai.ts.
export const examples: readonly Example[] = [
  {
    id: '33-browser-ai/unsupported-node', title: 'Distinguish lazy construction from an unsupported LanguageModel environment',
    features: ['chrome-ai', 'browser-only', 'unsupported-environment', 'global-restoration'], modes: ['offline'],
    async run(ctx) {
      const saved = new Map(['LanguageModel', 'ai'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      try {
        for (const key of saved.keys()) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: undefined });
        // 25.4.9 does not probe Chrome in the constructor: the first chat rejects.
        const service = ai({ name: 'chrome-ai', options: { fetch: noNetwork } });
        assert.equal(service.getFeatures().functions, false);
        assert.equal(service.getFeatures().streaming, true);
        assert.equal(service.getFeatures().structuredOutputs, true);
        await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }), /Chrome built-in AI \(LanguageModel\) is not available/);
        return { constructor: 'lazy; succeeds without a browser', chat: 'rejects without LanguageModel', apiKey: 'not needed', browserDemo: 'browser/chrome-ai.html' };
      } finally {
        for (const [key, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  },
  {
    id: '33-browser-ai/native-schema-wire', title: 'Map text history, JSON Schema and abort signals; destroy the completed session',
    features: ['chrome-ai', 'LanguageModel-fixture', 'native-json-schema', 'text-history', 'completion-cleanup'], modes: ['offline'],
    async run(ctx) {
      let created: CreateOptions;
      let input: string | undefined;
      let received: PromptOptions;
      let destroyed = 0;
      const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
      const languageModel: LanguageModelFixture = {
        availability: async () => 'available',
        create: async (options) => {
          created = options;
          return {
            prompt: async (text, options) => { input = text; received = options; return '{"answer":4}'; },
            promptStreaming: () => { throw new Error('This fixture expects non-streaming prompt'); },
            destroy: () => { destroyed++; },
          };
        },
      };
      const service = ai({ name: 'chrome-ai', languageModel, options: { fetch: noNetwork } });
      const history = [{ role: 'system' as const, content: 'Answer arithmetic in JSON.' }, { role: 'user' as const, content: 'Remember two.' }, { role: 'assistant' as const, content: 'Two.' }];
      const response = completed(await service.chat({ chatPrompt: [...history, ...prompt], responseFormat: { type: 'json_schema', schema: { name: 'arithmetic', strict: true, schema } } }, { stream: false, abortSignal: ctx.signal }));
      assert.deepEqual(created, { initialPrompts: history, signal: ctx.signal });
      assert.equal(input, prompt[0]?.content);
      assert.deepEqual(received, { responseConstraint: schema, signal: ctx.signal });
      assert.deepEqual(JSON.parse(response.results[0]?.content ?? ''), { answer: 4 });
      assert.equal(destroyed, 1);
      return { answer: 4, nativeSchemaForwarded: true, numericSampling: 'omitted: browser defaults', sessionDestroyed: destroyed, scope: 'adapter protocol, not model quality' };
    },
  },
  {
    id: '33-browser-ai/extension-sampling', title: 'Discover the missing extension sampling parameter or reject before creating a session',
    features: ['chrome-ai', 'LanguageModel-fixture', 'extension-temperature-topK-pair', 'params-defaults', 'capabilities-legacy-defaults'], modes: ['offline'],
    async run(ctx) {
      const created: CreateOptions[] = [];
      let defaultsRead = 0;
      let destroyed = 0;
      const languageModel: LanguageModelFixture = {
        availability: async () => 'available',
        params: async () => { defaultsRead++; return { defaultTemperature: 1, maxTemperature: 2, defaultTopK: 3, maxTopK: 128 }; },
        create: async (options) => {
          created.push(options);
          return { prompt: async () => '4', promptStreaming: () => { throw new Error('Unexpected streaming'); }, destroy: () => { destroyed++; } };
        },
      };
      for (const config of [{ temperature: 0.4 }, { topK: 5 }, { temperature: 0.2, topK: 7 }]) {
        const service = ai({ name: 'chrome-ai', languageModel, config, options: { fetch: noNetwork } });
        completed(await service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }));
      }
      assert.deepEqual(created.map((options) => [options?.temperature, options?.topK]), [[0.4, 3], [1, 5], [0.2, 7]]);
      assert.equal(defaultsRead, 2, 'An explicit pair needs no defaults discovery');
      const legacy = { ...languageModel, availability: undefined, params: undefined, capabilities: async () => ({ available: 'readily' as const, defaultTemperature: 0.8, defaultTopK: 9 }) };
      completed(await ai({ name: 'chrome-ai', languageModel: legacy, config: { temperature: 0.3 }, options: { fetch: noNetwork } }).chat({ chatPrompt: prompt }, { stream: false }));
      assert.equal(created.at(-1)?.topK, 9);
      const missingDefaults = { ...languageModel, params: undefined };
      await assert.rejects(() => ai({ name: 'chrome-ai', languageModel: missingDefaults, config: { temperature: 0.5 }, options: { fetch: noNetwork } }).chat({ chatPrompt: prompt }, { stream: false }), /sampling requires both temperature and topK/);
      assert.equal(created.length, 4, 'Missing defaults fail before session creation');
      assert.equal(destroyed, 4);
      return { samplingPairs: created.map((options) => [options?.temperature, options?.topK]), prerequisite: 'Legacy numeric sampling is for Chrome extensions, not ordinary web pages' };
    },
  },
  {
    id: '33-browser-ai/unavailable-and-failure-cleanup', title: 'Reject unavailable devices; close sessions after prompt and streaming-start failures',
    features: ['chrome-ai', 'LanguageModel-fixture', 'availability', 'failure-cleanup', 'close-fallback', 'no-embeddings'], modes: ['offline'],
    async run(ctx) {
      let creates = 0;
      let closed = 0;
      let failPrompt = true;
      let transports = 0;
      const languageModel: LanguageModelFixture = {
        availability: async () => 'available',
        create: async () => {
          creates++;
          return { prompt: async () => { if (failPrompt) throw new Error('fixture prompt failure'); return '4'; }, promptStreaming: () => { throw new Error('fixture streaming-start failure'); }, close: () => { closed++; } };
        },
      };
      for (const availability of ['unavailable', 'no'] as const) {
        await assert.rejects(() => ai({ name: 'chrome-ai', languageModel: { ...languageModel, availability: async () => availability }, options: { fetch: noNetwork } }).chat({ chatPrompt: prompt }, { stream: false }), /model is not available on this device/);
      }
      assert.equal(creates, 0);
      const service = ai({ name: 'chrome-ai', languageModel, options: { fetch: async () => { transports++; throw new Error('Chrome AI must not use HTTP'); } } });
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }), /fixture prompt failure/);
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: true, abortSignal: ctx.signal }), /fixture streaming-start failure/);
      assert.equal(closed, 2);
      assert.equal(creates, 2);
      failPrompt = false;
      const positiveControl = completed(await service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }));
      assert.equal(positiveControl.results[0]?.content, '4');
      assert.equal(creates, 3, 'The supported chat operation creates a real adapter session');
      assert.equal(closed, 3);
      assert.equal(transports, 0);
      const beforeEmbedding = { creates, closed, transports };
      await assert.rejects(() => service.embed({ texts: ['No embedding endpoint exists'] }));
      assert.deepEqual({ creates, closed, transports }, beforeEmbedding, 'Unsupported embeddings reject without creating a session or attempting HTTP');
      return { unavailableCreates: 0, failureSessionsClosed: 2, positiveControl: '4', tools: 'not supported; advertised false', embeddings: 'rejected before session/transport', media: 'text only in this adapter' };
    },
  },
  {
    id: '33-browser-ai/successive-stream-cleanup', title: 'Pass successive text unchanged and destroy ReadableStream/AsyncIterable sessions on every exit',
    features: ['chrome-ai', 'LanguageModel-fixture', 'successive-text', 'ReadableStream', 'AsyncIterable', 'stream-completion-cleanup', 'stream-cancel-cleanup', 'stream-failure-cleanup'], modes: ['offline'],
    async run(ctx) {
      const outcomes: string[] = [];
      for (const kind of ['readable', 'iterable'] as const) {
        for (const exit of ['complete', 'cancel', 'failure'] as const) {
          let destroyed = 0;
          let read = 0;
          const { promise: destruction, resolve: markDestroyed } = Promise.withResolvers<void>();
          const { promise: cancelled, resolve: finishCancelled } = Promise.withResolvers<IteratorResult<string>>();
          const next = async (): Promise<IteratorResult<string>> => {
            if (read++ === 0) return { done: false, value: 'Hel' };
            if (exit === 'cancel') return cancelled;
            if (exit === 'failure') throw new Error('fixture stream read failure');
            if (read === 2) return { done: false, value: 'Hello' };
            return { done: true, value: undefined };
          };
          const languageModel: LanguageModelFixture = {
            availability: async () => 'available',
            create: async () => ({
              prompt: async () => { throw new Error('Unexpected non-streaming prompt'); },
              promptStreaming: () => kind === 'readable'
                ? new ReadableStream<string>({ async pull(controller) { try { const item = await next(); if (item.done) controller.close(); else controller.enqueue(item.value); } catch (error) { controller.error(error); } } })
                : { [Symbol.asyncIterator]: () => ({ next }) },
              destroy: () => { destroyed++; finishCancelled({ done: true, value: undefined }); markDestroyed(); },
            }),
          };
          const service = ai({ name: 'chrome-ai', languageModel, options: { fetch: noNetwork } });
          const response = await service.chat({ chatPrompt: prompt }, { stream: true, abortSignal: ctx.signal });
          assert.ok(response instanceof ReadableStream);
          const reader = response.getReader();
          const text: string[] = [];
          try {
            if (exit === 'cancel') {
              assert.equal((await reader.read()).value?.results[0]?.content, 'Hel');
              assert.equal(destroyed, 0, 'A pending stream must not finish before consumer cancellation');
              await reader.cancel('fixture user cancelled');
            } else if (exit === 'failure') {
              await assert.rejects(async () => { while (!(await reader.read()).done) { /* consume until the real adapter propagates the read error */ } }, /fixture stream read failure/);
            } else {
              while (true) { const item = await reader.read(); if (item.done) break; text.push(item.value.results[0]?.content ?? ''); }
              assert.deepEqual(text, ['Hel', 'Hello'], 'The adapter neither accumulates nor trims even overlapping native chunks');
            }
            await destruction;
            assert.equal(destroyed, 1);
          } finally { reader.releaseLock(); }
          outcomes.push(`${kind}:${exit}:destroyed-once`);
        }
      }
      return { outcomes, scope: 'Node adapter protocol fixtures; actual browser cancellation uses an AbortController (see browser entry)' };
    },
  },
];
