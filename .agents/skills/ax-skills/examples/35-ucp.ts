import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  agent, ax, flow, axSignUCPRequest, AxUCPClient, AxUCPWebhookEventSource,
  AxInMemoryEventStore, eventPath, eventRoute, eventRuntime, eventTarget,
  type AxEventPublishReceipt, type AxEventRuntime, type AxUCPProfile,
} from '@ax-llm/ax';
import { options, scriptedAI, type Example } from './support.js';

// Select either 35-ucp case in the collection's offline runner. No merchant
// account, credentials or purchases: owned loopback exposes one cart read.
// Read skills/ax-skills/references/event-runtime.md, agent.md and flow.md
// for deployment policy. HTTP/loopback permissions below are fixture-only.
const version = '2026-04-08';
const cart = { ucp: { version }, id: 'cart-35', total: { amount: 1250, currency: 'USD' } };
interface SignedWebhook {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}
const key = (kid: string) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, publicJWK: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256' }, kid };
};
const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    assert(bytes <= 16_384, 'Owned merchant accepts bounded fixture bodies only');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

/** Only external protocol behavior is scripted. Ax owns discovery, sessions,
 * crypto verification, tool dispatch, generation parsing and event execution. */
async function merchant() {
  let origin = '';
  let activeKey = key('initial-key');
  let profileReads = 0;
  let initializations = 0;
  let cartReads = 0;
  let sessionDeletes = 0;
  let delayedResponse: ServerResponse | undefined;
  const delayedStarted = Promise.withResolvers<void>();
  let webhook: ((request: Request) => Promise<AxEventPublishReceipt>) | undefined;
  const session = 'owned-ucp-session-35';
  const sessions: string[] = [];
  const errors: string[] = [];
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) json(response, 400, { error: errors.at(-1) });
      else response.destroy();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.headers.host, new URL(origin).host, 'Bind the HTTP host, not a forwarded/payload host');
    if (request.method === 'GET' && request.url === '/.well-known/ucp') {
      profileReads++;
      const profile: AxUCPProfile = {
        ucp: { version, services: { 'dev.ucp.shopping': [{ version, transport: 'mcp', endpoint: `${origin}/mcp` }] },
          capabilities: { 'dev.ucp.shopping.cart': [{ version }], 'dev.ucp.shopping.order': [{ version }] } },
        signing_keys: [activeKey.publicJWK],
      };
      json(response, 200, profile); return;
    }
    if (request.method === 'POST' && request.url === '/hooks/account-a') {
      assert(webhook, 'Install the application ingress before accepting webhooks');
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const incoming = new Request(`${origin}/hooks/account-a`, { method: 'POST', headers, body: await bodyOf(request) });
      try { json(response, 202, await webhook(incoming)); }
      catch (error) { json(response, 401, { rejected: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (request.url !== '/mcp') { json(response, 404, { error: 'Unknown owned route' }); return; }
    if (request.method === 'DELETE') {
      assert.equal(request.headers['mcp-session-id'], session);
      sessionDeletes++; response.writeHead(200); response.end(); return;
    }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
    assert.equal(request.method, 'POST');
    const message = object(JSON.parse(await bodyOf(request)));
    if (message.method === 'initialize') {
      initializations++;
      response.setHeader('Mcp-Session-Id', session);
      json(response, 200, { jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'owned-read-only-merchant', version: '1.0' },
      } }); return;
    }
    assert.equal(request.headers['mcp-session-id'], session);
    sessions.push(String(request.headers['mcp-session-id']));
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      response.writeHead(202); response.end(); return;
    }
    const reply = (result: unknown) => json(response, 200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'get_cart', description: 'Read the owned fixture cart; never purchase',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true } }] }); return;
    }
    if (message.method === 'ping') { reply({}); return; }
    if (message.method !== 'tools/call') {
      json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }); return;
    }
    const params = object(message.params);
    const args = object(params.arguments);
    if (params.name !== 'get_cart' || !['cart-35', 'wait'].includes(String(args.id))) {
      json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Only owned cart reads are permitted' } }); return;
    }
    // UCP, not the model, injects the platform profile in protocol metadata.
    assert.equal(object(object(args.meta)['ucp-agent']).profile, `${origin}/platform-profile`);
    if (args.id === 'wait') {
      delayedResponse = response; delayedStarted.resolve();
      // Finite owned request; cancellation closes this response first.
      const deadline = setTimeout(() => { if (!response.destroyed) reply({ content: [], structuredContent: cart }); }, 3000);
      response.once('close', () => clearTimeout(deadline));
      return;
    }
    cartReads++;
    reply({ content: [{ type: 'text', text: 'Untrusted merchant cart data' }], structuredContent: cart });
  }
  async function closeServer(): Promise<void> {
    delayedResponse?.destroy();
    if (!server.listening) return;
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const profileUrl = `${origin}/.well-known/ucp`;
    const client = new AxUCPClient({ profileUrl, agentProfile: `${origin}/platform-profile`, namespace: 'merchant',
      evaluationMode: 'sandbox', webhookMaxAgeSeconds: 60,
      mcp: { timeoutMs: 3000, retry: false, ssrfProtection: { allowHTTP: true, allowLoopback: true,
        validateURL(url) { assert.equal(url.origin, origin); } } },
    });
    return {
      client, origin, profileUrl, delayedStarted: delayedStarted.promise,
      installWebhook(handler: NonNullable<typeof webhook>) { webhook = handler; },
      rotate() { activeKey = key('rotated-key'); },
      stats: () => ({ profileReads, initializations, cartReads, sessionDeletes, sessions: [...sessions] }),
      async signedWebhook(id: string, extra: Record<string, unknown> = {}, timestamp = Math.floor(Date.now() / 1000),
        parameterOrder: 'default' | 'created-last' = 'default'): Promise<SignedWebhook> {
        const body = JSON.stringify({ ucp: { version }, id: 'order-35', checkout_id: 'checkout-35', status: 'updated',
          tenantId: 'payload-attacker', accountId: 'payload-attacker', ...extra });
        const url = `${origin}/hooks/account-a`;
        let reorderedInput: string | undefined;
        const headers = await axSignUCPRequest({ url, method: 'POST', body, headers: {
          'UCP-Agent': `profile="${profileUrl}"`, 'Request-Id': id,
          'Webhook-Id': id, 'Webhook-Timestamp': String(timestamp),
        } }, { keyId: activeKey.kid, algorithm: 'ES256', created: () => timestamp, nonce: () => id,
          components: ['@method', '@authority', '@path', 'ucp-agent', 'request-id', 'content-digest', 'content-type'],
          sign: (base, { signatureInput }) => {
            if (parameterOrder === 'default') {
              return sign('sha256', base, { key: activeKey.privateKey, dsaEncoding: 'ieee-p1363' });
            }
            // A merchant may legally put created last. Sign the reordered
            // parameter bytes, then emit that exact order in Signature-Input.
            const parameters = `${signatureInput.replace(/;created=\d+/, '')};created=${timestamp}`;
            const originalTail = `"@signature-params": ${signatureInput}`;
            const text = Buffer.from(base).toString('utf8');
            assert(text.endsWith(originalTail));
            const reorderedBase = `${text.slice(0, -originalTail.length)}"@signature-params": ${parameters}`;
            reorderedInput = `sig1=${parameters}`;
            return sign('sha256', Buffer.from(reorderedBase), { key: activeKey.privateKey, dsaEncoding: 'ieee-p1363' });
          },
        });
        if (reorderedInput !== undefined) headers['Signature-Input'] = reorderedInput;
        return { url, body, headers };
      },
      async close() {
        try { await client.close(); } finally { await closeServer(); }
        assert.deepEqual(errors, [], 'Owned merchant protocol must not fail silently');
      },
    };
  } catch (error) {
    await closeServer();
    throw error;
  }
}

// 25.4.9 verifyOrderEvent checks Webhook-Id/Timestamp, but does not require
// either to be signed, and recreates its signature verifier on each call.
// Host policy binds them to signed request-id / created, and requires signed
// signer profile. This supplements, never replaces, real client verification.
// Published sources: @ax-llm/ax/index.js.map → ../ucp/client.ts
// (verifyOrderEvent), ../ucp/signing.ts (verifyRequest),
// ../event/ucpSource.ts (ingest). Replay protection here is process-local.
function bindWebhookHeaders(request: Request): void {
  const input = request.headers.get('Signature-Input') ?? '';
  // Bounded application policy: exactly one sig1 member, simple quoted
  // component names and unambiguous parameters. Do not search across labels:
  // the pinned SDK verifies the first member, not an arbitrary later created.
  const member = /^sig1=\(((?:"[@a-z0-9-]+"(?: "[@a-z0-9-]+")*))\)((?:;[a-z][a-z0-9_-]*=(?:"[^"\\,;\r\n]*"|\d+))*)$/.exec(input);
  assert(member, 'Require exactly one unambiguous sig1 Signature-Input member');
  assert(/^sig1=:[A-Za-z0-9+/]+={0,2}:$/.test(request.headers.get('Signature') ?? ''),
    'Require exactly one matching sig1 Signature member');
  const components = [...member[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(components).size, components.length, 'Duplicate signature components are ambiguous');
  assert(components.includes('request-id') && components.includes('ucp-agent'));
  const parameters = new Map<string, string>();
  for (const parameter of member[2]!.matchAll(/;([a-z][a-z0-9_-]*)=("[^"\\,;\r\n]*"|\d+)/g)) {
    const name = parameter[1]!;
    assert(['created', 'keyid', 'alg', 'nonce', 'expires'].includes(name), 'Unsupported signature parameter');
    assert(!parameters.has(name), 'Duplicate signature parameters are ambiguous');
    parameters.set(name, parameter[2]!);
  }
  const created = parameters.get('created');
  assert(created && /^\d+$/.test(created) && Number.isSafeInteger(Number(created)),
    'Require one integer created parameter from the verified sig1 member');
  const requestId = request.headers.get('Request-Id');
  assert(requestId, 'Require a signed request ID');
  assert.equal(request.headers.get('Webhook-Id'), requestId);
  assert.equal(request.headers.get('Webhook-Timestamp'), created);
}

export const examples: readonly Example[] = [
  {
    id: '35-ucp/verified-webhook', title: 'Verify a rotating merchant key before host-bound tenant routing',
    features: ['UCP', 'AxUCPWebhookEventSource', 'RFC9421', 'digest', 'freshness', 'key-rotation', 'replay', 'trusted-identity', 'eventTarget', 'stored-result'],
    modes: ['offline'],
    async run(ctx) {
      const owned = await merchant();
      let runtime: AxEventRuntime | undefined;
      try {
        let enqueued = 0;
        class CountingStore extends AxInMemoryEventStore {
          override enqueue(...args: Parameters<AxInMemoryEventStore['enqueue']>) { enqueued++; return super.enqueue(...args); }
        }
        const store = new CountingStore();
        let identityResolutions = 0;
        let businessRuns = 0;
        const source = new AxUCPWebhookEventSource({ client: owned.client,
          identity(_event, request) {
            identityResolutions++;
            // Trusted application registration for this exact host/route/signer,
            // not event.tenantId, accountId, checkout_id or an MCP session ID.
            assert.equal(request.url, `${owned.origin}/hooks/account-a`);
            assert.equal(request.headers.get('UCP-Agent'), `profile="${owned.profileUrl}"`);
            return { tenantId: 'tenant-a', accountId: 'account-a' };
          },
        });
        const business = ax('orderEventId:string, tenant:string, account:string -> orderId:string, disposition:string');
        const model = scriptedAI((request) => {
          businessRuns++;
          const prompt = JSON.stringify(request.chatPrompt);
          assert(prompt.includes('tenant-a') && prompt.includes('account-a') && !prompt.includes('payload-attacker'));
          return { results: [{ index: 0, content: 'Order Id: order-35\nDisposition: Review recorded; no purchase or shipment performed.' }] };
        });
        const target = eventTarget('order-review').program(business).ai(model).forwardOptions(options(ctx))
          .input((input) => input.field('orderEventId', eventPath.data('id'))
            .field('tenant', eventPath.identity('tenantId')).field('account', eventPath.identity('accountId'))).build();
        runtime = eventRuntime({ store, sources: [source], allowVolatile: true, maxAttempts: 1,
          routes: [eventRoute('owned-orders').sources(owned.profileUrl).types('ucp.order.updated').authenticated()
            .authorize(({ identity }) => identity?.tenantId === 'tenant-a' && identity.accountId === 'account-a')
            .instanceKey(eventPath.subject()).wake(target).build()],
        });
        owned.installWebhook(async (request) => { bindWebhookHeaders(request); return source.ingest(request, ctx.signal); });
        const send = async (signed: SignedWebhook) => {
          const response = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: ctx.signal });
          return { status: response.status, body: object(await response.json()) };
        };
        await runtime.start();
        await owned.client.init(); // Cache initial key, then force profile-key refresh.
        owned.rotate();
        const valid = await owned.signedWebhook('webhook-35');
        const damaged = { ...valid, body: valid.body.replace('order-35', 'order-99') };
        assert.equal((await send(damaged)).status, 401, 'Digest mismatch must precede enqueue');
        const forged = await owned.signedWebhook('forged');
        assert.equal((await send({ ...forged, headers: { ...forged.headers, Signature: 'sig1=:AAAA:' } })).status, 401);
        assert.equal((await send(await owned.signedWebhook('expired', {}, Math.floor(Date.now() / 1000) - 120))).status, 401);
        assert.equal(enqueued, 0); assert.equal(identityResolutions, 0); assert.equal(businessRuns, 0);
        const accepted = await send(valid);
        assert.equal(accepted.status, 202);
        await runtime.waitForIdle();
        const ids = accepted.body.deliveryIds;
        assert(Array.isArray(ids) && typeof ids[0] === 'string');
        const delivery = await store.getDelivery(ids[0]);
        assert(delivery?.runId);
        const run = await runtime.getRun(delivery.runId);
        assert(run);
        assert.equal(run?.status, 'succeeded', run?.error);
        assert.deepEqual(run.output, { orderId: 'order-35', disposition: 'Review recorded; no purchase or shipment performed.' });
        assert.equal((await send(valid)).status, 401, 'Client rejects an accepted Webhook-Id replay');
        assert.equal((await send({ ...valid, headers: { ...valid.headers, 'Webhook-Id': 'changed-id' } })).status, 401,
          'Host rejects replay-header mutation before calling ingest');
        assert.equal(enqueued, 1); assert.equal(identityResolutions, 1); assert.equal(businessRuns, 1);
        assert.equal(owned.stats().profileReads, 2, 'Missing key triggers real discovery refresh');
        return { status: run.status, output: run.output, enqueued, rejected: 5, keyRotation: true,
          boundary: 'Owned fixture only. Volatile inbox and process-local webhook replay state are not restart durability; deploy durable replay/idempotency policy and HTTPS.' };
      } finally {
        try { await runtime?.close({ drain: false }); } finally { await owned.close(); }
      }
    },
  },
  {
    id: '35-ucp/webhook-freshness-member-binding',
    title: 'Reject an unsigned signature member that attempts to refresh a stale signed webhook',
    features: ['UCP', 'RFC9421', 'freshness', 'signature-member-binding', 'reject-before-enqueue'],
    modes: ['offline'],
    async run(ctx) {
      const owned = await merchant();
      let runtime: AxEventRuntime | undefined;
      try {
        let enqueued = 0;
        let identityResolutions = 0;
        let businessRuns = 0;
        class CountingStore extends AxInMemoryEventStore {
          override enqueue(...args: Parameters<AxInMemoryEventStore['enqueue']>) { enqueued++; return super.enqueue(...args); }
        }
        const store = new CountingStore();
        const source = new AxUCPWebhookEventSource({ client: owned.client,
          identity(_event, request) {
            identityResolutions++;
            assert.equal(request.url, `${owned.origin}/hooks/account-a`);
            assert.equal(request.headers.get('UCP-Agent'), `profile="${owned.profileUrl}"`);
            return { tenantId: 'tenant-a', accountId: 'account-a' };
          },
        });
        const business = ax('orderEventId:string -> disposition:string');
        const model = scriptedAI(() => {
          businessRuns++;
          return { results: [{ index: 0, content: 'Disposition: Recorded verified fixture order.' }] };
        });
        const target = eventTarget('freshness-review').program(business).ai(model).forwardOptions(options(ctx))
          .input((input) => input.field('orderEventId', eventPath.data('id'))).build();
        runtime = eventRuntime({ store, sources: [source], allowVolatile: true, workerConcurrency: 1, maxAttempts: 1,
          routes: [eventRoute('freshness-bound-orders').sources(owned.profileUrl).types('ucp.order.updated').authenticated()
            .authorize(({ identity }) => identity?.tenantId === 'tenant-a' && identity.accountId === 'account-a')
            .instanceKey(eventPath.subject()).wake(target).build()],
        });
        owned.installWebhook(async (request) => { bindWebhookHeaders(request); return source.ingest(request, ctx.signal); });
        const send = async (signed: SignedWebhook) => {
          const response = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: ctx.signal });
          await response.json();
          return response.status;
        };
        await runtime.start();
        await owned.client.init();
        const now = Math.floor(Date.now() / 1000);
        const stale = await owned.signedWebhook('stale-primary-35', {}, now - 120, 'created-last');
        // sig2 has NO signature. Preserve the real stale sig1/base/body,
        // append unsigned parameters, and change only the unsigned timestamp.
        const attack = { ...stale, headers: { ...stale.headers,
          'Signature-Input': `${stale.headers['Signature-Input']},sig2=("@method");created=${now}`,
          'webhook-timestamp': String(now),
        } };
        assert.equal(await send(attack), 401, 'Unsigned sig2.created must not refresh merchant-signed sig1.created');
        assert.equal(enqueued, 0);
        assert.equal(identityResolutions, 0);
        assert.equal(businessRuns, 0);
        const fresh = await owned.signedWebhook('fresh-primary-35', {}, now, 'created-last');
        assert.equal(await send(fresh), 202, 'Legal fresh single-member created-last signatures remain accepted');
        await runtime.waitForIdle();
        assert.equal(enqueued, 1);
        assert.equal(identityResolutions, 1);
        assert.equal(businessRuns, 1);
        return { staleUnsignedMember: 'rejected-before-enqueue', freshCreatedLast: 'accepted', enqueued, businessRuns };
      } finally {
        try { await runtime?.close({ drain: false }); } finally { await owned.close(); }
      }
    },
  },
  {
    id: '35-ucp/native-flow-agent', title: 'Inherit native UCP into Agent and Gen, reuse the MCP session, cancel a pending read',
    features: ['UCP', 'native-attachment', 'Agent', 'Flow', 'mcpInheritance', 'structured-results', 'session-reuse', 'cancellation'],
    modes: ['offline'],
    async run(ctx) {
      const owned = await merchant();
      try {
        const reader = agent('query:string -> cart:json', { contextFields: [], directResponse: 'off', mcpInheritance: 'all' });
        const check = ax('cart:json -> amount:number');
        // Neither node declares ucp: the Flow passes its live execution context.
        const workflow = flow<{ query: string }, { cart: unknown; amount: number }>({ ucp: owned.client })
          .node('readCart', reader).node('checkCart', check)
          .execute('readCart', (state) => ({ query: state.query }))
          .execute('checkCart', (state) => ({ cart: state.readCartResult.cart }))
          .returns((state) => ({ cart: state.readCartResult.cart, amount: state.checkCartResult.amount }));
        const actorReplies = [
          { results: [{ index: 0, content: JSON.stringify({ javascriptCode: 'await final("Read the owned cart through ucp.merchant.get_cart; retain its structured value", {id:"cart-35"})' }) }] },
          { results: [{ index: 0, content: JSON.stringify({ javascriptCode: 'const cart = await ucp.merchant.get_cart({id:"cart-35"}); await final("Return cart unchanged", {cart});' }) }] },
          { results: [{ index: 0, content: `Cart: ${JSON.stringify(cart)}` }] },
        ];
        const model = scriptedAI((request, index) => {
          if (index === 2) {
            const prompt = JSON.stringify(request.chatPrompt);
            assert(prompt.includes('1250') && prompt.includes('USD'), 'Native UCP structured result reaches the Agent synthesizer');
          }
          if (index < actorReplies.length) return actorReplies[index]!;
          if (index === 3) {
            assert(JSON.stringify(request.chatPrompt).includes('1250'), 'Structured Agent output reaches the next Flow node');
            const tool = request.functions?.find((candidate) => candidate.name.includes('get_cart'));
            assert(tool);
            return { results: [{ index: 0, functionCalls: [{ id: 'second-cart-read', type: 'function', function: { name: tool.name, params: { id: 'cart-35' } } }] }] };
          }
          assert.equal(index, 4);
          assert(JSON.stringify(request.chatPrompt).includes('USD'));
          return { results: [{ index: 0, content: 'Amount: 1250' }] };
        });
        const result = await workflow.forward(model, { query: 'Read cart-35 only; preserve JSON and independently check the amount.' }, options(ctx));
        assert.deepEqual(result.cart, cart); assert.equal(result.amount, 1250);
        assert.equal(owned.stats().cartReads, 2);
        assert.equal(owned.stats().initializations, 1);
        assert.equal(owned.stats().profileReads, 1);
        assert(owned.stats().sessions.every((session) => session === 'owned-ucp-session-35'));
        const abort = new AbortController();
        const cancelModel = scriptedAI((request) => {
          const tool = request.functions?.find((candidate) => candidate.name.includes('get_cart'));
          assert(tool, 'Inherited native UCP tools must reach Gen');
          return { results: [{ index: 0, functionCalls: [{ id: 'pending-cart-read', type: 'function', function: { name: tool.name, params: { id: 'wait' } } }] }] };
        });
        const pending = flow<{ query: string }, { amount: number }>({ ucp: owned.client })
          .node('read', 'query:string -> amount:number').execute('read', (state) => ({ query: state.query }))
          .returns((state) => ({ amount: state.readResult.amount }));
        const request = pending.forward(cancelModel, { query: 'Read the pending owned cart.' }, {
          ...options(ctx), abortSignal: AbortSignal.any([ctx.signal, abort.signal]),
        });
        const rejected = assert.rejects(request);
        await Promise.race([owned.delayedStarted, request.then(
          () => { throw new Error('Pending read completed before application cancellation'); },
          (error: unknown) => { throw error; },
        )]);
        abort.abort(new Error('Application cancelled owned cart read'));
        await rejected;
        assert.equal(owned.stats().cartReads, 2, 'Cancelled request never completes a business read');
        const stats = owned.stats();
        return { result, initializations: stats.initializations, profileReads: stats.profileReads,
          reads: stats.cartReads, cancelled: true,
          proof: 'Real UCP/MCP session and native Flow→Agent/Gen execution; merchant data and model decisions are explicit offline fixtures, not model-quality evidence.' };
      } finally {
        await owned.close();
        assert.equal(owned.stats().sessionDeletes, owned.stats().initializations, 'Every acquired MCP session is closed');
      }
    },
  },
];
