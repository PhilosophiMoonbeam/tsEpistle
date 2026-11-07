import assert from 'node:assert/strict';
import { ai, agent, AxAIOpenAIModel, AxJSRuntime, axGlobals, f, fn, type AxProgramUsage, type AxUsageEvent } from '@ax-llm/ax';
import { options, type Example } from './support.js';

type CompletedRequest = {
  requestId: string;
  responseId: string;
  stage: 'distiller' | 'executor' | 'responder';
  tokens: AxUsageEvent['tokens'];
};

// Compare accounting to completed provider responses, not an assumed number of agent turns.
function assertUsageOwnership(events: readonly Readonly<AxUsageEvent>[], requests: readonly CompletedRequest[]) {
  assert.ok(requests.length > 0);
  const expected = new Map(requests.map(request => [request.requestId, request]));
  const seen = new Set<string>();
  assert.equal(expected.size, requests.length);
  assert.equal(events.length, requests.length, 'one normalized event per completed provider request');
  for (const event of events) {
    const requestId = event.remoteRequestId;
    assert.ok(requestId, 'provider request identity must survive the adapter');
    const request = expected.get(requestId);
    assert.ok(request, 'usage must belong to a completed request in this run');
    assert.ok(!seen.has(requestId), 'a completed request must not be counted twice');
    seen.add(requestId);
    assert.equal(event.remoteId, request.responseId);
    assert.equal(event.operation, 'chat');
    assert.equal(event.streaming, false, 'the consumer received completed non-stream responses');
    assert.deepEqual(event.tokens, request.tokens);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.tokens));
  }
}

const usageTokens = (usage: readonly AxProgramUsage[]) =>
  usage.reduce((sum, item) => sum + (item.tokens?.totalTokens ?? 0), 0);
const stageTokens = (requests: readonly CompletedRequest[], stage: CompletedRequest['stage']) =>
  requests.filter(request => request.stage === stage).reduce((sum, request) => sum + request.tokens.totalTokens, 0);

export const examples: readonly Example[] = [
  {
    id: '15-observability/accounting-and-runtime-events',
    title: 'Observe real provider-adapter usage and runtime events without exporting sensitive payloads',
    features: ['axGlobals.onUsage', 'usageContext merge', 'actorTurnCallback', 'onFunctionCall', 'agentStatusCallback', 'onContextEvent', 'getUsage/resetUsage', 'getStagedUsage', 'getChatLog', 'getTraces', 'privacy'],
    modes: ['offline'],
    async run(ctx) {
      const usageEvents: Readonly<AxUsageEvent>[] = [];
      const completedRequests: CompletedRequest[] = [];
      const prompts = new Map<string, string>();
      const turns: { stage: string; isError: boolean; rawChars: number; replayChars: number }[] = [];
      const functions: string[] = [], statuses: string[] = [], contextEvents: string[] = [], computedTotals: number[] = [];
      let attempts = 0;
      const fixture = [
        { stage: 'distiller' as const, content: JSON.stringify({ javascriptCode: 'await final("Compute the invoice total using the calculator", { amounts: [12, 5] })' }) },
        { stage: 'executor' as const, content: JSON.stringify({ javascriptCode: 'await reportSuccess("Calculating invoice total"); const total = await billing.total({ amounts: inputs.distilledContext.amounts }); console.log(total)' }) },
        { stage: 'executor' as const, content: JSON.stringify({ javascriptCode: 'await final("Report computed total", { total })' }) },
        { stage: 'responder' as const, content: 'Answer: 17' },
      ];
      // The real OpenAI adapter parses these finite wire responses and emits usage.
      // Omitted `stream` and explicit false are equivalent wire defaults; assert the consumed behavior instead.
      const transport: typeof fetch = async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(body && typeof body === 'object');
        const frame = fixture[attempts++]; assert.ok(frame, 'finite transport fixture exhausted');
        if (frame.stage !== 'responder') assert.match(JSON.stringify(Reflect.get(body, 'response_format')) ?? '', /"javascriptCode"/);
        const requestId = `invoice-request-${attempts}`, responseId = `invoice-response-${attempts}`;
        prompts.set(requestId, JSON.stringify(Reflect.get(body, 'messages')) ?? '');
        completedRequests.push({ requestId, responseId, stage: frame.stage, tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } });
        return new Response(JSON.stringify({ id: responseId, object: 'chat.completion', created: 1, model: AxAIOpenAIModel.GPT4OMini, choices: [{ index: 0, message: { role: 'assistant', content: frame.content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
      };
      const model = ai({ name: 'openai', apiKey: 'isolated-fixture-not-a-credential', apiURL: 'https://fixture.invalid/v1', config: { model: AxAIOpenAIModel.GPT4OMini, stream: false }, options: { fetch: transport, usageContext: { feature: 'default-feature', attributes: { environment: 'fixture', region: 'test' } } } });
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 3, directResponse: 'off',
        functions: [fn('total').namespace('billing').description('Sum the supplied invoice amounts').arg('amounts', f.number('Amount').array()).returns(f.number('Total')).handler(({ amounts }) => {
          const total = amounts.reduce((a, b) => a + b, 0); computedTotals.push(total); return total;
        }).build()],
        // This top-level callback observes executor turns, not the distiller.
        actorTurnCallback: t => { turns.push({ stage: t.stage, isError: t.isError, rawChars: JSON.stringify(t.result ?? null).length, replayChars: t.output.length }); },
        onFunctionCall: call => { functions.push(`${call.kind}:${call.qualifiedName}`); },
        agentStatusCallback: (_message, status) => { statuses.push(status); },
        onContextEvent: event => { contextEvents.push(event.kind); },
      });
      try {
        axGlobals.onUsage = event => { usageEvents.push(event); };
        const result = await worker.forward(model, { task: 'Compute 12+5. Private reference: invoice-private-marker.' }, { ...options(ctx), stream: false, usageContext: { tenantId: 'opaque-tenant-1', requestId: 'opaque-request-1', runId: 'opaque-run-1', feature: 'invoice-total', attributes: { region: 'override' } }, excludeContentFromTrace: true });
        assert.equal(result.answer, '17'); assert.deepEqual(computedTotals, [17]);
        assertUsageOwnership(usageEvents, completedRequests);
        for (const event of usageEvents) {
          assert.equal(event.context?.tenantId, 'opaque-tenant-1');
          assert.equal(event.context?.requestId, 'opaque-request-1');
          assert.equal(event.context?.runId, 'opaque-run-1');
          assert.equal(event.context?.feature, 'invoice-total');
          assert.equal(event.context?.attributes?.environment, 'fixture');
          assert.equal(event.context?.attributes?.region, 'override');
          assert.doesNotMatch(JSON.stringify(event), /invoice-private-marker|javascriptCode|Calculating invoice/);
        }
        assert.ok(functions.includes('external:billing.total')); assert.ok(statuses.includes('success'));
        assert.ok(turns.length > 0 && turns.every(turn => turn.stage === 'executor' && !turn.isError));
        assert.ok(contextEvents.includes('budget_check'));
        const usage = worker.getUsage(), staged = worker.getStagedUsage();
        assert.equal(usageTokens(staged.ctx?.actor ?? []), stageTokens(completedRequests, 'distiller'));
        assert.equal(usageTokens(staged.task.actor), stageTokens(completedRequests, 'executor'));
        assert.equal(usageTokens(staged.task.responder), stageTokens(completedRequests, 'responder'));
        assert.equal(usageTokens(usage.actor) + usageTokens(usage.responder), usageEvents.reduce((sum, event) => sum + event.tokens.totalTokens, 0));
        const chatLog = worker.getChatLog(), traces = worker.getTraces();
        assert.ok(chatLog.length > 0); assert.ok(traces.length > 0);
        // The coordinator prefers the flow's nonempty log snapshot. It is not
        // an all-request ledger, even though staged usage accounts for every turn.
        const loggedRequestIds = new Set<string>();
        const visibleRequests = chatLog.map(entry => {
          const request = completedRequests.find(item => item.requestId === entry.remoteRequestId);
          assert.ok(request, 'each visible round trip belongs to a completed provider request');
          assert.equal(entry.remoteId, request.responseId);
          assert.ok(entry.name?.startsWith(request.stage), 'visible round trips retain actual stage ownership');
          if (entry.stage !== undefined) assert.equal(entry.stage, request.stage === 'distiller' ? 'ctx' : 'task');
          assert.ok(!loggedRequestIds.has(request.requestId), 'the instance view must not duplicate a request');
          loggedRequestIds.add(request.requestId);
          return { requestId: request.requestId, stage: request.stage, name: entry.name, flowStage: entry.stage };
        });
        const omittedRequests = completedRequests
          .filter(request => !loggedRequestIds.has(request.requestId))
          .map(({ requestId, stage }) => ({ requestId, stage }));
        assert.equal(visibleRequests.length + omittedRequests.length, completedRequests.length);
        for (const request of omittedRequests) {
          assert.ok(usageEvents.some(event => event.remoteRequestId === request.requestId), 'omitted log entries still have globally correlated accounting');
        }
        const distillerRequest = completedRequests.find(request => request.stage === 'distiller'); assert.ok(distillerRequest);
        assert.match(prompts.get(distillerRequest.requestId) ?? '', /invoice-private-marker/);
        // The marker reached a real provider prompt, but never the exported usage
        // events (checked above). Trace exclusion does not promise chat-log redaction.
        const loggedDistiller = chatLog.find(entry => entry.remoteRequestId === distillerRequest.requestId);
        if (loggedDistiller) assert.match(JSON.stringify(loggedDistiller), /invoice-private-marker/);
        const privateMarkerInChatLog = JSON.stringify(chatLog).includes('invoice-private-marker');
        worker.resetUsage(); assert.equal(worker.getUsage().actor.length, 0); assert.equal(worker.getUsage().responder.length, 0);
        return { answer: result.answer, normalizedEvents: usageEvents.length, requests: completedRequests, attribution: usageEvents[0]?.context, turns, functions, statuses, contextEvents: [...new Set(contextEvents)], chatLogEntries: chatLog.length, chatLogView: { visibleRequests, omittedRequests, boundary: 'instance flow snapshot, not a complete provider-request ledger' }, traces: traces.length, privateMarkerInChatLog, privacy: 'only metadata exported here; chat logs, program traces and raw turn artifacts require restricted retention', proof: 'real adapter accounting correlated to completed provider requests, not provider billing reconciliation' };
      } finally { worker.stop(); axGlobals.onUsage = undefined; }
    },
  },
  {
    id: '15-observability/observer-and-consumption-boundaries',
    title: 'Keep accounting fail-open; enforce limits separately and account only completed streams',
    features: ['onUsage fail-open', 'rateLimiter enforcement', 'abort', 'unconsumed/cancelled streams', 'fully consumed stream usage'],
    modes: ['offline'],
    async run(ctx) {
      const events: Readonly<AxUsageEvent>[] = [], failedObserverEvents: Readonly<AxUsageEvent>[] = [];
      let httpCalls = 0;
      const transport: typeof fetch = async (_url, init) => {
        httpCalls++;
        const request: unknown = JSON.parse(String(init?.body));
        const streaming = request && typeof request === 'object' && Reflect.get(request, 'stream') === true;
        const id = `boundary-response-${httpCalls}`, requestId = `boundary-request-${httpCalls}`;
        if (!streaming) return new Response(JSON.stringify({ id, model: AxAIOpenAIModel.GPT4OMini, choices: [{ index: 0, message: { role: 'assistant', content: 'bounded answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), { headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
        const chunks = [
          { id, model: AxAIOpenAIModel.GPT4OMini, choices: [{ index: 0, delta: { role: 'assistant', content: 'bounded answer' }, finish_reason: null }] },
          { id, model: AxAIOpenAIModel.GPT4OMini, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
        ];
        const encoder = new TextEncoder(); let position = 0;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks[position++]; if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)); else { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': requestId } });
      };
      const model = ai({ name: 'openai', apiKey: 'isolated-fixture-not-a-credential', apiURL: 'https://fixture.invalid/v1', config: { model: AxAIOpenAIModel.GPT4OMini, stream: false }, options: { fetch: transport } });
      const request = { chatPrompt: [{ role: 'user' as const, content: 'Give a bounded answer.' }] };
      try {
        axGlobals.onUsage = event => { failedObserverEvents.push(event); throw new Error('observer storage unavailable'); };
        const completed = await model.chat({ ...request, modelConfig: { stream: false } }, { abortSignal: ctx.signal });
        assert.ok(!(completed instanceof ReadableStream)); assert.equal(completed.results[0]?.content, 'bounded answer');
        assert.equal(failedObserverEvents.length, 1, 'the observer actually ran and failed without breaking completion');
        assert.equal(failedObserverEvents[0]?.remoteRequestId, completed.remoteRequestId);
        const beforeLimit = httpCalls;
        // The limiter is an enforcement point. A best-effort onUsage observer is not.
        await assert.rejects(() => model.chat({ ...request, modelConfig: { stream: false } }, { rateLimiter: async () => { throw new Error('application request budget exhausted'); }, abortSignal: ctx.signal }), /application request budget exhausted/);
        assert.equal(httpCalls, beforeLimit);
        axGlobals.onUsage = event => { events.push(event); };
        const controller = new AbortController(); controller.abort('caller cancelled');
        await assert.rejects(() => model.chat({ ...request, modelConfig: { stream: false } }, { abortSignal: controller.signal }));
        assert.equal(httpCalls, beforeLimit); assert.equal(events.length, 0);
        const unused = await model.chat({ ...request, modelConfig: { stream: true } }, { abortSignal: ctx.signal, usageContext: { requestId: 'opaque-unused-stream' } });
        assert.ok(unused instanceof ReadableStream);
        const observedBeforeCancel = events.length;
        await unused.cancel('caller did not consume response');
        const cancelledEvents = events.length;
        const stream = await model.chat({ ...request, modelConfig: { stream: true } }, { abortSignal: ctx.signal, usageContext: { requestId: 'opaque-consumed-stream' } });
        assert.ok(stream instanceof ReadableStream);
        const consumedRequestId = `boundary-request-${httpCalls}`, beforeConsumption = events.length;
        const reader = stream.getReader(); let chunks = 0, consumed = false;
        try {
          while (true) { const next = await reader.read(); if (next.done) { consumed = true; break; } chunks++; }
        } finally { try { if (!consumed) await reader.cancel('fixture cleanup'); } finally { reader.releaseLock(); } }
        assert.ok(chunks > 0); assert.equal(events.length, beforeConsumption + 1);
        const consumedEvent = events.at(-1); assert.ok(consumedEvent);
        assert.equal(consumedEvent.streaming, true);
        assert.equal(consumedEvent.remoteRequestId, consumedRequestId);
        assert.equal(consumedEvent.context?.requestId, 'opaque-consumed-stream');
        assert.equal(consumedEvent.tokens.totalTokens, 6);
        assert.equal(new Set(events.map(event => event.remoteRequestId)).size, events.length, 'consumption must not double-count a provider request');
        return { observerFailureDidNotBreakCompletion: true, limiterBlockedHTTP: true, abortedEvents: 0, observedBeforeCancel, cancelledEvents, consumedStreamEvents: events.length - beforeConsumption, consumedRequestId, boundary: 'unconsumed/cancelled responses may not report usage; absence is not proof of zero provider cost; reconcile billing separately' };
      } finally { axGlobals.onUsage = undefined; }
    },
  },
  {
    id: '15-observability/aborted-agent-retains-accounting',
    title: 'Cancel after executor inspection and retain accounting for both completed stages',
    features: ['agent abort', 'partial usage', 'partial chat log', 'usageContext', 'no responder accounting on abort'],
    modes: ['offline'],
    async run(ctx) {
      const events: Readonly<AxUsageEvent>[] = [], completedRequests: CompletedRequest[] = [];
      const cancellation = new AbortController();
      const inspectedTurns: { stage: string; isError: boolean; chatMessages: number }[] = [];
      let attempts = 0;
      let abortBoundary: { attempts: number; requestIds: string[] } | undefined;
      const fixture = [
        { stage: 'distiller' as const, javascriptCode: 'await final("Inspect the invoice amounts before computing the total", { amounts: [12, 5] })' },
        { stage: 'executor' as const, javascriptCode: 'const inspected = inputs.distilledContext.amounts; console.log("inspected-count=" + inspected.length)' },
      ];
      const transport: typeof fetch = async (_url, init) => {
        const frame = fixture[attempts++];
        assert.ok(!cancellation.signal.aborted, 'cancellation must prevent subsequent provider execution');
        assert.ok(frame, 'finite stage fixture exhausted');
        const body: unknown = JSON.parse(String(init?.body)); assert.ok(body && typeof body === 'object');
        assert.match(JSON.stringify(Reflect.get(body, 'response_format')) ?? '', /"javascriptCode"/);
        const requestId = `partial-request-${attempts}`, responseId = `partial-response-${attempts}`;
        completedRequests.push({ requestId, responseId, stage: frame.stage, tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } });
        return new Response(JSON.stringify({
          id: responseId, model: AxAIOpenAIModel.GPT4OMini,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ javascriptCode: frame.javascriptCode }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }), { headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
      };
      const model = ai({ name: 'openai', apiKey: 'isolated-fixture-not-a-credential', apiURL: 'https://fixture.invalid/v1', config: { model: AxAIOpenAIModel.GPT4OMini, stream: false }, options: { fetch: transport } });
      const worker = agent('task:string -> answer:string', {
        runtime: new AxJSRuntime(), maxTurns: 3, directResponse: 'off',
        // This callback runs on the executor, after the distiller has completed its handoff.
        actorTurnCallback: turn => {
          inspectedTurns.push({ stage: turn.stage, isError: turn.isError, chatMessages: turn.chatLogMessages?.length ?? 0 });
          if (turn.stage === 'executor' && !turn.isError && turn.output.includes('inspected-count=2')) {
            abortBoundary = { attempts, requestIds: completedRequests.map(request => request.requestId) };
            cancellation.abort('caller cancelled after executor inspection');
          }
        },
      });
      try {
        axGlobals.onUsage = event => { events.push(event); };
        await assert.rejects(() => worker.forward(model, { task: 'Inspect invoices, then compute the total. Private reference: aborted-invoice-private-marker.' }, {
          ...options(ctx), stream: false,
          abortSignal: AbortSignal.any([ctx.signal, cancellation.signal]),
          usageContext: { runId: 'opaque-partial-run', feature: 'partial-invoice-inspection' },
        }));
        assert.ok(cancellation.signal.aborted && abortBoundary, 'the real successful executor turn must cause cancellation');
        assert.equal(attempts, abortBoundary.attempts, 'no provider request starts after the cancellation boundary');
        assert.deepEqual(completedRequests.map(request => request.requestId), abortBoundary.requestIds);
        assertUsageOwnership(events, completedRequests);
        for (const event of events) {
          assert.equal(event.context?.runId, 'opaque-partial-run');
          assert.equal(event.context?.feature, 'partial-invoice-inspection');
          assert.doesNotMatch(JSON.stringify(event), /aborted-invoice-private-marker|javascriptCode|inspected-count/);
        }
        assert.ok(completedRequests.some(request => request.stage === 'distiller'));
        assert.ok(completedRequests.some(request => request.stage === 'executor'));
        assert.ok(inspectedTurns.some(turn => turn.stage === 'executor' && !turn.isError && turn.chatMessages > 0));
        const staged = worker.getStagedUsage();
        assert.equal(usageTokens(staged.ctx?.actor ?? []), stageTokens(completedRequests, 'distiller'));
        assert.equal(usageTokens(staged.task.actor), stageTokens(completedRequests, 'executor'));
        assert.equal(staged.task.responder.length, 0);
        assert.ok(worker.getUsage().actor.length > 0); assert.equal(worker.getUsage().responder.length, 0);
        const chatLog = worker.getChatLog();
        assert.ok(chatLog.length > 0);
        assert.ok(chatLog.every(entry => completedRequests.some(request => entry.remoteRequestId === request.requestId)));
        return { completedRequests, observedUsageEvents: events.length, retainedStageChatEntries: chatLog.length, inspectedTurns, responderCalls: 0, boundary: 'an aborted run is not free: global events cover completed provider calls and staged usage retains executor work; getChatLog may contain only completed flow stages, so capture executor callback chatLogMessages when interrupted-stage detail is needed' };
      } finally { worker.stop(); cancellation.abort('fixture cleanup'); axGlobals.onUsage = undefined; }
    },
  },
];
