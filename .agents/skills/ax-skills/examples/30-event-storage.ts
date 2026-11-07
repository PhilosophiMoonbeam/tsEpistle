import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ax, AxInMemoryEventStore, AxPushEventSource, eventPath, eventRoute, eventRuntime, eventTarget,
  type AxEventIngress, type AxEventRun, type AxEventRuntime, type AxEventSource,
} from '@ax-llm/ax';
import { AxSQLiteEventStore } from '@ax-llm/ax-tools/event/sqlite';
import { options, scriptedAI, type Example } from './support.js';

const event = (id: string): AxEventIngress => ({
  event: { specversion: '1.0', id, source: 'urn:example:orders', type: 'order.received', subject: id, data: { order: `Pack order ${id}` } },
  identity: { tenantId: 'warehouse-training' }, trust: 'authenticated',
});

// Explicit retention is business policy, not an unlimited durable archive.
const retention = { eventAndResultMs: 86_400_000, runMetadataAndDeadLettersMs: 604_800_000, completedContinuationsMs: 86_400_000 };

export const examples: readonly Example[] = [
  {
    id: '30-event-storage/sqlite-restart-sink-redrive',
    title: 'Reopen durable results and redrive only a failed sink',
    features: ['AxSQLiteEventStore', 'retention', 'persisted-result', 'sink-redrive', 'idempotencyKey', 'restart', 'deduplication'],
    modes: ['offline'],
    async run(ctx) {
      // Published 25.4.9 uses better-sqlite3: its native addon must be installed
      // for this Node/ABI. node:sqlite alone is not the required driver.
      const directory = await mkdtemp(join(tmpdir(), 'ax-events-restart-'));
      const filename = join(directory, 'events.sqlite');
      const runtimes: AxEventRuntime[] = [];
      let generations = 0;
      let sinkCalls = 0;
      let sinkAvailable = false;
      const appliedKeys = new Set<string>();
      let businessEffects = 0;
      const model = scriptedAI(() => {
        generations++;
        return { results: [{ index: 0, content: 'Receipt: Order queued for packing.' }] };
      });
      const makeTarget = () => eventTarget('packing').program(ax('order:string -> receipt:string')).ai(model)
        .input(input => input.field('order', eventPath.data('order'))).forwardOptions(options(ctx))
        .sink({ id: 'local-fulfillment', write(output, context) {
          assert.ok(output.receipt);
          sinkCalls++;
          // Owned in-memory application ledger: demonstrate the stable key, not
          // claim crash-safe transactions between SQLite and a remote effect.
          if (!appliedKeys.has(context.idempotencyKey)) {
            appliedKeys.add(context.idempotencyKey);
            businessEffects++;
          }
          if (!sinkAvailable) throw new Error('Fixture: acknowledgement lost after local effect');
        } }).build();
      try {
        const firstStore = new AxSQLiteEventStore({ filename, retention });
        const first = eventRuntime({ id: 'before-restart', store: firstStore, programStateStore: firstStore,
          workerConcurrency: 1, maxAttempts: 1, routes: [eventRoute('pack').types('order.received').wake(makeTarget()).build()] });
        runtimes.push(first);
        await first.start();
        const input = event('order-42');
        const receipt = await first.publish(input, ctx.signal);
        assert.equal(receipt.durability, 'persistent');
        await first.waitForIdle();
        const delivery = await firstStore.getDelivery(receipt.deliveryIds[0]!);
        assert.ok(delivery?.runId);
        const runId = delivery.runId;
        const saved = await first.getRun(runId);
        assert.equal(saved?.status, 'succeeded');
        assert.deepEqual(saved.output, { receipt: 'Order queued for packing.' });
        assert.equal(saved.sinks?.[0]?.status, 'failed');
        const letters = await first.listDeadLetters();
        assert.equal(letters.length, 1);
        assert.equal(letters[0]?.kind, 'sink');
        await first.close({ drain: false });

        const reopenedStore = new AxSQLiteEventStore({ filename, retention });
        const reopened = eventRuntime({ id: 'after-restart', store: reopenedStore, programStateStore: reopenedStore,
          workerConcurrency: 1, maxAttempts: 1, routes: [eventRoute('pack').types('order.received').wake(makeTarget()).build()] });
        runtimes.push(reopened);
        await reopened.start();
        assert.deepEqual((await reopened.getRun(runId))?.output, saved.output);
        assert.equal((await reopened.publish(input, ctx.signal)).duplicate, true);
        sinkAvailable = true;
        await reopened.redrive(letters[0]!.id);
        await reopened.waitForIdle();
        assert.equal((await reopened.listDeadLetters()).length, 0);
        assert.equal(generations, 1);
        assert.equal(sinkCalls, 2);
        assert.equal(businessEffects, 1);
        return { durability: receipt.durability, recoveredOutput: saved.output, generations, sinkCalls, businessEffects,
          proof: 'SQLite result and dedupe survived reopening; sink redrive did not re-invoke the program. The demonstration ledger survived only this process, not a crash.' };
      } finally {
        try { await Promise.all(runtimes.map(runtime => runtime.close({ drain: false }))); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    },
  },
  {
    id: '30-event-storage/local-multiworker',
    title: 'Two public runtimes share a conforming local SQLite inbox',
    features: ['multi-worker', 'leases', 'fencing', 'compare-and-set', 'persistent-store'],
    modes: ['offline'],
    async run(ctx) {
      const directory = await mkdtemp(join(tmpdir(), 'ax-events-workers-'));
      const filename = join(directory, 'events.sqlite');
      const runtimes: AxEventRuntime[] = [];
      const completed = new Set<string>();
      let generations = 0;
      const model = scriptedAI(() => {
        generations++;
        return { results: [{ index: 0, content: 'Receipt: Packing instruction saved.' }] };
      });
      const target = eventTarget('shared-packing').createProgram(ax('order:string -> receipt:string').getSignature(), () => ax('order:string -> receipt:string'))
        .ai(model).input(input => input.field('order', eventPath.data('order'))).forwardOptions(options(ctx))
        .sink({ id: 'capture', write(_output, context) {
          assert.ok(context.eventContext.fencingToken && context.eventContext.fencingToken > 0);
          assert.ok(!completed.has(context.run.deliveryId));
          completed.add(context.run.deliveryId);
        } }).build();
      try {
        const stores = [0, 1].map(() => new AxSQLiteEventStore({ filename, retention }));
        assert.equal(stores[0]!.capabilities.conformance.multiWorker, 'axevent-store-v1');
        for (let index = 0; index < stores.length; index++) {
          const store = stores[index]!;
          const runtime = eventRuntime({ id: `worker-runtime-${index}`, workerId: `worker-${index}`, store, programStateStore: store,
            coordination: 'multi-worker', workerConcurrency: 1, leaseMs: 3_000, heartbeatMs: 1_000,
            routes: [eventRoute('shared-pack').types('order.received').wake(target).build()] });
          runtimes.push(runtime);
          await runtime.start();
        }
        const input = event('shared-1');
        const receipts = await Promise.all([
          runtimes[0]!.publish(input, ctx.signal), runtimes[1]!.publish(input, ctx.signal),
          runtimes[1]!.publish(event('shared-2'), ctx.signal),
        ]);
        await Promise.all(runtimes.map(runtime => runtime.waitForIdle()));
        assert.equal(receipts.filter(receipt => receipt.duplicate).length, 1);
        assert.equal(completed.size, 2);
        assert.equal(generations, 2);
        for (const receipt of receipts.filter(receipt => !receipt.duplicate)) {
          const delivery = await stores[0]!.getDelivery(receipt.deliveryIds[0]!);
          assert.equal(delivery?.status, 'succeeded');
          assert.ok(delivery.fencingToken && delivery.fencingToken > 0);
        }
        return { runtimes: runtimes.length, claimedDeliveries: completed.size, generations, duplicatePublications: 1,
          limits: 'One process with two SQLite connections proves cooperating claims, not a process-crash test. Local disk only; no network filesystem, distributed exactly-once guarantee, or permanent dedupe beyond retention.' };
      } finally {
        try { await Promise.all(runtimes.map(runtime => runtime.close({ drain: false }))); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    },
  },
  {
    id: '30-event-storage/output-persistence-failure',
    title: 'A failed output write cannot dispatch a final sink',
    features: ['output_persistence_failed', 'dead-letter', 'sink-boundary'],
    modes: ['offline'],
    async run(ctx) {
      // Fault injection is explicit at the public store boundary. The real
      // runtime must classify the failure; no successful persistence is faked.
      class FailOneOutputWrite extends AxInMemoryEventStore {
        private failed = false;
        override async saveRun(run: Readonly<AxEventRun>): Promise<void> {
          if (run.output !== undefined && !this.failed) {
            this.failed = true;
            throw new Error('output_persistence_failed: injected unavailable result storage');
          }
          await super.saveRun(run);
        }
      }
      const store = new FailOneOutputWrite();
      let sinkCalls = 0;
      const target = eventTarget('persist-first').program(ax('order:string -> receipt:string'))
        .ai(scriptedAI([{ results: [{ index: 0, content: 'Receipt: Result ready.' }] }]))
        .input(input => input.field('order', eventPath.data('order'))).forwardOptions(options(ctx))
        .sink({ id: 'must-not-send', write() { sinkCalls++; } }).build();
      const runtime = eventRuntime({ store, routes: [eventRoute('persist').types('order.received').wake(target).build()] });
      try {
        await runtime.start();
        const receipt = await runtime.publish(event('storage-down'), ctx.signal);
        await runtime.waitForIdle();
        const delivery = await store.getDelivery(receipt.deliveryIds[0]!);
        assert.equal(delivery?.status, 'output_persistence_failed');
        assert.ok(delivery.runId);
        const run = await runtime.getRun(delivery.runId);
        assert.equal(run?.status, 'output_persistence_failed');
        assert.equal(run.output, undefined);
        assert.equal(sinkCalls, 0);
        assert.equal((await runtime.listDeadLetters()).length, 1);
        return { status: run.status, sinkCalls, outputAvailable: false,
          boundary: 'Reconcile completed business work before delivery redrive; a missing result does not prove the program did nothing.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '30-event-storage/capability-source-boundaries',
    title: 'Refuse unsupported durability/coordination and observe source failures',
    features: ['store-capabilities', 'requiresDurable', 'onSourceError', 'source-cleanup', 'single-worker-limit'],
    modes: ['offline'],
    async run() {
      const guarded = eventRuntime({ store: new AxInMemoryEventStore(), sources: [new AxPushEventSource('durable-only', true)], routes: [] });
      const multiworker = eventRuntime({ store: new AxInMemoryEventStore(), coordination: 'multi-worker', routes: [] });
      let closedSources = 0;
      const failures: string[] = [];
      const source: AxEventSource = { id: 'owned-adapter', start(context) {
        context.reportError(new Error('Fixture: upstream disconnected'));
        return { close() { closedSources++; } };
      } };
      const observed = eventRuntime({ sources: [source], routes: [], onSourceError(sourceId, error) {
        assert.ok(error instanceof Error);
        failures.push(`${sourceId}: ${error.message}`);
      } });
      try {
        await assert.rejects(guarded.start(), /require a persistent AxEventStore/);
        await assert.rejects(multiworker.start(), /conforming persistent store/);
        await observed.start();
        await observed.waitForIdle();
        assert.deepEqual(failures, ['owned-adapter: Fixture: upstream disconnected']);
        await observed.close();
        assert.equal(closedSources, 1);
        return { volatileDurableSourceRejected: true, volatileMultiworkerRejected: true, failures, closedSources,
          limit: 'In-memory stores are volatile and single-process; do not override allowVolatile for production durable sources.' };
      } finally { await Promise.all([guarded.close({ drain: false }), multiworker.close({ drain: false }), observed.close({ drain: false })]); }
    },
  },
];
