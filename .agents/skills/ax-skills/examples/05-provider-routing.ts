import assert from 'node:assert/strict';
import {
  ai, AxBalancer, AxInMemoryBalancerStatsStore, AxMultiServiceRouter,
  AxProviderRouter, AxMockAIService, AxAIServiceStatusError,
  AxAIServiceAbortedError,
  type AxAIFeatures, type AxChatRequest, type AxChatResponse, type AxBalancerRoutingEvent,
} from '@ax-llm/ax';
import { type Example } from './support.js';

const answer = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
function complete(response: AxChatResponse | ReadableStream<AxChatResponse>): AxChatResponse {
  assert.ok(!(response instanceof ReadableStream));
  return response;
}
const textPrompt: AxChatRequest['chatPrompt'] = [{ role: 'user', content: 'What department owns an invoice refund?' }];
const transient = () => new AxAIServiceStatusError(503, 'Service unavailable', 'https://fixture.invalid', {}, { error: 'isolated provider outage' });

// AxMockAIService 25.4.9 hardcodes caching=false and omits configured image detail levels.
// This fixture explicitly advertises the native contract needed by the cached high-detail input.
class CachedVisionFixture extends AxMockAIService<string> {
  override getFeatures(): AxAIFeatures {
    const features = super.getFeatures();
    return {
      ...features,
      media: { ...features.media, images: { ...features.media.images, detailLevels: ['high'] } },
      caching: { supported: true, types: ['ephemeral'] },
    };
  }
}

// Mock children declare deterministic transport capabilities and output. Selection, conversion,
// filtering, failover and adaptive statistics below are the real public Ax implementations.
export const examples: readonly Example[] = [
  {
    id: '05-provider-routing/native-capability-selection', title: 'Select a native image provider and preserve every content hint',
    features: ['provider-router', 'capability-selection', 'native-media-preservation', 'compatibility-validation'], modes: ['offline'],
    async run(ctx) {
      let textCalls = 0;
      let imageCalls = 0;
      const textOnly = new AxMockAIService<string>({ name: 'text-only', features: { media: { images: { supported: false, formats: [] } } }, chatResponse: async () => { textCalls++; return answer('unreachable'); } });
      const request: AxChatRequest = { chatPrompt: [{ role: 'user', content: [{ type: 'text', text: 'Read this invoice:' }, { type: 'image', image: 'aW52b2ljZQ==', mimeType: 'image/png', details: 'high', cache: true, optimize: 'quality', altText: 'Invoice fixture' }, { type: 'text', text: 'Which team owns it?' }] }] };
      const vision = new CachedVisionFixture({ name: 'vision', features: { media: { images: { supported: true, formats: ['image/png'], detailLevels: ['high'] } } }, chatResponse: async (received) => { imageCalls++; assert.deepEqual(received.chatPrompt, request.chatPrompt); return answer('billing'); } });
      const router = new AxProviderRouter({ providers: { primary: textOnly, alternatives: [vision] }, routing: { preferenceOrder: ['capability'], capability: { requireExactMatch: true, allowDegradation: false } }, processing: {} });
      const validation = await router.validateRequest(request);
      assert.equal(validation.canHandle, true);
      const result = await router.chat(request, { stream: false, abortSignal: ctx.signal });
      assert.equal(result.routing.provider.getId(), vision.getId());
      assert.equal(complete(result.response).results[0]?.content, 'billing');
      assert.equal(textCalls, 0);
      assert.equal(imageCalls, 1);
      assert.deepEqual(result.routing.degradations, []);
      return { selected: result.routing.provider.getName(), answer: 'billing', nativeContentPreserved: true, scope: 'capability compatibility, not semantic-quality ranking' };
    },
  },
  {
    id: '05-provider-routing/explicit-media-degradation', title: 'Own file-to-text degradation and reject requests that cannot be served',
    features: ['provider-router', 'file-degradation', 'compatibility-boundary', 'history-ownership'], modes: ['offline'],
    async run(ctx) {
      let conversions = 0;
      let calls = 0;
      const request: AxChatRequest = { chatPrompt: [{ role: 'user', content: [{ type: 'file', data: 'aW52b2ljZQ==', mimeType: 'application/pdf', filename: 'invoice.pdf' }] }] };
      const original = structuredClone(request);
      const textOnly = new AxMockAIService<string>({ name: 'text-only', features: { media: { files: { supported: false, formats: [], uploadMethod: 'none' } } }, chatResponse: async (received) => { calls++; assert.match(JSON.stringify(received.chatPrompt), /Invoice total: 12 EUR/); assert.doesNotMatch(JSON.stringify(received.chatPrompt), /"type":"file"/); return answer('12 EUR'); } });
      const router = new AxProviderRouter({ providers: { primary: textOnly, alternatives: [] }, routing: { preferenceOrder: ['capability'], capability: { requireExactMatch: false, allowDegradation: true } }, processing: { fileToText: async (data, mime) => { conversions++; assert.equal(data, 'aW52b2ljZQ=='); assert.equal(mime, 'application/pdf'); return 'Invoice total: 12 EUR'; } } });
      const result = await router.chat(request, { stream: false, abortSignal: ctx.signal });
      assert.equal(complete(result.response).results[0]?.content, '12 EUR');
      assert.equal(conversions, 1);
      assert.equal(calls, 1);
      assert.deepEqual(request, original, 'Degradation must not destroy the caller-owned native history');
      const strict = new AxProviderRouter({ providers: { primary: textOnly, alternatives: [] }, routing: { preferenceOrder: ['capability'], capability: { requireExactMatch: true, allowDegradation: false } }, processing: {} });
      const validation = await strict.validateRequest(request);
      assert.equal(validation.canHandle, false);
      assert.ok(validation.issues.some((issue) => /no.*provider|file.*not supported|unsupported.*file/i.test(issue)));
      // Ax 25.4.9 wraps provider-selection failures in public Error, not a stable media-error subclass.
      await assert.rejects(() => strict.chat(request, { stream: false }), /no.*provider|file.*not supported|unsupported.*file/i);
      assert.equal(conversions, 1, 'Strict selection must not invoke a degradation processor');
      assert.equal(calls, 1);
      return { selected: result.routing.provider.getName(), answer: '12 EUR', conversions, strictRejectedBeforeTransport: true, prerequisite: 'Replace deterministic PDF extraction with an application-owned parser for real documents' };
    },
  },
  {
    id: '05-provider-routing/logical-dispatch', title: 'Dispatch caller-selected logical models without pretending to select them',
    features: ['multi-service-router', 'logical-model-dispatch', 'model-key-uniqueness'], modes: ['offline'],
    async run(ctx) {
      const calls: string[] = [];
      const billing = new AxMockAIService<string>({ name: 'billing-model', chatResponse: async (request) => { calls.push('billing'); assert.equal(request.model, undefined, 'Key-wrapper routing selects the default child model'); return answer('billing'); } });
      const engineering = new AxMockAIService<string>({ name: 'code-model', chatResponse: async () => { calls.push('engineering'); return answer('engineering'); } });
      const services = [{ key: 'invoice', description: 'Application explicitly chose invoice analysis', service: billing }, { key: 'code', description: 'Application explicitly chose code analysis', service: engineering }] as const;
      const router = AxMultiServiceRouter.create(services);
      const result = complete(await router.chat({ model: 'invoice', chatPrompt: textPrompt }, { stream: false, abortSignal: ctx.signal }));
      assert.equal(result.results[0]?.content, 'billing');
      assert.deepEqual(calls, ['billing']);
      await assert.rejects(() => router.chat({ chatPrompt: textPrompt }), /Model key must be specified/);
      assert.throws(() => AxMultiServiceRouter.create([services[0], services[0]]), /Duplicate model key/);
      return { selectedKey: 'invoice', answer: result.results[0]?.content, calls, owner: 'application selects semantics; router only dispatches' };
    },
  },
  {
    id: '05-provider-routing/ordered-transient-failover', title: 'Fail over equivalent services only on a retryable provider failure',
    features: ['ordered-balancer', 'transient-failover', 'nonretryable-cancellation'], modes: ['offline'],
    async run(ctx) {
      const attempts: string[] = [];
      const primary = new AxMockAIService<string>({ name: 'primary', chatResponse: async () => { attempts.push('primary'); throw transient(); } });
      const backup = new AxMockAIService<string>({ name: 'backup', chatResponse: async () => { attempts.push('backup'); return answer('billing'); } });
      const balancer = AxBalancer.create([primary, backup] as const, { comparator: AxBalancer.inputOrderComparator, maxRetries: 1, initialBackoffMs: 1, maxBackoffMs: 1 });
      const result = complete(await balancer.chat({ chatPrompt: textPrompt }, { stream: false, abortSignal: ctx.signal }));
      assert.equal(result.results[0]?.content, 'billing');
      assert.deepEqual(attempts, ['primary', 'backup']);
      const cancelled = new AxMockAIService<string>({ name: 'cancelled', chatResponse: async () => { throw new AxAIServiceAbortedError('https://fixture.invalid', 'caller cancelled'); } });
      const isolated = AxBalancer.create([cancelled, backup] as const, { comparator: AxBalancer.inputOrderComparator });
      await assert.rejects(() => isolated.chat({ chatPrompt: textPrompt }, { stream: false }), AxAIServiceAbortedError);
      assert.deepEqual(attempts, ['primary', 'backup'], 'Cancellation must not invoke backup');
      return { attempts, answer: 'billing', cancellationDidNotFailOver: true, requirement: 'Both routes must first pass application quality evaluation for this task' };
    },
  },
  {
    id: '05-provider-routing/adaptive-equivalent-alias', title: 'Rank equivalent aliases by operational cost and learn actual failover outcomes',
    features: ['adaptive-balancer', 'shared-stats-store', 'stable-route-keys', 'slice', 'routing-events', 'capability-filtering'], modes: ['offline'],
    async run(ctx) {
      const events: AxBalancerRoutingEvent[] = [];
      const stats = new AxInMemoryBalancerStatsStore();
      const attempts: string[] = [];
      const models = [{ key: 'support', model: 'evaluated-support-model', description: 'Quality-approved equivalent support route' }];
      const first = new AxMockAIService<string>({ name: 'cheap-primary', models, chatResponse: async () => { attempts.push('cheap'); throw transient(); } });
      const second = new AxMockAIService<string>({ name: 'reliable-backup', models, chatResponse: async () => { attempts.push('backup'); return answer('billing'); } });
      const balancer = AxBalancer.create([first, second] as const, { strategy: { type: 'adaptive', deadlineMs: 6000, badOutcomeCost: 0, expectedTokens: { promptTokens: 100, completionTokens: 20 }, estimateCost: ({ serviceIndex, resolvedModel }) => { assert.equal(resolvedModel, 'evaluated-support-model'); return serviceIndex + 1; }, namespace: 'fixture-support', slice: ({ options }) => options?.customLabels?.workflow ?? 'default', routeKey: (_service, index) => index === 0 ? 'cheap-route' : 'backup-route', statsStore: stats, onRoutingEvent: (event) => { events.push(event); } } });
      const result = complete(await balancer.chat({ model: 'support', chatPrompt: textPrompt }, { stream: false, customLabels: { workflow: 'invoice' }, abortSignal: ctx.signal }));
      assert.equal(result.results[0]?.content, 'billing');
      assert.deepEqual(attempts, ['cheap', 'backup']);
      const key = { namespace: 'fixture-support', slice: 'invoice', logicalModel: 'support' };
      assert.equal((await stats.get({ ...key, routeKey: 'cheap-route' }))?.failureEwma, 0.2 + 0.8 * 0.05);
      assert.equal((await stats.get({ ...key, routeKey: 'backup-route' }))?.successes, 1);
      assert.ok(events.some((event) => event.type === 'fallback' && event.fromRouteKey === 'cheap-route' && event.toRouteKey === 'backup-route'));
      assert.doesNotMatch(JSON.stringify(events), /invoice refund|chatPrompt/);
      return { attempts, eventTypes: events.map((event) => event.type), learned: { cheapFailure: true, backupSuccess: true }, scope: 'badOutcomeCost=0 makes this fixture cost ordering deterministic; production nonzero risk uses learned reliability/latency, never semantic prompt routing' };
    },
  },
  {
    id: '05-provider-routing/decision-compatibility-exclusion', title: 'Exclude schema-required decision services from freeform routes',
    features: ['decision-compatibility', 'mixed-balancer', 'pre-transport-capability-filtering'], modes: ['offline'],
    async run(ctx) {
      let decisionCalls = 0;
      let generativeCalls = 0;
      // A mixed balancer requires every child to advertise the same logical model keys.
      const decisions = ai({ name: 'typesafe', apiKey: 'fixture-only', models: [{ key: 'department', model: 'jev-latest', description: 'Schema-required department decision' }], options: { fetch: async () => { decisionCalls++; throw new Error('Incompatible decision service reached transport'); } } });
      const generator = new AxMockAIService<string>({ name: 'generator', models: [{ key: 'department', model: 'evaluated-support-model', description: 'Freeform department explanation' }], chatResponse: async () => { generativeCalls++; return answer('billing'); } });
      const balancer = AxBalancer.create([decisions, generator] as const, { comparator: AxBalancer.inputOrderComparator });
      const response = complete(await balancer.chat({ model: 'department', chatPrompt: textPrompt }, { stream: false, abortSignal: ctx.signal }));
      assert.equal(response.results[0]?.content, 'billing');
      assert.equal(decisionCalls, 0);
      assert.equal(generativeCalls, 1);
      return { selected: 'generator', incompatibleDecisionTransports: decisionCalls, answer: 'billing', reason: 'Freeform chat has no supported required decision schema' };
    },
  },
  {
    id: '05-provider-routing/stream-failover-boundary', title: 'Fail over before output; never replay a partially emitted stream',
    features: ['streaming-balancer', 'pre-chunk-failover', 'midstream-error-boundary', 'stream-cleanup'], modes: ['offline'],
    async run(ctx) {
      let backupCalls = 0;
      const backup = new AxMockAIService<string>({ name: 'backup', chatResponse: async () => { backupCalls++; return new ReadableStream<AxChatResponse>({ start(controller) { controller.enqueue(answer('billing')); controller.close(); } }); } });
      const before = new AxMockAIService<string>({ name: 'fails-before-first-chunk', chatResponse: async () => new ReadableStream<AxChatResponse>({ start(controller) { controller.error(transient()); } }) });
      const early = AxBalancer.create([before, backup] as const, { comparator: AxBalancer.inputOrderComparator, initialBackoffMs: 1, maxRetries: 1 });
      const stream = await early.chat({ chatPrompt: textPrompt }, { stream: true, abortSignal: ctx.signal });
      assert.ok(stream instanceof ReadableStream);
      const chunks: string[] = [];
      const earlyReader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await earlyReader.read();
          if (done) break;
          chunks.push(value.results[0]?.content ?? '');
        }
      } finally { earlyReader.releaseLock(); }
      assert.deepEqual(chunks, ['billing']);
      let pull = 0;
      let cancelled = false;
      const during = new AxMockAIService<string>({ name: 'fails-after-first-chunk', chatResponse: async () => new ReadableStream<AxChatResponse>({ pull(controller) { if (pull++ === 0) controller.enqueue({ results: [{ index: 0, content: 'bill' }] }); else controller.error(transient()); }, cancel() { cancelled = true; } }) });
      const late = AxBalancer.create([during, backup] as const, { comparator: AxBalancer.inputOrderComparator });
      const partial = await late.chat({ chatPrompt: textPrompt }, { stream: true });
      assert.ok(partial instanceof ReadableStream);
      const reader = partial.getReader();
      try {
        assert.equal((await reader.read()).value?.results[0]?.content, 'bill');
        await assert.rejects(() => reader.read(), AxAIServiceStatusError);
      } finally { reader.releaseLock(); }
      assert.equal(backupCalls, 1, 'Only the before-output failure may reach backup');
      return { earlyFailoverAnswer: chunks.join(''), committedPartial: 'bill', midstreamReplayed: false, erroredStreamAlreadyClosed: !cancelled };
    },
  },
];
