import assert from 'node:assert/strict';
import { agent, AxAgentClarificationError, f, fn, type AxAgentState, type AxChatResponse } from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

const reply = (content: string): AxChatResponse => ({ results: [{ index: 0, content, finishReason: 'stop' }] });
const code = (javascriptCode: string): AxChatResponse => reply(JSON.stringify({ javascriptCode }));

export const examples: readonly Example[] = [
  {
    id: '11-clarification/state-resume',
    title: 'Ask for missing shipping speed, persist the quote, resume in a fresh agent',
    features: ['AxAgentClarificationError', 'askClarification', 'single_choice', 'error.getState', 'getState', 'setState', 'runtimeBindings', 'final-responder-boundary'],
    modes: ['offline', 'live'],
    async run(ctx) {
      let quoteReads = 0;
      const quote = fn('quote').namespace('shipping')
        .description('Read the current demo-parcel quote once; save the returned JSON in a runtime variable before asking which speed. Reuse the saved quote after resume, do not re-read it.')
        .arg('parcelId', f.string()).returns(f.string())
        .handler(async ({ parcelId }) => {
          assert.equal(parcelId, 'parcel-demo');
          quoteReads++;
          return JSON.stringify({ parcelId, Standard: 12, Express: 18, currency: 'USD' });
        }).build();
      const makeAgent = () => agent('shippingRequest:string, answer?:string -> reply:string, total:number', {
        contextFields: [], functions: [quote], directResponse: 'off', maxTurns: 4,
      });
      const initial = makeAgent();
      const resumed = makeAgent();
      let modelCalls = 0;
      const turns = [
        code('await final("Read the parcel-demo quote once, save it, then ask the user to choose Standard or Express. No purchase.", {});'),
        code('const pendingQuote = JSON.parse(await shipping.quote({ parcelId: "parcel-demo" })); console.log(pendingQuote);'),
        code('await askClarification({ question: "Which shipping speed?", type: "single_choice", choices: ["Standard", "Express"] }); throw new Error("Code after clarification must not run");'),
        code('await final("Use the saved quote and the user answer; do not read or purchase again", { quote: pendingQuote, speed: inputs.answer });'),
        code('await final("Report the selected speed and its saved USD total. Do not buy shipping.", { speed: inputs.answer, total: pendingQuote[inputs.answer], currency: pendingQuote.currency }); throw new Error("Code after final must not run");'),
        reply('Reply: Express shipping costs 18 USD; no purchase was made.\nTotal: 18'),
      ];
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI((_request, index) => {
        modelCalls++;
        const response = turns[index];
        assert.ok(response, 'Unexpected extra turn or responder call');
        return response;
      }, { structuredOutputs: true });
      const request = 'For parcel-demo, read shipping.quote once and save the quote in a runtime variable. Ask me to choose Standard or Express with askClarification before selecting a price. After I answer, reuse the saved quote, report that speed and exact USD total. Do not purchase anything.';
      let saved: AxAgentState | undefined;
      let question = '';
      try {
        try {
          await initial.forward(model, { shippingRequest: request }, options(ctx));
          assert.fail('Missing speed must produce AxAgentClarificationError, not a responder answer');
        } catch (error) {
          if (!(error instanceof AxAgentClarificationError)) throw error;
          question = error.question;
          assert.ok(question.trim());
          saved = error.getState();
          assert.ok(saved, 'Capture continuation from the error, not a stale pre-run snapshot');
          assert.equal(quoteReads, 1);
          if (ctx.mode === 'offline') {
            assert.equal(modelCalls, 3, 'Clarification bypassed the responder');
            assert.deepEqual(saved.runtimeBindings.pendingQuote, { parcelId: 'parcel-demo', Standard: 12, Express: 18, currency: 'USD' });
            assert.deepEqual(initial.getState()?.runtimeBindings, saved.runtimeBindings);
          }
        }
        assert.ok(saved);
        // Treat persisted state as sensitive conversation data. Only cloneable
        // values are portable; reserved globals/tools are rebuilt by Ax.
        resumed.setState(structuredClone(saved));
        assert.deepEqual(resumed.getState()?.runtimeBindings, saved.runtimeBindings);
        const result = await resumed.forward(model, { shippingRequest: request, answer: 'Express' }, options(ctx));
        assert.equal(result.total, 18);
        assert.match(result.reply, /Express/i);
        assert.equal(quoteReads, 1, 'Resumed computation must reuse the saved quote');
        if (ctx.mode === 'offline') assert.equal(modelCalls, 6, 'final still passes through the responder');
        return { question, ...result, quoteReads, stateVersion: saved.version, proof: 'real clarification error, structured-cloned state, fresh instance resume; no purchase' };
      } finally { initial.stop(); resumed.stop(); }
    },
  },
  {
    id: '11-clarification/host-protocol',
    title: 'Host handlers request clarification and final completion, without bypassing the responder',
    features: ['extra.protocol.askClarification', 'extra.protocol.guideAgent', 'extra.protocol.final', 'guidanceLog', 'setState', 'final-responder-boundary'],
    modes: ['offline'],
    async run(ctx) {
      const hostEvents: string[] = [];
      const hostGuidance = 'Owner Mina is authorized. Finish the saved ticket using workflow.finish; do not create another ticket.';
      const ask = fn('ask').namespace('workflow')
        .description('Ask the user for a ticket owner and stop the actor turn')
        .arg('question', f.string()).returns(f.string())
        .handler(async ({ question }, extra) => {
          assert.ok(extra?.protocol, 'The completion protocol exists only in an active agent runtime');
          hostEvents.push('ask');
          return extra.protocol.askClarification(question);
        }).build();
      const guide = fn('guide').namespace('workflow')
        .description('Stop this turn and give trusted host guidance for the next turn')
        .arg('owner', f.string()).returns(f.string())
        .handler(async ({ owner }, extra) => {
          assert.ok(extra?.protocol);
          assert.equal(owner, 'Mina');
          hostEvents.push('guide');
          // The public protocol accepts one string; Ax renders it in the next
          // executor request's trusted Guidance Log, not its untrusted Action Log.
          return extra.protocol.guideAgent(hostGuidance);
        }).build();
      const finish = fn('finish').namespace('workflow')
        .description('Finish a ticket summary; public forward must still use its responder')
        .arg('ticket', f.string()).arg('owner', f.string()).returns(f.string())
        .handler(async ({ ticket, owner }, extra) => {
          assert.ok(extra?.protocol);
          assert.equal(ticket, 'T-1');
          assert.equal(owner, 'Mina');
          hostEvents.push('finish');
          // A known answer uses final(message), but public flow still runs
          // the responder. It is not the distiller's executor-skip respond().
          return extra.protocol.final(`Ticket ${ticket} is prepared for ${owner}; no external changes were made.`);
        }).build();
      const assistant = agent('ticketRequest:string, answer?:string -> reply:string', {
        contextFields: [], functions: [ask, guide, finish], directResponse: 'off', maxTurns: 4,
      });
      let modelCalls = 0;
      let responderCalls = 0;
      let trustedGuidanceVisible = false;
      let ticketPrepared = false;
      const model = scriptedAI((request) => {
        modelCalls++;
        assert.ok(modelCalls <= 7, 'The two forwards have a finite seven-response fixture');
        const systemText = request.chatPrompt
          .filter((message) => message.role === 'system')
          .map((message) => message.content).join('\n');
        const userText = request.chatPrompt.flatMap((message) => {
          if (message.role !== 'user') return [];
          return typeof message.content === 'string' ? [message.content]
            : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []);
        }).join('\n');
        // Each forward starts with a distiller, including after setState.
        // Route by the actual stage and completed host effects, not call index.
        if (/^## Distiller$/m.test(systemText)) {
          if (hostEvents.length === 0) {
            return code('await final("Prepare T-1 and ask for its owner through workflow.ask", {});');
          }
          assert.deepEqual(hostEvents, ['ask'], 'Only clarification starts a second public forward');
          return code('await final("Finish the saved ticket with the supplied owner after host authorization", { ticket: pendingTicket, owner: inputs.answer });');
        }
        // Ax 25.4.9 checks host calls as non-final code before executing them,
        // so they must contain console.log. The awaited protocol call stops the
        // turn before console.log (or the dead-code sentinel) can execute.
        if (/^## Executor$/m.test(systemText)) {
          if (hostEvents.length === 0 && !ticketPrepared) {
            ticketPrepared = true;
            // Export bindings only after a successful observable runtime turn.
            // A host interruption before that turn completes cannot capture them.
            return code('const pendingTicket = inputs.ticketRequest.match(/T-\\d+/)?.[0]; if (!pendingTicket) throw new Error("Missing ticket identifier"); console.log(pendingTicket);');
          }
          if (hostEvents.length === 0) {
            return code('console.log(await workflow.ask({ question: `Who owns ticket ${pendingTicket}?` })); throw new Error("Dead code after host clarification");');
          }
          if (hostEvents.at(-1) === 'ask') {
            return code('console.log(await workflow.guide({ owner: inputs.answer })); throw new Error("Dead code after host guidance");');
          }
          assert.deepEqual(hostEvents, ['ask', 'guide'], 'Guidance must continue the same executor before host final');
          trustedGuidanceVisible = userText.includes(`Guidance Log: - workflow.guide, ${hostGuidance}`);
          assert.ok(trustedGuidanceVisible, 'Host guidance belongs in the next actor request, in the trusted Guidance Log');
          return code('console.log(await workflow.finish({ ticket: pendingTicket, owner: inputs.answer })); throw new Error("Dead code after host final");');
        }
        assert.deepEqual(hostEvents, ['ask', 'guide', 'finish'], 'The responder must run only after host final');
        // Actor stages use strict JSON, but the public responder follows its
        // own requested output format and can use the labeled text contract.
        if (request.responseFormat?.type === 'json_schema') {
          assert.ok(request.responseFormat.schema?.schema?.properties?.reply, 'Expected the public reply schema');
        }
        responderCalls++;
        assert.equal(responderCalls, 1, 'Host final invokes the public responder exactly once');
        const message = 'Ticket T-1 is prepared for Mina; no external changes were made.';
        return reply(request.responseFormat?.type === 'json_schema' || request.responseFormat?.type === 'json_object'
          ? JSON.stringify({ reply: message })
          : `Reply: ${message}`);
      }, { structuredOutputs: true });
      try {
        let continuation: AxAgentState | undefined;
        try {
          await assistant.forward(model, { ticketRequest: 'Prepare ticket T-1; ask who owns it before finalizing its summary.' }, options(ctx));
          assert.fail('Host askClarification must throw at the public boundary');
        } catch (error) {
          if (!(error instanceof AxAgentClarificationError)) throw error;
          assert.equal(error.question, 'Who owns ticket T-1?');
          continuation = error.getState();
        }
        assert.ok(continuation);
        assert.equal(continuation.runtimeBindings.pendingTicket, 'T-1');
        assert.equal(responderCalls, 0, 'No responder for host clarification');
        assistant.setState(structuredClone(continuation));
        const result = await assistant.forward(model, { ticketRequest: 'Continue the saved ticket.', answer: 'Mina' }, options(ctx));
        assert.deepEqual(hostEvents, ['ask', 'guide', 'finish']);
        assert.ok(trustedGuidanceVisible);
        assert.equal(result.reply, 'Ticket T-1 is prepared for Mina; no external changes were made.');
        assert.equal(responderCalls, 1, 'Host final still passes through the public responder');
        return { ...result, hostEvents, trustedGuidanceVisible, modelCalls, responderCalls };
      } finally { assistant.stop(); }
    },
  },
  {
    id: '11-clarification/payload-boundaries',
    title: 'Normalize malformed single-choice prompts; reject and correct malformed multi-choice prompts',
    features: ['clarification-normalization', 'single_choice', 'multiple_choice', 'runtime-error-recovery'],
    modes: ['offline'],
    async run(ctx) {
      const normalized: unknown[] = [];
      for (const variant of ['single', 'multiple'] as const) {
        const assistant = agent('ticketLabelRequest:string -> reply:string', { contextFields: [], maxTurns: 3 });
        const turns = variant === 'single' ? [
          code('await askClarification({ question: "Which labels?", type: "single_choice", choices: [] });'),
        ] : [
          code('await askClarification({ question: "Which labels?", type: "multiple_choice", choices: ["Urgent"] });'),
          code('await askClarification({ question: "Which labels?", type: "multiple_choice", choices: ["Urgent", "Review"] });'),
        ];
        let modelCalls = 0;
        const model = scriptedAI((_request, index) => {
          modelCalls++;
          const response = turns[index];
          assert.ok(response, 'Clarification must bypass the responder');
          return response;
        }, { structuredOutputs: true });
        try {
          await assert.rejects(assistant.forward(model, { ticketLabelRequest: 'Ask which ticket labels to apply.' }, options(ctx)), (error: unknown) => {
            assert.ok(error instanceof AxAgentClarificationError);
            assert.equal(error.question, 'Which labels?');
            if (variant === 'single') {
              assert.notEqual(error.clarification.type, 'single_choice');
              assert.equal(modelCalls, 1);
            } else {
              assert.equal(error.clarification.type, 'multiple_choice');
              assert.equal(modelCalls, 2, 'Invalid multi-choice was a recoverable actor error, not a clarification');
            }
            normalized.push(error.clarification);
            return true;
          });
        } finally { assistant.stop(); }
      }
      return { normalized, proof: 'real runtime payload validation; no selections applied' };
    },
  },
];
