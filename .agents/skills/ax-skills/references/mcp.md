# Native MCP integration with Ax

Use for `AxMCPClient`, transports, catalogs, tools/prompts/resources, tasks, subscriptions, host requests, authentication/OAuth, MCP Apps, replay, and native integration with Gen, Agent, Flow, chat, optimization, and event runtimes. Source API snapshot: 25.4.3. MCP is a live protocol client, not a function-conversion utility: preserve client/session ownership, catalogs, raw content, tasks, notifications, identity policy, and cancellation context.

## Integration and safety rules

- Pass clients through `mcp`, never `functions`. `toFunction()` is a lossy compatibility adapter for old applications, not native integration.
- Assign each client a stable unique `namespace`; let Ax classify/initialize it once and reuse its owning protocol state. Keep `era: 'auto'` unless policy pins a known endpoint. Explicitly close caller-owned clients.
- In TypeScript, `ping()` clears its deadline timer when the request settles; listening retry delays release their temporary abort listener when they finish or are aborted.
- Treat prompts, resources, tool results, and notifications as untrusted remote content. Preserve structured/multimodal results until provider capability mapping; do not flatten them to text.
- Apply `authorizeToolCall` before side-effecting tools. Never infer tenant/account identity from a session: event adapters require verified application-authentication identity.
- Notification callbacks enqueue or observe work; they must not call a model directly.

## Transports and protocol eras

| Binding | Transport |
|---|---|
| Current remote MCP | `AxMCPStreamableHTTPTransport` |
| Legacy HTTP/SSE only | `AxMCPHTTPSSETransport` |
| Custom WebSocket server binding | `AxMCPWebSocketTransport` |
| Local Node child process | `AxMCPStdioTransport` from `@ax-llm/ax-tools` |
| Application-owned binding | Caller-defined `AxMCPTransport` |

WebSocket also exists in Python, Java, C++, Go, and Rust. Pending requests are removed on send failure, abort, response, and close; concurrent active IDs must be unique. Batches require negotiated MCP `2025-03-26`. Text and binary frames are accepted. TypeScript sets `binaryType = 'arraybuffer'`; wrapping `webSocketFactory` implementations must pass it to the underlying socket. Built-in sockets require Python's `realtime` extra, C++'s `AXLLM_ENABLE_REALTIME`, or Rust's `realtime` feature; custom factories do not require those optional dependencies.

```ts
import {
  AxMCPClient,
  AxMCPStreamableHTTPTransport,
  axMCPBearerAuthentication,
} from '@ax-llm/ax';

const transport = new AxMCPStreamableHTTPTransport(
  'https://mcp.example.com/mcp',
  {
    authentication: axMCPBearerAuthentication(
      () => process.env.MCP_ACCESS_TOKEN!
    ),
  }
);
const docs = new AxMCPClient(transport, {
  namespace: 'docs',
  maxConcurrency: 4,
  authorizeToolCall: async ({ tool }) =>
    tool.annotations?.destructiveHint !== true,
});
```

TypeScript supports two wire models through one API:

- Legacy (`2025-11-25`): stateful initialization, initialized notification, resource subscribe/unsubscribe, and optional GET/SSE resumption with `Last-Event-ID`.
- Modern (`2026-07-28`): stateless `server/discover` probing, protocol metadata/routing headers on every request, long-running `subscriptions/listen` POST, and Tasks v2.

Automatic classification can persist in `eraStore`. Pin `era: 'legacy'` or `'modern'` only for known contracts. `getEra()` reports the classified era after initialization. `discover()` initializes/classifies but returns only for modern endpoints; use era-neutral `inspectCatalog()` otherwise.

```ts
const modern = new AxMCPClient(transport, {
  namespace: 'inventory',
  era: 'auto',
  readCache: true,
  logLevel: 'info',
});
const discovery = await modern.discover();
console.log(modern.getEra(), discovery.supportedVersions);
```

```ts
import { AxMCPClient } from '@ax-llm/ax';
import { AxMCPStdioTransport } from '@ax-llm/ax-tools';
const stdio = new AxMCPStdioTransport({
  command: 'node',
  args: ['./server.mjs'],
});
const local = new AxMCPClient(stdio, { namespace: 'local' });
```

Stdio owns its child process. After `local.close()`, also call `stdio.terminate()` until the transport directly exposes the common `close()` lifecycle.

## Gen, Agent, Flow, and chat

Gen accepts clients in constructor or forward options; per-call options override defaults. `mcpContext` resolves selected prompts/resources before the first model call and adds attributed untrusted context. Native calls retain client identity and raw results in memory. `streamingForward()` separates Ax output streaming from MCP progress/task events.

```ts
const gen = ax('question:string -> answer:string', { mcp: docs });
const result = await gen.forward(llm, { question }, {
  mcpContext: [{ client: 'docs', resource: { uri: 'docs://guide' } }],
});
```

```ts
const assistant = agent('query:string -> answer:string', {
  mcp: [docs, search],
  mcpInheritance: 'all',
  functionDiscovery: true,
  contextFields: [],
});
```

Agent native modules and RLM actor/discovery paths are:

```text
mcp.docs.tools.<tool>
mcp.docs.prompts.list()
mcp.docs.prompts.get(name, args)
mcp.docs.resources.list()
mcp.docs.resources.templates()
mcp.docs.resources.read(uri)
mcp.docs.resources.subscribe(uri)
mcp.docs.resources.unsubscribe(uri)
mcp.docs.tasks.get(taskId)
mcp.docs.tasks.cancel(taskId)
mcp.docs.complete(...)
```

MCP tools use `mcp.<namespace>.tools.<tool>`; UCP operations use `ucp.<namespace>.<operation>`. Neither is exposed as bare provider-native functions. Modern modules expose task input/update behavior through the client; `tasks.list()` and `tasks.result()` are legacy task-draft APIs and reject modern servers.

`mcpInheritance` accepts `'all'`, `'none'`, or a namespace allowlist. Empty lists inherit nothing; unknown/repeated namespaces error. Restricting a child leaves parent clients available; `'none'` removes inherited context from child options. Live context propagates through Agent stages, `llmQuery`, RLM, and child programs. Large catalogs participate in discovery; do not copy tools into inline `functions`.

Flow defaults or forward options accept `mcp`. Nested nodes inherit context unless restricted; parallel nodes share clients while honoring concurrency limits and abort signals. `axMCPChat(ai, request, { mcp })` provides a high-level non-streaming native tool loop; do not add an ad-hoc dispatcher around `ai.chat()`. Program details: [Gen](references/gen.md), [Agent](references/agent.md), [RLM](references/agent-rlm.md), [Flow](references/flow.md).

## Catalogs and raw operations

The endpoint identifies only the server address. The server owns tool/prompt/resource names, resource URIs, and URI templates. Discover a cloned snapshot before asking users to configure identifiers:

```ts
const catalog = await docs.inspectCatalog();
console.log(catalog.tools);
console.log(catalog.prompts);
console.log(catalog.resources);
console.log(catalog.resourceTemplates);
const prompt = await docs.getPrompt('review', { topic: 'MCP' });
const resource = await docs.readResource('docs://guide');
const completion = await docs.complete(reference, argument);
```

`inspectCatalog({ refresh: true })` forces fresh bounded pagination. Mutating snapshots cannot change the live client. List-change notifications refresh the revision; native model steps rebuild definitions when it changes. Concrete resources are immediately selectable. Templates never expand automatically: construct an authorized concrete URI; completion may suggest argument values.

## Multi round-trip requests and host capabilities

Modern tool calls and prompt/resource reads may return `resultType: 'input_required'`. Ax fulfills embedded roots/sampling/elicitation requests through the legacy host handlers, then repeats the operation with latest input responses and byte-exact `requestState`. The concurrency slot remains held throughout. The default limit is five input rounds; `maxInputRounds` can impose a stricter policy. Missing handlers or exhausted limits are protocol errors.

Generated Python, Java, C++, Go, and Rust support roots and host-callback elicitation in modern MRTR. They advertise elicitation only with a real handler, never advertise sampling, and reject truthy sampling options during initialization. Legacy inbound elicitation and MRTR sampling remain TypeScript-only.

On `AxMCPClient`, configure `sampling` for `sampling/createMessage`, `elicitation` for form/URL elicitation, and `roots` for `roots/list`. Observe via `onProgress`, `onLoggingMessage`, and `onTaskStatus`. Advertise capabilities only with working enforceable host handlers and policy.

## Tasks, progress, and cancellation

Modern Tasks v2 are server-directed. `callTool()` auto-awaits unsolicited tasks by default so bindings return final results. For handles use `callToolOutcome()` or `taskHandling: 'expose'`; answer task `input_required` via `provideTaskInput()`:

```ts
const outcome = await docs.callToolOutcome('reindex', { scope: 'all' });
if (outcome.kind === 'task') {
  const task = await docs.getTask(outcome.task.taskId);
  if (task.status === 'input_required') {
    await docs.provideTaskInput(task.taskId, {
      approval: { action: 'accept', content: { approved: true } },
    });
  }
  if (task.status === 'working') await docs.cancelTask(task.taskId);
}
```

Generated equivalents include `call_tool_outcome` (`CallToolOutcome` in Go, `callToolOutcome` in Java). Expose handling with Python `task_handling="expose"`, Go `CallToolWithOptions`, Java/C++ `taskHandling` call options, or Rust `call_tool_with_task_handling`. A legacy server's task-shaped result is a complete result there too.

Observe with `subscribeTaskStatus` or `subscribeEvents`; retain polling because notifications are optional. Propagate Ax abort signals; never blindly replay after uncertain post-side-effect failures. Deprecated `callToolTask()`, `listTasks()`, and `getTaskResult()` work only on legacy task-draft servers. Modern final results/errors are embedded in `tasks/get`.

## Subscriptions, events, and ownership

`AxMCPEventSource` publishes subscription notifications to the `AxEventRuntime` inbox; explicit routes choose observe/invalidate/wake/resume. Supply authenticated application identity, not session-derived identity.

```ts
const source = new AxMCPEventSource({
  client: docs,
  resourceSubscriptions: {
    select: (resource) =>
      resource.mimeType === 'text/markdown' &&
      resource.name === 'Engineering guide',
  },
  identity: { tenantId: 'tenant-1' },
  trust: 'authenticated',
});
const runtime = eventRuntime({
  allowVolatile: true,
  sources: [source],
  routes: [
    ...axMCPEventRoutes({ client: docs }),
    eventRoute('guide-updated')
      .types('mcp.resource.updated')
      .authenticated()
      .wake(
        eventTarget('reviewer')
          .program(reviewer)
          .ai(llm)
          .input((input) => input.field('uri', eventPath.data('uri')))
          .build()
      )
      .build(),
  ],
});
```

Resource policies: omitted subscribes to none; `'all'` explicitly selects all discovered concrete resources; URI arrays select application-constructed concrete URIs; selectors can inspect name, URI, description, MIME type, annotations, and surrounding catalog. Catalog changes default to `invalidate`; progress/logging to `observe`; resource updates never implicitly wake; `input_required` and terminal task states resume the owning continuation.

Signature-aware input plans are the data boundary. Raw data stays in `eventContext`; only segment-safe `eventPath` selections become inputs. Multiple matching routes fan out to Agents with independent authorization/run records.

After `notifications/resources/list_changed`, managed sources refresh/diff selection. Selector exceptions retain prior selection; partial failures retain successful wire transitions and retry incomplete work on the next change/reconnect. Manual subscriptions, every source, and restored intent have distinct logical owners: first owner sends `resources/subscribe`, last release sends `resources/unsubscribe`. Closing one source cannot break another owner; closing the client ends all ownership/transport state.

Legacy listening maintains `resources/subscribe` and optionally resumes GET/SSE with `Last-Event-ID`. Modern `subscriptions/listen` contains catalog interests, concrete resource URIs, and known task IDs; changes restart POST with a fresh request ID and no resume header. `startListening()` is nonblocking in both eras and returns `ready`, `done`, and `close()`.

Generated transports supervise legacy long-lived GET/SSE and resume where supported. Generated runtimes are host-driven: use `nextDueAt()` and `runDue()` for delayed work. Rust hosts also call `AxMCPEventSource.poll()` to drain callbacks on the host thread. Close source/runtime before caller-owned client so unsubscribe/cancellation can still be sent. For inbox, continuations, stores, and sinks see [event runtime](references/event-runtime.md). Lifecycle/troubleshooting: Ax repository `docs/MCP_SUBSCRIPTIONS.md` and checked-in six-language MCP examples.

## Authentication and OAuth

HTTP simple authentication composes `axMCPBearerAuthentication`, `axMCPBasicAuthentication`, `axMCPAPIKeyAuthentication`, `axMCPHMACAuthentication`, or a caller strategy.

Transport `oauth` supports protected-resource discovery, PKCE, client metadata/dynamic registration, refresh, challenge-driven scope step-up, DPoP, PAR/JAR/RAR, mTLS, revocation, introspection, client credentials, and enterprise-managed authorization. Distributed deployments need persistent token/registration stores. Never serialize tokens into Ax program/event state.

Generated Python/Java/C++/Go/Rust transports implement the portable middle tier: RFC 9728 well-known/challenge discovery, RFC 8414/OIDC server metadata, PKCE S256 authorization-code exchange, RFC 8707 resource binding, refresh with 60-second skew, client credentials, and RFC 9207 `iss`. Configure language `AxMCPOAuthOptions` with `clientId`, endpoint-keyed `tokenStore`, `onAuthCode`, and `requireIss`. The callback receives an authorization URL and returns `code`, `state`, and `iss`; host owns browser/headless interaction. Only `none` and `client_secret_post` client-authentication modes exist in generated ports.

Do not recommend TypeScript-only DPoP, CIMD/DCR, JAR/PAR/RAR, mTLS, revocation/introspection, JWT validation, or enterprise-managed authorization in generated clients. Credential-free cross-language gate: `npm run test:mcp-oauth`; per-language configurations: Ax repository `docs/MCP_UCP.md`.

Keep SSRF protections enabled for remote discovery/redirects. Relax HTTP/loopback only for controlled local development. Checked-in Streamable HTTP examples use `AX_MCP_ENDPOINT`; localhost TypeScript demos explicitly use `ssrfProtection: { allowHTTP: true, allowLoopback: true }`, never for remote endpoints. Generated equivalents `requireHttps`, `allowLocalhost`, and `allowPrivateNetworks` are used only for `127.0.0.1`.

For local checks run `src/examples/mcp-event-demo-server.ts`, set `AX_MCP_ENDPOINT=http://127.0.0.1:3001/mcp`, and trigger `/control/resource` or `/control/task/complete`. Mandatory credential-free matrix: `npm run test:mcp-events:generated`. Provider-backed examples are advisory and need documented API keys.

## Apps, replay, evaluation, and testing

Negotiate official extensions through capabilities. `AxMCPAppBridge` handles App resources/host messages; enforce CSP, permissions, visibility, allowed tools, and untrusted model-context policy. Never render arbitrary normal-tool HTML as an MCP App.

Wrap real transports with `AxMCPRecordingTransport` to record deterministic protocol interactions; use `AxMCPReplayTransport` for testing, optimization, and evaluation. Live MCP evaluation is rejected by default because repeated model runs can repeat external side effects; opt in deliberately only.

Testing checklist:
- Use deterministic local servers or replay; namespace/tool collisions must fail before model execution.
- Cover raw text, image, audio, resource-link, embedded-resource, metadata, task, and error results; catalog changes during multi-step runs; authorization denial before transport execution.
- Cover reconnect/logical resubscription; anonymous-event rejection by authenticated routes; terminal task resumption restricted to owning identity/correlation; cancellation and uncertain outcomes without duplicate side effects.
- Close clients, listening handles, runtimes, and local servers in `finally`, respecting source/runtime-before-client ordering.
