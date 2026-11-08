import assert from 'node:assert/strict';
import {
  agent, ai, ax, AxAgentContextMap, AxAIServiceStatusError,
  AxBalancer, AxInMemoryEventStore, AxMockAIService, AxProgram,
  AxPushEventSource, axAIOpenAIAudioDefaultConfig,
  eventPath, eventRoute, eventRuntime, eventTarget, flow, typesafe,
  type AxAIService, type AxAITypesafeQuestions, type AxAITypesafeResponse,
  type AxChatResponse, type AxGenStreamingOut,
  type AxProgramForwardOptions, type AxProgramStreamingForwardOptions,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const reply = (content: string): AxChatResponse => ({
  results: [{ index: 0, content, finishReason: 'stop' }],
});

// Design handoffs, not a replacement reference: each pattern names why the
// topology is the smallest useful one and which policies remain host-owned.
export const examples: readonly Example[] = [
  {
    id: '26-architecture/typed-invoice',
    title: 'One typed extraction → hard monetary invariant → accepted record',
    features: ['architecture', 'typed-invoice', 'signature', 'AxGen', 'addAssert', 'application-persistence'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const acceptedInvoices = new Map<string, { currency: 'USD'; totalCents: number }>();
      const invoice = ax('invoiceText:string -> invoiceId:string, currency:class "USD", lineCents:number[], totalCents:number');
      invoice.addAssert(({ lineCents, totalCents }) =>
        lineCents.length > 0 && lineCents.every((cents) => Number.isSafeInteger(cents) && cents >= 0)
          && Number.isSafeInteger(totalCents) && totalCents === lineCents.reduce((sum, cents) => sum + cents, 0),
      'All amounts are integer cents and totalCents must exactly equal the sum of lineCents');
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI([
        reply('Invoice Id: INV-104\nCurrency: USD\nLine Cents: [250, 500]\nTotal Cents: 750'),
      ]);
      const result = await invoice.forward(model, { invoiceText: 'Invoice INV-104, USD. Item A: $2.50; item B: $5.00. Total $7.50. Return integer cents.' }, options(ctx));
      assert.equal(result.invoiceId, 'INV-104');
      assert.equal(result.totalCents, 750);
      assert.deepEqual(result.lineCents, [250, 500]);
      // The authenticated application, not model text, accepts the record.
      acceptedInvoices.set(result.invoiceId, { currency: result.currency, totalCents: result.totalCents });
      const acceptedBeforeRejection = acceptedInvoices.size;
      await assert.rejects(invoice.forward(scriptedAI([
        reply('Invoice Id: INV-BAD\nCurrency: USD\nLine Cents: [250, 500]\nTotal Cents: 1'),
      ]), { invoiceText: 'INV-BAD: USD 250 cents and 500 cents, total 750 cents.' }, { ...options(ctx), maxRetries: 0 }));
      assert.equal(acceptedInvoices.size, acceptedBeforeRejection);
      assert.equal(acceptedInvoices.has('INV-BAD'), false);
      return {
        invoice: result, acceptedRecords: acceptedInvoices.size,
        design: 'One extraction needs AxGen, not an agent or DAG. The application owns acceptance and volatile storage; model extraction quality still needs representative invoice evaluation.',
      };
    },
  },
  {
    id: '26-architecture/evidence-aware-ticket',
    title: 'Native decision evidence → explicit typed handoff → generative explanation',
    features: ['architecture', 'evidence-aware-ticket', 'typesafe', 'native-evidence', 'hybrid-generation', 'authorization-boundary'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const questions = {
        reportsUnauthorized: { type: 'noul', instructions: 'Does the customer report a charge or account activity they did not authorize?' },
        requestsHuman: { type: 'noul', instructions: 'Does the customer explicitly request a human representative?' },
        threatensLegal: { type: 'noul', instructions: 'Does the customer threaten legal action?' },
        wantsRefund: { type: 'noul', instructions: 'Does the customer request a refund?' },
        wantsCancel: { type: 'noul', instructions: 'Does the customer request subscription cancellation?' },
        openToOffer: { type: 'noul', instructions: 'Does the customer express willingness to consider a retention offer?' },
      } as const satisfies AxAITypesafeQuestions;
      // Independent means no answer consumes another answer, not statistical independence.
      type QuestionId = keyof typeof questions;
      type Judgment = false | true | 'unknown';
      type Outcome = 'fraud-review' | 'human-legal-handoff' | 'refund-proposal'
        | 'refund-team-review' | 'retention-proposal' | 'answer' | 'uncertainty-review';
      type Facts = { eligible: boolean; alreadyRefunded: boolean; amountCents: number; activeSubscription: boolean };
      type RuleId = 'R1-fraud' | 'R2-human-legal' | 'R3-refund' | 'R4-retention' | 'R5-answer';
      type Selection = { outcome: Outcome; winningRule: RuleId; evaluated: { ruleId: RuleId; match: Judgment }[] };
      const questionIds = Object.keys(questions) as QuestionId[];
      const thresholds = { id: 'ticket-thresholds-v1', falseAtMost: 0.3, trueAtLeast: 0.7 } as const;
      const classify = (p: number): Judgment => p <= thresholds.falseAtMost ? false
        : p >= thresholds.trueAtLeast ? true : 'unknown';
      const selectOutcome = (j: Record<QuestionId, Judgment>, facts: Facts): Selection => {
        const evaluated: Selection['evaluated'] = [];
        const selected = (outcome: Outcome, winningRule: RuleId) => ({ outcome, winningRule, evaluated });
        evaluated.push({ ruleId: 'R1-fraud', match: j.reportsUnauthorized });
        if (j.reportsUnauthorized === true) return selected('fraud-review', 'R1-fraud');
        if (j.reportsUnauthorized === 'unknown') return selected('uncertainty-review', 'R1-fraud');
        // A true disjunct settles OR even if the other judgment is unknown.
        const humanOrLegal = j.requestsHuman === true || j.threatensLegal === true ? true
          : j.requestsHuman === false && j.threatensLegal === false ? false : 'unknown';
        evaluated.push({ ruleId: 'R2-human-legal', match: humanOrLegal });
        if (humanOrLegal === true) return selected('human-legal-handoff', 'R2-human-legal');
        if (humanOrLegal === 'unknown') return selected('uncertainty-review', 'R2-human-legal');
        const refund = facts.eligible && !facts.alreadyRefunded ? j.wantsRefund : false;
        evaluated.push({ ruleId: 'R3-refund', match: refund });
        if (refund === true) return selected(
          facts.amountCents <= 2500 ? 'refund-proposal' : 'refund-team-review', 'R3-refund');
        if (refund === 'unknown') return selected('uncertainty-review', 'R3-refund');
        // Any false conjunct settles AND; inactive subscriptions and declined
        // offers make other retention uncertainty irrelevant.
        const retention = !facts.activeSubscription || j.wantsCancel === false || j.openToOffer === false ? false
          : j.wantsCancel === true && j.openToOffer === true ? true : 'unknown';
        evaluated.push({ ruleId: 'R4-retention', match: retention });
        if (retention === true) return selected('retention-proposal', 'R4-retention');
        if (retention === 'unknown') return selected('uncertainty-review', 'R4-retention');
        evaluated.push({ ruleId: 'R5-answer', match: true });
        return selected('answer', 'R5-answer');
      };
      type Scenario = {
        id: string; conversation: string; facts?: Partial<Facts>;
        // Order: unauthorized, human, legal, refund, cancel, offer.
        probabilities: readonly [number, number, number, number, number, number];
        expected: Outcome; rule: RuleId;
      };
      const scenarios: readonly Scenario[] = [
        { id: 'fraud-overlap', conversation: 'I did not authorize this charge. Get a human or I will sue. Refund me and cancel; I might consider an offer.',
          probabilities: [0.7, 0.9, 0.9, 0.9, 0.9, 0.9], expected: 'fraud-review', rule: 'R1-fraud' },
        { id: 'human-or-unknown-legal', conversation: 'I need a human and a refund. This may become a legal matter.',
          probabilities: [0.1, 0.9, 0.5, 0.9, 0.1, 0.1], expected: 'human-legal-handoff', rule: 'R2-human-legal' },
        { id: 'legal-or-unknown-human', conversation: 'I will sue. Perhaps a person could help; refund me.',
          probabilities: [0.1, 0.5, 0.9, 0.9, 0.1, 0.1], expected: 'human-legal-handoff', rule: 'R2-human-legal' },
        { id: 'refund-2500-over-retention', conversation: 'Refund me and cancel, though I would consider an offer.',
          probabilities: [0.1, 0.1, 0.1, 0.9, 0.9, 0.9], expected: 'refund-proposal', rule: 'R3-refund' },
        { id: 'refund-2501', conversation: 'Please refund my payment.', facts: { amountCents: 2501 },
          probabilities: [0.1, 0.1, 0.1, 0.9, 0.1, 0.1], expected: 'refund-team-review', rule: 'R3-refund' },
        { id: 'refund-ineligible', conversation: 'Please refund my payment.', facts: { eligible: false },
          probabilities: [0.1, 0.1, 0.1, 0.9, 0.1, 0.1], expected: 'answer', rule: 'R5-answer' },
        { id: 'already-paid-unknown-refund-retention', conversation: 'Maybe return my money. Cancel, but I would consider an offer.', facts: { alreadyRefunded: true },
          probabilities: [0.1, 0.1, 0.1, 0.5, 0.9, 0.9], expected: 'retention-proposal', rule: 'R4-retention' },
        { id: 'unknown-fraud-high-edge', conversation: 'I may not have authorized this. Refund me.',
          probabilities: [0.699999, 0.1, 0.1, 0.9, 0.1, 0.1], expected: 'uncertainty-review', rule: 'R1-fraud' },
        { id: 'unknown-handoff', conversation: 'Perhaps someone should handle this. Refund me.',
          probabilities: [0.1, 0.5, 0.1, 0.9, 0.1, 0.1], expected: 'uncertainty-review', rule: 'R2-human-legal' },
        { id: 'unknown-refund', conversation: 'Maybe return my money. Cancel; I would consider an offer.',
          probabilities: [0.1, 0.1, 0.1, 0.5, 0.9, 0.9], expected: 'uncertainty-review', rule: 'R3-refund' },
        { id: 'retention', conversation: 'Cancel my subscription, but I am open to a retention offer.',
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.9, 0.9], expected: 'retention-proposal', rule: 'R4-retention' },
        { id: 'inactive-irrelevant-unknowns', conversation: 'I might cancel or consider an offer.', facts: { activeSubscription: false },
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.5, 0.5], expected: 'answer', rule: 'R5-answer' },
        { id: 'no-cancel-unknown-offer', conversation: 'Do not cancel. Perhaps an offer would help.',
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.1, 0.5], expected: 'answer', rule: 'R5-answer' },
        { id: 'unknown-cancel-no-offer', conversation: 'I may cancel, but I will not consider offers.',
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.5, 0.1], expected: 'answer', rule: 'R5-answer' },
        { id: 'uncertain-retention', conversation: 'Cancel my subscription. I might consider an offer.',
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.9, 0.5], expected: 'uncertainty-review', rule: 'R4-retention' },
        { id: 'all-negative', conversation: 'Where can I find the usage guide?',
          probabilities: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], expected: 'answer', rule: 'R5-answer' },
        { id: 'inclusive-thresholds', conversation: 'Cancel my subscription; I would consider an offer.',
          probabilities: [0.3, 0.3, 0.3, 0.3, 0.7, 0.7], expected: 'retention-proposal', rule: 'R4-retention' },
        { id: 'unknown-fraud-low-edge', conversation: 'I am unsure whether I authorized this. Refund me.',
          probabilities: [0.300001, 0.1, 0.1, 0.9, 0.1, 0.1], expected: 'uncertainty-review', rule: 'R1-fraud' },
      ];
      const activeScenarios = ctx.mode === 'live' ? scenarios.slice(0, 1) : scenarios;
      let decisionRequests = 0;
      let currentScenario: Scenario | undefined;
      const fixtureDecisions = typesafe({
        apiKey: 'offline-fixture-not-a-secret', apiURL: 'https://decision-fixture.invalid',
        options: { fetch: async (_url, init) => {
          decisionRequests++;
          assert.ok(currentScenario && init?.body);
          const request = JSON.parse(String(init.body));
          assert.deepEqual(request.state, { conversation: currentScenario.conversation });
          assert.deepEqual(request.questions, questions);
          return Response.json({
            model: 'jev-latest', usage: { input_tokens: 60, output_tokens: 6 },
            answers: Object.fromEntries(questionIds.map((id, index) =>
              [id, { type: 'noul', noul: currentScenario!.probabilities[index] }])),
          });
        } },
      });
      type Handoff = { ticketId: string; selectedOutcome: Outcome };
      const dispatchedActions: Handoff[] = [];
      // Host-only approval ledger; neither model receives it or an execution tool.
      const approvals = new Set<string>();
      const dispatchIfApproved = (proposal: Handoff) => {
        if (!approvals.has(JSON.stringify(proposal))) return;
        dispatchedActions.push(proposal); // Only a volatile dispatch recorder; no payment/cancellation capability.
      };
      const records: {
        scenarioId: string; ticketId: string; facts: Facts;
        raw: AxAITypesafeResponse<typeof questions>;
        judgments: Record<QuestionId, Judgment>;
        selection: Selection;
        explanation: { caseId: string; outcome: string; explanation: string };
      }[] = [];
      for (const [index, scenario] of activeScenarios.entries()) {
        currentScenario = scenario;
        const ticketId = `T-${104 + index}`;
        const facts: Facts = { eligible: true, alreadyRefunded: false, amountCents: 2500, activeSubscription: true, ...scenario.facts };
        assert.ok(Number.isSafeInteger(facts.amountCents) && facts.amountCents >= 0);
        // Only conversation crosses this boundary. Eligibility, ledger, cents and
        // subscription status are authoritative fixture facts retained by the host.
        const raw = await (ctx.mode === 'live' ? ctx.nativeDecisions : fixtureDecisions).systemOne({
          state: { conversation: scenario.conversation }, questions,
        }, { abortSignal: ctx.signal });
        assert.ok(raw.model.length > 0);
        const judgments = {} as Record<QuestionId, Judgment>;
        for (const id of questionIds) {
          assert.equal(raw.answers[id].type, 'noul');
          const p = raw.answers[id].noul;
          assert.ok(Number.isFinite(p) && p >= 0 && p <= 1);
          judgments[id] = classify(p);
        }
        const selection = selectOutcome(judgments, facts);
        if (ctx.mode === 'offline') {
          assert.equal(selection.outcome, scenario.expected, scenario.id);
          assert.equal(selection.winningRule, scenario.rule, scenario.id);
        }
        const handoff: Handoff = { ticketId, selectedOutcome: selection.outcome };
        const explain = ax('ticketId:string, selectedOutcome:string "Host-owned outcome: fraud-review, human-legal-handoff, refund-proposal, refund-team-review, retention-proposal, answer, or uncertainty-review" -> caseId:string, outcome:class "fraud-review, human-legal-handoff, refund-proposal, refund-team-review, retention-proposal, answer, uncertainty-review", explanation:string "Briefly explain the host-selected outcome as pending, not an executed action"');
        explain.addAssert(({ caseId, outcome }) => caseId === handoff.ticketId && outcome === handoff.selectedOutcome,
          'Preserve the host ticket ID and outcome; do not select or execute a different action');
        const generative = ctx.mode === 'live' ? ctx.ai : scriptedAI([
          reply(`Case Id: ${ticketId}\nOutcome: ${selection.outcome}\nExplanation: The host selected ${selection.outcome}; any proposed action remains pending approval.`),
        ]);
        const explanation = await explain.forward(generative, handoff, options(ctx));
        assert.equal(explanation.caseId, ticketId);
        assert.equal(explanation.outcome, selection.outcome);
        assert.ok(explanation.explanation.length > 0);
        dispatchIfApproved(handoff);
        assert.equal(dispatchedActions.length, 0);
        records.push({ scenarioId: scenario.id, ticketId, facts, raw, judgments, selection, explanation });
      }
      if (ctx.mode === 'offline') assert.equal(decisionRequests, scenarios.length);
      const bounded = records[0]!;
      return {
        scenarios: records.length,
        outcomes: records.map(({ scenarioId, selection }) => ({ scenarioId, outcome: selection.outcome })),
        dispatchedActions: dispatchedActions.length,
        trace: {
          ticketId: bounded.ticketId, model: bounded.raw.model,
          provenance: { source: 'native', provider: 'typesafe', model: bounded.raw.model },
          thresholds,
          questionSetVersion: 'ticket-signals-v1', policyVersion: 'ticket-policy-v1',
          judgments: questionIds.map((questionId) => ({
            questionId, probability: bounded.raw.answers[questionId].noul, judgment: bounded.judgments[questionId],
          })),
          facts: bounded.facts, factsProvenance: 'host fixture: eligibility policy, refund ledger, integer-cent billing record, subscription record',
          evaluatedRules: bounded.selection.evaluated, winningRule: bounded.selection.winningRule,
          outcome: bounded.selection.outcome,
        },
        design: 'One six-Noul request per conversation; explicit host policy owns ordered routing, authoritative facts and approval. A separate generative provider explains the typed host outcome. Raw native responses stay in internal records; only one bounded trace is returned.',
        proofBoundary: 'Offline scenarios prove scripted transport, policy, typed handoff and zero unapproved dispatch effects—not judgment quality or calibration. Thresholds are illustrative; live runs one scenario and asserts contracts, not fixture probabilities. No payment or subscription executor is connected.',
      };
    },
  },
  {
    id: '26-architecture/repository-investigator',
    title: 'Read-only RLM investigation with corpus orientation and tenant-scoped recall',
    features: ['architecture', 'repository-investigator', 'agent', 'RLM', 'contextMap', 'contextPolicy', 'recall', 'tenant-isolation'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const tenantId = 'tenant-a';
      const memoryRows = [
        { tenantId: 'tenant-a', id: 'tenant-a/retry-policy', content: 'Checkout retry policy: retry only read-only inventory lookup; never retry charging automatically.' },
        { tenantId: 'tenant-b', id: 'tenant-b/private', content: 'Other tenant private billing policy must not be visible.' },
      ];
      // Authenticate/filter BEFORE handing a catalog to Ax; recall is not auth.
      const catalog = memoryRows.filter((row) => row.tenantId === tenantId).map(({ id, content }) => ({ id, content }));
      const loaded: string[] = [];
      const orientation = new AxAgentContextMap('Repository v104: src/checkout.ts owns checkout; src/inventory.ts owns read-only stock lookup.', { infiniteEvolve: false, evolveSteps: 0, maxChars: 1200 });
      const mapBefore = orientation.snapshot();
      const policyReader = agent('sourceFilePath:string, source:string, recalledPolicyId:string, policy:string -> finding:string, sourcePath:string, policyId:string', {
        agentIdentity: { name: 'Policy Reader', namespace: 'research', description: 'Read only the explicitly handed-off source and tenant policy; preserve their identifiers.' },
        contextFields: [], maxTurns: 2,
      });
      const investigator = agent('repository:string, question:string -> finding:string, sourcePath:string, policyId:string', {
        agentIdentity: { name: 'Repository Investigator', description: 'Read-only source and tenant policy investigator; cite the actual file and recalled policy.' },
        contextFields: ['repository'],
        contextMap: { map: orientation },
        contextPolicy: { preset: 'full' },
        functions: [policyReader], directResponse: 'off',
        memoriesCatalog: catalog,
        onLoadedMemories: (memories) => { loaded.push(...memories.map(({ id }) => id)); },
        maxTurns: 4, maxSubAgentCalls: 0, maxRuntimeChars: 2000,
        contextOptions: { description: 'Inspect repository source and recall the checkout retry policy. Hand the actual source to the executor using final(task, evidence); the executor reads the recalled policy from inputs.memories after the phase handoff, then delegates to research.policyReader with explicit evidence. Do not invent policy or invoke external tools.' },
      });
      const finding = {
        finding: 'checkout calls charge once; the tenant policy forbids automatic charging retries. Only read-only inventory lookup may retry.',
        sourcePath: 'src/checkout.ts',
        policyId: 'tenant-a/retry-policy',
      };
      const stages = [
        { javascriptCode: 'await recall(["checkout retry policy"]); console.log("Tenant-scoped checkout retry policy recalled for the executor handoff.");' },
        { javascriptCode: 'var files = JSON.parse(inputs.repository); var evidence = { sourcePath: "src/checkout.ts", source: files["src/checkout.ts"] }; console.log(evidence);' },
        { javascriptCode: 'await final("Read the recalled tenant policy from inputs.memories, then ask research.policyReader to compare this checkout source with that policy; preserve the exact sourcePath and policyId", evidence);' },
        // Host-loaded memories are synchronized into worker inputs at the
        // distiller → executor boundary, not during the recall host callback.
        { javascriptCode: 'var policy = inputs.memories[0]; if (!policy || typeof policy.id !== "string" || typeof policy.content !== "string") throw new Error("Missing recalled tenant policy"); console.log(policy);' },
        // The public child function synthesizes and returns title-labelled text.
        { javascriptCode: 'var childReply = await research.policyReader({ sourceFilePath: inputs.distilledContext.sourcePath, source: inputs.distilledContext.source, recalledPolicyId: policy.id, policy: policy.content }); console.log(childReply);' },
        { javascriptCode: 'await respond("Explain which operation may retry using only this explicit source and policy", { sourcePath: inputs.sourceFilePath, source: inputs.source, policyId: inputs.recalledPolicyId, policy: inputs.policy });' },
        finding,
        { javascriptCode: 'if (typeof childReply !== "string" || !childReply.includes("tenant-a/retry-policy") || !childReply.includes("src/checkout.ts")) throw new Error("Missing child evidence"); await final("Report the child investigation with its exact sourcePath and policyId", { childReply });' },
        finding,
      ] as const;
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI((request, index) => {
        const stage = stages[index];
        assert.ok(stage, `Unexpected investigation request ${index + 1}`);
        // Actors request native javascriptCode JSON. Responders use their exact
        // signature titles unless this particular request asks for native JSON.
        if ('javascriptCode' in stage || request.responseFormat) return reply(JSON.stringify(stage));
        const signature = index === 6 ? policyReader.getSignature() : investigator.getSignature();
        return reply(signature.getOutputFields().map((field) =>
          `${field.title}: ${stage[field.name as keyof typeof finding]}`).join('\n'));
      }, { structuredOutputs: true });
      try {
      const result = await investigator.forward(model, {
        repository: JSON.stringify({
          'src/checkout.ts': 'export async function checkout(order) { const stock = await lookupInventory(order.sku); return charge(order, stock); }',
          'src/inventory.ts': 'export async function lookupInventory(sku) { return inventory.get(sku); }',
        }),
        question: 'Investigate which checkout operation may be retried. Read source and recall the checkout retry policy; return its exact policy ID and the checkout source path.',
      }, options(ctx));
      assert.equal(result.sourcePath, 'src/checkout.ts');
      assert.equal(result.policyId, 'tenant-a/retry-policy');
      assert.ok(loaded.includes('tenant-a/retry-policy'));
      assert.ok(loaded.every((id) => id.startsWith('tenant-a/')));
      assert.deepEqual(orientation.snapshot(), mapBefore);
      return {
        result, loaded, mapVersion: orientation.snapshot().version,
        design: 'An RLM is useful when the actor chooses inspection/recall steps. A read-only child receives explicit source and tenant policy evidence; neither agent receives filesystem permission. The map is frozen reusable orientation, full replay is deliberately simplest for this short run, and recall is run context—not a durable business record.',
        proofBoundary: 'Scripted actor code proves real runtime/recall integration, not investigation quality; live mode uses the configured model but grants no real repository filesystem or application-tool network access.',
      };
      } finally {
        investigator.stop();
        policyReader.stop();
      }
    },
  },
  {
    id: '26-architecture/webhook-review',
    title: 'Authenticated inbox → typed flow → owned continuation → stored result → sink',
    features: ['architecture', 'webhook-review', 'eventRuntime', 'event-routes', 'flow', 'continuation', 'sink-redrive', 'volatile-store'],
    modes: ['offline'],
    async run(ctx) {
      let modelCalls = 0;
      let observed = 0;
      let sinkAttempts = 0;
      const delivered: { reviewId: string; recommendation: string }[] = [];
      const store = new AxInMemoryEventStore();
      const source = new AxPushEventSource('authenticated-webhook-adapter');
      const model = scriptedAI(() => {
        modelCalls++;
        return reply('Recommendation: The completed scan is clean; a human may approve release REV-104.');
      });
      // Known topology: stage one records review readiness; stage two generates
      // prose only after an authenticated, correlated completion is delivered.
      const review = flow<{ reviewId: string; scanComplete: boolean; scanReport: string }, { reviewId: string; recommendation: string }>()
        .node('explainReview', 'reviewId:string, scanReport:string -> recommendation:string')
        .branch((state) => state.scanComplete)
        .when(false)
        .map((state) => ({ ...state, waitingMessage: 'Waiting for the owned external scan.' }))
        .when(true)
        .execute('explainReview', (state) => ({ reviewId: state.reviewId, scanReport: state.scanReport }))
        .merge()
        .returns((state) => ({ reviewId: state.reviewId, recommendation: state.explainReviewResult?.recommendation ?? state.waitingMessage }));
      type ReviewInput = { reviewRequestId: string; scanReport?: string };
      type ReviewOutput = { reviewId: string; recommendation: string };
      // Flow dependency inference does not describe optional wake/resume fields.
      // This application program declares the event contract and maps it into
      // the real flow's concrete state; Ax still validates both input plans.
      class ReviewTask extends AxProgram<ReviewInput, ReviewOutput> {
        constructor() {
          super('reviewRequestId:string, scanReport?:string -> reviewId:string, recommendation:string');
        }
        async forward(ai: Readonly<AxAIService>, input: ReviewInput, opts?: Readonly<AxProgramForwardOptions<string>>): Promise<ReviewOutput> {
          return review.forward(ai, { reviewId: input.reviewRequestId, scanComplete: input.scanReport !== undefined, scanReport: input.scanReport ?? 'Pending' }, opts);
        }
        async *streamingForward(ai: Readonly<AxAIService>, input: ReviewInput, opts?: Readonly<AxProgramStreamingForwardOptions<string>>): AxGenStreamingOut<ReviewOutput> {
          const result = await this.forward(ai, input, opts);
          yield { index: 0, version: 1, delta: result, partial: result };
        }
      }
      const target = eventTarget('review')
        .program(new ReviewTask()).ai(model).forwardOptions(options(ctx))
        .wakeInput((input) => input.field('reviewRequestId', eventPath.data('reviewId')))
        // continuation selectors start at the owned metadata object itself.
        .resumeInput((input) => input.field('reviewRequestId', eventPath.continuation('reviewId')).field('scanReport', eventPath.data('report')))
        .waitFor('scan', eventPath.data('scanId'), { metadata: { reviewId: eventPath.data('reviewId') } })
        .sink({ id: 'review-result', async write(output, context) {
          sinkAttempts++;
          const stored = await store.getRun(context.run.id);
          assert.deepEqual(stored?.output, output);
          if (sinkAttempts === 1) throw new Error('Isolated delivery fixture: sink temporarily unavailable');
          delivered.push(output);
        } })
        .build();
      const runtime = eventRuntime({
        id: 'review-fixture', sources: [source], store, allowVolatile: true, maxAttempts: 1,
        routes: [
          eventRoute('scan-progress').types('scan.progress').authenticated().observe(() => { observed++; }).build(),
          eventRoute('review-created').types('review.created').authenticated().authorize((ingress) => ingress.identity?.tenantId === 'tenant-a').instanceKey(eventPath.data('reviewId')).wake(target).build(),
          eventRoute('scan-completed').types('scan.completed').authenticated().authorize((ingress) => ingress.identity?.tenantId === 'tenant-a').correlate('scan', eventPath.data('scanId')).resume(target).build(),
        ],
      });
      const identity = { tenantId: 'tenant-a', userId: 'reviewer-104' };
      await runtime.start();
      try {
        // Identity here represents adapter-authenticated state, NOT payload data.
        const created = { specversion: '1.0' as const, id: 'review-created-104', source: 'fixture://webhook', type: 'review.created', data: { reviewId: 'REV-104', scanId: 'SCAN-104' } };
        const wakeReceipt = await source.publish({ event: created, identity, trust: 'authenticated' }, ctx.signal);
        await runtime.waitForIdle();
        const waitingDelivery = await store.getDelivery(wakeReceipt.deliveryIds[0]!);
        assert.equal(waitingDelivery?.status, 'waiting_event', waitingDelivery?.error);
        assert.ok(waitingDelivery?.runId);
        const waitingRun = await store.getRun(waitingDelivery.runId);
        assert.equal(waitingRun?.status, 'waiting_event', waitingRun?.error);
        assert.ok(waitingRun?.continuationIds?.length);
        assert.deepEqual(waitingRun.output, { reviewId: 'REV-104', recommendation: 'Waiting for the owned external scan.' });
        assert.equal(modelCalls, 0);
        assert.equal(delivered.length, 0);
        await source.publish({ event: { specversion: '1.0', id: 'progress-104', source: 'fixture://scanner', type: 'scan.progress', data: { scanId: 'SCAN-104' } }, identity, trust: 'authenticated' }, ctx.signal);
        await runtime.waitForIdle();
        assert.equal(observed, 1);
        assert.equal(modelCalls, 0);
        const resumeReceipt = await source.publish({ event: { specversion: '1.0', id: 'complete-104', source: 'fixture://scanner', type: 'scan.completed', data: { scanId: 'SCAN-104', report: 'Scan completed: no blocking findings.' } }, identity, trust: 'authenticated' }, ctx.signal);
        await runtime.waitForIdle();
        const resumedDelivery = await store.getDelivery(resumeReceipt.deliveryIds[0]!);
        assert.equal(resumedDelivery?.status, 'succeeded', resumedDelivery?.error);
        assert.ok(resumedDelivery?.runId);
        const resumedRun = await store.getRun(resumedDelivery.runId);
        assert.ok(resumedRun);
        assert.equal(resumedRun?.status, 'succeeded', resumedRun?.error);
        assert.deepEqual(resumedRun.output, { reviewId: 'REV-104', recommendation: 'The completed scan is clean; a human may approve release REV-104.' });
        assert.equal(resumedRun.sinks?.find((sink) => sink.sinkId === 'review-result')?.status, 'failed');
        assert.equal(modelCalls, 1);
        const deadLetters = await runtime.listDeadLetters();
        const sinkFailure = deadLetters.find((letter) => letter.kind === 'sink');
        assert.ok(sinkFailure);
        await runtime.redrive(sinkFailure.id);
        await runtime.waitForIdle();
        assert.equal(modelCalls, 1);
        assert.equal(sinkAttempts, 2);
        assert.equal(delivered.length, 1);
        const deliveredRun = await store.getRun(resumedDelivery.runId);
        assert.equal(deliveredRun?.status, 'succeeded', deliveredRun?.error);
        // In 25.4.9, redrive awaits the sink and removes its dead letter but
        // does not rewrite run.sinks (the original dispatch attempt snapshot).
        // Completion is the accepted business output plus cleared failed work,
        // not a fabricated successful status in that historical snapshot.
        assert.equal(await store.getDeadLetter(sinkFailure.id), undefined);
        assert.deepEqual(await runtime.listDeadLetters(), []);
        assert.deepEqual(deliveredRun?.output, delivered[0]);
        assert.equal(delivered[0]?.reviewId, 'REV-104');
        const duplicate = await source.publish({ event: created, identity, trust: 'authenticated' }, ctx.signal);
        assert.equal(duplicate.duplicate, true);
        return {
          delivered, modelCalls, observed, sinkAttempts, duplicate: duplicate.duplicate,
          design: 'Use an event runtime plus fixed flow, not a model call inside a callback. No MCP client is needed for this webhook transport. The authenticated adapter owns identity/correlation; Ax owns inbox routing and sink redrive; humans still own release approval.',
          boundary: 'All effects and records are in memory. Duplicate suppression here is not restart durability or cross-system exactly-once. A real deployment requires webhook signature/freshness verification, a durable store, and an idempotent delivery sink.',
        };
      } finally {
        await runtime.close({ drain: true, timeoutMs: 2000 });
      }
    },
  },
  {
    id: '26-architecture/spoken-failover',
    title: 'Compatible audio chat providers fail over before output; partial speech is not replayed',
    features: ['architecture', 'spoken-failover', 'audio-chat', 'AxBalancer', 'transport-fixture', 'batch-audio-no-failover', 'pre-chunk-recovery', 'stream-failure-ui'],
    modes: ['offline'],
    async run(ctx) {
      let primaryRequests = 0;
      let fallbackRequests = 0;
      // 10 ms of valid mono 24 kHz PCM WAV silence. The fixture does NOT prove
      // speech intelligibility; its purpose is provider wire/audio preservation.
      const wav = Buffer.alloc(44 + 480);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(480, 40);
      const audioData = wav.toString('base64');
      const voiceProvider = (primary: boolean) => ai({
        name: 'openai', apiKey: 'offline-fixture-not-a-secret', apiURL: primary ? 'https://voice-primary.invalid/v1' : 'https://voice-fallback.invalid/v1',
        config: axAIOpenAIAudioDefaultConfig(),
        options: { logger: () => {}, retry: { maxRetries: 0 }, fetch: async (_url, init) => {
          const request: unknown = JSON.parse(String(init?.body));
          assert.ok(request && typeof request === 'object' && 'audio' in request && 'modalities' in request);
          if (primary) { primaryRequests++; return Response.json({ error: { message: 'Fixture service unavailable' } }, { status: 503 }); }
          fallbackRequests++;
          return Response.json({ id: 'audio-fixture-104', object: 'chat.completion', created: 1, model: 'gpt-audio-mini', system_fingerprint: 'fixture',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: null, audio: { id: 'audio-104', data: audioData, transcript: 'Your review is ready.' } } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        } },
      });
      const pool = AxBalancer.create([voiceProvider(true), voiceProvider(false)], { comparator: AxBalancer.inputOrderComparator, maxRetries: 1, initialBackoffMs: 1, maxBackoffMs: 1 });
      const response = await pool.chat({ chatPrompt: [{ role: 'user', content: 'Say: Your review is ready.' }], modelConfig: { stream: false, maxTokens: 80, audio: { output: { enabled: true, voice: 'alloy', format: 'wav' } } } }, { abortSignal: ctx.signal });
      assert.ok('results' in response);
      const audio = response.results[0]?.audio;
      assert.ok(audio?.data);
      assert.equal(audio.transcript, 'Your review is ready.');
      assert.equal(Buffer.from(audio.data, 'base64').subarray(0, 4).toString(), 'RIFF');
      assert.equal(primaryRequests, 1);
      assert.equal(fallbackRequests, 1);

      // Negative/control pair: batch audio delegates to the current service.
      // A healthy alternate is configured, but does NOT get called implicitly.
      const batchCalls = { primarySpeak: 0, primaryTranscribe: 0, alternateSpeak: 0, alternateTranscribe: 0 };
      const batchProvider = (primary: boolean) => ai({
        name: 'openai', apiKey: 'offline-fixture-not-a-secret',
        apiURL: primary ? 'https://batch-primary.invalid/v1' : 'https://batch-alternate.invalid/v1',
        options: { logger: () => {}, retry: { maxRetries: 0 }, fetch: async (url, init) => {
          const speechRequest = String(url).endsWith('/audio/speech');
          if (speechRequest) {
            const body: unknown = JSON.parse(String(init?.body));
            assert.ok(body && typeof body === 'object' && 'input' in body);
            if (primary) batchCalls.primarySpeak++;
            else batchCalls.alternateSpeak++;
          } else {
            assert.ok(String(url).endsWith('/audio/transcriptions'));
            assert.ok(init?.body instanceof FormData && init.body.get('file') instanceof Blob);
            if (primary) batchCalls.primaryTranscribe++;
            else batchCalls.alternateTranscribe++;
          }
          if (primary) return Response.json({ error: { message: 'Isolated batch endpoint unavailable' } }, { status: 503 });
          return speechRequest
            ? new Response(wav, { headers: { 'content-type': 'audio/wav' } })
            : Response.json({ text: 'Your review is ready.' });
        } },
      });
      const batchPrimary = batchProvider(true);
      const batchAlternate = batchProvider(false);
      const batchPool = AxBalancer.create([batchPrimary, batchAlternate], { comparator: AxBalancer.inputOrderComparator, maxRetries: 1 });
      const speechRequest = { text: 'Your review is ready.', format: 'wav' as const };
      const transcriptionRequest = { audio: { data: audioData, format: 'wav' as const } };
      await assert.rejects(batchPool.speak(speechRequest, { abortSignal: ctx.signal }),
        (error: unknown) => error instanceof AxAIServiceStatusError && error.status === 503);
      await assert.rejects(batchPool.transcribe(transcriptionRequest, { abortSignal: ctx.signal }),
        (error: unknown) => error instanceof AxAIServiceStatusError && error.status === 503);
      assert.deepEqual(batchCalls, { primarySpeak: 1, primaryTranscribe: 1, alternateSpeak: 0, alternateTranscribe: 0 });
      // Calling the alternate explicitly proves its batch endpoints work; this
      // is host-owned selection, not hidden AxBalancer batch failover.
      const directSpeech = await batchAlternate.speak(speechRequest, { abortSignal: ctx.signal });
      const directTranscript = await batchAlternate.transcribe(transcriptionRequest, { abortSignal: ctx.signal });
      assert.equal(Buffer.from(directSpeech.data, 'base64').subarray(0, 4).toString(), 'RIFF');
      assert.equal(directTranscript.text, 'Your review is ready.');
      assert.deepEqual(batchCalls, { primarySpeak: 1, primaryTranscribe: 1, alternateSpeak: 1, alternateTranscribe: 1 });

      let preChunkPrimaryCalls = 0;
      let preChunkAlternateCalls = 0;
      const preChunkFailure = new AxAIServiceStatusError(503, 'Fixture failure before first chunk', 'fixture://voice', {}, {});
      const noFirstChunk = new AxMockAIService<string>({
        id: 'pre-chunk-primary', name: 'pre-chunk-primary',
        chatResponse: async () => {
          preChunkPrimaryCalls++;
          return new ReadableStream<AxChatResponse>({ start(controller) { controller.error(preChunkFailure); } });
        },
      });
      const firstChunkAlternate = new AxMockAIService<string>({
        id: 'pre-chunk-alternate', name: 'pre-chunk-alternate',
        chatResponse: async () => {
          preChunkAlternateCalls++;
          return new ReadableStream<AxChatResponse>({ start(controller) {
            controller.enqueue({ results: [{ index: 0, audio: { data: audioData, format: 'wav', transcript: 'Your review is ready.' } }] });
            controller.close();
          } });
        },
      });
      const preChunkPool = AxBalancer.create([noFirstChunk, firstChunkAlternate], { comparator: AxBalancer.inputOrderComparator, maxRetries: 1, initialBackoffMs: 1 });
      const recovered = await preChunkPool.chat({ chatPrompt: [{ role: 'user', content: 'Speak a status update.' }], modelConfig: { stream: true } }, { abortSignal: ctx.signal });
      assert.ok(!('results' in recovered));
      const recoveredReader = recovered.getReader();
      try {
        assert.equal((await recoveredReader.read()).value?.results[0]?.audio?.transcript, 'Your review is ready.');
        assert.equal((await recoveredReader.read()).done, true);
      } finally { recoveredReader.releaseLock(); }
      assert.equal(preChunkPrimaryCalls, 1);
      assert.equal(preChunkAlternateCalls, 1);

      let forbiddenReplayCalls = 0;
      const streamFailure = new AxAIServiceStatusError(503, 'Fixture mid-stream interruption', 'fixture://voice', {}, {});
      let chunks = 0;
      const partial = new AxMockAIService<string>({ id: 'partial-voice', name: 'partial-voice', chatResponse: async () => new ReadableStream<AxChatResponse>({
        pull(controller) {
          if (chunks++ === 0) controller.enqueue({ results: [{ index: 0, audio: { data: audioData, format: 'wav', transcript: 'Your review', isDelta: true } }] });
          else controller.error(streamFailure);
        },
      }) });
      const neverReplay = new AxMockAIService<string>({ id: 'no-replay', name: 'no-replay', chatResponse: async () => { forbiddenReplayCalls++; return reply('This must never be called.'); } });
      const streaming = AxBalancer.create([partial, neverReplay], { comparator: AxBalancer.inputOrderComparator, maxRetries: 1, initialBackoffMs: 1 });
      const stream = await streaming.chat({ chatPrompt: [{ role: 'user', content: 'Speak a status update.' }], modelConfig: { stream: true } }, { abortSignal: ctx.signal });
      assert.ok(!('results' in stream));
      const reader = stream.getReader();
      let ui: 'idle' | 'playing-provisional' | 'interrupted-offer-explicit-restart' = 'idle';
      try {
        const first = await reader.read();
        assert.ok(first.value?.results[0]?.audio?.data);
        ui = 'playing-provisional';
        await assert.rejects(reader.read(), /Fixture mid-stream interruption/);
        ui = 'interrupted-offer-explicit-restart';
      } finally { reader.releaseLock(); }
      assert.equal(forbiddenReplayCalls, 0);
      assert.equal(ui, 'interrupted-offer-explicit-restart');
      return {
        transcript: audio.transcript, wavBytes: wav.length, primaryRequests, fallbackRequests,
        batchCalls, preChunkPrimaryCalls, preChunkAlternateCalls, ui, forbiddenReplayCalls,
        design: 'Batch conversational audio uses a compatible pool, not an input-only model or an agent wrapper. The application accepts every substitute semantically and owns playback/reset policy. AxBalancer chat failover does not imply batch speak()/transcribe() failover.',
        prerequisites: 'Live integration requires two authorized audio-output-capable deployments, supported voices/formats, real audio and listening/quality evaluation. These isolated transports make no network calls and prove no model or acoustic quality.',
      };
    },
  },
];
