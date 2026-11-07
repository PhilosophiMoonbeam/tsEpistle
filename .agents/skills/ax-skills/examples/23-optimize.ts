import assert from 'node:assert/strict';
import {
  AxBootstrapFewShot, AxGEPA, AxGen, ax, optimize,
  axSerializeOptimizedProgram, axDeserializeOptimizedProgram,
  type AxChatResponse, type AxMetricFn, type AxMultiMetricFn,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example, type ExampleContext } from './support.js';

// Fixtures are explicit model outputs. Ax still collects traces, scores candidates,
// selects the frontier, and applies serialized artifacts; this is not model-quality evidence.
const response = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && key in value ? Reflect.get(value, key) : undefined;
const train = [
  { ticket: 'Checkout is down for every customer.', priority: 'high' },
  { ticket: 'Production database unavailable.', priority: 'high' },
];
// Selection holdout: never supplied as bootstrap training or teacher feedback examples.
const validation = [{ ticket: 'All customer logins fail with a server error.', priority: 'high' }];
const metric: AxMetricFn = ({ prediction, example }) => field(prediction, 'priority') === example.priority ? 1 : 0;
const makeProgram = () => ax('ticket:string -> priority:class "high, normal", rationale:string');
const answer = 'Priority: high\nRationale: Customer-facing outage.';

function teacherFixture() {
  return scriptedAI(request => {
    const prompt = JSON.stringify(request.chatPrompt);
    if (prompt.includes('Feedback Summary')) return response('Feedback Summary: Route customer-facing outages to high priority.');
    if (prompt.includes('New Value')) return response('New Value: OUTAGE_RULE: Classify customer-facing outages as high priority. Explain in one short sentence.');
    return response(answer); // Bootstrap execution, not a prebuilt demonstration artifact.
  });
}

async function globalPipeline(ctx: ExampleContext) {
  const studentAI = ctx.mode === 'live' ? ctx.ai : scriptedAI(() => response(answer));
  const teacherAI = ctx.mode === 'live' ? ctx.ai : teacherFixture();
  const program = makeProgram();
  const result = await optimize(program, train, metric, {
    studentAI, teacherAI, teacherOptions: options(ctx),
    bootstrap: { maxRounds: 1, maxExamples: 1, maxDemos: 1, batchSize: 1, verboseMode: false },
    numTrials: 1, sampleCount: 1, minibatch: true, minibatchSize: 1,
    validationExamples: validation, maxMetricCalls: 8, seed: 7, verbose: false,
  });
  assert.ok(result.optimizedProgram);
  assert.ok(result.optimizedProgram.demos?.some(demo => demo.traces.length > 0));
  assert.equal(typeof result.baselineScore, 'number');
  assert.ok(result.bestScore >= (result.baselineScore ?? 0));
  // The serializer returns JSON-compatible data, not a string. Persist metadata separately.
  const serialized = axSerializeOptimizedProgram(result.optimizedProgram);
  const restored = axDeserializeOptimizedProgram(serialized);
  const production = makeProgram();
  production.setId(program.getId()); // Component/demo ownership is identified by stable program IDs.
  production.applyOptimization(restored);
  const replay = await production.forward(studentAI, validation[0]!, options(ctx));
  assert.ok(['high', 'normal'].includes(replay.priority));
  return { baseline: result.baselineScore, selected: result.bestScore,
    validationCount: validation.length, demoGroups: restored.demos?.length,
    totalEvaluationsIncludingBootstrap: result.stats.totalCalls, replay,
    comparison: 'Same held-out subset, model, sampleCount and metric before/after bootstrap. This fixture already scores 1; no improvement is claimed.' };
}

async function bootstrapOnly(ctx: ExampleContext) {
  const model = scriptedAI(() => response(answer));
  const program = makeProgram();
  const optimizer = new AxBootstrapFewShot({ studentAI: model, teacherAI: model,
    teacherOptions: options(ctx), verbose: false,
    options: { maxRounds: 1, maxExamples: 1, maxDemos: 1, batchSize: 1, verboseMode: false } });
  const result = await optimizer.compile(program, train, metric, { maxIterations: 1, maxDemos: 1, verbose: false });
  assert.ok(result.demos);
  assert.ok(result.demos.some(demo => demo.traces.length > 0));
  assert.equal(result.stats.totalCalls, 1);
  program.setDemos(result.demos);
  const replay = await program.forward(model, validation[0]!, options(ctx));
  assert.equal(replay.priority, 'high');
  return { demos: result.demos, calls: result.stats.totalCalls, replay,
    boundary: 'Bootstrap bestScore is successful-demo rate, not a held-out baseline comparison; validation above is separate.' };
}

async function directGEPA(ctx: ExampleContext, pareto: boolean) {
  let studentCalls = 0;
  let teacherCalls = 0;
  const studentAI = scriptedAI(request => {
    studentCalls++;
    const repaired = JSON.stringify(request.chatPrompt).includes('OUTAGE_RULE');
    return response(repaired ? answer : 'Priority: normal\nRationale: A deliberately verbose baseline explanation of a customer-facing outage.');
  });
  const teacherAI = scriptedAI(request => {
    teacherCalls++;
    return response(JSON.stringify(request.chatPrompt).includes('New Value')
      ? 'New Value: OUTAGE_RULE: Route customer-facing outages to high priority; keep rationale under 40 characters.'
      : 'Feedback Summary: The outage was misclassified; prioritize correctness and concise explanations.');
  });
  const program = makeProgram();
  const multi: AxMultiMetricFn = ({ prediction, example }) => ({
    accuracy: field(prediction, 'priority') === example.priority ? 1 : 0,
    brevity: String(field(prediction, 'rationale') ?? '').length <= 40 ? 1 : 0,
  });
  const optimizer = new AxGEPA({ studentAI, teacherAI, teacherOptions: options(ctx),
    numTrials: 1, sampleCount: 1, minibatch: true, minibatchSize: 1, seed: 7, verbose: false });
  const result = await optimizer.compile(program, train, pareto ? multi : metric, {
    bootstrap: false, validationExamples: validation, maxMetricCalls: 8, skipPerfectScore: false, verbose: false,
  });
  assert.ok(result.optimizedProgram);
  assert.equal(result.baselineScore, 0);
  assert.ok(result.bestScore > result.baselineScore);
  assert.ok(result.paretoFront.length > 0);
  assert.ok(teacherCalls >= 2 && teacherCalls <= 4);
  assert.ok(studentCalls <= 8);
  const restored = axDeserializeOptimizedProgram(axSerializeOptimizedProgram(result.optimizedProgram));
  program.applyOptimization(restored);
  const replay = await program.forward(studentAI, validation[0]!, options(ctx));
  assert.equal(replay.priority, 'high');
  return { baseline: result.baselineScores, selected: result.bestScore,
    frontier: result.paretoFront.map(point => ({ scores: point.scores, configuration: point.configuration })),
    componentMap: restored.componentMap, studentCalls, teacherCalls, replay,
    comparison: 'Train supplies reflection; held-out selection uses the same validation subset for baseline and candidates. Scalar reward depends on objective definitions/weights and dataset, so it is not an invariant across experiments.' };
}

async function budgetBoundary(ctx: ExampleContext) {
  let calls = 0;
  const model = scriptedAI(() => { calls++; return response(answer); });
  const optimizer = new AxGEPA({ studentAI: model, numTrials: 1, verbose: false });
  await assert.rejects(() => optimizer.compile(makeProgram(), train, metric, { maxMetricCalls: 0 }), /maxMetricCalls/);
  assert.equal(calls, 0);
  const program = makeProgram();
  const result = await optimizer.compile(program, train, metric, {
    maxMetricCalls: 1, validationExamples: validation, bootstrap: false,
  });
  assert.ok(result.optimizedProgram);
  assert.equal(result.baselineScore, result.bestScore);
  assert.equal(calls, 1);
  return { invalidBudgetRejectedBeforeModel: true, exhaustedBudgetRetainsBaseline: result.bestScore, calls };
}

async function qualitativeMetric(ctx: ExampleContext) {
  // Outside agent.optimize, own the qualitative rubric with one plain typed AxGen.
  const evaluator = new AxGen<{ taskInput: string; candidateOutput: string; expectedOutput: string }, { score: number }>(
    'taskInput:string, candidateOutput:string, expectedOutput:string -> score:number');
  evaluator.setInstruction('Score factual correctness from 0 to 1. Penalize invented claims. Return only score.');
  const judgeAI = ctx.mode === 'live' ? ctx.ai : scriptedAI([response('Score: 1')]);
  const judged = await evaluator.forward(judgeAI, {
    taskInput: 'Summarize: checkout is down.', candidateOutput: 'Checkout is unavailable.', expectedOutput: 'Checkout outage.',
  }, options(ctx));
  assert.ok(Number.isFinite(judged.score));
  const score = Math.max(0, Math.min(1, judged.score));
  assert.ok(score >= 0 && score <= 1);
  return { score, boundary: 'A rubric-bound model judgment is not exact correctness or an action-policy invariant. Use this numeric evaluator as a metric only when deterministic scoring is unavailable.' };
}

export const examples: readonly Example[] = [
  { id: '23-optimize/bootstrap-gepa-artifact', title: 'Normal optimize pipeline with bounded bootstrap and reusable artifact', features: ['optimize', 'BootstrapFewShot', 'baseline', 'validation', 'call-budgets', 'artifact-serialize-restore-apply'], modes: ['offline', 'live'], run: globalPipeline },
  { id: '23-optimize/bootstrap-traces', title: 'Low-level successful-trace demonstration selection', features: ['AxBootstrapFewShot', 'demos', 'held-out-replay'], modes: ['offline'], run: bootstrapOnly },
  { id: '23-optimize/direct-gepa', title: 'One real reflective mutation retained by the metric', features: ['AxGEPA', 'reflection', 'candidate-selection'], modes: ['offline'], run: ctx => directGEPA(ctx, false) },
  { id: '23-optimize/pareto', title: 'Accuracy and brevity as an actual Pareto objective vector', features: ['AxGEPA', 'Pareto', 'multi-objective', 'componentMap'], modes: ['offline'], run: ctx => directGEPA(ctx, true) },
  { id: '23-optimize/budget-boundary', title: 'Invalid budget rejection and baseline-only bounded selection', features: ['call-budgets', 'error-boundary', 'baseline-artifact'], modes: ['offline'], run: budgetBoundary },
  { id: '23-optimize/qualitative-metric', title: 'Plain typed AxGen qualitative evaluator, not a judge framework', features: ['AxGen', 'qualitative-metric', 'rubric'], modes: ['offline', 'live'], run: qualitativeMetric },
];
