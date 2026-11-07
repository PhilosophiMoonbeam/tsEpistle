import assert from 'node:assert/strict';
import { type AxChatResponse } from '@ax-llm/ax';
import { AxAIProvider } from '@ax-llm/ax-ai-sdk-provider';
import { generateText, NoObjectGeneratedError, Output, streamText } from 'ai';
import { z } from 'zod';
import { scriptedAI, type Example } from './support.js';

// Pin @ax-llm/ax-ai-sdk-provider@25.4.9 with ai@7.0.2 (Node >=22).
// Only model I/O is scripted: AxAIProvider and Vercel generation/parsing are real.
// Replace the scripted Ax service with a configured Ax ai(...) service in an app.
// This adapter does NOT forward providerOptions, responseFormat or abortSignal.
// Schema checks below are client-side; signal guards are not transport cancellation.
const reply = (content: string): AxChatResponse => ({
  results: [{ index: 0, content, finishReason: 'stop' }],
});

export const examples: readonly Example[] = [
  {
    id: '34-vercel/generate-text',
    title: 'Wrap an Ax service and consume Vercel text, usage and response metadata',
    features: ['AxAIProvider', 'generateText', 'message conversion', 'token usage', 'provider metadata'],
    modes: ['offline'],
    async run(ctx) {
      ctx.signal.throwIfAborted();
      let requests = 0;
      const service = scriptedAI((request) => {
        requests++;
        assert.deepEqual(request.chatPrompt, [
          { role: 'system', content: 'Write one concise delivery update.' },
          { role: 'user', content: [{ type: 'text', text: 'Order AX-42 arrived at 14:05; tell the customer.' }] },
        ]);
        return {
          ...reply('Order AX-42 was delivered at 14:05.'),
          remoteId: 'delivery-response-42',
          remoteRequestId: 'delivery-request-42',
          remoteSessionId: 'delivery-conversation-42',
          modelUsage: { ai: 'offline-script', model: 'delivery-fixture',
            tokens: { promptTokens: 17, completionTokens: 10, totalTokens: 27 } },
          providerMetadata: { delivery: { source: 'explicit model-I/O fixture' } },
        };
      });
      const model = new AxAIProvider(service); // A real public adapter, not a custom Vercel provider.
      const result = await generateText({
        model,
        instructions: 'Write one concise delivery update.',
        prompt: 'Order AX-42 arrived at 14:05; tell the customer.',
        maxRetries: 0,
        abortSignal: ctx.signal,
      });
      // Refuse to publish a completion after cancellation; this cannot stop Ax transport work.
      ctx.signal.throwIfAborted();
      const text: string = result.text;
      assert.equal(text, 'Order AX-42 was delivered at 14:05.');
      assert.equal(result.finishReason, 'stop');
      assert.equal(result.usage.inputTokens, 17);
      assert.equal(result.usage.outputTokens, 10);
      assert.equal(result.usage.totalTokens, 27);
      assert.equal(result.response.id, 'delivery-response-42');
      assert.equal(result.response.modelId, 'delivery-fixture');
      assert.deepEqual(result.providerMetadata?.[model.provider], {
        requestId: 'delivery-request-42', remoteSessionId: 'delivery-conversation-42',
      });
      assert.equal(result.providerMetadata?.delivery?.source, 'explicit model-I/O fixture');
      assert.equal(requests, 1);
      return { text, usage: result.usage, responseId: result.response.id,
        providerMetadata: result.providerMetadata, proof: 'Scripted Ax model I/O; real Ax-to-Vercel request and response conversion' };
    },
  },
  {
    id: '34-vercel/typed-output',
    title: 'Validate a typed consumer result without claiming native JSON-schema enforcement',
    features: ['generateText', 'Output.object', 'Zod', 'typed consumer output', 'NoObjectGeneratedError'],
    modes: ['offline'],
    async run(ctx) {
      ctx.signal.throwIfAborted();
      const schema = z.object({
        orderId: z.string(),
        itemCount: z.number().int().nonnegative(),
        paid: z.boolean(),
      });
      const output = Output.object({ schema });
      let requests = 0;
      const model = new AxAIProvider(scriptedAI((request, index) => {
        requests++;
        // AxAIProvider 25.4.9 omits the Vercel responseFormat when constructing this request.
        assert.equal(request.responseFormat, undefined);
        return reply(index === 0
          ? '{"orderId":"AX-42","itemCount":2,"paid":true}'
          : '{"orderId":"AX-42","itemCount":"two","paid":true}');
      }));
      // State the JSON contract in the prompt too: this adapter does not send the schema to Ax.
      const prompt = 'Return only JSON for order AX-42: orderId (string), itemCount (integer), paid (boolean). There are 2 items and payment is complete.';
      const result = await generateText({ model, prompt, output, maxRetries: 0, abortSignal: ctx.signal });
      ctx.signal.throwIfAborted();
      const order: z.infer<typeof schema> = result.output;
      const itemCount: number = order.itemCount;
      assert.deepEqual(order, { orderId: 'AX-42', itemCount: 2, paid: true });
      assert.equal(itemCount * 12, 24); // A typed downstream consumer, not a JSON-string echo.
      await assert.rejects(
        () => generateText({ model, prompt, output, maxRetries: 0, abortSignal: ctx.signal }),
        (error: unknown) => {
          assert(NoObjectGeneratedError.isInstance(error));
          assert.match(error.message, /did not match schema/);
          return true;
        },
      );
      ctx.signal.throwIfAborted();
      assert.equal(requests, 2);
      return { order, totalUsd: itemCount * 12, invalidCountRejected: true,
        proof: 'Real Vercel Output.object parsing and validation; provider schema enforcement is not demonstrated' };
    },
  },
  {
    id: '34-vercel/stream-text',
    title: 'Drain real Vercel text deltas and await final usage through the Ax adapter',
    features: ['AxAIProvider', 'streamText', 'textStream', 'finishReason', 'streamed usage'],
    modes: ['offline'],
    async run(ctx) {
      ctx.signal.throwIfAborted();
      // A finite, already-closed model-I/O stream owns no timers, readers or external handles.
      // Do not append an empty-results sentinel: adapter flush emits the terminal Vercel events.
      const source = new ReadableStream<AxChatResponse>({ start(controller) {
        controller.enqueue({ results: [{ index: 0, content: 'Order AX-42 ' }] });
        controller.enqueue({ results: [{ index: 0, content: 'is ready ' }] });
        controller.enqueue({ results: [{ index: 0, content: 'for pickup.', finishReason: 'stop' }],
          modelUsage: { ai: 'offline-script', model: 'pickup-fixture',
            tokens: { promptTokens: 8, completionTokens: 9, totalTokens: 17 } } });
        controller.close();
      } });
      const service = scriptedAI(async (request) => {
        assert.deepEqual(request.chatPrompt, [{ role: 'user', content: [
          { type: 'text', text: 'Summarize pickup status for order AX-42.' },
        ] }]);
        return source;
      });
      const model = new AxAIProvider(service);
      const result = streamText({ model, prompt: 'Summarize pickup status for order AX-42.',
        maxRetries: 0, abortSignal: ctx.signal });
      const deltas: string[] = [];
      try {
        for await (const delta of result.textStream) {
          ctx.signal.throwIfAborted();
          deltas.push(delta);
        }
      } finally {
        // Drain this finite fixture even when the consumer aborts; this does not cancel live Ax I/O.
        await result.consumeStream();
      }
      const [text, finishReason, usage] = await Promise.all([result.text, result.finishReason, result.usage]);
      ctx.signal.throwIfAborted();
      assert.equal(deltas.join(''), 'Order AX-42 is ready for pickup.');
      assert.equal(text, deltas.join(''));
      assert.equal(finishReason, 'stop');
      assert.equal(usage.inputTokens, 8);
      assert.equal(usage.outputTokens, 9);
      assert.equal(usage.totalTokens, 17);
      assert.equal(service.getMetrics().latency.chat.samples.length, 1);
      return { deltas, text, finishReason, usage,
        proof: 'Scripted Ax chunks; real adapter streaming transformation and Vercel stream aggregation' };
    },
  },
];
