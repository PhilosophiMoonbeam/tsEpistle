import assert from 'node:assert/strict';
import {
  agent, ax, AxMCPClient, AxMCPProtocolError, AxMCPWebSocketTransport,
  type AxMCPJSONRPCMessage, type AxMCPJSONRPCNotification,
  type AxMCPJSONRPCRequest, type AxMCPJSONRPCResponse,
  type AxMCPRequestOptions, type AxMCPTask, type AxMCPTool,
  type AxMCPTransport, type AxMCPWebSocketLike,
} from '@ax-llm/ax';
import { AxMCPStdioTransport } from '@ax-llm/ax-tools';
import { options, scriptedAI, type Example } from './support.js';

/** Application-owned JSON-RPC binding, not a replacement for Ax's MCP client.
 * The fixture is deterministic remote data; it proves protocol behavior, not
 * server trustworthiness or model quality. Every unsupported method errors.
 */
export class LocalMCPPeer implements AxMCPTransport {
  readonly evaluationMode = 'sandbox' as const;
  readonly requests: Readonly<AxMCPJSONRPCRequest>[] = [];
  readonly notifications: Readonly<AxMCPJSONRPCNotification>[] = [];
  readonly tasks = new Map<string, AxMCPTask>();
  readonly subscriptions = new Set<string>();
  closed = false;
  tools: AxMCPTool[] = [
    { name: 'lookup', description: 'Read an inventory item by SKU', inputSchema: {
      type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'],
    }, annotations: { readOnlyHint: true } },
    { name: 'delete', description: 'Delete inventory (fixture only)', inputSchema: { type: 'object' },
      annotations: { destructiveHint: true } },
    { name: 'failure', description: 'Report a domain-level tool error', inputSchema: { type: 'object' } },
    { name: 'reindex', description: 'Reindex after explicit approval', inputSchema: { type: 'object' } },
  ];
  handler?: (message: Readonly<AxMCPJSONRPCMessage>) => void | Promise<void>;
  // Host examples supply additional real JSON-RPC method behavior here.
  intercept?: (request: Readonly<AxMCPJSONRPCRequest>) => unknown | undefined;
  constructor(readonly modern = false) {}
  setMessageHandler(handler: NonNullable<LocalMCPPeer['handler']>): void { this.handler = handler; }
  async emit(method: string, params: Record<string, unknown>): Promise<void> {
    assert(!this.closed, 'peer is closed');
    assert(this.handler, 'Ax must install its inbound handler');
    await this.handler({ jsonrpc: '2.0', method, params });
  }
  async sendNotification(message: Readonly<AxMCPJSONRPCNotification>): Promise<void> {
    assert(!this.closed, 'peer is closed');
    if (!['notifications/initialized', 'notifications/cancelled', 'notifications/roots/list_changed'].includes(message.method)) {
      throw new Error(`Unsupported fixture notification ${message.method}`);
    }
    this.notifications.push(structuredClone(message));
  }
  async send(request: Readonly<AxMCPJSONRPCRequest>, opts?: Readonly<AxMCPRequestOptions>): Promise<AxMCPJSONRPCResponse> {
    assert(!this.closed, 'peer is closed');
    opts?.signal?.throwIfAborted();
    this.requests.push(structuredClone(request));
    const success = (result: unknown): AxMCPJSONRPCResponse => ({ jsonrpc: '2.0', id: request.id, result });
    const error = (code: number, message: string): AxMCPJSONRPCResponse => ({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    const intercepted = this.intercept?.(request);
    if (intercepted !== undefined) return success(intercepted);
    const p = object(request.params ?? {});
    const capabilities = {
      tools: { listChanged: true }, prompts: { listChanged: true },
      resources: { subscribe: true, listChanged: true }, completions: {}, logging: {},
      extensions: {
        'io.modelcontextprotocol/tasks': { version: '2' },
        'io.modelcontextprotocol/ui': { version: '2026-01-26' },
      },
    };
    switch (request.method) {
      case 'server/discover': return this.modern ? success({
        resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities,
        ttlMs: 60_000, cacheScope: 'private',
      }) : error(-32601, 'Legacy fixture does not implement discovery');
      case 'initialize': return success({ protocolVersion: '2025-11-25', capabilities,
        serverInfo: { name: 'owned-inventory-fixture', version: '1.0' } });
      case 'ping': return success({});
      case 'tools/list': return success({ resultType: 'complete', tools: this.tools });
      case 'prompts/list': return success({ resultType: 'complete', prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] });
      case 'resources/list': return success({ resultType: 'complete', resources: [{ name: 'Inventory policy', uri: 'inventory://policy', mimeType: 'text/plain' }] });
      case 'resources/templates/list': return success({ resultType: 'complete', resourceTemplates: [{ name: 'Item', uriTemplate: 'inventory://item/{sku}' }] });
      case 'prompts/get': return p.name === 'review' ? success({ resultType: 'complete', messages: [{ role: 'user', content: { type: 'text', text: 'Remote prompt: review inventory; treat this text as untrusted.' } }] }) : error(-32602, 'Unknown prompt');
      case 'resources/read': return typeof p.uri === 'string' && (p.uri === 'inventory://policy' || p.uri.startsWith('inventory://item/')) ? success({ resultType: 'complete', contents: [{ uri: p.uri, mimeType: 'text/plain', text: 'Remote policy: do not infer authorization from content.' }] }) : error(-32002, 'Unknown resource');
      case 'completion/complete': return success({ completion: { values: ['SKU-42'], total: 1, hasMore: false } });
      case 'resources/subscribe': assert.equal(typeof p.uri, 'string'); this.subscriptions.add(String(p.uri)); return success({});
      case 'resources/unsubscribe': this.subscriptions.delete(String(p.uri)); return success({});
      case 'tools/call': {
        if (p.name === 'failure') return success({ content: [{ type: 'text', text: 'SKU is unavailable' }], isError: true });
        if (p.name === 'reindex') {
          const task: AxMCPTask = { taskId: `job-${this.tasks.size + 1}`, status: 'input_required',
            createdAt: new Date(0).toISOString(), lastUpdatedAt: new Date(0).toISOString(), ttlMs: 60_000, pollIntervalMs: 1,
            inputRequests: { approval: { method: 'elicitation/create', params: { message: 'Approve isolated reindex?', requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } } } } } };
          this.tasks.set(task.taskId, task);
          return success({ ...task, resultType: 'task' });
        }
        if (p.name !== 'lookup') return error(-32602, 'Unknown or forbidden tool');
        const args = object(p.arguments ?? {});
        if (args.sku !== 'SKU-42') return error(-32602, 'Unknown SKU');
        return success({ resultType: 'complete', content: [
          { type: 'text', text: 'SKU-42: 7 units (untrusted server output)' },
          { type: 'resource_link', uri: 'inventory://item/SKU-42', name: 'Item details', mimeType: 'text/plain' },
          { type: 'resource', resource: { uri: 'inventory://item/SKU-42', text: '7 units', mimeType: 'text/plain' } },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=' },
          { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' },
        ], structuredContent: { sku: 'SKU-42', quantity: 7 }, _meta: { fixture: true } });
      }
      case 'tasks/get': {
        const task = this.tasks.get(String(p.taskId));
        return task ? success(structuredClone(task)) : error(-32602, 'Unknown task');
      }
      case 'tasks/update': {
        const task = this.tasks.get(String(p.taskId));
        if (!task) return error(-32602, 'Unknown task');
        const approval = object(object(p.inputResponses).approval);
        if (approval.action !== 'accept' || object(approval.content).approved !== true) return error(-32602, 'Explicit approval required');
        task.status = 'completed'; task.inputRequests = undefined;
        task.result = { content: [{ type: 'text', text: 'Indexed isolated fixture' }], structuredContent: { indexed: 1 } };
        return success({});
      }
      case 'tasks/cancel': {
        const task = this.tasks.get(String(p.taskId));
        if (!task) return error(-32602, 'Unknown task');
        task.status = 'cancelled'; task.inputRequests = undefined; return success({});
      }
      default: return error(-32601, `Unsupported method ${request.method}`);
    }
  }
  close(): void { this.closed = true; this.subscriptions.clear(); }
}

export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected protocol object');
  return value as Record<string, unknown>;
}

export const examples: readonly Example[] = [
  {
    id: '19-mcp/catalog-raw-errors', title: 'Own a namespaced client, inspect catalogs and retain native results',
    features: ['MCP', 'custom transport', 'catalog', 'prompts', 'resources', 'completion', 'authorization', 'multimodal', 'subscriptions', 'events', 'lifecycle'], modes: ['offline'],
    async run(ctx) {
      const peer = new LocalMCPPeer();
      const events: string[] = [];
      const client = new AxMCPClient(peer, { namespace: 'inventory', maxConcurrency: 2,
        authorizeToolCall: ({ tool }) => tool.annotations?.destructiveHint !== true });
      const unsubscribe = client.subscribeEvents((event) => { events.push(event.type); });
      try {
        const catalog = await client.inspectCatalog();
        assert.equal(client.getEra(), 'legacy'); assert.equal(catalog.namespace, 'inventory');
        assert.equal(catalog.resourceTemplates[0]?.uriTemplate, 'inventory://item/{sku}');
        const changed = structuredClone(catalog); changed.tools[0]!.description = 'tampered';
        assert.notEqual(client.getTools()[0]?.description, 'tampered');
        const before = peer.requests.length;
        await assert.rejects(client.callTool('delete', {}, { signal: ctx.signal }), /denied|authoriz/i);
        assert.equal(peer.requests.length, before, 'Denied tool never reaches the wire');
        const result = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
        assert.deepEqual(result.structuredContent, { sku: 'SKU-42', quantity: 7 });
        assert.deepEqual(result.content?.map((c) => c.type), ['text', 'resource_link', 'resource', 'image', 'audio']);
        assert.equal((await client.callTool('failure')).isError, true);
        assert((await client.getPrompt('review', { topic: 'inventory' })).messages.length > 0);
        assert((await client.readResource('inventory://policy')).contents.length > 0);
        await assert.rejects(client.getPrompt('missing'), AxMCPProtocolError);
        await assert.rejects(client.readResource('inventory://missing'), AxMCPProtocolError);
        assert.deepEqual((await client.complete({ type: 'ref/resource', uri: 'inventory://item/{sku}' }, { name: 'sku', value: 'SKU' })).completion.values, ['SKU-42']);
        await client.acquireResourceSubscription('inventory://policy', 'panel');
        await client.subscribeResource('inventory://policy');
        await client.releaseResourceSubscription('inventory://policy', 'panel');
        assert(peer.subscriptions.has('inventory://policy'), 'Manual owner still holds subscription');
        await peer.emit('notifications/resources/updated', { uri: 'inventory://policy' });
        await peer.emit('notifications/progress', { progressToken: 'read-1', progress: 1, total: 1 });
        await peer.emit('notifications/message', { level: 'info', data: 'Observed; no model call in callbacks' });
        await client.unsubscribeResource('inventory://policy'); assert.equal(peer.subscriptions.size, 0);
        peer.tools = [...peer.tools, { name: 'new_lookup', inputSchema: { type: 'object' } }];
        await peer.emit('notifications/tools/list_changed', {});
        const fresh = await client.inspectCatalog({ refresh: true });
        assert(fresh.tools.some((tool) => tool.name === 'new_lookup'));
        await client.ping(1000);
        assert(events.includes('resource_updated') && events.includes('progress') && events.includes('logging'));
        return { namespace: catalog.namespace, tools: fresh.tools.map((t) => t.name), structuredContent: result.structuredContent, events, proof: 'Native parsing/catalog/authorization only; remote content remains untrusted.' };
      } finally { unsubscribe(); await client.close(); assert(peer.closed); }
    },
  },
  {
    id: '19-mcp/function-overrides', title: 'Rename an old function-wrapper view without renaming the MCP server tool',
    features: ['MCP', 'functionOverrides', 'legacy function compatibility', 'catalog', 'structured results', 'lifecycle'], modes: ['offline'],
    async run(ctx) {
      const peer = new LocalMCPPeer();
      let client: AxMCPClient | undefined;
      const authorizedNames: string[] = [];
      const description = 'Check available inventory before promising an order';
      try {
        client = new AxMCPClient(peer, {
          namespace: 'inventory',
          functionOverrides: [{ name: 'lookup', updates: { name: 'checkStock', description } }],
          authorizeToolCall: ({ tool }) => {
            authorizedNames.push(tool.name);
            return tool.name === 'lookup';
          },
        });
        const catalog = await client.inspectCatalog();
        const serverTool = catalog.tools.find((tool) => tool.name === 'lookup');
        assert(serverTool);
        assert.equal(client.getTools().find((tool) => tool.name === 'lookup')?.description, serverTool.description);
        assert(!catalog.tools.some((tool) => tool.name === 'checkStock'));
        assert.notEqual(serverTool.description, description);

        // Compatibility feature only: native integrations keep using `mcp`.
        // In Ax 25.4.9 these overrides affect toFunction() wrappers, not the
        // raw catalog or callTool() names; the wrapper also flattens content.
        const wrappers = client.toFunction();
        const checkStock = wrappers.find((tool) => tool.name === 'checkStock');
        assert(checkStock);
        assert.equal(checkStock.description, description);
        assert(!wrappers.some((tool) => tool.name === 'lookup'));
        const args = { sku: 'SKU-42' };
        const legacyDisplay = await checkStock.func(args);
        assert.equal(typeof legacyDisplay, 'string');

        // Keep structured inventory for application decisions via the native API.
        const native = await client.callTool('lookup', args, { signal: ctx.signal });
        const inventory = object(native.structuredContent);
        assert.deepEqual(inventory, { sku: 'SKU-42', quantity: 7 });
        assert(typeof legacyDisplay === 'string' && legacyDisplay.includes(JSON.stringify(inventory, null, 2)));
        assert.equal(typeof inventory.quantity, 'number');
        const canFulfill = typeof inventory.quantity === 'number' && inventory.quantity >= 5;
        assert(canFulfill, 'The structured quantity can fulfill the requested five units');
        assert.deepEqual(peer.requests.filter((request) => request.method === 'tools/call')
          .map((request) => object(request.params)), [
          { name: 'lookup', arguments: args }, { name: 'lookup', arguments: args },
        ]);
        assert.deepEqual(authorizedNames, ['lookup', 'lookup']);
        return { wrapperName: checkStock.name, serverName: serverTool.name, inventory, canFulfill,
          qualification: 'Constructor overrides rename and describe legacy toFunction() wrappers only in this case; raw MCP catalogs and native callTool names stay server-owned. The compatibility display is flattened, while native structuredContent remains an object.' };
      } finally {
        try { await client?.close(); } finally { peer.close(); }
        assert(peer.closed);
      }
    },
  },
  {
    id: '19-mcp/native-gen', title: 'Attach native MCP plus attributed resource context to Gen',
    features: ['MCP', 'Gen', 'native tools', 'mcpContext'], modes: ['offline', 'live'],
    async run(ctx) {
      const peer = new LocalMCPPeer();
      const client = new AxMCPClient(peer, { namespace: 'inventory', authorizeToolCall: ({ tool }) => tool.name === 'lookup' });
      try {
        const model = ctx.mode === 'live' ? ctx.ai : scriptedAI((request, index) => {
          if (index === 0) {
            const tool = request.functions?.find((f) => f.name.includes('lookup'));
            assert(tool, 'Native Ax tool definitions must reach the provider');
            return { results: [{ index: 0, functionCalls: [{ id: 'inventory-call', type: 'function', function: { name: tool.name, params: { sku: 'SKU-42' } } }] }] };
          }
          assert(JSON.stringify(request.chatPrompt).includes('SKU-42'));
          return { results: [{ index: 0, content: 'Answer: SKU-42 has 7 units.' }] };
        });
        const gen = ax('question:string -> answer:string', { mcp: client });
        const result = await gen.forward(model, { question: 'Use inventory lookup for SKU-42 and report the exact available units. Do not call other tools.' }, {
          ...options(ctx), mcpContext: [{ client: 'inventory', resource: { uri: 'inventory://policy' } }],
        });
        assert.match(result.answer, /7/);
        assert(peer.requests.some((r) => r.method === 'tools/call'));
        return { ...result, proof: 'Real Ax native tool loop over deterministic server; offline model output is scripted.' };
      } finally { await client.close(); }
    },
  },
  {
    id: '19-mcp/native-agent', title: 'Use the native MCP module in Agent executor code',
    features: ['MCP', 'Agent', 'native modules', 'mcpInheritance'], modes: ['offline', 'live'],
    async run(ctx) {
      const peer = new LocalMCPPeer();
      const client = new AxMCPClient(peer, { namespace: 'inventory', authorizeToolCall: ({ tool }) => tool.name === 'lookup' });
      try {
        const model = ctx.mode === 'live' ? ctx.ai : scriptedAI([
          { results: [{ index: 0, content: JSON.stringify({ javascriptCode: 'await final("Look up SKU-42 using mcp.inventory.tools.lookup and report units", {sku:"SKU-42"})' }) }] },
          { results: [{ index: 0, content: JSON.stringify({ javascriptCode: 'const item = await mcp.inventory.tools.lookup({sku:"SKU-42"}); await final("Report available units", {item});' }) }] },
          { results: [{ index: 0, content: 'Answer: SKU-42 has 7 units.' }] },
        ]);
        const assistant = agent('query:string -> answer:string', { mcp: [client], mcpInheritance: 'all',
          contextFields: [], directResponse: 'off' });
        const result = await assistant.forward(model, { query: 'Use the native inventory module to look up SKU-42. Report the quantity.' }, options(ctx));
        assert.match(result.answer, /7/);
        assert(peer.requests.some((r) => r.method === 'tools/call'));
        return { ...result, proof: 'Ax executor calls native MCP; fixture proves module plumbing, not model reliability.' };
      } finally { await client.close(); }
    },
  },
  {
    id: '19-mcp/modern-tasks', title: 'Discover Tasks v2, approve input, poll results, cancel and propagate abort',
    features: ['MCP', 'modern discovery', 'Tasks v2', 'input_required', 'progress', 'cancellation'], modes: ['offline'],
    async run(ctx) {
      const peer = new LocalMCPPeer(true);
      const states: string[] = [];
      const client = new AxMCPClient(peer, { namespace: 'jobs', onProgress: (p) => { states.push(`progress:${p.progress}`); } });
      const off = client.subscribeTaskStatus((task) => { states.push(task.status); });
      try {
        assert((await client.discover()).supportedVersions.includes('2026-07-28'));
        assert.equal(client.getEra(), 'modern'); assert(client.hasTasksCapability());
        const outcome = await client.callToolOutcome('reindex', {}, { signal: ctx.signal });
        assert.equal(outcome.kind, 'task'); if (outcome.kind !== 'task') throw new Error('Expected durable task');
        assert.equal((await client.getTask(outcome.task.taskId)).status, 'input_required');
        await client.provideTaskInput(outcome.task.taskId, { approval: { action: 'accept', content: { approved: true } } });
        await peer.emit('notifications/progress', { progressToken: outcome.task.taskId, progress: 1, total: 1 });
        const result = await client.waitForTask(outcome.task.taskId, { signal: ctx.signal, timeoutMs: 1000, defaultPollIntervalMs: 1 });
        assert.deepEqual(object(result).structuredContent, { indexed: 1 });
        const cancelled = await client.callToolOutcome('reindex');
        assert.equal(cancelled.kind, 'task'); if (cancelled.kind !== 'task') throw new Error('Expected task');
        await client.cancelTask(cancelled.task.taskId);
        assert.equal((await client.getTask(cancelled.task.taskId)).status, 'cancelled');
        await assert.rejects(client.waitForTask(cancelled.task.taskId, { timeoutMs: 1000 }), /cancel/i);
        await assert.rejects(client.listTasks(), /legacy|modern/i);
        const controller = new AbortController(); controller.abort(new Error('Owner cancelled before dispatch'));
        await assert.rejects(client.callTool('lookup', { sku: 'SKU-42' }, { signal: controller.signal }), /cancel/i);
        assert(states.includes('completed') && states.includes('cancelled') && states.includes('progress:1'));
        return { era: client.getEra(), result, states, proof: 'Tasks are isolated in memory; no external reindex or resumable production queue.' };
      } finally { off(); await client.close(); }
    },
  },
  {
    id: '19-mcp/namespace-collision', title: 'Reject duplicate native client namespaces before model execution',
    features: ['MCP', 'namespace', 'collision', 'preflight'], modes: ['offline'],
    async run(ctx) {
      const first = new AxMCPClient(new LocalMCPPeer(), { namespace: 'duplicate' });
      const second = new AxMCPClient(new LocalMCPPeer(), { namespace: 'duplicate' });
      let modelCalls = 0;
      const model = scriptedAI(() => { modelCalls++; throw new Error('Model must not be reached'); });
      try {
        await assert.rejects(async () => {
          const gen = ax('question:string -> answer:string', { mcp: [first, second] });
          await gen.forward(model, { question: 'Read SKU-42' }, options(ctx));
        }, /Duplicate MCP client namespace/);
        assert.equal(modelCalls, 0);
        return { duplicateNamespace: 'rejected', modelCalls };
      } finally { await first.close(); await second.close(); }
    },
  },
  {
    id: '19-mcp/stdio-and-windows-scope', title: 'Own a Node stdio server; qualify Windows command configuration',
    features: ['MCP', 'stdio', 'ax-tools', 'child lifecycle', 'Windows configuration'], modes: ['offline'],
    async run(ctx) {
      // Child gets no inherited application credentials and owns no files.
      // This is an actual newline-delimited JSON-RPC server, not an MCP SDK.
      const source = `
        import { createInterface } from 'node:readline';
        const lines = createInterface({ input: process.stdin });
        lines.on('line', line => {
          const request = JSON.parse(line);
          if (!Object.hasOwn(request, 'id')) {
            if (request.method !== 'notifications/initialized') process.exitCode = 1;
            return;
          }
          let result;
          if (request.method === 'initialize') result = {
            protocolVersion: '2025-11-25', capabilities: { tools: {} },
            serverInfo: { name: 'owned-stdio-fixture', version: '1.0' }
          };
          else if (request.method === 'tools/list') result = { tools: [{
            name: 'lookup', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] }
          }] };
          else if (request.method === 'tools/call' && request.params.name === 'lookup' && request.params.arguments.sku === 'SKU-42')
            result = { content: [{type:'text', text:'SKU-42 has 7 units'}], structuredContent: {sku:'SKU-42',quantity:7} };
          else if (request.method === 'ping') result = {};
          const response = result === undefined
            ? { jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'Unsupported fixture operation'} }
            : { jsonrpc:'2.0', id:request.id, result };
          process.stdout.write(JSON.stringify(response) + '\\n');
        });
      `;
      const stdio = new AxMCPStdioTransport({ command: process.execPath, args: ['--input-type=module', '-e', source], env: {} });
      const client = new AxMCPClient(stdio, { namespace: 'local_node', era: 'legacy' });
      try {
        await client.init();
        const result = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
        assert.deepEqual(result.structuredContent, { sku: 'SKU-42', quantity: 7 });
        await client.ping(1000);
        const windowsConfig = {
          command: 'npx.cmd', args: ['--no-install', 'owned-mcp-server'],
          envRequirements: ['PATH', 'PATHEXT', 'ComSpec'],
        };
        return { result: result.structuredContent, platform: process.platform, windowsConfig,
          windowsQualification: 'Configuration only: .cmd routing uses effective child PATH/PATHEXT/ComSpec. This case does not execute Windows commands or qualify Windows behavior on Linux.' };
      } finally {
        try { await client.close(); } finally { await stdio.terminate(); }
      }
    },
  },
  {
    id: '19-mcp/websocket-binding', title: 'Run real Ax WebSocket framing through a custom in-memory socket binding',
    features: ['MCP', 'WebSocket', 'custom factory', 'text frames', 'binary frames', 'abort', 'send failure', 'batch gate', 'owned close'], modes: ['offline'],
    async run(ctx) {
      const peer = new LocalMCPPeer();
      const listeners = new Map<string, { callback: (event: unknown) => void; once: boolean }[]>();
      const dispatch = (type: string, event: unknown) => {
        const current = [...(listeners.get(type) ?? [])];
        listeners.set(type, current.filter((entry) => !entry.once));
        for (const entry of current) entry.callback(event);
      };
      let frames = 0, failNextSend = false;
      const socket: AxMCPWebSocketLike = {
        readyState: 0,
        addEventListener(type, callback, opts) {
          const current = listeners.get(type) ?? [];
          current.push({ callback, once: opts?.once === true }); listeners.set(type, current);
        },
        send(data) {
          if (failNextSend) { failNextSend = false; throw new Error('Owned socket send failure'); }
          const p = object(JSON.parse(data));
          assert(typeof p.method === 'string');
          if (!Object.hasOwn(p, 'id')) {
            void peer.sendNotification({ jsonrpc: '2.0', method: p.method, params: object(p.params ?? {}) })
              .catch((error: unknown) => { dispatch('error', error); });
            return;
          }
          assert(typeof p.id === 'number' || typeof p.id === 'string');
          void peer.send({ jsonrpc: '2.0', id: p.id, method: p.method, params: p.params })
            .then((response) => {
              const payload = JSON.stringify(response); frames++;
              dispatch('message', { data: frames % 2 === 0 ? new TextEncoder().encode(payload).buffer : payload });
            }).catch((error: unknown) => { dispatch('error', error); });
        },
        close() { socket.readyState = 3; peer.close(); dispatch('close', {}); },
      };
      const transport = new AxMCPWebSocketTransport('ws://owned-fixture.invalid/mcp', {
        webSocketFactory: (url) => {
          assert.equal(url, 'ws://owned-fixture.invalid/mcp');
          queueMicrotask(() => { socket.readyState = 1; dispatch('open', {}); });
          return socket;
        },
      });
      const client = new AxMCPClient(transport, { namespace: 'socket', era: 'legacy' });
      try {
        await client.init(); assert.equal(socket.binaryType, 'arraybuffer');
        const result = await client.callTool('lookup', { sku: 'SKU-42' }, { signal: ctx.signal });
        assert.deepEqual(result.structuredContent, { sku: 'SKU-42', quantity: 7 }); assert(frames >= 2);
        await assert.rejects(transport.sendBatch([{ jsonrpc: '2.0', id: 'batch', method: 'ping' }]), /batching is not allowed/);
        failNextSend = true;
        await assert.rejects(transport.send({ jsonrpc: '2.0', id: 'recoverable', method: 'ping' }), /send failure/);
        assert('result' in await transport.send({ jsonrpc: '2.0', id: 'recoverable', method: 'ping' }), 'Send failure must release the active request ID');
        const cancelled = new AbortController(); cancelled.abort(new Error('Owner aborted socket request'));
        await assert.rejects(transport.send({ jsonrpc: '2.0', id: 'aborted', method: 'ping' }, { signal: cancelled.signal }), /aborted/);
        return { frames, result: result.structuredContent,
          proof: 'Actual Ax WebSocket transport framing/pending-request algorithms over an explicit in-memory public socket binding. This is not RFC6455 network interoperability or reconnect qualification.' };
      } finally { await client.close(); assert.equal(socket.readyState, 3); }
    },
  },
];
