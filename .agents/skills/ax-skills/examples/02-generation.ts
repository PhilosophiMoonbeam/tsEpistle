import assert from 'node:assert/strict';
import { ax, f, fn, AxGenerateError, AxMemory, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const answer = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });

export const examples: readonly Example[] = [
  {
    id: '02-generation/generative-classification',
    title: 'Classify a message with bounded, explicitly elicited confidence',
    features: ['f.class', 'classification', 'numeric constraints', 'elicited versus native confidence'],
    modes: ['offline'],
    async run(ctx) {
      const classifier = ax(f()
        .input('emailBody', f.string())
        .output('category', f.class(['spam', 'ham', 'uncertain'] as const))
        .output('confidence', f.number().min(0).max(1)).build());
      let calls = 0;
      const model = scriptedAI(() => {
        calls++;
        return answer(`Category: spam\nConfidence: ${calls === 1 ? 1.2 : 0.75}`);
      });
      const result = await classifier.forward(model,
        { emailBody: 'Claim an unsolicited prize by sending your account details.' }, options(ctx));
      assert.equal(calls, 2, 'Out-of-range confidence requires an actual corrected generation');
      assert.deepEqual(result, { category: 'spam', confidence: 0.75 });
      // The application chooses a reversible review queue, never an automatic deletion.
      const queue = result.category === 'spam' ? 'spam-review' : 'ordinary-review';
      assert.equal(queue, 'spam-review');
      return { result, queue, corrections: calls - 1,
        boundary: 'This number is elicited model text, not a calibrated probability or native decision evidence. Validate policy on held-out data; the fixture proves class/number parsing and correction only.' };
    },
  },
  {
    id: '02-generation/typed-extraction',
    title: 'The smallest typed generation: extract a support ticket',
    features: ['ax', 'forward', 'typed inputs and outputs', 'bounded generation'],
    modes: ['offline', 'live'],
    async run(ctx) {
      // Use a signature instead of manually parsing a free-form completion.
      const gen = ax('ticketText:string -> customerName:string, ticketCount:number, urgent:boolean');
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI([
        answer('Customer Name: Ada\nTicket Count: 2\nUrgent: true'),
      ]);
      const result = await gen.forward(ai, { ticketText: 'Ada reports 2 urgent tickets.' }, options(ctx));
      const count: number = result.ticketCount;
      assert.equal(result.customerName, 'Ada');
      assert.equal(count, 2);
      assert.equal(result.urgent, true);
      return { result, proof: ctx.mode === 'offline' ? 'deterministic model output; real Ax parsing' : 'one live extraction, not a benchmark' };
    },
  },
  {
    id: '02-generation/memory-few-shot',
    title: 'Few-shot channel decisions retain a user preference across two forwards',
    features: ['AxMemory', 'setExamples', 'conversation history', 'typed class outcomes', 'session cleanup'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax(f()
        .input('userMessage', f.string())
        .output('updateChannel', f.class(['email', 'sms', 'unknown'] as const))
        .output('nextAction', f.class(['remember', 'draft', 'clarify'] as const))
        .build());
      gen.setInstruction('Remember a stated update-channel preference. For a later update request, use that preference. If none is known, ask; never guess.');
      const demonstrations = [
        { userMessage: 'Send a text update now.', updateChannel: 'sms', nextAction: 'draft' },
        { userMessage: 'Prepare an update; no channel preference is available.', updateChannel: 'unknown', nextAction: 'clarify' },
      ] as const;
      gen.setExamples(demonstrations);
      const mem = new AxMemory();
      const sessionId = 'delivery-preference';
      const preference = 'My delivery updates must use email, not text messages.';
      const followUp = 'Prepare my delivery update using my saved preference.';
      const replies = [
        answer('Update Channel: email\nNext Action: remember'),
        answer('Update Channel: email\nNext Action: draft'),
      ];
      let calls = 0;
      const model = scriptedAI((request, index) => {
        calls++;
        const reply = replies[index];
        assert(reply, 'Only the two declared conversational turns may reach the model');
        for (const example of demonstrations) {
          const exampleIndex = request.chatPrompt.findIndex((message) =>
            message.role === 'user' && JSON.stringify(message.content).includes(example.userMessage));
          assert(exampleIndex >= 0, 'setExamples must render a real few-shot user message');
          const completion = request.chatPrompt[exampleIndex + 1];
          assert(completion?.role === 'assistant');
          assert(completion.content?.includes(example.updateChannel));
          assert(completion.content?.includes(example.nextAction));
        }
        const current = request.chatPrompt.findLast((message) => message.role === 'user');
        assert(current?.role === 'user');
        assert(JSON.stringify(current.content).includes(index === 0 ? preference : followUp));
        if (index === 1) {
          assert(!JSON.stringify(current.content).includes(preference), 'The app must not restate the remembered fact as new input');
          assert(request.chatPrompt.some((message) =>
            message.role === 'user' && JSON.stringify(message.content).includes(preference)));
          assert(request.chatPrompt.some((message) =>
            message.role === 'assistant' && message.content?.includes('Next Action: remember')));
        }
        return reply;
      });
      try {
        const remembered = await gen.forward(model, { userMessage: preference }, { ...options(ctx), mem, sessionId });
        assert.deepEqual(remembered, { updateChannel: 'email', nextAction: 'remember' });
        assert(mem.history(0, sessionId).some((message) =>
          message.role === 'user' && JSON.stringify(message.content).includes(preference)));
        // Only the new request is passed here; AxMemory supplies the earlier fact.
        const decision = await gen.forward(model, { userMessage: followUp }, { ...options(ctx), mem, sessionId });
        assert.deepEqual(decision, { updateChannel: 'email', nextAction: 'draft' });
        const drafts: { channel: 'email' | 'sms'; body: string }[] = [];
        if (decision.nextAction === 'draft' && decision.updateChannel !== 'unknown') {
          drafts.push({ channel: decision.updateChannel, body: 'Your delivery is ready for dispatch.' });
        }
        assert.deepEqual(drafts, [{ channel: 'email', body: 'Your delivery is ready for dispatch.' }]);
        assert(mem.history(0, sessionId).some((message) =>
          message.role === 'assistant' && message.content?.includes('Next Action: draft')));
        assert.deepEqual(mem.history(0, 'another-customer'), []);
        assert.equal(calls, 2);
        return { remembered, decision, drafts,
          proof: 'Finite model fixtures; real few-shot rendering, parsing and history retention, not real-model memory quality. Draft only; nothing is sent.' };
      } finally {
        mem.reset(sessionId);
        assert.deepEqual(mem.history(0, sessionId), []);
      }
    },
  },
  {
    id: '02-generation/direct-generator-chain',
    title: 'Extract reported facts, apply a host return rule, then explain',
    features: ['two AxGen programs', 'direct composition', 'typed intermediate output', 'deterministic host policy'],
    modes: ['offline'],
    async run(ctx) {
      const extract = ax('customerNote:string -> orderCode:string, daysSinceDelivery:number, itemOpened:boolean');
      const explain = ax(f()
        .input('orderCode', f.string())
        .input('daysSinceDelivery', f.number())
        .input('itemOpened', f.boolean())
        .input('returnPolicy', f.string())
        .input('returnRoute', f.string('Host-selected route: standard_return or manual_review'))
        .output('reasonText', f.string())
        .build());
      explain.setInstruction('Explain the supplied host-selected return route. Do not select another route or invent order facts.');
      const returnPolicy = 'Standard returns require an unopened item delivered at most 30 days ago. Otherwise route to manual_review.';
      const replies = [
        answer('Order Code: ORD-104\nDays Since Delivery: 12\nItem Opened: true'),
        answer('Reason Text: ORD-104 is within 30 days, but the item was opened, so the host selected manual_review.'),
      ];
      let calls = 0;
      const model = scriptedAI((request, index) => {
        calls++;
        const reply = replies[index];
        assert(reply, 'The fixed chain has exactly two model calls');
        const current = request.chatPrompt.findLast((message) => message.role === 'user');
        assert(current?.role === 'user');
        const input = JSON.stringify(current.content);
        if (index === 0) {
          assert(input.includes('ORD-104 arrived 12 days ago; I opened it.'));
          assert(!input.includes(returnPolicy), 'Extraction does not need the routing policy');
        } else {
          assert(input.includes('ORD-104'));
          assert(input.includes('12'));
          assert(input.includes('true'));
          assert(input.includes(returnPolicy));
          assert(input.includes('manual_review'));
          assert(!input.includes('arrived 12 days ago'), 'The second generator consumes typed facts, not the original prose');
        }
        return reply;
      });
      const reportedFacts = await extract.forward(model, {
        customerNote: 'ORD-104 arrived 12 days ago; I opened it.',
      }, options(ctx));
      assert.deepEqual(reportedFacts, { orderCode: 'ORD-104', daysSinceDelivery: 12, itemOpened: true });
      // Extracted customer claims are not authoritative order-system facts.
      // This demonstration routes those claims to a local queue, never authorizes a return.
      const returnRoute = !reportedFacts.itemOpened && reportedFacts.daysSinceDelivery <= 30
        ? 'standard_return' : 'manual_review';
      const reviewQueue = returnRoute === 'manual_review' ? [{ ...reportedFacts }] : [];
      const explanation = await explain.forward(model, { ...reportedFacts, returnPolicy, returnRoute }, options(ctx));
      assert.equal(returnRoute, 'manual_review');
      assert(explanation.reasonText.includes(reportedFacts.orderCode));
      assert.match(explanation.reasonText, /opened/);
      assert.deepEqual(reviewQueue, [{ orderCode: 'ORD-104', daysSinceDelivery: 12, itemOpened: true }]);
      assert.equal(extract.getChatLog().length, 1);
      assert.equal(explain.getChatLog().length, 1);
      assert.equal(calls, 2);
      return { reportedFacts, returnRoute, explanation, reviewQueue,
        proof: 'Finite model fixtures; real Ax parsing and direct data handoff. Host code selects the route and queue before prose; prose cannot reselect them. No return is authorized.' };
    },
  },
  {
    id: '02-generation/hard-invariants',
    title: 'Schema constraints, whole-output assertions, strict labels and correction',
    features: ['addAssert', 'schema validation', 'strictMode', 'correction retries', 'AxGenerateError'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax('invoiceText:string -> netAmount:number(min 0), taxAmount:number(min 0), totalAmount:number(min 0)');
      // Arithmetic conservation is a hard invariant, unlike a reward for nicer wording.
      gen.addAssert((value) => value.netAmount + value.taxAmount === value.totalAmount || 'Total must equal net plus tax');
      const result = await gen.forward(scriptedAI([
        answer('Net Amount: 20\nTax Amount: 4\nTotal Amount: 99'),
        answer('Net Amount: 20\nTax Amount: 4\nTotal Amount: 24'),
      ]), { invoiceText: 'Net 20, tax 4, total 24' }, options(ctx));
      assert.equal(result.totalAmount, 24);
      assert.equal(gen.getChatLog().length, 2);
      assert(JSON.stringify(gen.getChatLog()).includes('Total must equal net plus tax'));
      const labeled = ax('questionText:string -> answerText:string', { strictMode: true });
      const corrected = await labeled.forward(scriptedAI([answer('four'), answer('Answer Text: four')]),
        { questionText: 'What is two plus two?' }, options(ctx));
      assert.equal(corrected.answerText, 'four');
      assert.equal(labeled.getChatLog().length, 2);
      const bad = ax('requestText:string -> ageYears:number(min 18)');
      await assert.rejects(() => bad.forward(scriptedAI([answer('Age Years: 12')]),
        { requestText: 'Invalid age fixture' }, { ...options(ctx), maxRetries: 0 }), (error: unknown) => {
        assert(error instanceof AxGenerateError);
        assert.match(error.message, /Unable to fix validation error/);
        assert.match(error.message, /LLM Output:/);
        assert(error.details.signature);
        return true;
      });
      return { result, assertionAttempts: 2, strictLabelAttempts: 2, exhaustedValidationRejected: true };
    },
  },
  {
    id: '02-generation/structured-extraction',
    title: 'Explicit structured JSON with nested and optional fields',
    features: ['useStructured', 'nested outputs', 'native schema', 'optional nullability'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const signature = f().input('invoiceText', f.string())
        .output('invoiceNumber', f.string().regex('^INV-[0-9]+$', 'Invoice identifier'))
        .output('lineItems', f.object({ productName: f.string(), quantity: f.number().min(1) }).array())
        .output('purchaseOrder', f.string().optional()).useStructured().build();
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI((request) => {
        assert.equal(request.responseFormat?.type, 'json_schema');
        // Provider schema enforcement is simulated; Ax still parses/validates the response.
        assert.match(JSON.stringify(request.responseFormat?.schema), /additionalProperties/);
        return answer(JSON.stringify({ invoiceNumber: 'INV-42', lineItems: [{ productName: 'Notebook', quantity: 2 }], purchaseOrder: null }));
      }, { structuredOutputs: true });
      const result = await ax(signature).forward(ai, {
        invoiceText: 'Invoice INV-42: 2 Notebook items. No purchase order was supplied.',
      }, options(ctx));
      assert.equal(result.invoiceNumber, 'INV-42');
      assert.equal(result.lineItems[0]?.quantity, 2);
      return { result, prerequisite: 'Live provider must support a structured-output capability rung', proof: 'Client validation does not prove provider schema enforcement' };
    },
  },
  {
    id: '02-generation/structured-rungs',
    title: 'Native, function and JSON-object outputs are explicit capability contracts',
    features: ['structuredOutputMode', 'native', 'function', 'json_object', '__axOutput', 'numeric coercion', 'capability failures'],
    modes: ['offline'],
    async run(ctx) {
      const outputs: Record<string, unknown> = {};
      for (const rung of ['native', 'function', 'json_object'] as const) {
        const signature = f().input('orderText', f.string()).output('itemCount', f.number())
          .output('paid', f.boolean()).useStructured().build();
        const ai = scriptedAI((request) => {
          if (rung === 'function') {
            assert(request.functions?.some((tool) => tool.name === '__axOutput'));
            return { results: [{ index: 0, functionCalls: [{ id: 'output-1', type: 'function',
              function: { name: '__axOutput', params: { itemCount: '2', paid: 'true' } } }], finishReason: 'function_call' }] };
          }
          assert.equal(request.responseFormat?.type, rung === 'native' ? 'json_schema' : 'json_object');
          assert.equal(request.functions?.some((tool) => tool.name === '__axOutput') ?? false, false);
          return answer('{"itemCount":"2","paid":"true"}');
        }, { structuredOutputs: rung === 'native', structuredOutputModes: [rung], functions: true });
        const result = await ax(signature).forward(ai, { orderText: 'Two paid items' }, { ...options(ctx), structuredOutputMode: rung });
        assert.equal(result.itemCount, 2);
        assert.equal(result.paid, true);
        outputs[rung] = result;
      }
      for (const mode of ['native', 'function', 'json_object'] as const) {
        let requests = 0;
        const unavailable = scriptedAI(() => { requests++; throw new Error('Transport must not run'); },
          { functions: false, structuredOutputs: false, structuredOutputModes: [] });
        await assert.rejects(() => ax(f().input('orderText', f.string()).output('itemCount', f.number()).useStructured().build())
          .forward(unavailable, { orderText: 'Two items' }, { ...options(ctx), structuredOutputMode: mode }), /structured|support|function|capabilit/i);
        assert.equal(requests, 0);
      }
      // Reserved names belong to Ax, not application tools.
      const collision = fn('__axOutput').description('Invalid reserved tool').handler(async () => 'not allowed').build();
      await assert.rejects(() => ax('questionText:string -> answerText:string').forward(scriptedAI([]),
        { questionText: 'Reserved-name fixture' }, { ...options(ctx), functions: [collision] }), /reserved|__axOutput/i);
      return { outputs, unavailableModesRejectedBeforeTransport: 3, reservedNameRejected: true };
    },
  },
  {
    id: '02-generation/structured-correction',
    title: 'JSON shape errors correct; typed fields are not arbitrary coercions',
    features: ['structured validation', 'strict shape', 'retry feedback', 'json flexible field'],
    modes: ['offline'],
    async run(ctx) {
      const signature = f().input('orderText', f.string()).output('customerName', f.string())
        .output('tags', f.string().array()).output('preferences', f.json()).useStructured().build();
      const gen = ax(signature);
      const result = await gen.forward(scriptedAI([
        answer('{"customerName":42,"tags":"priority","preferences":"{\"gift\":true}"}'),
        answer(JSON.stringify({ customerName: 'Ada', tags: ['priority'], preferences: JSON.stringify({ gift: true }) })),
      ], { structuredOutputs: true }), { orderText: 'Ada, priority order, gift preferred' }, options(ctx));
      assert.equal(result.customerName, 'Ada');
      assert.deepEqual(result.tags, ['priority']);
      assert.deepEqual(result.preferences, { gift: true });
      assert.equal(gen.getChatLog().length, 2);
      return { result, attempts: 2, proof: 'number-to-string and string-to-array mismatches do not silently pass' };
    },
  },
  {
    id: '02-generation/singleton-json-fallback',
    title: 'A required singleton string can use JSON-object mode without synthetic tools',
    features: ['auto rung selection', 'singleton fallback', 'exact wire keys', 'json_object'],
    modes: ['offline'],
    async run(ctx) {
      const signature = f().input('questionText', f.string()).output('answerText', f.string()).useStructured().build();
      const result = await ax(signature).forward(scriptedAI((request) => {
        assert.equal(request.responseFormat?.type, 'json_object');
        assert.equal(request.functions?.length ?? 0, 0);
        assert(JSON.stringify(request.chatPrompt).includes('answerText'));
        return answer('{"answerText":"Four."}');
      }, { functions: false, structuredOutputs: false, structuredOutputModes: ['json_object'] }),
      { questionText: '2+2?' }, options(ctx));
      assert.equal(result.answerText, 'Four.');
      return { result, proof: 'Client-side shape validation is retained; JSON-object capability is not native JSON Schema enforcement' };
    },
  },
  {
    id: '02-generation/defaults-usage',
    title: 'Constructor defaults merge per call; logs reset while usage can be reset',
    features: ['option precedence', 'modelConfig merge', 'getChatLog', 'getUsage', 'resetUsage', 'showThoughts', 'thinkingTokenBudget'],
    modes: ['offline'],
    async run(ctx) {
      const requests: Readonly<AxChatRequest<unknown>>[] = [];
      const ai = scriptedAI((request) => {
        requests.push(request);
        return { results: [{ index: 0, content: 'Answer Text: four', thought: 'A short fixture rationale', finishReason: 'stop' }],
          modelUsage: { ai: 'offline-script', model: 'fixture-model', tokens: {
            promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 3, cacheCreationTokens: 2,
          } } };
      });
      const gen = ax('questionText:string -> answerText:string', {
        model: 'constructor-model', modelConfig: { temperature: 0.2, maxTokens: 128 },
        promptCacheKey: 'owned-example', sessionId: 'owned-session', showThoughts: true,
        thinkingTokenBudget: 'low', contextCache: { cacheBreakpoint: 'after-examples' },
      });
      const first = await gen.forward(ai, { questionText: '2+2?' }, {
        ...options(ctx), model: 'call-model', modelConfig: { maxTokens: 64 },
      });
      assert.equal(requests[0]?.model, 'call-model');
      assert.equal(requests[0]?.modelConfig?.temperature, 0.2);
      assert.equal(requests[0]?.modelConfig?.maxTokens, 64);
      assert.equal(first.thought, 'A short fixture rationale');
      assert.equal(gen.getChatLog().length, 1);
      assert.equal(gen.getUsage()[0]?.tokens?.cacheReadTokens, 3);
      await gen.forward(ai, { questionText: 'two plus two?' }, options(ctx));
      assert.equal(gen.getChatLog().length, 1);
      const usage = gen.getUsage();
      assert(usage.length > 0);
      gen.resetUsage();
      assert.deepEqual(gen.getUsage(), []);
      return { first, model: requests[0]?.model, usage, lastCallLogEntries: gen.getChatLog().length,
        proof: 'Synthetic token counters demonstrate accounting, not measured cost or reasoning fidelity' };
    },
  },
];
