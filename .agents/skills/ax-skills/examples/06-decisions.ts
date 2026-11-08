import assert from 'node:assert/strict';
import {
  ai, ax, f, typesafe, openaiDecisions, AxDecisionRefusalError,
  type AxAITypesafeQuestions,
  type AxAIOpenAIDecisionsRequest,
  type AxAIOpenAIDecisionsResponse,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example, type ExampleContext } from './support.js';

const ticket = 'Checkout fails for every customer; payments cannot complete.';
const levels = ['Minor inconvenience', 'Feature impaired', 'Core task blocked'] as const;

// Real SDK transport fixture: deterministic server answers, not measured Jev quality.
// The public options.fetch seam runs serialization, authentication, validation and decoding.
function decisionFixture(answers: Record<string, unknown>, inspect?: (body: string) => void) {
  let calls = 0;
  const model = ai({
    name: 'typesafe', apiKey: 'isolated-fixture-not-a-secret', trueThreshold: 0.9,
    options: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).pathname, '/v1/systemone');
        assert.equal(request.headers.get('authorization'), 'Bearer isolated-fixture-not-a-secret');
        const body = await request.text();
        assert(!body.includes('trueThreshold')); // Local policy never goes on the wire.
        inspect?.(body);
        calls++;
        return Response.json({ model: 'jev-fixture', answers, usage: { input_tokens: 31, output_tokens: 7 } });
      },
    },
  });
  return { model, calls: () => calls };
}

// Generative controls (maxTokens etc.) are not supported by decision providers.
function decisionOptions(ctx: ExampleContext) {
  return { ...options(ctx), modelConfig: {} };
}

const evidenceAnswers = {
  urgent: { type: 'noul', noul: 0.9 },
  team: {
    type: 'choice', choice: 'engineering',
    probabilities: { support: 0.6, billing: 0.1, engineering: 0.3 }, confidence: 0.62,
  },
  severity: {
    type: 'score', score: 1.8, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
    legend: { '0': levels[0], '1': levels[1], '2': levels[2] }, confidence: 0.75,
  },
};

export const examples: readonly Example[] = [
  {
    id: '06-decisions/threshold-ownership',
    title: 'Separate provider scalar conversion from field evidence thresholds',
    features: ['typesafe adapter', 'scalar boolean', 'boolean evidence', 'local thresholds', 'one batch'],
    modes: ['offline'],
    async run(ctx) {
      const fixture = decisionFixture({
        scalar: { type: 'noul', noul: 0.6 },
        defaultEvidence: { type: 'noul', noul: 0.6 },
        explicitEvidence: { type: 'noul', noul: 0.6 },
      }, (body) => {
        const request = JSON.parse(body) as { questions: Record<string, { type: string }> };
        assert(!Object.hasOwn(request, 'trueThreshold'));
        assert(Object.values(request.questions).every((question) => !Object.hasOwn(question, 'threshold')));
        assert.deepEqual(Object.keys(request.questions).sort(), ['defaultEvidence', 'explicitEvidence', 'scalar']);
        assert(Object.values(request.questions).every((question) => question.type === 'noul'));
      });
      const program = ax(f().input('ticket', f.string())
        .output('scalar', f.boolean('Core task blocked?'))
        .output('defaultEvidence', f.boolean('Core task blocked?').withEvidence())
        .output('explicitEvidence', f.boolean('Core task blocked?').withEvidence({ threshold: 0.9 }))
        .build());
      const result = await program.forward(fixture.model, { ticket }, decisionOptions(ctx));
      assert.equal(result.scalar, false); // Provider trueThreshold is 0.9.
      assert.equal(result.defaultEvidence.value, true);
      assert.equal(result.defaultEvidence.threshold, 0.5);
      assert.equal(result.explicitEvidence.value, false);
      assert.equal(result.explicitEvidence.threshold, 0.9);
      assert.equal(result.defaultEvidence.probability, 0.6);
      assert.equal(result.explicitEvidence.probability, 0.6);
      assert.equal(fixture.calls(), 1);
      return { result, batches: fixture.calls(),
        proof: 'Injected HTTP answers exercise real SDK conversion. Threshold ownership, not inference quality or calibration.' };
    },
  },
  {
    id: '06-decisions/applicability-gate',
    title: 'Gate a native Choice with a separate applicability judgment',
    features: ['native Choice', 'companion Noul', 'ordered host policy', 'uncertain review'],
    modes: ['offline'],
    async run(ctx) {
      const questions = {
        applicable: { type: 'noul', instructions: 'Does this message concern an invoice or payment dispute?' },
        category: {
          type: 'choice', instructions: 'If this is a billing dispute, which billing category best fits?',
          criteria: { refund: 'A refund request', duplicate: 'A duplicate charge' },
        },
      } as const satisfies AxAITypesafeQuestions;
      const fixtures = [
        { name: 'no', probability: 0.02, expected: 'general' },
        { name: 'yes', probability: 0.98, expected: 'refund' },
        { name: 'uncertain', probability: 0.5, expected: 'review' },
      ] as const;
      const outcomes = [];
      for (const fixture of fixtures) {
        let calls = 0;
        // Only HTTP I/O is injected; native request validation and decoding are real.
        const client = typesafe({ apiKey: 'isolated-fixture-not-a-secret', options: {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            assert.equal(new URL(request.url).pathname, '/v1/systemone');
            const body = await request.json() as { questions: unknown };
            assert.deepEqual(body.questions, questions);
            calls++;
            return Response.json({ model: 'jev-fixture', answers: {
              applicable: { type: 'noul', noul: fixture.probability },
              category: { type: 'choice', choice: 'refund', probabilities: { refund: 0.96, duplicate: 0.04 }, confidence: 0.92 },
            }, usage: { input_tokens: 20, output_tokens: 4 } });
          },
        } });
        const result = await client.systemOne({ state: { message: `Declared ${fixture.name} transport fixture` }, questions }, { abortSignal: ctx.signal });
        const p = result.answers.applicable.noul;
        // Choice always selects within its supplied set; selection cannot establish applicability.
        const route = p <= 0.1 ? 'general' : p >= 0.9 ? result.answers.category.choice : 'review';
        assert.equal(result.answers.category.choice, 'refund');
        assert.equal(result.answers.category.probabilities.refund, 0.96);
        assert.equal(p, fixture.probability);
        assert.equal(route, fixture.expected);
        assert.equal(calls, 1);
        outcomes.push({ fixture: fixture.name, answers: result.answers, route, batches: calls });
      }
      return { outcomes,
        proof: 'Three finite injected HTTP fixtures; real SDK native decoding and host routing, not real inference or calibration. Questions have no sibling-answer dependencies.' };
    },
  },
  {
    id: '06-decisions/adapter-values',
    title: 'Own boolean policy and class meanings in a typed decision signature',
    features: ['typesafe adapter', 'value descriptions', 'trueThreshold', 'scalar boolean/class'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const fixture = decisionFixture({ urgent: evidenceAnswers.urgent, team: evidenceAnswers.team }, (body) => {
        assert(body.includes('Customers cannot complete a core task'));
        assert(body.includes('Individual invoice or charge disputes'));
      });
      const triage = ax(`ticket:string ->
        urgent:boolean(true "Customers cannot complete a core task", false "Routine request or minor inconvenience") "Does this need immediate attention?",
        team:class "support, billing, engineering"(support "Product usage questions", billing "Individual invoice or charge disputes", engineering "Broken functionality or service outages") "Which team should investigate?"`);
      const result = await triage.forward(ctx.mode === 'live' ? ctx.decisions : fixture.model, { ticket }, decisionOptions(ctx));
      assert.equal(typeof result.urgent, 'boolean');
      assert(['support', 'billing', 'engineering'].includes(result.team));
      if (ctx.mode === 'offline') {
        assert.equal(result.urgent, true); // Equality at 0.9 is included.
        assert.equal(result.team, 'engineering'); // Preserve native choice, not argmax.
        assert.equal(fixture.calls(), 1);
      }
      return { result, policy: 'Offline adapter trueThreshold=0.9; live policy belongs to ctx.decisions. Class has no automatic confidence cutoff.', proof: 'Contract and local conversion, not correctness or calibration.' };
    },
  },
  {
    id: '06-decisions/adapter-evidence',
    title: 'Retain native probabilities, continuous rubric score and provenance',
    features: ['boolean evidence', 'class evidence', 'score evidence', 'threshold', 'native provenance', 'diagnostics'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const program = ax(f()
        .input('ticket', f.string())
        .output('urgent', f.boolean('Core task blocked?').withEvidence({ threshold: 0.9 }).describeValues({ true: 'Core task blocked', false: 'Routine request' }))
        .output('team', f.class(['support', 'billing', 'engineering']).withEvidence())
        .output('severity', f.score(levels).withEvidence())
        .build());
      const fixture = decisionFixture(evidenceAnswers);
      const result = await program.forward(ctx.mode === 'live' ? ctx.decisions : fixture.model, { ticket }, decisionOptions(ctx));
      assert.equal(result.urgent.value, result.urgent.probability >= 0.9);
      assert.equal(result.urgent.threshold, 0.9);
      assert(result.severity.value >= 0 && result.severity.value <= 2);
      assert.equal(result.team.provenance.source, 'native');
      assert.deepEqual(Object.keys(result.team.probabilities).sort(), ['billing', 'engineering', 'support']);
      if (ctx.mode === 'offline') {
        assert.equal(result.team.value, 'engineering');
        assert.equal(result.team.confidence, 0.62);
        assert.equal(result.severity.value, 1.8); // Native score is NOT recomputed as 1.4.
        assert.deepEqual(result.severity.probabilities, [0.1, 0.4, 0.5]);
      }
      return { result, usage: program.getUsage(), chatEntries: program.getChatLog().length, proof: 'Native fields preserved; distributions and confidence are not guarantees of correctness.' };
    },
  },
  {
    id: '06-decisions/openai-decisions-wire',
    title: 'Exercise the dedicated OpenAI Decisions adapter with synthetic wire evidence',
    features: ['openai-decisions', '/v1/decisions', 'predicate', 'choice', 'rubric score', 'native evidence', 'unsupported box'],
    modes: ['offline'],
    async run(ctx) {
      // Wire contract: installed ai/openai-decisions/{types,api,validate}.ts
      // (embedded in index.js.map). This is not the Typesafe /systemone profile.
      const wireResponse = {
        model: 'gpt-6-luna',
        answers: [
          { name: 'urgent', type: 'predicate', probability: 0.9 },
          { name: 'team', type: 'choice', choice: 'engineering', confidence: 0.62, probabilities: [
            { value: 'support', probability: 0.6 },
            { value: 'billing', probability: 0.1 },
            { value: 'engineering', probability: 0.3 },
          ] },
          { name: 'severity', type: 'score', score: 1.8, confidence: 0.75, probabilities: [
            // Deliberately unordered: the adapter restores rubric-index order.
            { value: 2, label: levels[2], probability: 0.5 },
            { value: 0, label: levels[0], probability: 0.1 },
            { value: 1, label: levels[1], probability: 0.4 },
          ] },
        ],
        usage: {
          input_tokens: 31, output_tokens: 7, total_tokens: 38,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } satisfies AxAIOpenAIDecisionsResponse;
      let calls = 0;
      const model = ai({
        name: 'openai-decisions', apiKey: 'fixture-only', trueThreshold: 0.9,
        safetyIdentifier: 'offline-ticket-fixture',
        options: {
          abortSignal: ctx.signal, timeout: 1_000, retry: { maxRetries: 0 },
          fetch: async (input, init) => {
            assert.equal(++calls, 1, 'Dedicated Decisions transport budget exhausted');
            const request = new Request(input, init);
            assert.equal(request.url, 'https://api.openai.com/v1/decisions');
            assert.equal(request.method, 'POST');
            assert.equal(request.headers.get('authorization'), 'Bearer fixture-only');
            const body = await request.json() as AxAIOpenAIDecisionsRequest;
            assert.equal(body.model, 'gpt-6-luna');
            assert.equal(body.safety_identifier, 'offline-ticket-fixture');
            assert.deepEqual(body.questions.map(({ name, type }) => ({ name, type })), [
              { name: 'urgent', type: 'predicate' }, { name: 'team', type: 'choice' }, { name: 'severity', type: 'score' },
            ]);
            const scoreQuestion = body.questions.find(({ name }) => name === 'severity');
            assert(scoreQuestion?.type === 'score');
            assert.deepEqual(scoreQuestion.levels.map(({ label }) => label), levels);
            assert(Array.isArray(body.input));
            assert.equal(body.input.length, 1);
            assert.equal(body.input[0]!.role, 'user');
            const content = body.input[0]!.content;
            assert(Array.isArray(content));
            assert(content.every((part) => part.type === 'input_text'));
            assert(content.some((part) => part.type === 'input_text' && part.text.includes(ticket)));
            return Response.json(wireResponse);
          },
        },
      });
      const program = ax(f().input('ticket', f.string())
        .output('urgent', f.boolean('Core task blocked?').withEvidence({ threshold: 0.9 })
          .describeValues({ true: 'Core task blocked', false: 'Routine request' }))
        .output('team', f.class(['support', 'billing', 'engineering'], 'Investigation owner').withEvidence()
          .describeValues({ support: 'Product usage questions', billing: 'Invoice disputes', engineering: 'Broken functionality' }))
        .output('severity', f.score(levels, 'Customer impact').withEvidence())
        .build());
      const forwardOptions = { ...decisionOptions(ctx), maxSteps: 1, maxRetries: 0 };
      const result = await program.forward(model, { ticket }, forwardOptions);
      assert.equal(result.urgent.value, true);
      assert.equal(result.urgent.probability, 0.9);
      assert.equal(result.urgent.threshold, 0.9);
      assert(!('confidence' in result.urgent)); // Predicate wire answers have no confidence.
      assert.equal(result.team.value, 'engineering'); // Native selection, not probability argmax.
      assert.deepEqual(result.team.probabilities, { support: 0.6, billing: 0.1, engineering: 0.3 });
      assert.equal(result.team.confidence, 0.62);
      assert.equal(result.severity.value, 1.8); // Preserve native score, not weighted mean 1.4.
      assert.deepEqual(result.severity.levels, levels);
      assert.deepEqual(result.severity.probabilities, [0.1, 0.4, 0.5]);
      assert.equal(result.severity.confidence, 0.75);
      for (const evidence of [result.urgent, result.team, result.severity]) {
        assert.deepEqual(evidence.provenance, { source: 'native', provider: 'OpenAI Decisions', model: 'gpt-6-luna' });
      }
      // Unlike Typesafe, this distinct native profile cannot produce Box outputs.
      const locate = ax('ticket:string -> target:box(evidence)');
      await assert.rejects(() => locate.forward(model, { ticket }, forwardOptions));
      assert.equal(calls, 1); // The unsupported output fails before a second transport call.
      return {
        result, calls, endpoint: '/v1/decisions', unsupported: 'box outputs rejected before transport',
        proof: 'Synthetic HTTP answers exercise actual SDK serialization and native decoding; no live inference, correctness, or calibration measurement.',
        limits: 'Flat required scalar decisions only; evidence thresholds are local field policy. No tools, generation controls, or token streaming.',
      };
    },
  },
  {
    id: '06-decisions/openai-native-ordered', title: 'Use native ordered questions, typed choice values, inline images and per-question refusals',
    features: ['openaiDecisions', 'ordered questions', 'boolean choice values', 'inline images', 'native refusal'], modes: ['offline'],
    async run(ctx) {
      const questions = [
        { name: 'kind', type: 'choice', instructions: 'Choose the typed application result.',
          choices: [{ value: true, description: 'Approved' }, { value: 'true', description: 'Legacy string label' }, { value: false, description: 'Rejected' }] },
        { name: 'attachment', type: 'predicate', instructions: 'Does the attachment establish the requested fact?' },
      ] as const;
      const wire = {
        model: 'gpt-6-luna',
        answers: [
          { name: 'kind', type: 'choice', choice: true, confidence: 0.62,
            probabilities: [{ value: true, probability: 0.3 }, { value: 'true', probability: 0.6 }, { value: false, probability: 0.1 }] },
          { name: 'attachment', type: 'refusal' },
        ],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      } satisfies AxAIOpenAIDecisionsResponse<typeof questions>;
      let calls = 0;
      const client = openaiDecisions({ apiKey: 'fixture-only', options: {
        abortSignal: ctx.signal, retry: { maxRetries: 0 }, timeout: 1000,
        fetch: async (input, init) => {
          assert.equal(++calls, 1);
          const request = new Request(input, init);
          assert.equal(request.url, 'https://api.openai.com/v1/decisions');
          return Response.json(wire);
        },
      } });
      // A valid one-pixel PNG is transport data, not visual-quality evidence.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==';
      const result = await client.create({ model: 'gpt-6-luna', questions, input: [{ role: 'user', content: [
        { type: 'input_text', text: 'Evaluate this synthetic application record and attachment.' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}` },
      ] }] });
      const [choice, attachment] = result.answers;
      assert(choice.type === 'choice'); // Narrow native refusals before reading values.
      assert.equal(choice.choice, true);
      assert.equal(typeof choice.choice, 'boolean');
      assert.equal(choice.probabilities.find(({ value }) => value === 'true')?.probability, 0.6);
      assert.equal(attachment.type, 'refusal');
      assert.equal(result.usage.total_tokens, 15);
      return { choice: choice.choice, choiceType: typeof choice.choice, refused: attachment.name, calls,
        boundary: 'Real native request validation and decoding with synthetic HTTP answers. Boolean true differs from string true; preserve the selected value rather than taking argmax. A native batch retains per-question refusals instead of raising the signature adapter’s terminal refusal error. No image recognition or inference quality was measured.' };
    },
  },
  {
    id: '06-decisions/native-structured',
    title: 'Batch native Noul/Choice/Score with structured criteria and discover models',
    features: ['typesafe()', 'systemOne', 'structured criteria', 'Noul', 'Choice', 'Score', 'listModels', 'fetch customization'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const questions = {
        urgent: {
          type: 'noul', instructions: 'Does this ticket require immediate incident response?',
          criteria: { true: { description: 'Core task blocked', examples: ['Cannot pay'], allCustomers: true }, false: 'Routine request' },
        },
        team: {
          type: 'choice', instructions: { question: 'Which team owns the investigation?', chooseOne: true },
          criteria: { support: ['Product usage questions'], engineering: { description: 'Broken functionality or service outage' } },
        },
        severity: {
          type: 'score', instructions: 'How severe is customer impact?',
          criteria: [{ description: levels[0], impact: 0 }, { description: levels[1], impact: 1 }, { description: levels[2], impact: 2 }],
        },
      } as const satisfies AxAITypesafeQuestions;
      let inferenceCalls = 0;
      let discoveryCalls = 0;
      const fixture = typesafe({
        apiKey: 'isolated-fixture-not-a-secret',
        options: { fetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === '/v1/models') {
            discoveryCalls++;
            assert.equal(request.method, 'GET');
            return Response.json({ models: [{ name: 'jev-fixture', description: 'Deterministic transport fixture', release_date: '2026-01-01' }] });
          }
          inferenceCalls++;
          assert.equal(request.method, 'POST');
          assert((await request.text()).includes('allCustomers'));
          return Response.json({ model: 'jev-fixture', answers: {
            urgent: { type: 'noul', noul: 0.9 },
            team: { type: 'choice', choice: 'engineering', probabilities: { support: 0.1, engineering: 0.9 }, confidence: 0.8 },
            severity: { ...evidenceAnswers.severity, legend: Object.fromEntries(questions.severity.criteria.map((criterion, index) => [String(index), criterion])) },
          }, usage: { input_tokens: 48, output_tokens: 9 } });
        } },
      });
      const client = ctx.mode === 'live' ? ctx.nativeDecisions : fixture;
      const result = await client.systemOne({ state: { ticket, recentEvents: [], tenant: { sandbox: true } }, questions }, { abortSignal: ctx.signal });
      const models = await client.listModels({ abortSignal: ctx.signal });
      const decision = { escalate: result.answers.urgent.noul >= 0.9, owner: result.answers.team.choice, severityOnTen: result.answers.severity.score / 2 * 10 };
      assert(['support', 'engineering'].includes(decision.owner));
      assert(decision.severityOnTen >= 0 && decision.severityOnTen <= 10);
      assert(models.every((model) => typeof model.name === 'string'));
      assert(!('confidence' in result.answers.urgent));
      if (ctx.mode === 'offline') {
        assert.deepEqual(decision, { escalate: true, owner: 'engineering', severityOnTen: 9 });
        assert.equal(inferenceCalls, 1); assert.equal(discoveryCalls, 1);
      }
      return { decision, answers: result.answers, model: result.model, usage: result.usage, models, proof: 'Caller owns threshold/scaling; same-request questions cannot depend on sibling answers.' };
    },
  },
  {
    id: '06-decisions/reranking',
    title: 'Rank query/document pairs while retaining application candidate IDs',
    features: ['reranking', 'rubric scores', 'evidence', 'candidate ownership'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const candidates = [
        { id: 'invoice-guide', text: 'Download invoices from Billing > Invoices.' },
        { id: 'outage-runbook', text: 'For checkout outages page on-call engineering and enable the payment incident runbook.' },
      ];
      const query = 'Who handles a checkout outage?';
      const judge = ax('query:string, document:string -> relevance:score "Irrelevant, Related, Partial answer, Direct answer"(evidence)');
      const ranked = [];
      for (const [index, candidate] of candidates.entries()) {
        const score = index === 0 ? 0.2 : 2.8;
        const fixture = decisionFixture({ relevance: {
          type: 'score', score, probabilities: index === 0 ? { '0': 0.8, '1': 0.2, '2': 0, '3': 0 } : { '0': 0, '1': 0, '2': 0.2, '3': 0.8 },
          legend: { '0': 'Irrelevant', '1': 'Related', '2': 'Partial answer', '3': 'Direct answer' }, confidence: 0.7,
        } });
        const result = await judge.forward(ctx.mode === 'live' ? ctx.decisions : fixture.model, { query, document: candidate.text }, decisionOptions(ctx));
        ranked.push({ id: candidate.id, relevance: result.relevance });
      }
      ranked.sort((a, b) => b.relevance.value - a.relevance.value);
      assert.equal(new Set(ranked.map((item) => item.id)).size, candidates.length);
      assert(ranked[0]!.relevance.value >= ranked[1]!.relevance.value);
      if (ctx.mode === 'offline') assert.equal(ranked[0]!.id, 'outage-runbook');
      return { ranked, proof: 'One shared rubric/model permits ordering; fixture ranking does not establish retrieval quality.' };
    },
  },
  {
    id: '06-decisions/typed-generation-handoff',
    title: 'Make a typed decision first, then ask a generative model for prose',
    features: ['decision to generation', 'typed handoff', 'provider separation'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const triage = ax('ticket:string -> urgent:boolean, team:class "support, engineering"');
      const fixture = decisionFixture({ urgent: evidenceAnswers.urgent, team: { type: 'choice', choice: 'engineering', probabilities: { support: 0.1, engineering: 0.9 }, confidence: 0.8 } });
      const decision = await triage.forward(ctx.mode === 'live' ? ctx.decisions : fixture.model, { ticket }, decisionOptions(ctx));
      const writer = ax('ticket:string, urgent:boolean, assignedTeam:string "The decision-selected owner: support or engineering" -> reply:string');
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI([{ results: [{ index: 0, content: 'Reply: Engineering is investigating the checkout outage. No restoration time is confirmed.' }] }]);
      const response = await writer.forward(model, { ticket, urgent: decision.urgent, assignedTeam: decision.team }, options(ctx));
      assert(response.reply.trim().length > 0);
      return { decision, response, delivery: 'Draft only; no email or external action.', proof: 'The decision provider never receives an unsupported freeform output.' };
    },
  },
  {
    id: '06-decisions/refusal-policy',
    title: 'Return or throw terminal decision refusals without inventing probabilities',
    features: ['refusal return', 'AxDecisionRefusalError', 'elicited evidence'],
    modes: ['offline'],
    async run(ctx) {
      const returnProgram = ax('reviewRequest:string -> allowed:boolean(evidence, refusal return)');
      const result = await returnProgram.forward(scriptedAI([{ results: [{ index: 0, content: '{"allowed":{"status":"refused"}}' }] }]), { reviewRequest: 'An intentionally refused safety decision fixture.' }, options(ctx));
      assert.equal(result.allowed.status, 'refused');
      assert(!('probability' in result.allowed));
      assert.equal(result.allowed.provenance.source, 'elicited');
      let calls = 0;
      const throwProgram = ax('reviewRequest:string -> allowed:boolean(evidence)');
      const refused = scriptedAI(() => { calls++; return { results: [{ index: 0, content: '{"allowed":{"status":"refused"}}' }] }; });
      await assert.rejects(() => throwProgram.forward(refused, { reviewRequest: 'Same refusal, default throw policy.' }, options(ctx)), (error: unknown) => {
        assert(error instanceof AxDecisionRefusalError);
        assert.equal(error.fieldPath, 'allowed');
        return true;
      });
      assert.equal(calls, 1); // Terminal refusal bypasses the normal correction budget.
      return { result, defaultPolicy: 'AxDecisionRefusalError', calls, proof: 'Deterministic refusal handling, not a claim that a live model will refuse this input.' };
    },
  },
  {
    id: '06-decisions/native-validation',
    title: 'Enforce native distributions and reject unsupported adapter shapes before transport',
    features: ['probability validation', 'inclusive distribution tolerance', 'no renormalization', 'adapter restrictions'],
    modes: ['offline'],
    async run(ctx) {
      const question = {
        owner: { type: 'choice', instructions: 'Who owns this ticket?', criteria: { support: null, engineering: 'Service outage' } },
      } as const satisfies AxAITypesafeQuestions;
      let total = 0.99;
      let calls = 0;
      const client = typesafe({ apiKey: 'isolated-fixture-not-a-secret', options: { fetch: async () => {
        calls++;
        return Response.json({
          model: 'jev-fixture',
          answers: { owner: { type: 'choice', choice: 'engineering', probabilities: { support: 0.1, engineering: total - 0.1 }, confidence: 0.7 } },
          usage: { input_tokens: 9, output_tokens: 3 },
        });
      } } });
      const preservedTotals = [];
      for (total of [0.99, 1.01]) {
        const result = await client.systemOne({ state: { ticket }, questions: question }, { abortSignal: ctx.signal });
        const sum = Object.values(result.answers.owner.probabilities).reduce((a, b) => a + b, 0);
        assert(Math.abs(sum - total) < 1e-12);
        preservedTotals.push(sum);
      }
      total = 0.98;
      await assert.rejects(() => client.systemOne({ state: { ticket }, questions: question }, { abortSignal: ctx.signal }), /distribution/i);
      assert.equal(calls, 3);
      let adapterCalls = 0;
      const unsupported = ai({ name: 'typesafe', apiKey: 'isolated-fixture-not-a-secret', options: { fetch: async () => {
        adapterCalls++; throw new Error('Unsupported signature unexpectedly reached transport');
      } } });
      const signatures = [
        'ticket:string -> reply:string',
        'ticket:string -> severity:number',
        'ticket:string -> urgent?:boolean',
        'ticket:string -> teams:class[] "support, engineering"',
      ] as const;
      for (const signature of signatures) {
        const program = ax(signature);
        await assert.rejects(() => program.forward(unsupported, { ticket }, { ...decisionOptions(ctx), maxRetries: 0 }), /Typesafe|flat|required|scalar|output/i);
      }
      assert.equal(adapterCalls, 0);
      return { preservedTotals, rejectedDistributionTotal: total, unsupportedSignatures: signatures, adapterCalls, proof: 'Native tolerance is inclusive and preserves probabilities; plain numbers are not scoring rubrics and decision providers do not generate prose.' };
    },
  },
];
