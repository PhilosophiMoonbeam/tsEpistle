import assert from 'node:assert/strict';
import {
  AxProgram, AxInMemoryEventStore, AxInMemoryProgramStateStore, AxEventOutcomeUnknownError,
  eventInput, eventPath, eventRoute, eventRuntime, eventTarget,
  type AxAIService, type AxEventContext, type AxEventIngress, type AxGenStreamingOut,
  type AxProgrammable, type AxProgramForwardOptions, type AxProgramStreamingForwardOptions,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

type TaskInput = { taskId: string; phase: string; answer?: string };
type TaskOutput = { taskOutcome: string };

// A real application-owned programmable, not a simulated runtime/model. No LLM
// is needed for this deterministic approval task; Ax owns dispatch and storage.
class LocalTask extends AxProgram<TaskInput, TaskOutput> implements AxProgrammable<TaskInput, TaskOutput> {
  constructor(private readonly execute: (input: TaskInput, context: AxEventContext) => Promise<TaskOutput>) {
    super('taskId:string, phase:string, answer?:string -> taskOutcome:string');
    this.setId('local-approval-v1');
  }
  async forward(_ai: Readonly<AxAIService>, input: TaskInput, opts?: Readonly<AxProgramForwardOptions<string>>): Promise<TaskOutput> {
    assert.ok(opts?.eventContext, 'This application task requires runtime-owned event provenance');
    return this.execute(input, opts.eventContext);
  }
  async *streamingForward(ai: Readonly<AxAIService>, input: TaskInput, opts?: Readonly<AxProgramStreamingForwardOptions<string>>): AxGenStreamingOut<TaskOutput> {
    const output = await this.forward(ai, input, opts);
    yield { index: 0, version: 1, delta: output, partial: output };
  }
}

const taskEvent = (id: string, type: string, tenant = 'tenant-a', answer?: string): AxEventIngress => ({
  event: { specversion: '1.0', id, type, source: 'urn:example:approval', subject: 'purchase-42',
    data: { taskId: 'approval-42', ...(answer ? { answer } : {}) } },
  identity: { tenantId: tenant }, trust: 'authenticated',
});

export const examples: readonly Example[] = [
  {
    id: '18-event-resume/owned-pause-resume',
    title: 'Program registers its own continuation; resume restores isolated state',
    features: ['registerContinuation', 'createProgram', 'wakeInput', 'resumeInput', 'continuation-metadata', 'program-state', 'tenant-isolation', 'resume'],
    modes: ['offline'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      const states = new AxInMemoryProgramStateStore();
      const businessEffects = new Set<string>();
      let constructed = 0;
      const restoredCounts: number[] = [];
      class ApprovalTask extends LocalTask {
        private starts = 0;
        constructor() {
          super(async (input, context) => {
            if (input.phase === 'start') {
              this.starts++;
              context.registerContinuation({ correlation: [{ kind: 'approval', value: input.taskId }],
                expiresAt: Date.now() + 60_000, metadata: { taskId: input.taskId } });
              return { taskOutcome: 'Waiting for a decision from the authenticated owner.' };
            }
            assert.ok(context.continuation);
            assert.equal(input.phase, 'resume');
            assert.equal(input.taskId, context.continuation.metadata?.taskId);
            assert.deepEqual(context.continuation.correlation, [{ kind: 'approval', value: input.taskId }]);
            assert.equal(context.identity.tenantId, 'tenant-a');
            assert.equal(this.starts, 1, 'A fresh instance must restore its persisted state');
            restoredCounts.push(this.starts);
            assert.equal(input.answer, 'approved');
            businessEffects.add(`${context.identity.tenantId}:${input.taskId}`);
            return { taskOutcome: `Approved ${input.taskId}` };
          });
        }
        getState() { return { starts: this.starts }; }
        setState(state: unknown) {
          assert.ok(state && typeof state === 'object' && 'starts' in state);
          assert.equal(typeof state.starts, 'number');
          this.starts = Number(state.starts);
        }
      }
      const signature = new ApprovalTask().getSignature();
      const target = eventTarget('purchase-approval').createProgram(signature, () => { constructed++; return new ApprovalTask(); })
        .ai(scriptedAI([])).forwardOptions(options(ctx))
        .wakeInput(eventInput<TaskInput>().field('taskId', eventPath.data('taskId')).field('phase', eventPath.constant('start')))
        // continuation() is rooted at persisted metadata, not the continuation record.
        .resumeInput(eventInput<TaskInput>().field('taskId', eventPath.continuation('taskId'))
          .field('phase', eventPath.constant('resume')).field('answer', eventPath.data('answer')))
        .build();
      const runtime = eventRuntime({ store, programStateStore: states, workerConcurrency: 1, routes: [
        eventRoute('approval-start').types('purchase.requested').authenticated().instanceKey(eventPath.subject()).wake(target).build(),
        eventRoute('approval-decision').types('approval.completed').authenticated().correlate('approval', eventPath.data('taskId')).resume(target).build(),
        eventRoute('approval-progress').types('approval.progress').observe().build(),
      ] });
      try {
        await runtime.start();
        const start = await runtime.publish(taskEvent('start', 'purchase.requested'), ctx.signal);
        await runtime.waitForIdle();
        const paused = await store.getDelivery(start.deliveryIds[0]!);
        assert.equal(paused?.status, 'waiting_event');
        assert.ok(paused.runId);
        const pausedRun = await runtime.getRun(paused.runId);
        assert.ok(pausedRun?.continuationIds);
        assert.equal(pausedRun.continuationIds.length, 1);
        const ownedContinuation = await store.findContinuation(paused.identityScope,
          { kind: 'approval', value: 'approval-42' }, Date.now());
        assert.ok(ownedContinuation);
        assert.equal(ownedContinuation.id, pausedRun.continuationIds[0]);
        assert.deepEqual(ownedContinuation.metadata, { taskId: 'approval-42' });
        assert.equal(ownedContinuation.instanceKey, pausedRun.instanceKey);
        await runtime.publish(taskEvent('progress', 'approval.progress'), ctx.signal);
        // Knowing another tenant's task ID is not ownership.
        const foreign = await runtime.publish(taskEvent('foreign', 'approval.completed', 'tenant-b', 'approved'), ctx.signal);
        await runtime.waitForIdle();
        assert.equal((await store.getDelivery(foreign.deliveryIds[0]!))?.status, 'dead_lettered');
        assert.equal(businessEffects.size, 0);
        const completed = taskEvent('completion', 'approval.completed', 'tenant-a', 'approved');
        const receipt = await runtime.publish(completed, ctx.signal);
        await runtime.waitForIdle();
        const resumed = await store.getDelivery(receipt.deliveryIds[0]!);
        assert.equal(resumed?.status, 'succeeded');
        assert.ok(resumed.runId);
        const completedRun = await runtime.getRun(resumed.runId);
        assert.ok(completedRun);
        assert.equal(completedRun.status, 'succeeded');
        assert.equal(completedRun.instanceKey, pausedRun.instanceKey);
        assert.deepEqual(completedRun.output, { taskOutcome: 'Approved approval-42' });
        assert.equal((await runtime.publish(completed, ctx.signal)).duplicate, true);
        // A new envelope with an already-consumed key cannot run the owner again.
        const replay = await runtime.publish(taskEvent('new-completion-id', 'approval.completed', 'tenant-a', 'approved'), ctx.signal);
        await runtime.waitForIdle();
        assert.equal((await store.getDelivery(replay.deliveryIds[0]!))?.status, 'dead_lettered');
        assert.deepEqual([...businessEffects], ['tenant-a:approval-42']);
        assert.equal(constructed, 2);
        assert.deepEqual(restoredCounts, [1]);
        return { paused: paused.status, resumed: resumed.status, businessEffects: businessEffects.size, freshInstances: constructed,
          rejectedForeignAndConsumedKeys: (await runtime.listDeadLetters()).length,
          boundary: 'Continuation correlation is identity-scoped and consumable; volatile state is not crash durability or exactly-once delivery.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '18-event-resume/retry-versus-unknown',
    title: 'Retry only effects protected by stable delivery keys; stop uncertain effects',
    features: ['retrySafety', 'idempotencyKey', 'retry', 'outcome_unknown', 'dead-letter'],
    modes: ['offline'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      const effectKeys = new Set<string>();
      let safeCalls = 0;
      let uncertainEffects = 0;
      const safe = new LocalTask(async (_input, context) => {
        safeCalls++;
        // This in-memory ledger represents one atomic local business operation.
        // A production ledger must share the effect's real transaction boundary.
        effectKeys.add(context.idempotencyKey);
        if (context.attempt === 1) throw new Error('Lost acknowledgement after local idempotent write');
        return { taskOutcome: 'Idempotent local operation completed' };
      });
      const unsafe = new LocalTask(async () => {
        uncertainEffects++;
        throw new AxEventOutcomeUnknownError('External acknowledgement missing; reconcile rather than retry');
      });
      const map = eventInput<TaskInput>().field('taskId', eventPath.data('taskId')).field('phase', eventPath.constant('run'));
      const safeTarget = eventTarget('safe-operation').program(safe).ai(scriptedAI([])).input(map)
        .retrySafety('idempotent').forwardOptions(options(ctx)).build();
      const unsafeTarget = eventTarget('unknown-operation').program(unsafe).ai(scriptedAI([])).input(map)
        .retrySafety('unknown').forwardOptions(options(ctx)).build();
      const runtime = eventRuntime({ store, maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1, routes: [
        eventRoute('safe').types('safe').wake(safeTarget).build(), eventRoute('unsafe').types('unsafe').wake(unsafeTarget).build(),
      ] });
      try {
        await runtime.start();
        const receipt = await runtime.publish(taskEvent('safe', 'safe'), ctx.signal);
        const uncertainEvent = taskEvent('unsafe', 'unsafe');
        const unknown = await runtime.publish(uncertainEvent, ctx.signal);
        await runtime.waitForIdle();
        const retried = await store.getDelivery(receipt.deliveryIds[0]!);
        const stopped = await store.getDelivery(unknown.deliveryIds[0]!);
        assert.equal(retried?.status, 'succeeded');
        assert.equal(retried.attempt, 2);
        assert.equal(safeCalls, 2);
        assert.equal(effectKeys.size, 1);
        assert.equal(stopped?.status, 'outcome_unknown');
        assert.equal(stopped.attempt, 1);
        assert.equal((await runtime.publish(uncertainEvent, ctx.signal)).duplicate, true);
        assert.equal(uncertainEffects, 1);
        assert.equal((await runtime.listDeadLetters()).length, 1);
        return { safeCalls, protectedEffects: effectKeys.size, unsafeEffects: uncertainEffects, unsafeStatus: stopped.status,
          boundary: 'Do not delivery-redrive outcome_unknown until an operator reconciles the real effect.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '18-event-resume/cancel-active-run',
    title: 'Cancel cooperative active work without implying external rollback',
    features: ['cancelRun', 'abortSignal', 'cancelled'],
    modes: ['offline'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      const { promise: started, resolve: announce } = Promise.withResolvers<string>();
      const program = new LocalTask(async (_input, context) => {
        const { promise, reject } = Promise.withResolvers<TaskOutput>();
        context.abortSignal.addEventListener('abort', () => reject(new Error(String(context.abortSignal.reason))), { once: true });
        announce(context.runId);
        return promise;
      });
      const target = eventTarget('cancellable-task').program(program).ai(scriptedAI([]))
        .input(input => input.field('taskId', eventPath.data('taskId')).field('phase', eventPath.constant('wait')))
        .forwardOptions(options(ctx)).build();
      const runtime = eventRuntime({ store, routes: [eventRoute('wait').types('wait').wake(target).build()] });
      try {
        await runtime.start();
        await runtime.publish(taskEvent('cancel-me', 'wait'), ctx.signal);
        const runId = await started;
        assert.equal(runtime.cancelRun(runId, 'Customer withdrew request'), true);
        await runtime.waitForIdle();
        const run = await runtime.getRun(runId);
        assert.equal(run?.status, 'cancelled');
        assert.equal(runtime.cancelRun(runId), false);
        assert.equal((await runtime.listDeadLetters()).length, 0);
        return { status: run.status, reason: run.error, boundary: 'Cancellation is cooperative; it cannot roll back an already-issued business effect.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
  {
    id: '18-event-resume/expired-continuation',
    title: 'An expired ownership deadline cannot resume business work',
    features: ['continuation-expiry', 'resume', 'dead-letter'],
    modes: ['offline'],
    async run(ctx) {
      const store = new AxInMemoryEventStore();
      let invocations = 0;
      const program = new LocalTask(async (input, context) => {
        invocations++;
        // The upstream deadline has already passed when this request arrives.
        context.registerContinuation({ correlation: [{ kind: 'approval', value: input.taskId }], expiresAt: Date.now() - 1 });
        return { taskOutcome: 'Waiting, but the approval deadline has elapsed.' };
      });
      const target = eventTarget('deadline-owner').program(program).ai(scriptedAI([]))
        .input(input => input.field('taskId', eventPath.data('taskId')).field('phase', eventPath.constant('run')))
        .forwardOptions(options(ctx)).build();
      const runtime = eventRuntime({ store, routes: [
        eventRoute('start-expired').types('start').wake(target).build(),
        eventRoute('finish-expired').types('finish').correlate('approval', eventPath.data('taskId')).resume(target).build(),
      ] });
      try {
        await runtime.start();
        await runtime.publish(taskEvent('expired-start', 'start'), ctx.signal);
        await runtime.waitForIdle();
        const receipt = await runtime.publish(taskEvent('expired-finish', 'finish'), ctx.signal);
        await runtime.waitForIdle();
        assert.equal((await store.getDelivery(receipt.deliveryIds[0]!))?.status, 'dead_lettered');
        assert.equal(invocations, 1);
        assert.equal((await runtime.listDeadLetters()).length, 1);
        return { invocations, expiredResume: 'dead_lettered', boundary: 'Expiry prevents resumption; it does not automatically undo upstream work or synthesize a completion.' };
      } finally { await runtime.close({ drain: false }); }
    },
  },
];
