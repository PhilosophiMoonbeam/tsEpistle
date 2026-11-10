import assert from 'node:assert/strict';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  AxMCPClient, AxMCPStreamableHTTPTransport, AxMCPHTTPSSETransport,
  axMCPAPIKeyAuthentication, axMCPBasicAuthentication,
  axMCPBearerAuthentication, axMCPHMACAuthentication,
  type AxMCPAuthentication, type AxMCPJSONRPCRequest,
  type AxMCPListeningHandle, type AxMCPOAuthOptions, type AxMCPTokenSet,
} from '@ax-llm/ax';
import { LocalMCPPeer, object } from './19-mcp.js';
import type { Example, ExampleContext } from './support.js';

// Only this owned ephemeral 127.0.0.1 server permits HTTP/loopback. Never copy
// these relaxations to an untrusted endpoint. No Internet or real keys used.
const localProtection = { allowHTTP: true, allowLoopback: true } as const;
const details = [{ type: 'inventory_read', locations: ['SKU-42'] }];

type AuthKind = 'bearer' | 'basic' | 'api-key' | 'hmac' | 'oauth';
interface OAuthFixture {
  origin: string;
  endpoint: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  peer: LocalMCPPeer;
  paths: string[];
  grants: string[];
  authHeaders: string[];
  tokenBodies: URLSearchParams[];
  invalidateAccess(): void;
  metadata: Record<string, unknown>;
  proofCount: number;
  authorize(url: string): Promise<{ code: string; state: string; iss: string }>;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    assert(size <= 65_536, 'Fixture body limit exceeded'); chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
function rpcRequest(value: unknown): AxMCPJSONRPCRequest {
  const p = object(value);
  assert.equal(p.jsonrpc, '2.0'); assert(typeof p.method === 'string');
  assert(typeof p.id === 'string' || typeof p.id === 'number');
  return { jsonrpc: '2.0', id: p.id, method: p.method, params: p.params };
}

async function verifyDPoP(jwt: string | string[] | undefined, url: string, method: string,
  seen: Set<string>, accessToken?: string): Promise<string> {
  assert(typeof jwt === 'string');
  const [header, claims, signature] = jwt.split('.'); assert(header && claims && signature);
  const h = object(JSON.parse(Buffer.from(header, 'base64url').toString()));
  const c = object(JSON.parse(Buffer.from(claims, 'base64url').toString()));
  assert.equal(h.typ, 'dpop+jwt'); assert.equal(h.alg, 'ES256');
  assert.equal(c.htm, method); assert.equal(c.htu, url);
  if (accessToken) assert.equal(c.ath, createHash('sha256').update(accessToken).digest('base64url'));
  assert(typeof c.iat === 'number' && Math.abs(Date.now() / 1000 - c.iat) < 60);
  assert(typeof c.jti === 'string' && c.jti.length > 0);
  assert(!seen.has(c.jti), 'DPoP proof must be fresh'); seen.add(c.jti);
  const jwk = object(h.jwk);
  assert.equal(jwk.kty, 'EC'); assert.equal(jwk.crv, 'P-256');
  assert(typeof jwk.x === 'string' && typeof jwk.y === 'string');
  const publicJwk = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y };
  const key = await webcrypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), Buffer.from(`${header}.${claims}`)));
  return createHash('sha256').update(JSON.stringify(publicJwk)).digest('base64url');
}

/** A minimal actual HTTP MCP peer plus OAuth AS/RS, not a mocked Ax client.
 * It intentionally omits production security infrastructure and browser UI.
 */
async function withOAuthFixture<T>(ctx: ExampleContext, kind: AuthKind,
  run: (fixture: OAuthFixture) => Promise<T>, config: { modern?: boolean; dpop?: boolean; par?: boolean; dynamic?: boolean; legacySSE?: boolean } = {}): Promise<T> {
  const peer = new LocalMCPPeer(config.modern);
  const paths: string[] = [], grants: string[] = [], authHeaders: string[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const codes = new Map<string, URLSearchParams>();
  const pushed = new Map<string, URLSearchParams>();
  const refreshTokens = new Set<string>();
  const seenProofs = new Set<string>();
  const streams = new Set<ServerResponse>();
  const errors: Error[] = [];
  let origin = '', currentAccess = '', boundProofKey = '', sequence = 0, proofs = 0;
  const metadata: Record<string, unknown> = {};
  const shutdown = new AbortController();
  const signal = AbortSignal.any([ctx.signal, shutdown.signal, AbortSignal.timeout(15_000)]);
  // Include discovery, token exchange, notification POSTs and session DELETEs:
  // the SDK's per-request timeout does not cover every lifecycle operation.
  const fixtureFetch: typeof globalThis.fetch = (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetch(input, { ...init, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal });
  };
  const server = createServer((request, response) => {
    void (async () => {
      signal.throwIfAborted();
      assert(paths.length < 150, 'Fixture HTTP request budget exceeded');
      const url = new URL(request.url ?? '/', origin);
      paths.push(url.pathname);
      if (config.legacySSE && url.pathname === '/sse') {
        assert.equal(request.headers.authorization, 'Bearer fixture-bearer');
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.flushHeaders(); streams.add(response);
        response.write('event: endpoint\ndata: /mcp\n\n');
        response.on('close', () => { streams.delete(response); }); return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['inventory.read'] }); return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') { json(response, metadata); return; }
      if (url.pathname === '/register') {
        assert(config.dynamic, 'DCR must be explicitly enabled');
        const registration = object(JSON.parse(await body(request)));
        assert.deepEqual(registration.redirect_uris, [`${origin}/callback`]);
        assert.equal(registration.token_endpoint_auth_method, 'none');
        assert.deepEqual(registration.grant_types, ['authorization_code', 'refresh_token']);
        assert.deepEqual(registration.response_types, ['code']);
        json(response, { client_id: 'loopback-public-client', token_endpoint_auth_method: 'none' }, 201); return;
      }
      if (url.pathname === '/par') {
        assert(config.par, 'PAR was not advertised');
        const parameters = new URLSearchParams(await body(request));
        assert.equal(parameters.get('client_id'), 'loopback-public-client');
        const uri = `urn:owned-fixture:par:${pushed.size + 1}`;
        pushed.set(uri, parameters); json(response, { request_uri: uri, expires_in: 60 }, 201); return;
      }
      if (url.pathname === '/authorize') {
        const parameters = url.searchParams.has('request_uri') ? pushed.get(url.searchParams.get('request_uri')!) : url.searchParams;
        assert(parameters, 'Unknown PAR reference');
        assert.equal(parameters.get('response_type'), 'code');
        assert.equal(parameters.get('client_id'), 'loopback-public-client');
        assert.equal(parameters.get('resource'), `${origin}/mcp`);
        assert.equal(parameters.get('scope'), 'inventory.read');
        assert.equal(parameters.get('code_challenge_method'), 'S256');
        assert(parameters.get('code_challenge') && parameters.get('state') && parameters.get('nonce'));
        if (config.par) assert.deepEqual(JSON.parse(parameters.get('authorization_details') ?? 'null'), details);
        assert.equal(parameters.get('redirect_uri'), `${origin}/callback`);
        const code = `owned-code-${codes.size + 1}`;
        codes.set(code, new URLSearchParams(parameters));
        json(response, { code, state: parameters.get('state'), iss: origin }); return;
      }
      if (url.pathname === '/token') {
        const parameters = new URLSearchParams(await body(request));
        tokenBodies.push(parameters);
        const grant = parameters.get('grant_type');
        assert(grant, 'grant_type required'); grants.push(grant);
        assert.equal(parameters.get('resource'), `${origin}/mcp`, 'Resource-bound access token');
        assert.equal(parameters.get('scope'), 'inventory.read');
        if (config.dpop) {
          boundProofKey = await verifyDPoP(request.headers.dpop, `${origin}/token`, 'POST', seenProofs);
          proofs++;
        }
        if (grant === 'authorization_code') {
          assert.equal(parameters.get('client_id'), 'loopback-public-client');
          const pending = codes.get(parameters.get('code') ?? '');
          assert(pending, 'Unknown authorization code');
          const verifier = parameters.get('code_verifier'); assert(verifier);
          assert.equal(createHash('sha256').update(verifier).digest('base64url'), pending.get('code_challenge'));
          assert.equal(parameters.get('redirect_uri'), pending.get('redirect_uri'));
          codes.delete(parameters.get('code')!); // One-use authorization code.
        } else if (grant === 'refresh_token') {
          assert.equal(parameters.get('client_id'), 'loopback-public-client');
          assert(refreshTokens.delete(parameters.get('refresh_token') ?? ''), 'Unknown/used refresh token');
        } else if (grant === 'client_credentials') {
          assert.equal(parameters.get('client_id'), 'loopback-service-client');
          assert.equal(parameters.get('client_secret'), 'fixture-only-secret');
        } else if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          assert.equal(parameters.get('assertion'), 'owned-identity-authorization-grant');
        } else throw new Error(`Unsupported grant ${grant}`);
        currentAccess = `owned-access-${++sequence}`;
        const refresh = `owned-refresh-${sequence}`; refreshTokens.add(refresh);
        json(response, { access_token: currentAccess, refresh_token: refresh, token_type: config.dpop ? 'DPoP' : 'Bearer', expires_in: 3600, scope: 'inventory.read' }); return;
      }
      if (url.pathname !== '/mcp') { json(response, { error: 'not_found' }, 404); return; }
      const raw = request.method === 'POST' ? await body(request) : '';
      const authorization = request.headers.authorization ?? '';
      authHeaders.push(authorization);
      let authenticated = false;
      if (kind === 'bearer') authenticated = authorization === 'Bearer fixture-bearer';
      if (kind === 'basic') authenticated = authorization === `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
      if (kind === 'api-key') authenticated = request.headers['x-fixture-key'] === 'fixture-api-key';
      if (kind === 'hmac') {
        const canonical = [request.method, `${url.pathname}${url.search}`, createHash('sha256').update(raw).digest('hex'), request.headers['x-timestamp'], request.headers['x-nonce']].join('\n');
        const expected = createHmac('sha256', 'fixture-hmac-secret').update(canonical).digest('hex');
        authenticated = request.headers['x-signature'] === `keyId=fixture,algorithm=hmac-sha256,signature=${expected}`;
      }
      if (kind === 'oauth') authenticated = currentAccess !== '' && authorization === `${config.dpop ? 'DPoP' : 'Bearer'} ${currentAccess}`;
      if (!authenticated) {
        response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="inventory.read"`, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_token' })); return;
      }
      if (kind === 'oauth' && config.dpop) {
        const proofKey = await verifyDPoP(request.headers.dpop, `${origin}/mcp`, request.method ?? 'POST', seenProofs, currentAccess);
        assert.equal(proofKey, boundProofKey, 'Access token must be presented with the issuing DPoP key');
        proofs++;
      }
      if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
      if (request.method !== 'POST') { json(response, { error: 'method_not_allowed' }, 405); return; }
      const message = object(JSON.parse(raw));
      if (!('id' in message)) {
        assert.equal(message.jsonrpc, '2.0'); assert(typeof message.method === 'string');
        await peer.sendNotification({ jsonrpc: '2.0', method: message.method, params: object(message.params ?? {}) });
        response.writeHead(202); response.end(); return;
      }
      const rpc = rpcRequest(message);
      if (config.modern) {
        const params = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params) ? rpc.params as Record<string, unknown> : {};
        const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : {};
        const version = meta['io.modelcontextprotocol/protocolVersion'];
        if (version !== '2026-07-28') {
          json(response, { jsonrpc: '2.0', id: rpc.id, error: {
            code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'] },
          } }, 400); return;
        }
        if (request.headers['mcp-protocol-version'] !== version || request.headers['mcp-method'] !== rpc.method) {
          json(response, { jsonrpc: '2.0', id: rpc.id, error: {
            code: -32020, message: 'MCP routing headers must match the request metadata and method',
          } }, 400); return;
        }
      }
      if (rpc.method === 'subscriptions/listen') {
        assert(config.modern);
        assert.equal(request.headers['last-event-id'], undefined);
        const p = object(rpc.params);
        const notifications = object(p.notifications);
        const subscriptions = notifications.resourceSubscriptions;
        assert(subscriptions === undefined || (Array.isArray(subscriptions) && subscriptions.every((uri) => typeof uri === 'string')));
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.flushHeaders(); streams.add(response);
        const meta = { 'io.modelcontextprotocol/subscriptionId': rpc.id };
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications, _meta: meta } })}\n\n`);
        if (Array.isArray(subscriptions) && subscriptions.includes('inventory://policy')) {
          response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'inventory://policy', _meta: meta } })}\n\n`);
        }
        response.on('close', () => { streams.delete(response); }); return;
      }
      if (!config.modern && !config.legacySSE && rpc.method === 'initialize') response.setHeader('mcp-session-id', 'owned-loopback-session');
      if (!config.modern && !config.legacySSE && rpc.method !== 'initialize' && rpc.method !== 'server/discover') assert.equal(request.headers['mcp-session-id'], 'owned-loopback-session');
      json(response, await peer.send(rpc, { signal }));
      if (config.legacySSE && rpc.method === 'resources/subscribe') {
        for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'inventory://policy' },
        })}\n\n`);
      }
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error)); errors.push(failure);
      if (!response.headersSent) json(response, { error: failure.message }, 500); else response.destroy(failure);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  Object.assign(metadata, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
    code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'] });
  if (config.par) metadata.pushed_authorization_request_endpoint = `${origin}/par`;
  if (config.dynamic) metadata.registration_endpoint = `${origin}/register`;
  const fixture: OAuthFixture = {
    origin, endpoint: `${origin}/mcp`, fetch: fixtureFetch, signal, peer, paths, grants, authHeaders, tokenBodies, metadata,
    get proofCount() { return proofs; },
    invalidateAccess() { currentAccess = ''; },
    async authorize(url) {
      assert.equal(new URL(url).origin, origin, 'Headless approval never navigates outside owned origin');
      const response = await fixtureFetch(url); assert(response.ok);
      const data = object(await response.json());
      assert.equal(typeof data.code, 'string'); assert.equal(typeof data.state, 'string'); assert.equal(typeof data.iss, 'string');
      return { code: String(data.code), state: String(data.state), iss: String(data.iss) };
    },
  };
  try {
    const result = await run(fixture);
    assert.equal(errors.length, 0, errors.map((e) => e.message).join('; ')); return result;
  } finally {
    shutdown.abort('Owned OAuth fixture closed');
    for (const stream of streams) stream.destroy();
    peer.close();
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
}

function transport(fixture: OAuthFixture, extra: ConstructorParameters<typeof AxMCPStreamableHTTPTransport>[1] = {}): AxMCPStreamableHTTPTransport {
  return new AxMCPStreamableHTTPTransport(fixture.endpoint, { ssrfProtection: localProtection, timeoutMs: 5000, maxResponseBytes: 262_144, retry: false, fetch: fixture.fetch, ...extra });
}
function tokens(): { store: NonNullable<AxMCPOAuthOptions['tokenStore']>; values: Map<string, AxMCPTokenSet> } {
  const values = new Map<string, AxMCPTokenSet>();
  return { values, store: { getToken: (key) => values.get(key) ?? null,
    setToken: (key, token) => { values.set(key, token); }, clearToken: (key) => { values.delete(key); } } };
}

export const examples: readonly Example[] = [
  {
    id: '29-mcp-oauth/simple-authentication', title: 'Send bearer, Basic, API-key and HMAC over actual loopback HTTP',
    features: ['MCP', 'Streamable HTTP', 'bearer', 'Basic', 'API key', 'HMAC', 'session lifecycle'], modes: ['offline'],
    async run(ctx) {
      const strategies: readonly [AuthKind, AxMCPAuthentication][] = [
        ['bearer', axMCPBearerAuthentication(async () => 'fixture-bearer')],
        ['basic', axMCPBasicAuthentication('fixture-user', 'fixture-password')],
        ['api-key', axMCPAPIKeyAuthentication({ key: 'fixture-api-key', name: 'X-Fixture-Key' })],
        ['hmac', axMCPHMACAuthentication({ keyId: 'fixture', secret: 'fixture-hmac-secret' })],
      ];
      const results: unknown[] = [];
      for (const [kind, authentication] of strategies) {
        results.push(await withOAuthFixture(ctx, kind, async (f) => {
          const client = new AxMCPClient(transport(f, { authentication }), { namespace: `auth_${kind.replace('-', '_')}`, era: 'legacy' });
          try {
            const catalog = await client.inspectCatalog(); assert(catalog.tools.length > 0);
            const result = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
            assert.deepEqual(result.structuredContent, { sku: 'SKU-42', quantity: 7 });
            await client.ping(1000);
            return { kind, verifiedRequests: f.authHeaders.length, result: result.structuredContent };
          } finally { await client.close(); }
        }));
      }
      return { results, proof: 'The real Ax HTTP transport and authentication strategies produce wire headers independently verified by an owned fixture; no credentials are printed.' };
    },
  },
  {
    id: '29-mcp-oauth/pkce-refresh', title: 'Discover protected resource, approve PKCE and rotate access/refresh tokens',
    features: ['MCP OAuth', 'RFC9728', 'RFC8414', 'PKCE S256', 'RFC8707', 'state', 'issuer', 'refresh', 'token store'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'oauth', async (f) => {
        const storage = tokens(); let approvals = 0;
        const client = new AxMCPClient(transport(f, { oauth: {
          clientId: 'loopback-public-client', tokenEndpointAuthMethod: 'none', redirectUri: `${f.origin}/callback`, scopes: ['inventory.read'],
          ssrfProtection: localProtection, tokenStore: storage.store,
          onAuthCode: async (url, state) => { approvals++; assert(new URL(url).searchParams.get('state') === state.state); return f.authorize(url); },
        } }), { namespace: 'authorized', era: 'legacy' });
        try {
          await client.init(); assert.equal(approvals, 1);
          const first = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
          f.invalidateAccess(); // Server revocation causes 401, not a local fake refresh call.
          await client.ping(1000);
          assert.deepEqual(f.grants, ['authorization_code', 'refresh_token']); assert.equal(approvals, 1);
          assert.equal(storage.values.size, 1);
          assert([...storage.values.keys()].every((key) => key === `${f.endpoint}::${f.origin}`));
          assert(f.authHeaders.some((header) => header.startsWith('Bearer ')));
          return { grants: f.grants, approvals, discovery: f.paths.filter((p) => p.includes('well-known')), result: first.structuredContent,
            proof: 'Real discovery, state/issuer checks, PKCE exchange and challenge-driven refresh. Host approval is a bounded same-origin headless callback, not a browser login or production AS.' };
        } finally { await client.close(); storage.values.clear(); }
      });
    },
  },
  {
    id: '29-mcp-oauth/client-credentials-dpop', title: 'Bind machine credentials to resource and verify real DPoP proofs',
    features: ['MCP OAuth', 'client_credentials', 'client_secret_post', 'DPoP', 'ES256', 'resource binding'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'oauth', async (f) => {
        const client = new AxMCPClient(transport(f, { oauth: {
          grantType: 'client_credentials', clientId: 'loopback-service-client', clientSecret: 'fixture-only-secret',
          tokenEndpointAuthMethod: 'client_secret_post', scopes: ['inventory.read'], dpop: {}, ssrfProtection: localProtection,
        } }), { namespace: 'machine', era: 'legacy' });
        try {
          await client.init(); const result = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
          assert.deepEqual(f.grants, ['client_credentials']); assert(f.proofCount > 0);
          assert(f.authHeaders.some((header) => header.startsWith('DPoP ')));
          return { grant: f.grants[0], verifiedDPoPProofs: f.proofCount, result: result.structuredContent,
            scope: 'TypeScript public transport; generated clients support client credentials but not this DPoP option.' };
        } finally { await client.close(); }
      }, { dpop: true });
    },
  },
  {
    id: '29-mcp-oauth/dynamic-registration-par-rar', title: 'Use dynamic registration, pushed authorization and rich authorization details',
    features: ['MCP OAuth', 'DCR', 'registrationStore', 'PAR', 'RAR', 'PKCE'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'oauth', async (f) => {
        const registrations = new Map<string, { client_id: string; token_endpoint_auth_method?: 'none' }>();
        const client = new AxMCPClient(transport(f, { oauth: {
          redirectUri: `${f.origin}/callback`, tokenEndpointAuthMethod: 'none', scopes: ['inventory.read'], ssrfProtection: localProtection,
          usePAR: true, authorizationDetails: details,
          registrationStore: { getRegistration: (issuer) => registrations.get(issuer) ?? null,
            setRegistration: (issuer, registration) => { assert.equal(registration.token_endpoint_auth_method, 'none'); registrations.set(issuer, { client_id: registration.client_id, token_endpoint_auth_method: 'none' }); } },
          onAuthCode: async (url) => { assert(new URL(url).searchParams.has('request_uri')); assert(!new URL(url).searchParams.has('code_challenge')); return f.authorize(url); },
        } }), { namespace: 'registered', era: 'legacy' });
        try {
          await client.init(); const result = await client.callTool('lookup', { sku: 'SKU-42' });
          assert(f.paths.includes('/register') && f.paths.includes('/par'));
          assert.equal(registrations.get(f.origin)?.client_id, 'loopback-public-client');
          return { registrationCount: registrations.size, pushedAuthorization: true, richAuthorizationDetails: details, result: result.structuredContent,
            scope: 'TypeScript-only advanced OAuth; this fixture does not establish authorization-server interoperability.' };
        } finally { await client.close(); registrations.clear(); }
      }, { par: true, dynamic: true });
    },
  },
  {
    id: '29-mcp-oauth/state-issuer-and-advanced-controls', title: 'Fail closed on state/issuer mismatch and missing advanced prerequisites',
    features: ['MCP OAuth', 'state rejection', 'issuer rejection', 'PAR control', 'mTLS control', 'JWT client-auth control', 'CIMD control', 'JAR policy', 'enterprise control', 'SSRF'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'oauth', async (f) => {
        const base: AxMCPOAuthOptions = { clientId: 'loopback-public-client', tokenEndpointAuthMethod: 'none', scopes: ['inventory.read'], redirectUri: `${f.origin}/callback`, ssrfProtection: localProtection,
          onAuthCode: (url) => f.authorize(url) };
        const policies: readonly [string, AxMCPOAuthOptions, RegExp][] = [
          ['state', { ...base, onAuthCode: async (url) => ({ ...await f.authorize(url), state: 'attacker-state' }) }, /state mismatch/],
          ['issuer', { ...base, onAuthCode: async (url) => ({ ...await f.authorize(url), iss: 'https://wrong-issuer.invalid' }) }, /issuer mismatch/],
          ['PAR', { ...base, usePAR: true }, /PAR required/],
          ['mTLS', { ...base, mtls: { fetch: f.fetch, requireCertificateBoundAccessTokens: true } }, /certificate-bound/],
          ['private_key_jwt', { ...base, grantType: 'client_credentials', tokenEndpointAuthMethod: 'private_key_jwt' }, /requires createClientAssertion/],
          ['JAR-policy', { ...base, createAuthorizationRequestJWT: async (claims) => {
            assert.equal(claims.resource, f.endpoint);
            throw new Error('Host policy forbids signing for this issuer');
          } }, /Host policy forbids signing/],
          ['enterprise-prerequisite', { ...base, enterpriseManagedAuthorization: {} }, /Enterprise authorization requires/],
          ['CIMD', { ...base, clientId: undefined, clientMetadataDocumentUrl: `${f.origin}/client.json` }, /must be HTTPS/],
        ];
        const rejected: string[] = [];
        for (const [name, oauth, expected] of policies) {
          const authorizationsBefore = f.paths.filter((path) => path === '/authorize').length;
          if (name === 'CIMD') f.metadata.client_id_metadata_document_supported = true;
          const client = new AxMCPClient(transport(f, { oauth }), { namespace: 'rejected', era: 'legacy' });
          try {
            await assert.rejects(client.init(), expected);
            if (name === 'state' || name === 'issuer') {
              assert.equal(f.paths.filter((path) => path === '/authorize').length, authorizationsBefore + 1, 'Mismatch must be rejected after the real authorization handoff');
            }
            rejected.push(name);
          }
          finally { await client.close(); }
        }
        const secured = new AxMCPClient(new AxMCPStreamableHTTPTransport(f.endpoint, { retry: false, timeoutMs: 1000 }), { namespace: 'ssrf', era: 'legacy' });
        try { await assert.rejects(secured.init(), /HTTPS|loopback|SSRF/i); rejected.push('SSRF-default'); }
        finally { await secured.close(); }
        assert.equal(f.grants.length, 0, 'Rejected authorization never exchanges a code');
        return { rejected, tokenExchanges: 0,
          scope: 'TypeScript controls only. Real mTLS requires a certificate-presenting host fetch; signed JAR/JWT auth requires an approved signer. Revocation/introspection are not exercised: the public Ax25.4.9 HTTP transport and OAuth options expose no corresponding methods.' };
      });
    },
  },
  {
    id: '29-mcp-oauth/authenticated-subscriptions', title: 'Listen to authenticated modern SSE subscriptions and close owned resources',
    features: ['MCP', 'modern', 'Streamable HTTP', 'subscriptions/listen', 'SSE', 'events', 'bearer', 'lifecycle'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'bearer', async (f) => {
        const observed = Promise.withResolvers<string>();
        const client = new AxMCPClient(transport(f, { authentication: axMCPBearerAuthentication('fixture-bearer') }), {
          namespace: 'updates', onResourceUpdated: (uri) => { observed.resolve(uri); },
        });
        let listener: AxMCPListeningHandle | undefined;
        let subscribed = false;
        let timer: NodeJS.Timeout | undefined;
        try {
          await client.init(); assert.equal(client.getEra(), 'modern');
          await client.subscribeResource('inventory://policy'); subscribed = true;
          timer = setTimeout(() => { observed.reject(new Error('No subscribed resource update within fixture deadline')); }, 5000);
          listener = await client.startListening({ signal: f.signal, onError: (error) => { observed.reject(error); } });
          const [, uri] = await Promise.all([listener.ready, observed.promise]);
          assert.equal(uri, 'inventory://policy');
          assert(f.paths.includes('/mcp'));
          return { era: client.getEra(), subscribed: client.getResourceSubscriptions(), event: 'inventory://policy',
            proof: 'Actual authenticated POST/SSE acknowledgement and notification. Callback observes only; application event-runtime routing/identity owns any later model wakeup.' };
        } finally {
          clearTimeout(timer);
          try {
            // Release only an acquired subscription, while the client still
            // owns its negotiated era/capabilities. Never mask an init failure.
            if (subscribed) await client.unsubscribeResource('inventory://policy');
          } finally {
            try { await listener?.close(); await listener?.done; }
            finally { await client.close(); }
          }
        }
      }, { modern: true });
    },
  },
  {
    id: '29-mcp-oauth/legacy-sse-bearer', title: 'Connect the explicitly legacy HTTP/SSE binding to an owned authenticated server',
    features: ['MCP', 'legacy HTTP/SSE', 'endpoint negotiation', 'bearer', 'resource subscription', 'lifecycle'], modes: ['offline'],
    async run(ctx) {
      return withOAuthFixture(ctx, 'bearer', async (f) => {
        const observed = Promise.withResolvers<string>();
        let closing = false;
        let streamDone: Promise<PromiseSettledResult<void> & { closedByHost?: boolean }> | undefined;
        // Ax25.4.9's legacy binding exposes the existing connection through
        // startListening(). Own that promise as soon as connect succeeds:
        // close() aborts its reader, whose done rejection otherwise goes unhandled.
        const legacy = new (class extends AxMCPHTTPSSETransport {
          override async connect(): Promise<void> {
            await super.connect();
            const listener = await super.startListening();
            streamDone = listener.done.then(
              () => ({ status: 'fulfilled' as const, value: undefined }),
              (reason: unknown) => ({ status: 'rejected' as const, reason, closedByHost: closing }),
            );
          }
        })(`${f.origin}/sse`, {
          authentication: axMCPBearerAuthentication('fixture-bearer'),
          ssrfProtection: localProtection, timeoutMs: 5000, retry: false, fetch: f.fetch,
        });
        const client = new AxMCPClient(legacy, { namespace: 'legacy_sse', era: 'legacy',
          onResourceUpdated: (uri) => { observed.resolve(uri); } });
        let timer: NodeJS.Timeout | undefined;
        let structuredContent: unknown;
        let streamFailed = false;
        let streamFailure: unknown;
        try {
          await client.init();
          const result = await client.callTool('lookup', { sku: 'SKU-42' });
          assert.deepEqual(result.structuredContent, { sku: 'SKU-42', quantity: 7 });
          await client.subscribeResource('inventory://policy');
          timer = setTimeout(() => { observed.reject(new Error('Legacy SSE update deadline exceeded')); }, 5000);
          assert.equal(await observed.promise, 'inventory://policy');
          await client.unsubscribeResource('inventory://policy');
          structuredContent = result.structuredContent;
        } finally {
          clearTimeout(timer);
          closing = true;
          try { await client.close(); }
          finally {
            const outcome = await streamDone;
            if (outcome?.status === 'rejected' &&
              !(outcome.closedByHost && outcome.reason instanceof Error && outcome.reason.name === 'AbortError')) {
              streamFailed = true;
              streamFailure = outcome.reason;
            }
          }
        }
        if (streamFailed) throw streamFailure;
        return { binding: 'legacy HTTP/SSE', result: structuredContent, resourceUpdate: true,
          proof: 'Real authenticated GET endpoint negotiation plus POST requests and SSE notification. New remote deployments should select Streamable HTTP instead.' };
      }, { legacySSE: true });
    },
  },
];
