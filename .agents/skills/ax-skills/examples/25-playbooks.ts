import assert from 'node:assert/strict';
import {
  ax, agent, playbook, AxJSRuntime, AxAIOpenAI, AxAIOpenAIModel,
  type AxChatResponse, type AxMetricFn, type AxAgentEvalPrediction,
  type AxPlaybookSnapshot,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example, type ExampleContext } from './support.js';

const response = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const lesson = 'PRAISE_RULE: Enthusiastic praise and five-star recommendations express positive sentiment.';
const reflection = [
  'Reasoning: The observed answer contradicts the supplied feedback.',
  'Error Identification: Praise was labeled negative.',
  'Root Cause Analysis: The sentiment rule ignored enthusiastic language.',
  'Correct Approach: Recognize enthusiastic praise as positive.',
  `Key Insight: ${lesson}`,
  'Bullet Tags: []',
].join('\n');
const curation = `Reasoning: Retain one reusable sentiment rule.\nOperations: ${JSON.stringify([{ type: 'ADD', section: 'sentiment', content: lesson }])}`;
function teacherFixture() {
  return scriptedAI(request => response(JSON.stringify(request.chatPrompt).includes('Operations') ? curation : reflection));
}
const sentimentMetric: AxMetricFn = ({ prediction, example }) =>
  prediction !== null && typeof prediction === 'object' && 'sentiment' in prediction && prediction.sentiment === example.sentiment ? 1 : 0;

async function offlineEvolution(ctx: ExampleContext) {
  const program = ax('review:string -> sentiment:class "positive, negative"');
  const studentAI = scriptedAI(request => response(JSON.stringify(request.chatPrompt).includes('PRAISE_RULE')
    ? 'Sentiment: positive' : 'Sentiment: negative'));
  const pb = playbook(program, { studentAI, teacherAI: teacherFixture(), teacherOptions: options(ctx),
    maxEpochs: 1, maxReflectorRounds: 1, maxSectionSize: 3, seed: 7, verbose: false });
  const train = [
    { review: 'Five stars, would buy again!', sentiment: 'positive' },
    { review: 'Absolutely wonderful; I recommend it!', sentiment: 'positive' },
  ];
  const result = await pb.evolve(train, sentimentMetric);
  assert.equal(result.bestScore, 1);
  assert.ok(result.playbook.stats.bulletCount > 0);
  assert.equal(pb.getState().artifact.feedback.length, 2);
  pb.applyTo();
  pb.applyTo();
  assert.equal((program.getSignature().getDescription() ?? '').split('## Context Playbook').length - 1, 1);
  // A real JSON round-trip of SDK-produced state, never a prefilled playbook.
  const saved: AxPlaybookSnapshot = JSON.parse(JSON.stringify(pb.toJSON()));
  const fresh = ax('review:string -> sentiment:class "positive, negative"');
  const restored = playbook(fresh, { studentAI, maxReflectorRounds: 1 }).load(saved);
  assert.deepEqual(restored.getState(), saved);
  const heldOut = { review: 'Delightful experience. Highly recommended!' };
  const replay = await fresh.forward(studentAI, heldOut, options(ctx));
  assert.equal(replay.sentiment, 'positive');
  return { bestTrainingScore: result.bestScore, bullets: saved.playbook.stats.bulletCount,
    feedbackEvents: saved.artifact.feedback.length, historyEntries: saved.artifact.history.length,
    rendered: restored.render(), replay,
    boundary: 'Program evolve bestScore is the best observed training score, not a held-out aggregate. Replay is separate; fixtures prove state plumbing, not generalization.' };
}

async function onlineUpdate(ctx: ExampleContext) {
  const program = ax('review:string -> sentiment:class "positive, negative"');
  const studentAI = ctx.mode === 'live' ? ctx.ai : scriptedAI(() => response('Sentiment: negative'));
  const teacherAI = ctx.mode === 'live' ? ctx.ai : teacherFixture();
  const example = { review: 'Five stars, would buy again!' };
  const prediction = await program.forward(studentAI, example, options(ctx));
  const pb = playbook(program, { studentAI, teacherAI, teacherOptions: options(ctx), maxReflectorRounds: 1, maxSectionSize: 3, verbose: false });
  // Lazy hydration: no evolve/load prerequisite. Feedback is a user observation, not a score oracle.
  await pb.update({ example, prediction, feedback: 'The correct label is positive: enthusiastic praise is positive. Remember the general rule, not this exact review.' });
  assert.ok(pb.getState().playbook.stats.bulletCount > 0);
  assert.equal(pb.getState().artifact.feedback.length, 1);
  assert.equal(pb.getState().artifact.history[0]?.source, 'online');
  const snapshot = pb.toJSON();
  const production = ax('review:string -> sentiment:class "positive, negative"');
  const restored = playbook(production, { studentAI }).load(snapshot);
  assert.equal(restored.render(), pb.render());
  return { observed: prediction, bulletCount: snapshot.playbook.stats.bulletCount,
    knowledge: restored.render(), historySources: snapshot.artifact.history.map(item => item.source),
    boundary: 'Online feedback is trusted adaptation, not held-out proof. Only agent-bound verified evolve provides the held-in/held-out acceptance gate.' };
}

async function verifiedAgentEvolution(ctx: ExampleContext, retain: boolean) {
  let lastAnswer = 'wrong';
  // Deterministic model behavior: only the retained lesson changes its proposed answer.
  // Real Ax agent execution, action logs, weakness evidence verification, ACE deltas,
  // validation metrics, and exact rollback remain SDK-owned.
  const executor = scriptedAI(request => {
    if (!JSON.stringify(request.responseFormat ?? {}).includes('javascriptCode')) {
      return response(request.responseFormat ? JSON.stringify({ answer: lastAnswer }) : `Answer: ${lastAnswer}`);
    }
    const taskStage = request.chatPrompt.some(message => message.role === 'user' &&
      typeof message.content === 'string' && message.content.includes('Executor Request:'));
    if (!taskStage) return response(JSON.stringify({ javascriptCode: 'await final("Answer the query using the standing guidance.", {});' }));
    lastAnswer = retain && JSON.stringify(request.chatPrompt).includes('PRAISE_RULE') ? 'positive' : 'wrong';
    return response(JSON.stringify({ javascriptCode: `console.log("SENTIMENT_MISS"); await final("Return the sentiment label.", {label: ${JSON.stringify(lastAnswer)}});` }));
  }, { structuredOutputs: true });
  const a = agent('query:string -> answer:string', {
    ai: executor, contextFields: [], directResponse: 'off', maxTurns: 2, maxSubAgentCalls: 0,
    runtime: new AxJSRuntime({ nodeWorkerPoolSize: 1, timeout: 5000 }),
    contextOptions: options(ctx), executorOptions: options(ctx), responderOptions: options(ctx),
  });
  const teacher = scriptedAI(request => {
    const prompt = JSON.stringify(request.chatPrompt);
    if (prompt.includes('Weakness Description')) return response([
      'Weakness Description: The agent ignores positive sentiment cues.',
      'Root Cause: It lacks a reusable positive-praise rule.',
      `Proposed Guidance: ${lesson}`,
      'Evidence Quotes: ["SENTIMENT_MISS"]',
      'Config Recommendations: []',
    ].join('\n'));
    return response(prompt.includes('Operations') ? curation : reflection);
  });
  const apb = a.playbook({ target: 'actor', teacherAI: teacher, teacherOptions: options(ctx), maxReflectorRounds: 1, maxSectionSize: 3 });
  const before = apb.getState();
  const metric: AxMetricFn = ({ prediction }) => {
    const run = prediction as AxAgentEvalPrediction<{ answer: string }>;
    return run.completionType === 'final' && run.output.answer === 'positive' ? 1 : 0;
  };
  const result = await apb.evolve({
    train: [{ id: 'praise-training', input: { query: 'Classify: five stars, would buy again!' }, criteria: 'Answer positive.' }],
    validation: [{ id: 'praise-held-out', input: { query: 'Classify: wonderful service, highly recommended!' }, criteria: 'Answer positive.' }],
  }, {
    metric, teacherAI: teacher, teacherOptions: options(ctx), verify: true,
    maxProposals: 1, maxMetricCalls: 4, runsPerTask: 1, epsilon: 0, minHeldInGain: 0.5,
    abortSignal: ctx.signal, verbose: false,
  });
  assert.equal(result.weaknesses.length, 1);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.accepted, retain);
  assert.equal(result.metricCallsUsed, 4);
  if (retain) {
    assert.ok(result.playbookSnapshot);
    assert.equal(result.final.heldIn, 1);
    assert.equal(result.final.heldOut, 1);
    const persisted = apb.toJSON();
    apb.load(persisted);
    assert.deepEqual(apb.getState(), persisted);
    assert.ok(apb.render().includes('PRAISE_RULE'));
  } else {
    assert.deepEqual(apb.getState(), before); // Exact prior snapshot, including history, not just bullet count.
    assert.deepEqual(result.final, result.baseline);
    assert.equal(result.playbookSnapshot, undefined);
  }
  return { baseline: result.baseline, final: result.final,
    outcomes: result.outcomes, calls: result.metricCallsUsed, knowledge: apb.render(),
    comparison: 'Identical train/held-out task sets and deterministic scoring before and after one proposed bullet. No online feedback is mislabeled as held-out validation.' };
}

async function teacherPermission(ctx: ExampleContext) {
  let httpCalls = 0;
  // Isolated real provider transport: dummy credential is never transmitted.
  // AxBaseAI, not the mock service, owns the expensive-model permission check.
  const teacher = new AxAIOpenAI({ apiKey: 'fixture-not-a-secret',
    config: { model: AxAIOpenAIModel.GPT55Pro, stream: false },
    options: { fetch: async (_url, init) => {
      httpCalls++;
      const prompt = String(init?.body ?? '');
      const curate = prompt.includes('Operations') || prompt.includes('"operations"');
      const content = prompt.includes('"response_format"')
        ? JSON.stringify(curate
          ? { reasoning: 'Retain one reusable sentiment rule.', operations: [{ type: 'ADD', section: 'sentiment', content: lesson }] }
          : { reasoning: 'Feedback identifies a sentiment error.', errorIdentification: 'Praise labeled negative.',
            rootCauseAnalysis: 'Ignored enthusiastic language.', correctApproach: 'Treat praise as positive.',
            keyInsight: lesson, bulletTags: [] })
        : curate ? curation : reflection;
      return new Response(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', created: 0,
        model: 'gpt-5.5-pro', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  const studentAI = scriptedAI(() => response('Sentiment: negative'));
  const event = { example: { review: 'Five stars!' }, prediction: { sentiment: 'negative' }, feedback: 'Praise is positive.' };
  const denied = playbook(ax('review:string -> sentiment:string'), { studentAI, teacherAI: teacher,
    teacherOptions: { ...options(ctx), stream: false }, maxReflectorRounds: 1, verbose: false });
  await denied.update(event); // ACE intentionally catches reflector failures; inspect state and transport count.
  assert.equal(httpCalls, 0);
  assert.equal(denied.getState().playbook.stats.bulletCount, 0);
  const allowed = playbook(ax('review:string -> sentiment:string'), { studentAI, teacherAI: teacher,
    teacherOptions: { ...options(ctx), stream: false, useExpensiveModel: 'yes' }, maxReflectorRounds: 1, verbose: false });
  await allowed.update(event);
  assert.equal(httpCalls, 2); // One reflection, one curation; no expensive teacher election.
  assert.ok(allowed.getState().playbook.stats.bulletCount > 0);
  return { deniedBeforeTransport: true, permittedTransportCalls: httpCalls,
    bullets: allowed.getState().playbook.stats.bulletCount,
    prerequisite: 'A real expensive teacher needs its own provider credential and explicit teacherOptions.useExpensiveModel=yes. Agent mining and curation each have separately owned teacherOptions.' };
}

export const examples: readonly Example[] = [
  { id: '25-playbooks/program-evolve', title: 'Program-bound offline ACE evolution, idempotent application and persistence', features: ['playbook', 'program-bound', 'offline-evolve', 'applyTo', 'persistence'], modes: ['offline'], run: offlineEvolution },
  { id: '25-playbooks/online-update', title: 'Lazy online feedback adaptation with persisted knowledge', features: ['playbook', 'online-update', 'lazy-hydration', 'persistence'], modes: ['offline', 'live'], run: onlineUpdate },
  { id: '25-playbooks/agent-verified-retain', title: 'One grounded agent lesson passes held-in and held-out gates', features: ['agent.playbook', 'verified-evolve', 'evidence-quotes', 'held-out-gate', 'persistence'], modes: ['offline'], run: ctx => verifiedAgentEvolution(ctx, true) },
  { id: '25-playbooks/agent-verified-reject', title: 'An ineffective bullet is rejected with exact snapshot rollback', features: ['agent.playbook', 'verified-evolve', 'rejection', 'rollback'], modes: ['offline'], run: ctx => verifiedAgentEvolution(ctx, false) },
  { id: '25-playbooks/teacher-permission', title: 'Real provider expensive-model gate with isolated HTTP fixture', features: ['teacher-permission', 'reflector', 'curator', 'error-boundary', 'isolated-transport'], modes: ['offline'], run: teacherPermission },
];
