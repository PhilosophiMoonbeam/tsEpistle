import assert from 'node:assert/strict';
import {
  ai, ax, axAIProfiles, axGetAIProfile, axGetSupportedAIModels,
  AxAIOpenAIModel, AxAIOpenAIEmbedModel, AxAIGoogleGeminiModel,
  AxAIGoogleGeminiEmbedModel, AxAIServiceAbortedError,
  AxAIServiceAuthenticationError, AxAIAnthropicModel, AxAIMetaModel,
  type AxChatRequest, type AxChatResponse,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

// Transport fixtures below contain deterministic provider responses, not model-quality evidence.
// No fetch escapes these fixtures; real credentials are owned by the CLI's environment setup.
type Wire = Record<string, unknown>;
function body(init?: RequestInit): Wire {
  assert.equal(typeof init?.body, 'string');
  const parsed: unknown = JSON.parse(String(init?.body));
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Wire;
}
function completed(value: AxChatResponse | ReadableStream<AxChatResponse>): AxChatResponse {
  assert.ok(!(value instanceof ReadableStream), 'This task requires a completed, non-streaming response');
  return value;
}
function chatResponse(content = 'Answer: 4', extra: Wire = {}): Response {
  return Response.json({ id: 'fixture-chat', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, ...extra });
}
const prompt: AxChatRequest['chatPrompt'] = [{ role: 'user', content: 'What is 2 + 2?' }];
const tool = { name: 'lookupPolicy', description: 'Read the refund policy', parameters: { type: 'object' as const, properties: {} } };

export const examples: readonly Example[] = [
  {
    id: '04-providers/custom-thinking-levels', title: 'Customize legacy token budgets separately from adaptive thinking effort',
    features: ['thinkingTokenBudgetLevels', 'effortLevelMapping', 'legacy budget tokens', 'adaptive thinking'], modes: ['offline'],
    async run(ctx) {
      const requests: Wire[] = [];
      const fixture: typeof fetch = async (_url, init) => {
        requests.push(body(init));
        return Response.json({ id: 'owned-thinking', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: '4' }], stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 1 } });
      };
      const levels = { minimal: 2048, low: 8000, medium: 16000, high: 25000, highest: 40000 };
      const effort = { minimal: 'low', low: 'medium', medium: 'high', high: 'high', highest: 'max' } as const;
      for (const model of [AxAIAnthropicModel.Claude45Opus, AxAIAnthropicModel.Claude48Opus]) {
        const service = ai({ name: 'anthropic', apiKey: 'fixture-only',
          config: { model, thinkingTokenBudgetLevels: levels, effortLevelMapping: effort },
          options: { fetch: fixture } });
        const response = completed(await service.chat({ chatPrompt: prompt, modelConfig: { maxTokens: 20000 } },
          { stream: false, thinkingTokenBudget: 'medium', showThoughts: false, abortSignal: ctx.signal }));
        assert.equal(response.results[0]?.content, '4');
      }
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]?.thinking, { type: 'enabled', budget_tokens: 16000 });
      assert.deepEqual(requests[1]?.thinking, { type: 'adaptive', display: 'omitted' });
      for (const request of requests) assert.equal((request.output_config as Wire)?.effort, 'high');
      assert.equal(requests[0]?.max_tokens, 20000);
      return { legacyBudgetTokens: 16000, adaptiveUsesNumericBudget: false, mappedEffort: 'high',
        boundary: 'Actual adapter mapping with scripted responses. Adaptive models use effort, not the custom numeric budget; hidden thoughts do not disable thinking or establish lower billing.' };
    },
  },
  {
    id: '04-providers/generated-image', title: 'Receive a generated image asset through native Meta Responses chat',
    features: ['Meta Muse Image', 'image generation', 'AxChatImageOutput', 'stateless image replay'], modes: ['offline'],
    async run(ctx) {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==';
      const requests: Wire[] = [];
      const service = ai({ name: 'meta', apiKey: 'fixture-only',
        config: { model: AxAIMetaModel.MuseImage10, imageGeneration: { outputFormat: 'png' } },
        options: { fetch: async (_url, init) => {
          requests.push(body(init));
          return Response.json({ id: `owned-image-${requests.length}`, status: 'completed',
            output: [{ type: 'image_generation_call', id: 'image-asset-1', status: 'completed', result: png }],
            usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } });
        } } });
      const first = completed(await service.chat({ chatPrompt: [
        { role: 'user', content: 'Create a small plain icon for an owned demonstration.' },
      ] }, { stream: false, abortSignal: ctx.signal }));
      const images = first.results.flatMap(result => result.images ?? []);
      assert.equal(images.length, 1);
      assert.equal(images[0]?.id, 'image-asset-1');
      assert.equal(images[0]?.mimeType, 'image/png');
      assert.equal(images[0]?.data, png);
      assert.deepEqual(Buffer.from(png, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await service.chat({ chatPrompt: [
        { role: 'user', content: 'Create an icon.' },
        { role: 'assistant', images },
        { role: 'user', content: 'Keep the earlier asset as conversation context.' },
      ] }, { stream: false, abortSignal: ctx.signal });
      const replay = requests[1]?.input;
      assert(Array.isArray(replay));
      assert(replay.some(item => item.type === 'image_generation_call' && item.id === 'image-asset-1' && item.result === null));
      await assert.rejects(() => service.chat({ chatPrompt: prompt, functions: [tool] }, { stream: false }));
      assert.equal(requests.length, 2, 'Image models reject ordinary function tools before transport');
      return { mimeType: images[0]?.mimeType, imageId: images[0]?.id, decodedBytes: Buffer.from(png, 'base64').length,
        replayUsesOpaqueId: true, ordinaryToolsRejected: true,
        boundary: 'The real Responses adapter normalizes an explicitly scripted valid PNG and its replay ID. Hosts must decode and validate untrusted assets before use; SDK normalization is not image validation. This is not live image synthesis, artistic quality, or a bounding-box decision.' };
    },
  },
  {
    id: '04-providers/raw-chat-stream-choice', title: 'Choose a completed raw chat response instead of assuming the streaming default',
    features: ['chat', 'streaming default', 'stream false', 'raw response consumption'], modes: ['offline'],
    async run(ctx) {
      const modes: boolean[] = [];
      const service = ai({ name: 'openai', apiKey: 'fixture-only',
        config: { model: AxAIOpenAIModel.GPT4OMini },
        options: { fetch: async (_url, init) => {
          const streaming = body(init).stream === true; modes.push(streaming);
          if (!streaming) return chatResponse('Four.');
          const chunk = { id: 'owned-chat', choices: [{ index: 0, delta: { content: 'Four.' }, finish_reason: 'stop' }] };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } });
        } } });
      const stream = await service.chat({ chatPrompt: prompt }, { abortSignal: ctx.signal });
      assert(stream instanceof ReadableStream);
      const reader = stream.getReader(); let text = '';
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          text += next.value.results.map(result => result.content ?? '').join(''); }
      } finally { reader.releaseLock(); }
      const response = completed(await service.chat({ chatPrompt: prompt },
        { stream: false, abortSignal: ctx.signal }));
      assert.equal(text, 'Four.');
      assert.equal(response.results[0]?.content, 'Four.');
      assert.deepEqual(modes, [true, false]);
      return { streamed: text, completed: response.results[0]?.content, modes,
        boundary: 'Explicit stream:false gives a completed chat result. The finite transport fixture validates SDK response modes, not provider answer quality.' };
    },
  },
  {
    id: '04-providers/configured-generation', title: 'Use the environment-configured generation service, not a model-name guess',
    features: ['factory', 'environment-credentials', 'generation', 'bounded-options'], modes: ['offline', 'live'],
    async run(ctx) {
      // Live: the runner creates ctx.ai from explicit provider/model/key environment variables.
      // Offline: only the model answer is scripted; Ax still builds and parses the signature.
      const service = ctx.mode === 'live' ? ctx.ai : scriptedAI([{ results: [{ index: 0, content: 'Answer: 4', finishReason: 'stop' }] }]);
      const program = ax('question:string -> answer:number');
      const result = await program.forward(service, { question: 'What is 2 + 2? Return the number.' }, options(ctx));
      assert.equal(result.answer, 4);
      return { answer: result.answer, scope: ctx.mode === 'live' ? 'configured-provider generation' : 'scripted model answer; real Ax parsing' };
    },
  },
  {
    id: '04-providers/catalog-preset-operation', title: 'Choose a catalog model, map a logical preset, and generate',
    features: ['factory', 'profile-catalog', 'model-catalog', 'model-presets', 'configuration-precedence'], modes: ['offline'],
    async run(ctx) {
      const profile = axGetAIProfile('openai');
      assert.ok(axAIProfiles().some((row) => row.id === profile.id));
      const catalog = axGetSupportedAIModels({ type: 'text' }).find((row) => row.name === 'openai');
      assert.ok(catalog);
      const selected = catalog.models.find((row) => row.name === AxAIOpenAIModel.GPT4OMini);
      assert.ok(selected, 'Choose a concrete bundled text model, not the cheapest unverified alias');
      let sent: Wire | undefined;
      const service = ai({ name: 'openai', apiKey: 'fixture-only', config: { model: AxAIOpenAIModel.GPT4OMini, maxTokens: 96 }, models: [{ key: 'arithmetic', model: AxAIOpenAIModel.GPT4OMini, description: 'Evaluated for small arithmetic tasks', modelConfig: { maxTokens: 64 } }], options: { fetch: async (_url, init) => { sent = body(init); return chatResponse('4'); } } });
      const result = completed(await service.chat({ model: 'arithmetic', chatPrompt: prompt, modelConfig: { maxTokens: 32 } }, { stream: false, abortSignal: ctx.signal }));
      assert.equal(result.results[0]?.content, '4');
      assert.equal(sent?.model, AxAIOpenAIModel.GPT4OMini);
      assert.equal(sent?.max_completion_tokens ?? sent?.max_tokens, 32);
      assert.throws(() => axGetAIProfile('not-a-provider'), /unknown|unsupported|not found/i);
      assert.throws(() => ai({ name: 'openai-compatible', apiKey: 'fixture-only' }), /requires apiURL/);
      return { profile: profile.id, model: selected.name, preset: 'arithmetic', maxTokens: 32, answer: result.results[0]?.content };
    },
  },
  {
    id: '04-providers/renewable-credentials', title: 'Renew host-owned bearer credentials for chat and embeddings',
    features: ['credential-provider', 'embedding-wire', 'authentication-error-boundary'], modes: ['offline'],
    async run(ctx) {
      const operations: string[] = [];
      const headers: string[] = [];
      const service = ai({ name: 'openai-compatible', apiURL: 'https://fixture.invalid/v1', apiKey: 'stale-fixture', config: { model: 'hosted-text', embedModel: 'hosted-vector' }, credentialProvider: async ({ operation, method, url }) => { operations.push(operation); assert.equal(method, 'POST'); assert.match(url, /fixture\.invalid/); return { Authorization: `Bearer fresh-${operations.length}` }; }, options: { retry: { maxRetries: 0 }, fetch: async (url, init) => { headers.push(new Headers(init?.headers).get('authorization') ?? ''); return String(url).includes('embeddings') ? Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 2, total_tokens: 2 } }) : chatResponse('4'); } } });
      completed(await service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }));
      const vectors = await service.embed({ texts: ['refund policy'] }, { abortSignal: ctx.signal });
      assert.deepEqual(vectors.embeddings, [[1, 0]]);
      assert.deepEqual(operations, ['chat', 'embed']);
      assert.deepEqual(headers, ['Bearer fresh-1', 'Bearer fresh-2']);
      let attempts = 0;
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, fetch: async () => { attempts++; return Response.json({ error: { message: 'expired fixture token' } }, { status: 401 }); } }), AxAIServiceAuthenticationError);
      assert.equal(attempts, 1, 'A completed 401 must not replay generation');
      return { operations, freshHeadersUsed: headers.length, vectors: vectors.embeddings, unauthorizedAttempts: attempts, prerequisite: 'Host supplies renewable tokens; Ax does not perform ADC discovery' };
    },
  },
  {
    id: '04-providers/deployment-reasoning-dialects', title: 'The deployment profile, not a DeepSeek-looking ID, owns reasoning syntax',
    features: ['deployment-profiles', 'reasoning-defaults', 'tool-choice-constraints', 'custom-endpoint'], modes: ['offline'],
    async run(ctx) {
      const sent = new Map<string, Wire>();
      for (const name of ['deepseek', 'together', 'openai-compatible'] as const) {
        const model = name === 'deepseek' ? 'deepseek-v4-flash' : 'deepseek-ai/DeepSeek-V4-Flash';
        const service = ai({ name, apiKey: 'fixture-only', apiURL: 'https://fixture.invalid/v1', config: { model }, options: { fetch: async (_url, init) => { sent.set(name, body(init)); return chatResponse('4'); } } });
        const response = completed(await service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: ctx.signal }));
        assert.equal(response.results[0]?.content, '4');
        if (name === 'deepseek') {
          const calls = sent.size;
          await assert.rejects(() => service.chat({ chatPrompt: prompt, functions: [tool], functionCall: { type: 'function', function: { name: tool.name } } }, { stream: false }), /tool.choice|forced|function.call/i);
          assert.equal(sent.size, calls);
        }
      }
      assert.deepEqual(sent.get('deepseek')?.thinking, { type: 'enabled' });
      assert.equal(sent.get('deepseek')?.reasoning_effort, 'max');
      assert.equal(sent.get('openai-compatible')?.thinking, undefined);
      assert.equal(sent.get('openai-compatible')?.reasoning_effort, undefined);
      // Together has its own verified rule; it is not the native DeepSeek object.
      assert.notDeepEqual(sent.get('together')?.thinking, sent.get('deepseek')?.thinking);
      return { native: { thinking: sent.get('deepseek')?.thinking, effort: sent.get('deepseek')?.reasoning_effort }, together: sent.get('together'), customDoesNotInferReasoning: true, scope: 'wire contracts only, not equivalent model quality' };
    },
  },
  {
    id: '04-providers/bedrock-transport-constraints', title: 'Bedrock Chat native schema differs from tools and from Responses/Converse',
    features: ['bedrock-chat', 'native-json-schema', 'reasoning-tool-constraints', 'pre-transport-rejection', 'service-tiers'], modes: ['offline'],
    async run(ctx) {
      let calls = 0;
      let sent: Wire | undefined;
      const service = ai({ name: 'amazon-bedrock', apiURL: 'https://fixture.invalid/openai/v1', apiKey: 'fixture-only', config: { model: 'global.openai.gpt-6-astra' }, options: { fetch: async (url, init) => { calls++; assert.match(String(url), /chat\/completions/); sent = body(init); return chatResponse('{"answer":4}'); } } });
      const response = completed(await service.chat({ chatPrompt: prompt, responseFormat: { type: 'json_schema', schema: { name: 'arithmetic', strict: true, schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } } } }, { stream: false, thinkingTokenBudget: 'high', serviceTier: 'standard', abortSignal: ctx.signal }));
      assert.equal(response.results[0]?.content, '{"answer":4}');
      assert.equal(sent?.reasoning_effort, 'high');
      assert.equal(sent?.temperature, undefined);
      assert.equal(sent?.top_p, undefined);
      assert.equal(sent?.stop, undefined);
      assert.equal((sent?.response_format as Wire)?.type, 'json_schema');
      await assert.rejects(() => service.chat({ chatPrompt: prompt, functions: [tool] }, { stream: false }), /function tools|function.*support|tools/i);
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, thinkingTokenBudget: 'none' }), /reason|thinking|none/i);
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, serviceTier: 'flex' }), /tier/i);
      assert.equal(calls, 1);
      const sol = ai({ name: 'amazon-bedrock', apiURL: 'https://fixture.invalid/openai/v1', apiKey: 'fixture-only', config: { model: 'us.openai.gpt-6-sol' }, options: { fetch: async (_url, init) => { calls++; sent = body(init); return chatResponse('4'); } } });
      await assert.rejects(() => sol.chat({ chatPrompt: prompt, functions: [tool] }, { stream: false }), /reason|effort|none|tools/i);
      completed(await sol.chat({ chatPrompt: prompt, functions: [tool] }, { stream: false, thinkingTokenBudget: 'none' }));
      assert.equal(sent?.reasoning_effort, 'none');
      assert.ok(Array.isArray(sent?.tools));
      assert.equal(calls, 2);
      return { schemaAnswer: 4, astraRejected: ['function tools', 'reasoning none', 'flex tier'], solToolsRequire: 'explicit none', transport: 'Bedrock OpenAI Chat; reasoning+tools requires Responses, native AWS Converse is a separate package' };
    },
  },
  {
    id: '04-providers/tiers-and-cache-opt-in', title: 'Apply tier precedence and cache markers only on the supporting deployment',
    features: ['service-tier-precedence', 'served-tier-normalization', 'openai-cache', 'azure-distinction'], modes: ['offline'],
    async run(ctx) {
      const bodies: Wire[] = [];
      const fixture: typeof fetch = async (_url, init) => { bodies.push(body(init)); return chatResponse('4', { service_tier: 'default' }); };
      const service = ai({ name: 'openai', apiKey: 'fixture-only', config: { model: AxAIOpenAIModel.GPT56Sol }, models: [{ key: 'review', model: AxAIOpenAIModel.GPT56Sol, description: 'Stable conversation route', serviceTier: 'flex' }], options: { serviceTier: 'priority', fetch: fixture } });
      const response = completed(await service.chat({ model: 'review', chatPrompt: [{ role: 'system', content: 'Arithmetic only.', cache: true }, ...prompt] }, { stream: false, serviceTier: 'standard', thinkingTokenBudget: 'none', contextCache: {}, promptCacheKey: 'fixture:conversation-7', abortSignal: ctx.signal }));
      assert.equal(bodies[0]?.service_tier, 'default');
      assert.equal(bodies[0]?.prompt_cache_key, 'fixture:conversation-7');
      assert.match(JSON.stringify(bodies[0]), /prompt_cache_breakpoint/);
      assert.equal(response.modelUsage?.tokens?.serviceTier, 'standard');
      const azure = ai({ name: 'azure-openai', apiKey: 'fixture-only', resourceName: 'fixture', deploymentName: 'gpt56-review', config: { model: AxAIOpenAIModel.GPT56Sol }, options: { fetch: fixture } });
      // Ax 25.4.9 does not enable OpenAI's context-cache contract on Azure deployments.
      await assert.rejects(() => azure.chat({ chatPrompt: [{ role: 'system', content: 'Arithmetic only.', cache: true }, ...prompt] }, { stream: false, thinkingTokenBudget: 'none', contextCache: {} }), /context caching is not supported/i);
      assert.equal(bodies.length, 1, 'Unsupported Azure caching must reject before transport');
      return { requestedTier: 'standard', servedTier: response.modelUsage?.tokens?.serviceTier, cacheKey: bodies[0]?.prompt_cache_key, azureCacheRejectedBeforeTransport: true };
    },
  },
  {
    id: '04-providers/embedding-dialects', title: 'Embed a concrete retrieval query across OpenAI, Gemini and Vertex wire shapes',
    features: ['embeddings', 'dimensions', 'gemini-batch-embeddings', 'vertex-global-single-text'], modes: ['offline'],
    async run(ctx) {
      const requests: { url: string; body: Wire }[] = [];
      const capture = (response: unknown): typeof fetch => async (url, init) => { requests.push({ url: String(url), body: body(init) }); return Response.json(response); };
      const openai = ai({ name: 'openai', apiKey: 'fixture-only', config: { embedModel: AxAIOpenAIEmbedModel.TextEmbedding3Small, dimensions: 2 }, options: { fetch: capture({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], usage: { prompt_tokens: 5, total_tokens: 5 } }) } });
      const first = await openai.embed({ texts: ['refund policy', 'shipping times'] }, { abortSignal: ctx.signal });
      assert.deepEqual(first.embeddings, [[1, 0], [0, 1]]);
      assert.deepEqual(requests[0]?.body, { model: 'text-embedding-3-small', input: ['refund policy', 'shipping times'], dimensions: 2 });
      const gemini = ai({ name: 'google-gemini', apiKey: 'fixture-only', config: { model: AxAIGoogleGeminiModel.Gemini35Flash, embedModel: AxAIGoogleGeminiEmbedModel.GeminiEmbedding2, dimensions: 2 }, options: { fetch: capture({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }) } });
      assert.deepEqual((await gemini.embed({ texts: ['refund policy', 'shipping times'] })).embeddings, first.embeddings);
      assert.match(requests[1]?.url ?? '', /:batchEmbedContents/);
      assert.deepEqual(requests[1]?.body.requests, ['refund policy', 'shipping times'].map((text) => ({ model: 'models/gemini-embedding-2', content: { parts: [{ text }] }, outputDimensionality: 2 })));
      // Gemini's Vertex mode requires a host-owned token callback, not a static API-key string.
      const vertex = ai({ name: 'google-gemini', apiKey: async () => 'fixture-access-token', projectId: 'fixture-project', region: 'us-central1', config: { embedModel: AxAIGoogleGeminiEmbedModel.GeminiEmbedding2, dimensions: 2 }, options: { fetch: capture({ embedding: { values: [1, 0] } }) } });
      assert.deepEqual((await vertex.embed({ texts: ['task: search result | query: refund policy'] })).embeddings, [[1, 0]]);
      assert.match(requests[2]?.url ?? '', /aiplatform\.googleapis\.com.*locations\/global.*:embedContent/);
      assert.equal(requests[2]?.body.taskType, undefined);
      await assert.rejects(() => vertex.embed({ texts: ['refund policy', 'shipping times'] }), /one text per request/);
      assert.equal(requests.length, 3);
      return { openai: first.embeddings, geminiBatch: 2, vertexLocation: 'global', rejectedVertexBatch: true, scope: 'deterministic vectors prove mapping, not retrieval quality; live embedding needs a configured embedding operation/model' };
    },
  },
  {
    id: '04-providers/cancellation-and-error-privacy', title: 'Cancel before transport and preserve typed errors without leaking prompt bodies',
    features: ['abort-signal', 'typed-provider-errors', 'error-body-privacy', 'per-call-fetch'], modes: ['offline'],
    async run() {
      let transports = 0;
      const service = ai({ name: 'openai', apiKey: 'fixture-only', config: { model: AxAIOpenAIModel.GPT4OMini }, options: { includeRequestBodyInErrors: false, retry: { maxRetries: 0 }, fetch: async () => { transports++; return chatResponse(); } } });
      const controller = new AbortController();
      controller.abort('User cancelled this arithmetic request');
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, abortSignal: controller.signal }), AxAIServiceAbortedError);
      assert.equal(transports, 0);
      let caught: unknown;
      try { await service.chat({ chatPrompt: [{ role: 'user', content: 'private-customer-fixture-42' }] }, { stream: false, fetch: async () => Response.json({ error: { message: 'fixture unauthorized' } }, { status: 401 }) }); } catch (error) { caught = error; }
      assert.ok(caught instanceof AxAIServiceAuthenticationError);
      assert.doesNotMatch(JSON.stringify(caught), /private-customer-fixture-42/);
      assert.doesNotMatch(caught.message, /private-customer-fixture-42/);
      assert.ok(caught.requestBody, 'Privacy controls serialization, not privileged direct access');
      return { cancelledBeforeTransport: true, error: caught.name, serializedPromptOmitted: true };
    },
  },
  {
    id: '04-providers/gemini-thinking-schema', title: 'Resolve a Gemini preset before mapping thinking and native JSON Schema',
    features: ['gemini-thinking-levels', 'native-json-schema', 'generation-config', 'gemini-service-tier'], modes: ['offline'],
    async run(ctx) {
      let sent: Wire | undefined;
      const service = ai({ name: 'google-gemini', apiKey: 'fixture-only', config: { model: AxAIGoogleGeminiModel.Gemini25Flash }, models: [{ key: 'reason', model: AxAIGoogleGeminiModel.Gemini38Flash, description: 'Explicitly chosen Gemini 3.8 reasoning task' }], options: { fetch: async (_url, init) => { sent = body(init); return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: '{"answer":4}' }] }, finishReason: 'STOP' }] }); } } });
      // Ax 25.4.9 rejects explicit maxTokens with Gemini thinkingLevel; retain thinking and schema.
      await assert.rejects(() => service.chat({ model: 'reason', chatPrompt: prompt, modelConfig: { maxTokens: 128 } }, { stream: false, thinkingTokenBudget: 'minimal' }), /cannot set maxTokens.*thinkingLevel/i);
      assert.equal(Boolean(sent), false, 'The unsupported combination must reject before transport');
      const response = completed(await service.chat({ model: 'reason', chatPrompt: prompt, responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } } }, { stream: false, thinkingTokenBudget: 'minimal', showThoughts: false, serviceTier: 'flex', abortSignal: ctx.signal }));
      assert.equal(response.results[0]?.content, '{"answer":4}');
      const generation = sent?.generationConfig as Wire;
      assert.equal(generation.maxOutputTokens, undefined, 'Only the incompatible explicit token control was removed');
      assert.equal(generation.responseMimeType, 'application/json');
      assert.deepEqual(generation.responseJsonSchema, { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] });
      assert.deepEqual(generation.thinkingConfig, { thinkingLevel: 'low', includeThoughts: false });
      assert.equal(generation.responseSchema, undefined, 'Use the current JSON Schema field, not the legacy OpenAPI subset');
      assert.equal(sent?.service_tier, 'flex');
      return { answer: 4, presetResolvedBeforeThinking: true, thinking: generation.thinkingConfig, schemaField: 'responseJsonSchema', serviceTier: sent?.service_tier };
    },
  },
  {
    id: '04-providers/anthropic-native-schema-and-budgets', title: 'Use native schema where forced tools are forbidden and bound task budgets',
    features: ['anthropic-adaptive-thinking', 'native-schema', 'forced-tool-rejection', 'task-budget', 'fast-mode'], modes: ['offline'],
    async run(ctx) {
      let sent: Wire | undefined;
      let calls = 0;
      const service = ai({ name: 'anthropic', apiKey: 'fixture-only', config: { model: AxAIAnthropicModel.Claude55Sonnet }, options: { fetch: async (_url, init) => { calls++; sent = body(init); return Response.json({ id: 'fixture-native', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"answer":4}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }); } } });
      const response = completed(await service.chat({ chatPrompt: prompt, responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } }, modelConfig: { speed: 'fast', effort: 'high', taskBudget: { type: 'tokens', total: 20_000 } } }, { stream: false, thinkingTokenBudget: 'medium', showThoughts: false, abortSignal: ctx.signal }));
      assert.equal(response.results[0]?.content, '{"answer":4}');
      assert.deepEqual(sent?.thinking, { type: 'adaptive', display: 'omitted' });
      assert.equal(sent?.speed, 'fast');
      assert.equal(sent?.temperature, undefined);
      assert.equal(sent?.top_p, undefined);
      assert.equal(sent?.top_k, undefined);
      assert.equal((sent?.output_config as Wire)?.effort, 'high');
      assert.ok((sent?.output_config as Wire)?.format);
      await assert.rejects(() => service.chat({ chatPrompt: prompt, functions: [tool], functionCall: 'required' }, { stream: false }), /forced|tool.choice|function.call/i);
      await assert.rejects(() => service.chat({ chatPrompt: prompt, modelConfig: { taskBudget: { type: 'tokens', total: 19_999 } } }, { stream: false }), /20.?000|task.?budget/i);
      assert.equal(calls, 1);
      return { nativeSchemaAnswer: 4, display: 'omitted', effort: 'high', taskBudget: 20_000, forcedToolsRejected: true, scope: 'Anthropic-only opt-ins are not portable provider configuration' };
    },
  },
  {
    id: '04-providers/openai-automatic-responses', title: 'Let the OpenAI factory choose GPT-6 Responses and its own cache/reasoning dialect',
    features: ['openai-factory-auto-responses', 'gpt6-thinking-ladder', 'gpt6-cache-ttl', 'served-tier-normalization'], modes: ['offline'],
    async run(ctx) {
      let sent: Wire | undefined;
      let calls = 0;
      const service = ai({ name: 'openai', apiKey: 'fixture-only', config: { model: AxAIOpenAIModel.GPT61Sol }, options: { fetch: async (url, init) => { calls++; assert.match(String(url), /\/responses$/); sent = body(init); return Response.json({ id: 'fixture-gpt6', object: 'response', status: 'completed', model: 'gpt-6.1-sol', service_tier: 'fast', output: [{ id: 'fixture-final', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '4', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }); } } });
      const response = completed(await service.chat({ chatPrompt: [{ role: 'system', content: 'Arithmetic only.', cache: true }, ...prompt] }, { stream: false, thinkingTokenBudget: 'highest', serviceTier: 'priority', contextCache: {}, promptCacheKey: 'fixture:gpt6-conversation', abortSignal: ctx.signal }));
      assert.equal(response.results[0]?.content, '4');
      assert.equal((sent?.reasoning as Wire)?.effort, 'max', 'Responses has max; Chat Completions has xhigh instead');
      assert.deepEqual(sent?.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
      assert.match(JSON.stringify(sent), /prompt_cache_breakpoint/);
      assert.equal(response.modelUsage?.tokens?.serviceTier, 'priority');
      await assert.rejects(() => service.chat({ chatPrompt: prompt }, { stream: false, thinkingTokenBudget: 'none' }), /reason|none|thinking/i);
      assert.equal(calls, 1);
      return { endpoint: 'responses', answer: '4', effort: 'max', servedTier: 'priority', cacheTTL: '30m', reasoningCannotBeDisabled: true };
    },
  },
  {
    id: '04-providers/configured-embeddings', title: 'Call configured embeddings only after checking the deployment operation contract',
    features: ['configured-live-embeddings', 'operation-capability-check', 'embedding-shape'], modes: ['offline', 'live'],
    async run(ctx) {
      const service = ctx.mode === 'live' ? ctx.ai : ai({ name: 'openai-compatible', apiURL: 'https://fixture.invalid/v1', apiKey: 'fixture-only', config: { model: 'fixture-text', embedModel: 'fixture-vector' }, options: { fetch: async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 3, total_tokens: 3 } }) } });
      const profile = axAIProfiles().find((row) => row.name === service.getName() || row.id === service.getName());
      assert.ok(profile?.operations.embed, `Configured provider ${service.getName()} must expose embeddings; select an embedding-capable deployment and embedding model`);
      const response = await service.embed({ texts: ['task: search result | query: invoice refund policy'] }, { abortSignal: ctx.signal, timeout: 30_000, retry: { maxRetries: 0 } });
      assert.equal(response.embeddings.length, 1);
      assert.ok(response.embeddings[0] && response.embeddings[0].length > 0);
      assert.ok(response.embeddings[0].every(Number.isFinite));
      return { provider: profile.id, vectors: response.embeddings.length, dimensions: response.embeddings[0].length, scope: ctx.mode === 'live' ? 'configured embedding operation; no cross-provider equivalence claim' : 'fixture vector; real Ax embedding transport and parsing' };
    },
  },
];
