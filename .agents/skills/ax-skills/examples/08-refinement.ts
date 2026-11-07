import assert from 'node:assert/strict';
import {
  ax, bestOfN, refine, AxGen, AxRefineError,
  type AxChatResponse, type AxOptimizableComponent,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const question = 'What is the capital of France? Answer concisely, mentioning the city and country.';
const response = (answer: string, totalTokens = 12): AxChatResponse => ({
  results: [{ index: 0, content: `Answer: ${answer}` }],
  modelUsage: { ai: 'offline-script', model: 'fixture-model', tokens: { promptTokens: totalTokens - 4, completionTokens: 4, totalTokens } },
});
// Preference, NOT a hard invariant: incomplete/wrong candidates still parse successfully.
const reward = (answer: string) => Number(/\bParis\b/i.test(answer)) * 0.5 + Number(/\bFrance\b/i.test(answer)) * 0.5;
const instructionSnapshot = (program: { getOptimizableComponents(): readonly AxOptimizableComponent[] }) =>
  program.getOptimizableComponents().filter((component) => component.kind === 'instruction').map(({ key, current }) => ({ key, current }));

// This application's policy is immutable to optimizers, while Ax still generates normally.
// No instruction component is advertised, so refine must report adviceApplied=false.
class FixedPolicyProgram extends AxGen<{ question: string }, { answer: string }> {
  override getOptimizableComponents(): readonly AxOptimizableComponent[] {
    return super.getOptimizableComponents().filter((component) => component.kind !== 'instruction');
  }
}

export const examples: readonly Example[] = [
  {
    id: '08-refinement/native-samples',
    title: 'Select a complete candidate using real native sampleCount/resultPicker machinery',
    features: ['bestOfN', 'native-samples', 'auto strategy', 'reward function', 'selected diagnostics', 'usage'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const program = ax('question:string -> answer:string');
      program.addAssert((prediction) => prediction.answer.trim().length > 0, 'Answer must not be empty');
      let calls = 0;
      const fixture = scriptedAI((request) => {
        calls++;
        assert.equal(request.modelConfig?.n, 3);
        assert.equal(request.modelConfig?.stream, false);
        return {
          results: [
            { index: 0, content: 'Answer: Lyon.' },
            { index: 1, content: 'Answer: Paris.' },
            { index: 2, content: 'Answer: Paris is the capital of France.' },
          ],
          modelUsage: { ai: 'offline-script', model: 'fixture-model', tokens: { promptTokens: 20, completionTokens: 18, totalTokens: 38 } },
        };
      });
      // auto selects native samples for AxGen. All candidates are generated before scoring.
      const selected = bestOfN(program, {
        n: 3, strategy: 'auto',
        rewardFn: ({ prediction, traces, chatLog }) => {
          assert.equal(traces.length, 0); assert.equal(chatLog.length, 0);
          return reward(prediction.answer);
        },
      });
      const result = await selected.forward(ctx.mode === 'live' ? ctx.ai : fixture, { question }, { ...options(ctx), maxRetries: 0 });
      const attempts = selected.getAttempts();
      assert(attempts.length > 0);
      assert(attempts.every((attempt) => attempt.strategy === 'native-samples'));
      assert.equal(reward(result.answer), Math.max(...attempts.map((attempt) => attempt.reward ?? -Infinity)));
      if (ctx.mode === 'offline') {
        assert.equal(calls, 1); assert.equal(attempts.length, 3);
        assert.deepEqual(attempts.map((attempt) => attempt.reward), [0, 0.5, 1]);
        assert.equal(result.answer, 'Paris is the capital of France.');
        assert.equal(selected.getUsage().reduce((sum, usage) => sum + (usage.tokens?.totalTokens ?? 0), 0), 38);
      }
      return {
        result, attempts: attempts.map(({ sampleIndex, reward: value, strategy, traces, chatLog }) => ({ sampleIndex, reward: value, strategy, traceEntries: traces.length, chatEntries: chatLog.length })),
        candidateUsage: selected.getUsage(), selectedTraceEntries: selected.getTraces().length,
        prerequisite: 'Live generative model/provider must support multiple completion samples. No decision provider.',
        proof: 'Reward chooses among complete candidates; fixture rewards do not measure real answer quality.',
      };
    },
  },
  {
    id: '08-refinement/serial-threshold',
    title: 'Score isolated full attempts and commit only the good-enough selection',
    features: ['bestOfN serial', 'threshold', 'failCount', 'attempt errors', 'onAttempt', 'traces', 'chat logs', 'in-memory effects'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const program = ax('question:string -> answer:string');
      program.addAssert((prediction) => prediction.answer.trim().length > 0, 'Nonempty is a hard invariant; reward is a preference');
      const audit: { attempt: number; reward?: number; failed: boolean }[] = [];
      let calls = 0;
      const fixture = scriptedAI(() => {
        const index = calls++;
        if (index === 0) throw new Error('Isolated fixture transport failure');
        return response(index === 1 ? 'Paris.' : 'Paris is the capital of France.');
      });
      const selected = bestOfN(program, {
        n: 4, strategy: 'serial', threshold: 1, failCount: 1,
        rewardFn: ({ prediction }) => reward(prediction.answer),
        // This hook is diagnostics only: NOT a publish/send/write hook for every candidate.
        onAttempt: (attempt) => { audit.push({ attempt: attempt.attempt, reward: attempt.reward, failed: attempt.error !== undefined }); },
      });
      const result = await selected.forward(ctx.mode === 'live' ? ctx.ai : fixture, { question }, { ...options(ctx), maxRetries: 0, modelConfig: { ...options(ctx).modelConfig, stream: false } });
      const attempts = selected.getAttempts();
      const chosen = attempts.find((attempt) => attempt.prediction === result);
      assert(chosen); assert.equal(chosen.error, undefined);
      assert.deepEqual(selected.getTraces(), chosen.traces);
      assert.deepEqual(selected.getChatLog(), chosen.chatLog);
      assert.equal(audit.length, attempts.length);
      // One application-owned effect, after final selection. Serial sessions do NOT roll back tools.
      const outbox: { draft: string }[] = [];
      outbox.push({ draft: result.answer });
      assert.equal(outbox.length, 1);
      if (ctx.mode === 'offline') {
        assert.equal(calls, 3); // Error + below-threshold + good-enough; fourth never runs.
        assert.equal(attempts.length, 3); assert(attempts[0]!.error instanceof Error);
        assert.equal(chosen.reward, 1);
        assert.equal(selected.getUsage().reduce((sum, usage) => sum + (usage.tokens?.totalTokens ?? 0), 0), 24);
      }
      return { result, audit, errors: attempts.filter((attempt) => attempt.error).map((attempt) => ({ attempt: attempt.attempt, message: String(attempt.error) })), candidateUsage: selected.getUsage(), selectedTraceEntries: selected.getTraces().length, selectedChatEntries: selected.getChatLog().length, outbox, proof: 'Fresh attempt sessions isolate model state, not external effects; this example only stages an in-memory draft.' };
    },
  },
  {
    id: '08-refinement/feedback-rounds',
    title: 'Apply real generated serial feedback temporarily, then restore instructions',
    features: ['refine', 'serial feedback', 'rewardDescription', 'feedbackAI', 'adviceApplied', 'instruction restoration'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const program = ax('question:string -> answer:string');
      program.setInstruction('Answer the supplied geography question in one concise sentence.');
      const originals = instructionSnapshot(program);
      const key = originals[0]?.key;
      assert(key);
      let actorCalls = 0; let feedbackCalls = 0;
      const actorFixture = scriptedAI((request) => {
        const index = actorCalls++;
        if (index > 0) assert(JSON.stringify(request.chatPrompt).includes('Mention both the capital and the country'));
        return response(index === 0 ? 'Paris.' : 'Paris is the capital of France.');
      });
      const feedbackFixture = scriptedAI(() => {
        feedbackCalls++;
        return { results: [{ index: 0, content: `Summary: Mention the missing country.\nAdvice: ${JSON.stringify({ [key]: 'Mention both the capital and the country.' })}` }] };
      });
      const improved = refine(program, {
        rounds: 2, samplesPerRound: 1, strategy: 'serial', threshold: 1,
        rewardDescription: '0.5 for naming Paris; 0.5 for naming France; these are preferences, not schema assertions.',
        rewardFn: ({ prediction }) => reward(prediction.answer),
        feedbackAI: ctx.mode === 'live' ? ctx.ai : feedbackFixture,
        feedbackModelConfig: { maxTokens: 256, stream: false },
      });
      const result = await improved.forward(ctx.mode === 'live' ? ctx.ai : actorFixture, { question }, { ...options(ctx), maxRetries: 0, modelConfig: { ...options(ctx).modelConfig, stream: false } });
      assert.deepEqual(instructionSnapshot(program), originals);
      const attempts = improved.getAttempts();
      assert(attempts.every((attempt) => attempt.strategy === 'serial'));
      if (ctx.mode === 'offline') {
        assert.equal(actorCalls, 2); assert.equal(feedbackCalls, 1);
        assert.equal(attempts[0]!.adviceApplied, true);
        assert.equal(attempts[0]!.advice?.[key], 'Mention both the capital and the country.');
        assert.deepEqual(attempts.map((attempt) => attempt.reward), [0.5, 1]);
      }
      return {
        result, attempts: attempts.map(({ round, reward: value, advice, adviceApplied }) => ({ round, reward: value, advice, adviceApplied })), instructionsRestored: true,
        candidateUsage: improved.getUsage(),
        accounting: 'getUsage aggregates candidate attempts; this SDK does not include the separate feedback generator usage in the wrapper total. Budget feedback calls separately.',
        proof: 'Offline scripted advice runs real Ax advice application/restoration; live may meet threshold in round one without feedback.',
      };
    },
  },
  {
    id: '08-refinement/error-restoration-and-no-streaming',
    title: 'Retain failure artifacts and restore instruction advice even on terminal error',
    features: ['AxRefineError', 'attempt artifacts', 'finally restoration', 'streaming rejection', 'bounded failures'],
    modes: ['offline'],
    async run(ctx) {
      const program = ax('question:string -> answer:string');
      program.setInstruction('Answer concisely.');
      const originals = instructionSnapshot(program); const key = originals[0]?.key; assert(key);
      let calls = 0;
      const actor = scriptedAI((request) => {
        if (calls++ === 0) return response('Paris.');
        assert(JSON.stringify(request.chatPrompt).includes('Name the country too'));
        throw new Error('Fixture second-round terminal failure');
      });
      const feedback = scriptedAI([{ results: [{ index: 0, content: `Summary: Missing country.\nAdvice: ${JSON.stringify({ [key]: 'Name the country too.' })}` }] }]);
      const improved = refine(program, { rounds: 2, threshold: 1, strategy: 'serial', failCount: 0, feedbackAI: feedback, feedbackModelConfig: { stream: false, maxTokens: 256 }, rewardFn: ({ prediction }) => reward(prediction.answer) });
      let retained: { round: number; failed: boolean; reward?: number; adviceApplied?: boolean }[] = [];
      await assert.rejects(() => improved.forward(actor, { question }, { ...options(ctx), maxRetries: 0, modelConfig: { stream: false } }), (error: unknown) => {
        assert(error instanceof AxRefineError);
        assert.equal(error.attempts.length, 2);
        assert(error.attempts[1]!.error instanceof Error);
        retained = error.attempts.map((attempt) => ({ round: attempt.round, failed: attempt.error !== undefined, reward: attempt.reward, adviceApplied: attempt.adviceApplied }));
        return true;
      });
      assert.deepEqual(instructionSnapshot(program), originals);
      assert.equal(retained[0]!.adviceApplied, true);
      for (const wrapper of [improved, bestOfN(program, { n: 1, rewardFn: ({ prediction }) => reward(prediction.answer) })]) {
        await assert.rejects(async () => {
          for await (const _chunk of wrapper.streamingForward(actor, { question })) { /* Iteration must reject before producing a chunk. */ }
        }, AxRefineError);
      }
      assert.equal(calls, 2); // streaming rejection never calls the actor.
      return { retained, instructionsRestored: true, actorCalls: calls, streaming: 'Both wrappers reject; use forward for complete-candidate scoring.' };
    },
  },
  {
    id: '08-refinement/no-instruction-components',
    title: 'Refinement degrades honestly to scored rounds when instructions are not optimizable',
    features: ['instruction ownership', 'adviceApplied false', 'best-of-N rounds', 'no feedback calls'],
    modes: ['offline'],
    async run(ctx) {
      const program = new FixedPolicyProgram('question:string -> answer:string');
      program.setInstruction('Immutable application policy: answer concisely.');
      assert.equal(instructionSnapshot(program).length, 0);
      const actor = scriptedAI([response('Lyon.'), response('Paris.')]);
      const improved = refine(program, { rounds: 2, samplesPerRound: 1, strategy: 'serial', threshold: 1, rewardFn: ({ prediction }) => reward(prediction.answer) });
      const result = await improved.forward(actor, { question }, { ...options(ctx), maxRetries: 0, modelConfig: { stream: false } });
      assert.equal(result.answer, 'Paris.');
      assert.equal(improved.getAttempts().length, 2);
      assert.equal(improved.getAttempts()[0]!.adviceApplied, false);
      assert.deepEqual(improved.getAttempts()[0]!.advice, {});
      assert.equal(program.getInstruction(), 'Immutable application policy: answer concisely.');
      return { result, rewards: improved.getAttempts().map((attempt) => attempt.reward), adviceApplied: improved.getAttempts()[0]!.adviceApplied, proof: 'No hidden feedback model call or hint_ field; the SDK selects the best below-threshold result when rounds end.' };
    },
  },
];
