import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  ax, AxInMemoryEventStore, AxManualEventClock, AxPushEventSource, AxTimerEventSource,
  eventInput, eventPath, eventRoute, eventRuntime, eventTarget,
  type AxEventIngress, type AxEventRuntime, type AxGenDeltaOut,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const ingress = (id: string, type: string, data: Record<string, string>): AxEventIngress => ({
  event: { specversion: '1.0', id, source: 'urn:example:incidents', type, subject: 'incident-42', data },
  // This is application-authenticated adapter state, not data.tenantId.
  identity: { tenantId: 'tenant-a', userId: 'operator' }, trust: 'authenticated',
});

// TS has worker loops and waitForIdle(), not the generated SDKs' runDue().
// Drive a manual clock while awaiting that actual public runtime boundary.
async function drain(runtime: AxEventRuntime, clock: AxManualEventClock): Promise<void> {
  let complete = false;
  const idle = runtime.waitForIdle(10_000).then(() => { complete = true; });
  for (let turn = 0; turn < 1_100 && !complete; turn++) {
    await setImmediate();
    clock.advanceBy(10);
  }
  await idle;
}

export const examples: readonly Example[] = [
  {
    id: '17-events/wake-route-result',
    title: 'Explicit wake, trusted identity mapping, and output-before-sink',
    features: ['eventRuntime', 'eventRoute', 'eventTarget', 'eventInput', 'eventPath', 'source', 'identity', 'observe', 'invalidate', 'wake', 'deduplication', 'stored-result', 'sink'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      const source = new AxPushEventSource('incident-adapter');
      const delivered: unknown[] = [];
      let observed = 0;
      let invalidated = 0;
      let fixtureCalls = 0;
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI(request => {
        fixtureCalls++;
        const prompt = JSON.stringify(request.chatPrompt);
        assert.ok(prompt.includes('tenant-a'));
        assert.ok(prompt.includes('created-42'));
        return { results: [{ index: 0, content: 'Summary: Investigate the failing checkout service.' }] };
      });
      const program = ax('incident:string, tenant:string, eventId:string -> summary:string');
      const mapping = eventInput<{ incident: string; tenant: string; eventId: string }>()
        .project(eventPath.data())
        .field('tenant', eventPath.identity('tenantId'))
        .field('eventId', eventPath.id())
        .build();
      const target = eventTarget('incident-triage').program(program).ai(model)
        .input(mapping).forwardOptions(options(ctx))
        .sink({ id: 'local-dashboard', async write(output, context) {
          const persisted = await store.getRun(context.run.id);
          assert.deepEqual(persisted?.output, output);
          assert.equal(persisted?.status, 'succeeded');
          assert.equal(context.eventContext.identity.tenantId, 'tenant-a');
          delivered.push(output);
        } }).build();
      const runtime = eventRuntime({ id: 'triage-example', store, sources: [source], workerConcurrency: 1,
        routes: [
          eventRoute('created').sources('urn:example:incidents').types('incident.created')
            .subjects('incident-42').authenticated()
            .authorize(({ identity }) => identity?.tenantId === 'tenant-a')
            .instanceKey(eventPath.subject()).wake(target).build(),
          eventRoute('progress').types('incident.progress').observe(() => { observed++; }).build(),
          eventRoute('catalog').types('catalog.changed').invalidate({ invalidate() { invalidated++; } }).build(),
        ],
      });
      try {
        await runtime.start();
        assert.equal((await source.publish(ingress('unmatched', 'unrelated', {}), ctx.signal)).deliveryIds.length, 0);
        await source.publish(ingress('progress', 'incident.progress', {}), ctx.signal);
        await source.publish(ingress('catalog', 'catalog.changed', {}), ctx.signal);
        const denied = { ...ingress('anonymous', 'incident.created', { incident: 'must not run' }), identity: undefined, trust: 'untrusted' as const };
        assert.equal((await source.publish(denied, ctx.signal)).deliveryIds.length, 0);
        const event = ingress('created-42', 'incident.created', {
          incident: 'Checkout returns HTTP 503.', tenant: 'payload-spoof', eventId: 'payload-spoof',
        });
        const receipt = await source.publish(event, ctx.signal);
        const duplicate = await source.publish(event, ctx.signal);
        await runtime.waitForIdle();
        assert.equal(duplicate.duplicate, true);
        assert.equal(delivered.length, 1);
        assert.equal(observed, 1);
        assert.equal(invalidated, 1);
        if (ctx.mode === 'offline') assert.equal(fixtureCalls, 1);
        const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
        assert.ok(delivery?.runId);
        const run = await runtime.getRun(delivery.runId);
        assert.equal(run?.status, 'succeeded');
        assert.ok(run.output && typeof run.output === 'object' && 'summary' in run.output);
        assert.equal(typeof run.output.summary, 'string');
        return { status: run.status, output: run.output, duplicate: duplicate.duplicate, observed, invalidated,
          durability: receipt.durability, proof: 'Real Ax mapping, generation parsing, routing and stored output; fixture text does not establish model quality.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '17-events/invalid-input-dead-letter',
    title: 'Declarative and callback mappings reject invalid inputs before invocation',
    features: ['signature-validation', 'eventInput', 'mapInput', 'dead-letter'],
    modes: ['offline'],
    async run(ctx) {
      let modelCalls = 0;
      const model = scriptedAI(() => { modelCalls++; throw new Error('Invalid mapping must never invoke a model'); });
      const store = new AxInMemoryEventStore();
      const program = ax('incident:string -> summary:string');
      const declarative = eventTarget('required-field').program(program).ai(model)
        .input(input => input.field('incident', eventPath.data('missing'))).forwardOptions(options(ctx)).build();
      const callback = eventTarget({ id: 'callback-field', program, ai: model,
        mapInput() { throw new Error('Adapter could not decode business data'); }, forwardOptions: options(ctx) });
      const runtime = eventRuntime({ store, maxAttempts: 3, routes: [
        eventRoute('missing').types('missing').wake(declarative).build(),
        eventRoute('callback').types('callback').wake(callback).build(),
      ] });
      try {
        await runtime.start();
        const receipts = await Promise.all(['missing', 'callback'].map(type => runtime.publish(ingress(type, type, {}), ctx.signal)));
        await runtime.waitForIdle();
        const letters = await runtime.listDeadLetters();
        assert.equal(letters.length, 2);
        assert.equal(modelCalls, 0);
        for (const receipt of receipts) {
          const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
          assert.equal(delivery?.status, 'dead_lettered');
          assert.equal(delivery.attempt, 1);
        }
        return { modelCalls, deadLetters: letters.map(letter => ({ kind: letter.kind, reason: letter.reason })) };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '17-events/debounce-latest',
    title: 'Replace intermediate updates only under an explicit latest policy',
    features: ['debounce', 'coalesce', 'manual-clock', 'ordering', 'waitFor'],
    modes: ['offline'],
    async run(ctx) {
      const clock = new AxManualEventClock(1_800_000_000_000);
      const store = new AxInMemoryEventStore({ clock });
      let calls = 0;
      const model = scriptedAI(request => {
        calls++;
        assert.ok(JSON.stringify(request.chatPrompt).includes('Latest draft'));
        return { results: [{ index: 0, content: 'Summary: Latest draft recorded.' }] };
      });
      const target = eventTarget('draft-review').program(ax('incident:string -> summary:string')).ai(model)
        .input(input => input.field('incident', eventPath.data('incident')))
        .waitFor('approval', eventPath.data('approvalId'), { expiresInMs: 5_000, metadata: { draft: eventPath.subject() } })
        .forwardOptions(options(ctx)).build();
      const runtime = eventRuntime({ store, clock, workerConcurrency: 1, routes: [
        eventRoute('draft-updates').types('draft.updated').instanceKey(eventPath.subject())
          .debounce(100, { coalesce: 'latest' }).ordering('strict').wake(target).build(),
      ] });
      try {
        await runtime.start();
        const first = await runtime.publish(ingress('draft-1', 'draft.updated', { incident: 'Old draft', approvalId: 'approval-42' }), ctx.signal);
        const latest = await runtime.publish(ingress('draft-2', 'draft.updated', { incident: 'Latest draft', approvalId: 'approval-42' }), ctx.signal);
        assert.equal(calls, 0);
        clock.advanceBy(100);
        await drain(runtime, clock);
        assert.equal(calls, 1);
        assert.deepEqual(first.deliveryIds, latest.deliveryIds);
        const delivery = await store.getDelivery(latest.deliveryIds[0]!);
        assert.equal(delivery?.status, 'waiting_event');
        assert.ok(delivery.runId);
        assert.equal((await runtime.getRun(delivery.runId))?.continuationIds?.length, 1);
        return { calls, coalescedDelivery: true, latest: delivery.status, policy: 'Intermediate drafts are intentionally replaceable; approval is a separate owned continuation.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '17-events/streaming-sink',
    title: 'Persist streaming deltas before provisional delivery and complete final delivery',
    features: ['streaming', 'writeChunk', 'stored-chunks', 'delta-reconstruction', 'final-sink'],
    modes: ['offline'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      const deliveredChunks: AxGenDeltaOut<{ summary: string }>[] = [];
      const finalDeliveries: unknown[] = [];
      let version = -1;
      let summary = '';
      const model = scriptedAI(() => new ReadableStream({
        start(controller) {
          controller.enqueue({ results: [{ index: 0, content: 'Summary: Checkout is' }] });
          controller.enqueue({ results: [{ index: 0, content: ' unavailable; investigate upstream health.', finishReason: 'stop' }] });
          controller.close();
        },
      }));
      const target = eventTarget('streamed-triage').program(ax('incident:string -> summary:string')).ai(model)
        .input(input => input.field('incident', eventPath.data('incident'))).forwardOptions(options(ctx)).execution('streaming')
        .sink({ id: 'provisional-dashboard',
          async writeChunk(chunk, context) {
            const saved = await store.getRun(context.run.id);
            assert.equal(saved?.status, 'running');
            assert.deepEqual(saved.chunks?.at(-1), chunk);
            deliveredChunks.push(chunk);
            if (chunk.version !== version) {
              version = chunk.version;
              summary = '';
            }
            summary += chunk.delta.summary ?? '';
          },
          async write(output, context) {
            const saved = await store.getRun(context.run.id);
            assert.equal(saved?.status, 'succeeded');
            assert.deepEqual(saved.output, output);
            finalDeliveries.push(output);
          },
        }).build();
      const runtime = eventRuntime({ store, routes: [eventRoute('stream').types('incident.created').wake(target).build()] });
      try {
        await runtime.start();
        const receipt = await runtime.publish(ingress('streamed', 'incident.created', { incident: 'Checkout is unavailable.' }), ctx.signal);
        await runtime.waitForIdle();
        const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
        assert.equal(delivery?.status, 'succeeded');
        assert.ok(delivery.runId);
        const run = await runtime.getRun(delivery.runId);
        assert.equal(run?.status, 'succeeded');
        assert.equal(summary, 'Checkout is unavailable; investigate upstream health.');
        assert.deepEqual(run.chunks, deliveredChunks);
        assert.ok(finalDeliveries.length > 0);
        assert.deepEqual(finalDeliveries.at(-1), run.output);
        assert.equal(run.sinks?.find(sink => sink.sinkId === 'provisional-dashboard')?.status, 'succeeded');
        assert.equal((await runtime.listDeadLetters()).length, 0);
        return { summary, status: run.status, provisionalChunks: deliveredChunks.length, finalWrites: finalDeliveries.length,
          boundary: 'Persisted deltas reconstruct the summary; final delivery uses the persisted runtime output. Fixture chunks do not establish model quality.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '17-events/timer-source',
    title: 'An owned timer publishes events; only its declared route observes them',
    features: ['AxTimerEventSource', 'manual-clock', 'source-cleanup', 'observe'],
    modes: ['offline'],
    async run() {
      const clock = new AxManualEventClock(1_800_000_000_000);
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      let ticks = 0;
      const runIds: string[] = [];
      const timer = new AxTimerEventSource({ id: 'owned-timer', source: 'urn:example:clock', type: 'clock.tick',
        intervalMs: 100, fireImmediately: true, data: { task: 'refresh-local-view' }, clock,
        identity: { tenantId: 'training' }, trust: 'trusted' });
      const runtime = eventRuntime({ clock, sources: [timer], workerConcurrency: 1, routes: [
        eventRoute('ticks').sources('urn:example:clock').types('clock.tick').observe((_ingress, context) => {
          runIds.push(context.runId);
          ticks++;
          if (ticks === 1) first.resolve();
          if (ticks === 2) second.resolve();
        }).build(),
      ] });
      try {
        await runtime.start();
        await first.promise;
        await setImmediate();
        assert.equal(ticks, 1);
        clock.advanceBy(100);
        await second.promise;
        await setImmediate();
        assert.equal(ticks, 2);
        for (const runId of runIds) assert.equal((await runtime.getRun(runId))?.status, 'succeeded');
        await runtime.close({ drain: false });
        clock.advanceBy(1_000);
        await setImmediate();
        assert.equal(ticks, 2);
        return { ticks, afterClose: ticks, modelCalls: 0, boundary: 'Scheduling a source alone never invokes a program; this route is observe-only.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
];
