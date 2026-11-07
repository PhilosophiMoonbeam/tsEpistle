import assert from 'node:assert/strict';
import {
  ai, ax, AxAIAnthropicModel, AxAIGoogleGeminiModel,
  AxAIOpenAIResponsesModel,
  type AxChatRequest, type AxChatResponse, type AxContextCacheRegistry,
  type AxContextCacheRegistryEntry,
} from '@ax-llm/ax';
import { options, type Example } from './support.js';

type Wire = Record<string, unknown>;
function record(value: unknown): Wire { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Wire; }
function requestBody(init?: RequestInit): Wire { assert.equal(typeof init?.body, 'string'); return record(JSON.parse(String(init?.body))); }
function complete(response: AxChatResponse | ReadableStream<AxChatResponse>): AxChatResponse { assert.ok(!(response instanceof ReadableStream)); return response; }
function sse(events: readonly unknown[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  return new Response(bytes, { headers: { 'content-type': 'text/event-stream' } });
}
function anthropicResponse(content: readonly unknown[]): Response { return Response.json({ id: 'fixture-message', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }); }
function geminiResponse(): Response { return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Answer: 4' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }); }
const question: AxChatRequest['chatPrompt'] = [{ role: 'user', content: 'What is 2 + 2?' }];

// These are isolated HTTP transcripts, not a server or claim about model intelligence.
// Ax's actual request mapping, cache management, stream parsing and generation run normally.
export const examples: readonly Example[] = [
  {
    id: '27-provider-replay/anthropic-hidden-signed-empty', title: 'Replay hidden signed and redacted thinking without synthetic empty text',
    features: ['anthropic-thinking', 'signed-replay', 'redacted-thinking', 'empty-text', 'append-only-system-order', 'cache-eligibility'], modes: ['offline'],
    async run(ctx) {
      const requests: Wire[] = [];
      let index = 0;
      const service = ai({ name: 'anthropic', apiKey: 'fixture-only', config: { model: AxAIAnthropicModel.Claude55Sonnet }, options: { fetch: async (_url, init) => { requests.push(requestBody(init)); return index++ === 0 ? anthropicResponse([{ type: 'thinking', thinking: '', signature: 'signed-empty-fixture' }, { type: 'redacted_thinking', data: 'opaque-redacted-fixture' }]) : anthropicResponse([{ type: 'text', text: '4' }]); } } });
      const first = complete(await service.chat({ chatPrompt: [{ role: 'system', content: 'Arithmetic only.' }, ...question] }, { stream: false, thinkingTokenBudget: 'none', showThoughts: false, abortSignal: ctx.signal }));
      const turn = first.results[0];
      assert.ok(turn);
      assert.equal(turn.thought, undefined);
      assert.deepEqual(turn.thoughtBlocks, [{ data: '', encrypted: false, signature: 'signed-empty-fixture' }, { data: 'opaque-redacted-fixture', encrypted: true }]);
      const history: AxChatRequest['chatPrompt'] = [{ role: 'system', content: 'Arithmetic only.' }, ...question, { role: 'assistant', content: '', thoughtBlocks: turn.thoughtBlocks, cache: true }, { role: 'system', content: 'Continue using integers.' }, { role: 'user', content: 'Repeat the answer.' }];
      const second = complete(await service.chat({ chatPrompt: history }, { stream: false, thinkingTokenBudget: 'none', showThoughts: false }));
      assert.equal(second.results[0]?.content, '4');
      const messages = requests[1]?.messages;
      assert.ok(Array.isArray(messages));
      const assistant = messages.map(record).find((message) => message.role === 'assistant');
      assert.deepEqual(assistant?.content, [{ type: 'thinking', thinking: '', signature: 'signed-empty-fixture' }, { type: 'redacted_thinking', data: 'opaque-redacted-fixture' }]);
      assert.doesNotMatch(JSON.stringify(assistant), /cache_control|"type":"text"/);
      const assistantIndex = messages.findIndex((message) => record(message).role === 'assistant');
      assert.equal(record(messages[assistantIndex + 1]).role, 'system');
      assert.equal(record(messages[assistantIndex + 1]).content, 'Continue using integers.');
      assert.deepEqual(requests[0]?.thinking, { type: 'between_tools' });
      return { displayedThought: false, replayBlocks: 2, syntheticText: false, cacheOnThoughts: false, laterSystemStayedAfterSignedPrefix: true, prerequisite: 'Real signatures must come from the same Anthropic conversation; fixture tokens are not valid server signatures' };
    },
  },
  {
    id: '27-provider-replay/anthropic-cache-nonempty-controls', title: 'Put cache markers on visible text and tool use, never signed thought blocks',
    features: ['anthropic-replay', 'nonempty-text-control', 'tool-use-cache-control', 'signed-thinking-cache-exclusion'], modes: ['offline'],
    async run(ctx) {
      const sent: Wire[] = [];
      const service = ai({ name: 'anthropic', apiKey: 'fixture-only', config: { model: AxAIAnthropicModel.Claude55Haiku }, options: { fetch: async (_url, init) => { sent.push(requestBody(init)); return anthropicResponse([{ type: 'text', text: '4' }]); } } });
      const blocks = [{ data: 'private reasoning', encrypted: false, signature: 'fixture-signed' }, { data: 'opaque', encrypted: true }];
      for (const withTool of [false, true]) {
        const history: AxChatRequest['chatPrompt'] = [...question, { role: 'assistant', content: withTool ? '' : 'The total is four.', thoughtBlocks: blocks, cache: true, ...(withTool ? { functionCalls: [{ id: 'lookup-1', type: 'function' as const, function: { name: 'lookup', params: { sku: 'four' } } }] } : {}) }, ...(withTool ? [{ role: 'function' as const, functionId: 'lookup-1', result: '4' }] : []), { role: 'user', content: 'Confirm.' }];
        complete(await service.chat({ chatPrompt: history }, { stream: false, thinkingTokenBudget: 'medium', showThoughts: false, abortSignal: ctx.signal }));
      }
      for (const [index, request] of sent.entries()) {
        assert.ok(Array.isArray(request.messages));
        const assistant = request.messages.map(record).find((message) => message.role === 'assistant');
        assert.ok(Array.isArray(assistant?.content));
        const content = assistant.content.map(record);
        assert.deepEqual(content.slice(0, 2), [{ type: 'thinking', thinking: 'private reasoning', signature: 'fixture-signed' }, { type: 'redacted_thinking', data: 'opaque' }]);
        assert.equal(content[2]?.type, index === 0 ? 'text' : 'tool_use');
        assert.deepEqual(content[2]?.cache_control, { type: 'ephemeral' });
        assert.equal(content.length, 3);
      }
      return { nonemptyTextCached: true, toolUseCached: true, thoughtBlocksCached: false, scope: 'wire eligibility only; provider minimum prefix/token requirements still apply' };
    },
  },
  {
    id: '27-provider-replay/anthropic-stream-usage', title: 'Consume hidden signed thinking and cumulative streaming usage through completion',
    features: ['anthropic-sse', 'hidden-stream-thinking', 'signed-stream-replay-state', 'cumulative-usage', 'stream-cleanup'], modes: ['offline'],
    async run(ctx) {
      const events = [
        { type: 'message_start', message: { id: 'fixture-stream', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, speed: 'fast' } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden calculation' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-stream-signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-stream' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '4' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: null }, usage: { input_tokens: 12, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 9 } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      const service = ai({ name: 'anthropic', apiKey: 'fixture-only', config: { model: AxAIAnthropicModel.Claude55Sonnet }, options: { fetch: async () => sse(events) } });
      const response = await service.chat({ chatPrompt: question }, { stream: true, showThoughts: false, thinkingTokenBudget: 'medium', abortSignal: ctx.signal });
      assert.ok(response instanceof ReadableStream);
      const chunks: AxChatResponse[] = [];
      const reader = response.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const results = chunks.flatMap((chunk) => chunk.results);
      assert.ok(results.every((result) => result.thought === undefined));
      assert.equal(results.map((result) => result.content ?? '').join(''), '4');
      assert.ok(results.flatMap((result) => result.thoughtBlocks ?? []).some((block) => block.signature === 'fixture-stream-signature'));
      assert.ok(results.flatMap((result) => result.thoughtBlocks ?? []).some((block) => block.encrypted && block.data === 'opaque-stream'));
      const usage = chunks.map((chunk) => chunk.modelUsage?.tokens).filter((value) => value !== undefined).at(-1);
      assert.ok(usage);
      assert.equal(usage.promptTokens, 12);
      assert.equal(usage.completionTokens, 3);
      assert.equal(usage.cacheCreationTokens, 0);
      assert.equal(usage.cacheReadTokens, 9);
      assert.equal(usage.totalTokens, 24);
      assert.equal(usage.speed, 'fast');
      return { answer: '4', displayThoughts: false, signedStateRetained: true, usage };
    },
  },
  {
    id: '27-provider-replay/gemini-ordered-system-cache', title: 'Create and reuse tenant-scoped Gemini caches without losing later system instructions',
    features: ['gemini-context-cache', 'ordered-system-instructions', 'external-registry', 'cache-migration', 'cache-reuse'], modes: ['offline'],
    async run(ctx) {
      const entries = new Map<string, AxContextCacheRegistryEntry>();
      const namespace = 'fixture-tenant-A:';
      const registry: AxContextCacheRegistry = { get: (key) => entries.get(namespace + key), set: (key, entry) => { entries.set(namespace + key, { ...entry }); } };
      const creates: Wire[] = [];
      const generations: Wire[] = [];
      const service = ai({ name: 'google-gemini', apiKey: 'fixture-only', config: { model: AxAIGoogleGeminiModel.Gemini25Flash }, options: { retry: { maxRetries: 0 }, fetch: async (url, init) => {
        const request = requestBody(init);
        if (String(url).endsWith('/cachedContents')) { creates.push(request); return Response.json({ name: `cachedContents/fixture-${creates.length}`, expireTime: new Date(Date.now() + 3_600_000).toISOString(), usageMetadata: { totalTokenCount: 30 } }); }
        generations.push(request); return geminiResponse();
      } } });
      const history: AxChatRequest['chatPrompt'] = [{ role: 'system', content: 'You are an accountant.' }, { role: 'user', content: 'Stable policy: use integers.', cache: true }, { role: 'system', content: 'Never round invoice totals.' }, { role: 'system', content: 'Return only the requested value.' }, ...question];
      const cache = { registry, minTokens: 1, ttlSeconds: 3600 };
      for (let turn = 0; turn < 2; turn++) complete(await service.chat({ chatPrompt: history }, { stream: false, contextCache: cache, abortSignal: ctx.signal }));
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0]?.systemInstruction, { role: 'user', parts: [{ text: 'You are an accountant. Never round invoice totals. Return only the requested value.' }] });
      assert.deepEqual(creates[0]?.contents, [{ role: 'user', parts: [{ text: 'Stable policy: use integers.' }] }]);
      assert.ok(generations.every((request) => request.cachedContent === 'cachedContents/fixture-1' && request.systemInstruction === undefined));
      assert.equal(entries.size, 1);
      // Migration is an actual invalidation, not the claim that an SDK upgrade repairs remote caches.
      entries.clear();
      complete(await service.chat({ chatPrompt: history }, { stream: false, contextCache: cache }));
      assert.equal(creates.length, 2);
      assert.equal(generations[2]?.cachedContent, 'cachedContents/fixture-2');
      entries.clear();
      return { creates: creates.length, generations: generations.length, orderedSystems: record(creates[0]?.systemInstruction).parts, migration: 'Expire/recreate pre-fix resources and remove stale registry pointers', namespace, scope: 'fixture proves ordered mapper/cache reuse; not provider cache economics or minimum-token eligibility' };
    },
  },
  {
    id: '27-provider-replay/gemini-refresh-and-rejection', title: 'Refresh near-expiry caches, recreate after failed refresh, and retry rejected managed caches once',
    features: ['gemini-cache-refresh', 'cache-recreation', 'managed-cache-rejection', 'explicit-cache-error-boundary'], modes: ['offline'],
    async run(ctx) {
      const entries = new Map<string, AxContextCacheRegistryEntry>();
      const registry: AxContextCacheRegistry = { get: (key) => entries.get(`tenant-B:${key}`), set: (key, entry) => { entries.set(`tenant-B:${key}`, { ...entry }); } };
      let creates = 0;
      let patches = 0;
      let rejectManaged = false;
      const generations: Wire[] = [];
      const service = ai({ name: 'google-gemini', apiKey: 'fixture-only', config: { model: AxAIGoogleGeminiModel.Gemini25Flash }, options: { retry: { maxRetries: 0 }, fetch: async (url, init) => {
        const wire = requestBody(init);
        if (String(init?.method).toUpperCase() === 'PATCH') { patches++; return Response.json({ error: { message: 'fixture refresh failed' } }, { status: 404 }); }
        if (String(url).endsWith('/cachedContents')) { creates++; return Response.json({ name: `cachedContents/lifecycle-${creates}`, expireTime: new Date(Date.now() + 60_000).toISOString() }); }
        generations.push(wire);
        if (wire.cachedContent === 'cachedContents/external-explicit' || (rejectManaged && wire.cachedContent)) return Response.json({ error: { message: 'Cached content not found or expired' } }, { status: 404 });
        return geminiResponse();
      } } });
      const request: AxChatRequest = { chatPrompt: [{ role: 'system', content: 'Fixture lifecycle arithmetic policy.' }, ...question] };
      const cache = { registry, minTokens: 1, refreshWindowSeconds: 300 };
      complete(await service.chat(request, { stream: false, contextCache: cache, abortSignal: ctx.signal }));
      complete(await service.chat(request, { stream: false, contextCache: cache }));
      assert.equal(patches, 1);
      assert.equal(creates, 2);
      rejectManaged = true;
      complete(await service.chat(request, { stream: false, contextCache: { ...cache, refreshWindowSeconds: 0 } }));
      assert.equal(generations.at(-2)?.cachedContent, 'cachedContents/lifecycle-2');
      assert.equal(generations.at(-1)?.cachedContent, undefined, 'Rejected managed caches retry exactly once uncached');
      assert.equal([...entries.values()][0]?.expiresAt, 0);
      const before = generations.length;
      await assert.rejects(() => service.chat(request, { stream: false, contextCache: { name: 'cachedContents/external-explicit' } }), /404|not found|expired/i);
      assert.equal(generations.length, before + 1, 'Caller-owned explicit caches do not get an automatic uncached retry');
      entries.clear();
      return { creates, failedRefreshes: patches, managedUncachedRetry: 1, explicitCacheAttempts: 1, prerequisite: 'Real Gemini cache creation requires model-specific token eligibility and cache permissions' };
    },
  },
  {
    id: '27-provider-replay/responses-encrypted-state', title: 'Replay opaque Responses reasoning without inventing assistant text',
    features: ['responses-replay', 'encrypted-reasoning', 'provider-item-identity', 'prompt-cache-key'], modes: ['offline'],
    async run(ctx) {
      const requests: Wire[] = [];
      const service = ai({ name: 'openai-responses', apiKey: 'fixture-only', config: { model: AxAIOpenAIResponsesModel.GPT4OMini }, options: { fetch: async (_url, init) => { requests.push(requestBody(init)); return Response.json({ id: `fixture-response-${requests.length}`, object: 'response', status: 'completed', model: 'gpt-4o-mini', output: requests.length === 1 ? [{ id: 'reasoning-1', type: 'reasoning', summary: [], encrypted_content: 'opaque-provider-state' }] : [{ id: 'message-2', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '4', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }); } } });
      const first = complete(await service.chat({ chatPrompt: question }, { stream: false, sessionId: 'fixture-conversation', abortSignal: ctx.signal }));
      const blocks = first.results.flatMap((result) => result.thoughtBlocks ?? []);
      assert.equal(blocks[0]?.encryptedContent, 'opaque-provider-state');
      assert.equal(blocks[0]?.id, 'reasoning-1');
      const second = complete(await service.chat({ chatPrompt: [...question, { role: 'assistant', content: '', thoughtBlocks: blocks }, { role: 'user', content: 'Give only the final number.' }] }, { stream: false, promptCacheKey: 'fixture:conversation-2' }));
      assert.equal(second.results[0]?.content, '4');
      assert.ok(Array.isArray(requests[1]?.input));
      const input = requests[1].input.map(record);
      const replay = input.find((item) => item.type === 'reasoning');
      assert.equal(replay?.id, 'reasoning-1');
      assert.equal(replay?.encrypted_content, 'opaque-provider-state');
      assert.ok(!input.some((item) => item.role === 'assistant'), 'Opaque-only turn must not add placeholder text');
      assert.equal(requests[0]?.prompt_cache_key, 'fixture-conversation');
      assert.equal(requests[1]?.prompt_cache_key, 'fixture:conversation-2');
      return { replayedReasoningId: replay?.id, syntheticAssistantMessages: 0, answer: '4', prerequisite: 'Real opaque reasoning belongs to its originating provider/model; do not translate it across aliases' };
    },
  },
  {
    id: '27-provider-replay/responses-incomplete-stream', title: 'Do not accept token-limited or failed Responses streams as completed Ax output',
    features: ['responses-sse', 'incomplete-stream-boundary', 'failed-stream-boundary', 'generation-completeness', 'stream-usage'], modes: ['offline'],
    async run(ctx) {
      const errors: string[] = [];
      let incompleteBilledTokens = 0;
      for (const status of ['incomplete', 'failed'] as const) {
        const response = { id: `fixture-${status}`, status, model: 'gpt-4o-mini', output: [], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : { error: { code: 'server_error', message: 'isolated fixture generation failed' } }) };
        const service = ai({ name: 'openai-responses', apiKey: 'fixture-only', config: { model: AxAIOpenAIResponsesModel.GPT4OMini }, options: { retry: { maxRetries: 0 }, fetch: async () => sse([{ type: 'response.created', response: { id: response.id, status: 'in_progress' } }, { type: 'response.output_item.added', output_index: 0, item: { id: 'answer-item', type: 'message', role: 'assistant', phase: 'final_answer', content: [] } }, { type: 'response.output_text.delta', item_id: 'answer-item', output_index: 0, content_index: 0, delta: 'Answer: 4' }, { type: `response.${status}`, response }]) } });
        if (status === 'incomplete') {
          const stream = await service.chat({ chatPrompt: question }, { stream: true, abortSignal: ctx.signal });
          assert.ok(stream instanceof ReadableStream);
          const deltas: AxChatResponse[] = [];
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              deltas.push(value);
            }
          } finally { reader.releaseLock(); }
          assert.ok(deltas.flatMap((delta) => delta.results).some((result) => result.finishReason === 'length'));
          const usage = deltas.map((delta) => delta.modelUsage?.tokens).filter((tokens) => tokens !== undefined).at(-1);
          assert.ok(usage);
          assert.equal(usage?.totalTokens, 12, 'Incomplete responses are still billed');
          incompleteBilledTokens = usage.totalTokens;
        }
        const program = ax('question:string -> answer:number');
        let caught: unknown;
        try { for await (const _chunk of program.streamingForward(service, { question: 'What is 2 + 2?' }, { ...options(ctx), maxRetries: 0 })) { /* Provisional chunks are not a completed result. */ } } catch (error) { caught = error; }
        assert.ok(caught instanceof Error, `${status} must reject, even though partial output is parseable`);
        assert.match(caught.message, status === 'incomplete' ? /token|length|limit|incomplete/i : /failed|server_error/i);
        errors.push(caught.name);
      }
      return { rejectedStatuses: ['incomplete', 'failed'], errors, incompleteBilledTokens, parsedPartialIsNotSuccess: true, scope: 'SSE fixture exercises actual Ax provider and program completion handling' };
    },
  },
];
