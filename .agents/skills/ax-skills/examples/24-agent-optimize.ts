import assert from 'node:assert/strict';
import {
  agent, fn, f, AxJSRuntime, axSerializeOptimizedProgram, axDeserializeOptimizedProgram,
  type AxChatResponse, type AxMetricFn, type AxAgentEvalPrediction, type AxAgentEvalTask,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example, type ExampleContext } from './support.js';

const response = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
type Input = { query: string };
type Output = { answer: string };
const train: readonly AxAgentEvalTask<Input>[] = [
  { id: 'stock-a', input: { query: 'Look up stock for SKU-1.' }, criteria: 'Read inventory.lookup once for SKU-1 and report 7. Never reserve stock.', expectedOutput: { answer: '7' }, expectedActions: ['inventory.lookup'], forbiddenActions: ['inventory.reserve'] },
  { id: 'stock-b', input: { query: 'How many SKU-1 units are available? Query inventory.' }, criteria: 'Use inventory.lookup for SKU-1 and report 7 without mutation.', expectedOutput: { answer: '7' }, expectedActions: ['inventory.lookup'], forbiddenActions: ['inventory.reserve'] },
];
const validation: readonly AxAgentEvalTask<Input>[] = [
  { id: 'held-out-stock', input: { query: 'Check the available count of SKU-1 without changing inventory.' }, criteria: 'Call inventory.lookup once; answer 7; never reserve stock.', expectedOutput: { answer: '7' }, expectedActions: ['inventory.lookup'], forbiddenActions: ['inventory.reserve'] },
];

function makeAssistant(ctx: ExampleContext, distinctActorIds = false) {
  const ledger: string[] = [];
  const tools = [
    fn('lookup').namespace('inventory').description('Read current stock without changing it.')
      .arg('sku', f.string()).returns(f.object({ sku: f.string(), available: f.number() }))
      .handler(async ({ sku }) => { ledger.push(`lookup:${sku}`); return { sku, available: sku === 'SKU-1' ? 7 : 0 }; }).build(),
    fn('reserve').namespace('inventory').description('Reserve stock; forbidden for these read-only tasks.')
      .arg('sku', f.string()).returns(f.object({ reserved: f.boolean() }))
      .handler(async ({ sku }) => { ledger.push(`reserve:${sku}`); return { reserved: true }; }).build(),
  ];
  // Route deterministic responses by the actual stage request. Evaluation can use
  // the agent's configured model for every stage, rather than forward-time overrides.
  const executor = ctx.mode === 'live' ? ctx.ai : scriptedAI(request => {
    const schema = JSON.stringify(request.responseFormat ?? {});
    const taskStage = request.chatPrompt.some(message => message.role === 'user' &&
      typeof message.content === 'string' && message.content.includes('Executor Request:'));
    if (!schema.includes('javascriptCode')) return response(request.responseFormat ? '{"answer":"7"}' : 'Answer: 7');
    return response(JSON.stringify({ javascriptCode: taskStage
      ? 'const stock = await inventory.lookup({sku: "SKU-1"}); await final("Report the available count.", {stock});'
      : 'await final("Look up stock for SKU-1 without reserving it.", {});' }));
  }, { structuredOutputs: true });
  const assistant = agent('query:string -> answer:string', {
    ai: executor, contextFields: [], functions: tools, directResponse: 'off',
    runtime: new AxJSRuntime({ nodeWorkerPoolSize: 1, timeout: 5000 }),
    maxTurns: 2, maxSubAgentCalls: 0,
    contextOptions: options(ctx),
    executorOptions: { ...options(ctx), description: 'Use inventory.lookup for read-only stock requests; never reserve. Only SKU-1 is requested.' },
    responderOptions: { ...options(ctx), description: 'Return only the numeric available count as answer.' },
  });
  if (distinctActorIds) {
    // Only the error-boundary case separates IDs to expose the raw context
    // trace incorrectly routed to the executor by the published SDK.
    const contextProgram = assistant.namedProgramInstances().find(entry =>
      entry.id.startsWith('ctx.') && !entry.id.endsWith('.actor'))?.program;
    assert.ok(contextProgram);
    contextProgram.setId('stock-context');
    assistant.setId('stock-task');
  }
  return { assistant, executor, ledger };
}

// A deterministic metric replaces (does not supplement) the built-in judge.
// Explicit action checks matter: a fluent answer alone must not earn full credit.
const actionMetric: AxMetricFn = ({ prediction }) => {
  const run = prediction as AxAgentEvalPrediction<Output>;
  if (run.completionType !== 'final' || run.output.answer.trim() !== '7') return 0;
  const reads = run.functionCalls.filter(call => call.qualifiedName === 'inventory.lookup');
  if (reads.length !== 1 || run.functionCalls.some(call => call.qualifiedName === 'inventory.reserve')) return 0;
  if (run.toolErrors.length > 0) return 0;
  return 1;
};

async function deterministicTuning(ctx: ExampleContext) {
  const { assistant, executor, ledger } = makeAssistant(ctx);
  const teacher = ctx.mode === 'live' ? ctx.ai : scriptedAI(request => response(
    JSON.stringify(request.chatPrompt).includes('New Value')
      ? 'New Value: Prefer the read-only inventory lookup; never reserve when only stock is requested.'
      : 'Feedback Summary: Keep exact SKU lookup and avoid all write operations.'));
  const result = await assistant.optimize({ train, validation }, {
    studentAI: executor, teacherAI: teacher, teacherOptions: options(ctx), metric: actionMetric,
    // This successful artifact path deliberately does not request the broken
    // pipeline bootstrap path. The separate offline case exposes both defects.
    bootstrap: false, apply: false, numTrials: 1, sampleCount: 1,
    minibatch: true, minibatchSize: 1, maxMetricCalls: 6, seed: 7, verbose: false,
  });
  assert.ok(result.optimizedProgram);
  assert.equal(typeof result.baselineScore, 'number');
  assert.ok(result.optimizedProgram.componentMap && Object.keys(result.optimizedProgram.componentMap).length > 0);
  assert.equal(result.optimizedProgram.demos?.length ?? 0, 0);
  assert.ok(result.stats.totalCalls <= 6);
  assert.ok(ledger.every(entry => entry.startsWith('lookup:')));
  const saved = axSerializeOptimizedProgram(result.optimizedProgram);
  // Fresh tool ledger and agent continuation state: evaluation side effects cannot leak into replay.
  const fresh = makeAssistant(ctx);
  fresh.assistant.setId(assistant.getId());
  const restored = axDeserializeOptimizedProgram(saved);
  assert.deepEqual(restored.componentMap, result.optimizedProgram.componentMap);
  assert.deepEqual(restored.demos, result.optimizedProgram.demos);
  fresh.assistant.applyOptimization(restored);
  const replay = await fresh.assistant.forward(fresh.executor, validation[0]!.input, options(ctx));
  assert.equal(replay.answer.trim(), '7');
  assert.deepEqual(fresh.ledger, ['lookup:SKU-1']);
  return { baseline: result.baselineScore, selected: result.bestScore,
    componentKeys: Object.keys(restored.componentMap ?? {}),
    bootstrap: 'Explicitly disabled: 25.4.9 pipeline trace filtering/routing is covered by bootstrap-boundaries, not hidden behind an automatic fallback.',
    optimizationLookups: ledger.length, replay, replayLedger: fresh.ledger,
    comparison: 'Train and held-out selection tasks are disjoint. The offline student already obeys the action policy: this real component artifact proves portability, not a quality gain or demonstration training. Public BootstrapFewShot demonstration training and restore are exercised separately in 23-optimize. Reward depends on this dataset, action policy, and cost rubric.' };
}

async function bootstrapBoundaries(ctx: ExampleContext) {
  const filtered = makeAssistant(ctx);
  const scoredTasks: string[] = [];
  const common = {
    teacherOptions: options(ctx), numTrials: 1, sampleCount: 1,
    maxMetricCalls: 1, apply: false, verbose: false,
    bootstrap: { maxBootstrapMetricCalls: 1, maxBootstrapDemos: 3, scoreThreshold: 1 },
  } as const;
  const result = await filtered.assistant.optimize({ train, validation }, {
    ...common, studentAI: filtered.executor, teacherAI: filtered.executor,
    metric: async args => {
      const score = await actionMetric(args);
      assert.equal(score, 1);
      scoredTasks.push((args.example as AxAgentEvalTask<Input>).id!);
      return score;
    },
  });
  assert.ok(result.optimizedProgram);
  assert.equal(result.optimizedProgram.demos?.length ?? 0, 0);
  assert.ok(scoredTasks.includes(train[0]!.id!));
  assert.ok(scoredTasks.includes(validation[0]!.id!));
  assert.deepEqual(filtered.ledger, ['lookup:SKU-1', 'lookup:SKU-1']);

  // Selecting every descriptor removes the trace filter, but is NOT a fix:
  // bootstrap then passes the context actor's raw ID to the task-side router.
  const unroutable = makeAssistant(ctx, true);
  await assert.rejects(() => unroutable.assistant.optimize({ train, validation }, {
    ...common, studentAI: unroutable.executor, teacherAI: unroutable.executor,
    metric: actionMetric,
    target: unroutable.assistant.namedPrograms().map(({ id }) => id),
  }), /Unknown program ID\(s\) in demos: stock-context\.actor/);
  assert.deepEqual(unroutable.ledger, ['lookup:SKU-1', 'lookup:SKU-1']);
  return {
    successfulScoredTasks: scoredTasks,
    defaultBootstrapDemos: result.optimizedProgram.demos?.length ?? 0,
    explicitAllDescriptorsRejected: true,
    lookupCounts: [filtered.ledger.length, unroutable.ledger.length],
    boundary: '25.4.9 default pipeline targets filter out raw trace IDs; selecting every descriptor exposes incompatible context-demo routing instead. Neither is a working agent bootstrap recipe. Use the explicit bootstrap:false component-artifact case, or public BootstrapFewShot training in 23-optimize for supported generator demonstrations.',
  };
}

async function builtInJudge(ctx: ExampleContext) {
  const { assistant, executor, ledger } = makeAssistant(ctx);
  let judgeCalls = 0;
  const judgeAI = ctx.mode === 'live' ? ctx.ai : scriptedAI(() => {
    judgeCalls++;
    return response('Reasoning: The full run reads SKU-1 exactly once, returns 7, and has no reservation or tool error.\nQuality: excellent');
  });
  // No custom metric: Ax owns holistic run judging and expected/forbidden-action adjustment.
  // One baseline validation evaluation exhausts the budget, yielding a real baseline artifact.
  const result = await assistant.optimize({ train, validation }, {
    studentAI: executor, judgeAI, teacherAI: judgeAI,
    judgeOptions: { ...options(ctx), description: 'Prioritize correct read-only actions over wording.' },
    teacherOptions: options(ctx), bootstrap: false, maxMetricCalls: 1,
    numTrials: 1, sampleCount: 1, apply: false, verbose: false,
  });
  assert.ok(result.optimizedProgram);
  assert.equal(result.bestScore, result.baselineScore);
  if (ctx.mode === 'offline') assert.equal(judgeCalls, 1);
  assert.deepEqual(ledger, ['lookup:SKU-1']);
  return { baseline: result.baselineScore, selected: result.bestScore, ledger,
    artifactComponents: Object.keys(result.optimizedProgram.componentMap ?? {}).length,
    boundary: 'Built-in judge sees completion, final output, calls, errors and turns. This bounded validation does not claim evolution or reward invariance.' };
}

async function datasetBoundary(ctx: ExampleContext) {
  const { assistant, ledger } = makeAssistant(ctx);
  await assert.rejects(() => assistant.optimize([], { maxMetricCalls: 1 }), /at least one training task/);
  assert.deepEqual(ledger, []);
  return { emptyDatasetRejected: true, toolSideEffects: ledger.length };
}

export const examples: readonly Example[] = [
  { id: '24-agent-optimize/action-metric-artifact', title: 'Action-aware tuning with a real component-only artifact and held-out replay', features: ['agent.optimize', 'dataset', 'action-aware', 'deterministic-metric', 'saved-components', 'artifact-replay'], modes: ['offline', 'live'], run: deterministicTuning },
  { id: '24-agent-optimize/bootstrap-boundaries', title: 'Pipeline bootstrap exposes filtered traces and rejects unroutable context demos', features: ['agent.optimize', 'bootstrap', 'trace-eligibility', 'demo-routing', 'error-boundary'], modes: ['offline'], run: bootstrapBoundaries },
  { id: '24-agent-optimize/builtin-judge-validation', title: 'Built-in holistic judge with an explicit baseline-only call budget', features: ['agent.optimize', 'built-in-judge', 'judgeOptions', 'validation', 'baseline-artifact'], modes: ['offline', 'live'], run: builtInJudge },
  { id: '24-agent-optimize/dataset-boundary', title: 'Empty task dataset fails before any tool execution', features: ['agent.optimize', 'error-boundary'], modes: ['offline'], run: datasetBoundary },
];
