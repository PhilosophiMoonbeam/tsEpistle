# Agent deployment and operations

Wiki agents use the ordinary Wiki origin plus one isolated browser-service boundary:

| Surface | Example | Purpose | Exposure |
| --- | --- | --- | --- |
| Wiki | `https://wiki.example.com` | Existing UI, inline Search/Ask, `/admin/agents`, internal agent REST/SSE, approvals | Existing authenticated users |
| MCP | `https://wiki.example.com/mcp` | Streamable HTTP MCP | Resource-bound API keys only |
| Browser worker | private mTLS endpoint | Playwright execution in a separate unprivileged process/container | Wiki application replicas only |

There is no agent-specific public origin, login, cookie, launch token, popup, iframe, or sidecar application. The internal agent controller handles only `/_api/agents`. When MCP is enabled, the exact `/mcp` endpoint on the Wiki origin is reserved for MCP; its API-key authentication remains independent from Wiki browser sessions.

## Database and compatibility

Agents require PostgreSQL for multi-replica leases and notification. Apply migrations through `2.5.140` before enabling any flag:

- `2.5.139` adds the source-revision ledger and agent tables.
- `2.5.140` removes the obsolete cross-origin launch-handoff table. Its down migration recreates only the empty compatibility shape.

All agent flags default to false. Back up PostgreSQL before upgrade or rollback.

Two rollback paths are supported:

1. With no authoritative agent data to retain: disable all agent flags, drain coordinators and maintenance, apply `2.5.140` down, then apply the guarded `2.5.139` down and start the prior image.
2. With agent data to retain: disable all flags and run the release-produced N-1 compatibility image. Keep the schema-compatible maintenance command active. Do not run an arbitrary older image.

Never run a destructive down migration while an application, MCP client, browser worker, or maintenance job can write agent state.

## Ingress

Route the Wiki hostname normally and apply a stricter exact-path policy to `/mcp` on that same hostname. Preserve `Host`, terminate TLS at trusted ingress, reject unknown hosts, disable proxy buffering for SSE/MCP, and apply an ingress rate limit to MCP.

Representative policy:

```nginx
server {
  listen 443 ssl http2;
  server_name wiki.example.com;
  location = /mcp {
    limit_req zone=mcp burst=20 nodelay;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 10m;
    proxy_pass http://wiki_app;
  }
  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 10m;
    proxy_pass http://wiki_app;
  }
}
```

The application derives the canonical MCP resource as `${wiki.config.host}/mcp` and rejects MCP `Host`, `Origin`, and resource-claim mismatches. `/mcp` is reserved while MCP is enabled; `_agent` remains an ordinary Wiki page path.

## Configuration

Start with every capability disabled:

```yaml
agents:
  enabled: false
  retention:
    temporarySessionHours: 24
    mcpContentDays: 7
    auditDays: 90
    maintenanceBatchSize: 100
  provider:
    enabled: false
    globalConcurrency: 4
    perUserConcurrency: 1
    pollingMilliseconds: 1000
  sse:
    maximumConnectionsPerUser: 3
  skills:
    enabled: false
    namespace: system/agent-skills
  browser:
    enabled: false
  proposals:
    enabled: false
  writes:
    enabled: false
    create: { enabled: false }
    patch: { enabled: false }
    move: { enabled: false }
    restore: { enabled: false }
    delete: { enabled: false }
  mcp:
    enabled: false
```

Startup rejects provider concurrency, polling, SSE, and retention values outside their bounded ranges. `perUserConcurrency` cannot exceed `globalConcurrency`. Flags are independent kill switches; write application requires `writes.enabled`, proposals, and the exact action flag.

Provider inference is intentionally unavailable until an operator enables the provider subsystem with its signing, profile-resolution, and provider-credential encryption keyrings, then an administrator adds an immutable provider profile in `/admin/agents`, runs conformance, and enables that profile. Enabling the subsystem alone offers no usable model destination: profiles remain disabled until conformance passes and an administrator enables them. The admin API accepts a credential only on profile-version creation, encrypts it before the transaction commits, and never returns it.

### Provider API protocols

A provider profile describes one approved destination, encrypted credential, model, protocol-derived capability descriptor, and policy. Its API protocol selects the exact wire contract used at that destination; it is not inferred from the URL. The ordinary admin form derives low-level transport behavior instead of asking operators to declare protocol facts.

| API protocol | Endpoint | Intended use |
| --- | --- | --- |
| OpenAI Responses API | `POST /v1/responses` | OpenAI's current item-based API and the preferred OpenAI integration |
| OpenResponses-compatible API | `POST /v1/responses` | Vendor-neutral OpenResponses contract with strict request, semantic-event, sequence, and terminal-marker validation |
| OpenAI-compatible Chat Completions | `POST /v1/chat/completions` | Message-based compatibility API; agent mode requires conformed streaming, function tools, and cancellation |
| Legacy text Completions | `POST /v1/completions` | Prompt-in/text-out compatibility only; buffered generation-only runs with no tools |
| Anthropic Messages API | `POST /v1/messages` | Native Anthropic message and tool-block protocol |

Chat Completions and text Completions are not aliases. Chat Completions accepts structured message history and can return tool calls; legacy text Completions accepts one flattened prompt and returns text. Likewise, OpenAI Responses and OpenResponses share an item-oriented shape but represent different compatibility promises. Administrators must choose the server's documented protocol and pass conformance rather than relying on endpoint probing.

For every tool-capable protocol, the preset accepts multiple tool calls from one model turn; Wiki executes those calls serially in model order. This is distinct from **Agent** use, which controls whether the model receives any Wiki action definitions and may continue through action-result turns. **Text generation** use never receives Wiki actions and rejects unexpected tool calls. Tool-capable profiles allow both uses; legacy text Completions allows text generation only. New sessions prefer Agent use and automatically fall back to text generation when the selected profile cannot use actions.

Streaming, cancellation, tool-call shape, structured-output mapping, usage-accounting source, authentication, and allowed uses are protocol-derived and shown read-only. Context/output limits and quotas remain model/deployment settings under Advanced limits and quotas. Capability revisions are generated from the versioned Wiki protocol preset, while pricing remains `unpriced-v1` until provider billing calculation exists; neither internal ledger field is operator input. A profile remains disabled until its immutable version passes conformance.

Editing a provider profile creates a new immutable version, disables the profile, and requires conformance before it can be enabled again. The current encrypted credential is retained when the administrator leaves the API-key field blank; entering a value creates a new managed credential for the new version. Removing a profile immediately excludes it from administration, session selection, default resolution, and new run admission. The profile and version ledger is retained for audit integrity, while its managed provider credentials are permanently deleted. A removed display name can be reused by a new profile.

Required cryptographic environment:

| Variable | Required when |
| --- | --- |
| `AGENT_SNAPSHOT_SIGNING_SECRET` or `AGENT_SNAPSHOT_SIGNING_SECRET_FILE` | Provider or MCP actions are enabled |
| `AGENT_PROFILE_RESOLUTION_KEYS` or `AGENT_PROFILE_RESOLUTION_KEYS_FILE` | Providers are enabled |
| `AGENT_PROVIDER_SECRET_KEYS` or `AGENT_PROVIDER_SECRET_KEYS_FILE` | Providers are enabled |
| `AGENT_MCP_REQUEST_STATE_KEYS` | MCP is enabled |

Each keyring uses `{ "currentKeyId": "name", "keys": { "name": "<base64>" } }`. Provider credential encryption keys must decode to exactly 32 bytes. Wiki encrypts each UI-supplied credential with AES-256-GCM, a fresh 96-bit nonce, and authenticated record identity, stores only ciphertext in `agentProviderSecrets`, and writes an opaque `managed:<uuid>` reference into the immutable profile version. Retain every encryption key ID referenced by stored credentials when rotating `currentKeyId`; removing an in-use key fails closed. Existing operator-managed `env:NAME` references remain readable for compatibility, including `NAME_FILE`, but the admin UI creates managed encrypted credentials. The `_FILE` forms read a mounted keyring when the matching inline variable is absent. Never log these keys, provider credentials, prompts, page/skill/browser content, approval payloads, or signed state tokens.

## Browser worker

Build `dev/build/Dockerfile.agent-browser`. It pins Playwright/Chromium, runs as `pwuser`, launches Chromium with its sandbox enabled, and executes outside the Wiki application process.

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file dev/build/Dockerfile.agent-browser \
  --build-arg WIKI_BUILD_REVISION="$WIKI_BUILD_REVISION" \
  --provenance=mode=max --sbom=true --push \
  --tag registry.example.com/wiki-agent-browser:"$WIKI_BUILD_REVISION" .
```

Run it with a read-only root filesystem, writable temporary storage only, no application/database/provider secrets, bounded memory/PIDs/CPU, and ingress only from Wiki replicas over mTLS. Worker variables:

- `AGENT_BROWSER_TLS_CERT`, `AGENT_BROWSER_TLS_KEY`, `AGENT_BROWSER_TLS_CA`
- `AGENT_BROWSER_SIGNING_KEYS`
- `AGENT_BROWSER_PORT` (default `9443`)
- `AGENT_BROWSER_MAX_CONTEXTS` (default `8`, allowed `1..64`)
- `AGENT_BROWSER_CHROMIUM_PATH` when overriding the bundled executable

Application replicas use `AGENT_BROWSER_WORKER_URL`, `AGENT_BROWSER_WORKER_SIGNING_KEY_ID`, `AGENT_BROWSER_WORKER_SIGNING_SECRET`, `AGENT_BROWSER_WORKER_CA_PATH`, `AGENT_BROWSER_WORKER_CERT_PATH`, and `AGENT_BROWSER_WORKER_KEY_PATH`.

The worker validates signed request identity, sequence, replay nonce, context/action/navigation/time/byte limits, canonical HTTPS GET targets, public DNS answers, stale refs, and screenshot format. Chromium request interception blocks non-attested requests, alternate methods, sockets, downloads, service workers, and popups.

In-process checks are not a network sandbox. Deploy the container in a network namespace with no direct external route and force egress through an independently filtered Layer 3/4 gateway. Do not enable `agents.browser.enabled` until packet capture or gateway logs prove Chromium cannot bypass that route. This repository cannot install a universal host-network policy because enforcement belongs to the deployment network.

Drain by disabling browser admission, waiting for active contexts, then sending `SIGTERM`. Keep the prior signing verification key only through the maximum request lifetime.

## Maintenance

Run the normal application image with:

```sh
node server/scripts/agent-maintenance.ts
```

Set `AGENT_MAINTENANCE_DATABASE_URL`. Optional positive bounds are `AGENT_MAINTENANCE_BATCH_SIZE`, `AGENT_MAINTENANCE_MCP_CONTENT_DAYS`, `AGENT_MAINTENANCE_AUDIT_DAYS`, `AGENT_MAINTENANCE_COMPACT_DELTA_DAYS`, and `AGENT_MAINTENANCE_MAX_BATCHES`.

Schedule at least hourly with single-job concurrency. The command emits one bounded JSON summary and exits nonzero on failure. Alert on repeated failure, growing expiry backlog, or `recovery_required` runs. Continue maintenance while capabilities are disabled and during an N-1 compatibility rollback. Stop it only during database restore or destructive down migration.

## Security and privacy

- Internal agent REST accepts ordinary authenticated user sessions only. Mutations require exact same-origin `Origin`, `Sec-Fetch-Site: same-origin`, and the session CSRF token. API keys are rejected.
- MCP accepts resource-bound API keys only at `/mcp` on the configured Wiki origin; ordinary browser sessions are rejected.
- Wiki `extra.js` is administrator-installed privileged code. It can act as the signed-in user on the Wiki origin; do not treat it as untrusted tenant content. Provider text, skill text, and page content never execute as code and are rendered through the existing sanitizer.
- Permission and ownership checks occur when actions are offered and again at execution. Write approvals are immutable, single-use, revision-fenced records.
- Browser contexts are per run. Cookies, storage, cache, live DOM, and browser profiles are not persisted into sessions.
- Logs and metrics contain IDs, states, hashes, durations, bounded error codes, token counts, and costs—not conversation or hidden reasoning content.

## Rollout

1. Apply migrations with all flags false. Verify ordinary Wiki routes, backup, restore, and both rollback paths on PostgreSQL 16 and 17.
2. Configure approved skills and provider profiles in `/admin/agents`; keep user access false.
3. Run transport conformance. Perform one controlled real read only after credentials and egress policy are ready.
4. Enable `agents.enabled` and one read-only provider for an explicit canary group. Keep browser, proposals, writes, and MCP false.
5. Observe queue depth, concurrency, reconnects, token/cost reservations, retention, and provider errors.
6. Enable browser only after the separate worker and no-bypass network proof.
7. Enable proposals, then create and patch separately. Enable move, restore, and delete only after action-specific review.
8. Enable MCP first behind private exact-path ingress for a dedicated `use:mcp` API-key group.

Disable the smallest failing capability. Existing session history remains reconstructable from PostgreSQL.

## Incident runbook

- **Provider exfiltration or outage:** disable `agents.provider.enabled`, revoke provider secrets, retain the audit ledger, and inspect profile/version, skill-use, action, and destination metadata.
- **Browser escape:** disable `agents.browser.enabled`, revoke worker certificates/signing keys, isolate the worker network, and retain gateway logs and artifact hashes.
- **MCP key compromise:** revoke the API key, rotate request-state keys, preserve the compromised key only as offline evidence, and review proposals by requester API-key ID.
- **Unsafe writes:** disable `writes.enabled`, preserve proposals/approvals/executions/outbox rows, reconcile the page projection, and restore only through normal page revision operations.
- **Lease or queue growth:** stop new admission, drain healthy workers, inspect expired leases and `recovery_required`, then run bounded maintenance. Never manually replay a run after an ambiguous side effect.
- **SSE pressure:** reduce per-user connection bounds or disable agent admission; reconnect uses durable `Last-Event-ID`.
- **Rollback:** disable flags, drain, back up, choose the empty-ledger or compatibility path above, and verify retention before restoring traffic.
