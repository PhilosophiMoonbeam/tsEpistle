# Agent deployment and operations

Wiki agents are three separate trust surfaces backed by one PostgreSQL ledger:

| Surface | Example origin | Purpose | Required exposure |
| --- | --- | --- | --- |
| Wiki | `https://wiki.example.com` | Existing Wiki UI, API, and one-time agent launch | Existing users |
| Agents | `https://agents.example.com` | Session UI, admin console, approvals, REST, and SSE | Authenticated Wiki users |
| MCP | `https://mcp.example.com/mcp` | Streamable HTTP MCP | Resource-bound API keys only |

Use distinct canonical origins. The application dispatches by the exact `Host` header; it does not mount the agent shell or MCP route on the ordinary Wiki origin. Terminate TLS at a trusted ingress, preserve the original `Host`, reject unknown hosts, and route all three hosts to the same Wiki application replicas. Do not rewrite paths between origins.

## Database and compatibility

Agents require PostgreSQL for multi-replica lease notification. Apply migration `2.5.139` before enabling any flag. The migration is additive and all agent flags default to false.

Two rollback paths are supported:

1. If no agent data must remain, disable every flag, drain coordinators, run the `2.5.139` down migration, and start the exact prior application image.
2. If the additive ledger must remain, disable every flag and run the release-produced N-1 compatibility image. Do not run an older image whose migration preflight does not recognize `2.5.139`.

Never run the migration down while an application, browser worker, MCP client, or maintenance job can write the agent tables. Back up the database before either path.

## Ingress

A representative reverse-proxy policy is:

```nginx
map $host $wiki_agents_upstream {
  hostnames;
  wiki.example.com   wiki_app;
  agents.example.com wiki_app;
  mcp.example.com    wiki_app;
  default            "";
}

server {
  listen 443 ssl http2;
  server_name wiki.example.com agents.example.com mcp.example.com;
  if ($wiki_agents_upstream = "") { return 421; }
  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off; # required for agent SSE and MCP streaming
    proxy_read_timeout 10m;
    proxy_pass http://$wiki_agents_upstream;
  }
}
```

Permit `/mcp` only on the MCP host. Apply an ingress request-rate limit before the application and retain the SDK `Host` and `Origin` checks. The agent origin uses the existing Wiki authentication strategies and an audience-bound cookie. Login redirects return only to the configured agent origin; arbitrary return URLs are rejected. Users launch from the Wiki origin through a hashed, single-use, five-minute database handoff.

## Configuration

Start with all flags false:

```yaml
agents:
  enabled: false
  publicOrigin: https://agents.example.com
  cookieAudience: wiki-agents-ui
  launchTokenTtlSeconds: 300
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
    publicOrigin: https://mcp.example.com
    resourceUrl: https://mcp.example.com/mcp
```

Flags are independent kill switches. `writes.enabled` and the exact action flag must both be true. Browser, MCP, provider, skill, and proposal failures never change `/healthz`.

Provider secrets are environment-backed references. A profile stores only the reference name. Configure the referenced value on every application replica before conformance or enablement. Provider profiles are immutable revisions and remain unselectable until the current revision passes the isolated-admin conformance runner.

Required cryptographic environment variables:

| Variable | Format | Required when |
| --- | --- | --- |
| `AGENT_SNAPSHOT_SIGNING_SECRET` | Base64, at least 32 decoded bytes | Providers or MCP actions enabled |
| `AGENT_PROFILE_RESOLUTION_KEYS` | JSON key-ring accepted by the provider registry | Providers enabled |
| `AGENT_MCP_REQUEST_STATE_KEYS` | JSON array of Base64 keys, newest first, each at least 32 bytes | MCP enabled |

Retain the prior request-state and profile-resolution verification key during rotation until every issued token has expired. Never log these values, provider credentials, prompts, page content, patches, browser text, or MCP request-state payloads.

## Isolated browser worker

Build `dev/build/Dockerfile.agent-browser`. It pins Playwright and both architecture manifests through the OCI index digest. Publish one multi-architecture manifest for `linux/amd64` and `linux/arm64`:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file dev/build/Dockerfile.agent-browser \
  --build-arg WIKI_BUILD_REVISION="$WIKI_BUILD_REVISION" \
  --provenance=mode=max --sbom=true --push \
  --tag registry.example.com/wiki-agent-browser:"$WIKI_BUILD_REVISION" .
```

Run the worker as an unprivileged user with a read-only root filesystem, writable temporary directory only, no application/database/provider secrets, bounded memory/PIDs/CPU, and no ingress except mTLS from Wiki application replicas. Required worker variables:

- `AGENT_BROWSER_TLS_CERT`, `AGENT_BROWSER_TLS_KEY`, `AGENT_BROWSER_TLS_CA`: mounted mTLS files.
- `AGENT_BROWSER_SIGNING_KEYS`: JSON object from key ID to Base64 verification key.
- `AGENT_BROWSER_PORT`: defaults to `9443`.
- `AGENT_BROWSER_CHROMIUM_PATH`: optional explicit bundled Chromium path.

Application replicas use `AGENT_BROWSER_WORKER_URL`, `AGENT_BROWSER_WORKER_SIGNING_KEY_ID`, `AGENT_BROWSER_WORKER_SIGNING_SECRET`, `AGENT_BROWSER_WORKER_CA_PATH`, `AGENT_BROWSER_WORKER_CERT_PATH`, and `AGENT_BROWSER_WORKER_KEY_PATH`.

The worker must have no general network route. Force all egress through a Layer 3/4 gateway that resolves and filters destinations independently. The in-process URL policy is defense in depth: exact HTTPS allowlist, public-address validation, anonymous GET-only navigation, redirect revalidation, and request interception. Do not enable `agents.browser.enabled` until packet-capture or gateway logs prove that Chromium cannot bypass the gateway.

Drain a worker by first disabling browser admission, waiting for active contexts to finish, and then sending `SIGTERM`. The worker closes Chromium contexts before exit. Keep the prior signing verification key during a rotation and remove it only after the maximum request lifetime.

## Maintenance image and schedule

Use the normal Wiki application image with an alternate command; no HTTP listener is needed:

```sh
node server/scripts/agent-maintenance.ts
```

Set `AGENT_MAINTENANCE_DATABASE_URL`. Optional positive integers are `AGENT_MAINTENANCE_BATCH_SIZE`, `AGENT_MAINTENANCE_MCP_CONTENT_DAYS`, `AGENT_MAINTENANCE_AUDIT_DAYS`, `AGENT_MAINTENANCE_COMPACT_DELTA_DAYS`, and `AGENT_MAINTENANCE_MAX_BATCHES`.

Run one scheduled job at least hourly. Concurrent jobs are safe but waste capacity; use the scheduler's single-concurrency policy. The command prints one bounded JSON summary and exits nonzero on failure. Alert if it fails twice, if expired artifact/proposal/session backlog rises across runs, or if a run remains `recovery_required`.

Continue maintenance during a disabled-feature rollout and while the N-1 compatibility image runs. Stop it only for a database restore or the destructive down migration.

## Rollout

1. Deploy the additive migration and origins with every agent flag false. Verify ordinary Wiki routes, backup, restore, and the two rollback paths.
2. Configure approved page-native skills and provider profiles from `https://agents.example.com/admin`. Run provider conformance; do not enable user access.
3. Enable `agents.enabled` and OpenAI Responses for one explicit canary group. Keep browser, writes, proposals, and MCP false.
4. Expand read-only use. Observe queue latency, per-user/global concurrency, reconnect behavior, token/cost gauges, retention, and provider errors.
5. Enable browser only after the separate worker egress proof.
6. Enable proposals, then create and patch separately. Enable move, restore, and delete only after action-specific review.
7. Enable MCP on private ingress for a dedicated API-key group with `use:mcp`. Public exposure requires rate-limit, Host/Origin/resource, approval, and incident-response evidence.

At any stage, disable the smallest failing capability. Existing sessions remain reconstructable from PostgreSQL. Disabling a provider prevents new selection without changing retained history.

## Monitoring and incident response

The existing metrics endpoint exports low-cardinality `wiki_agent_runs{status}`, `wiki_agent_proposals{status}`, `wiki_agent_artifacts_total`, and `wiki_agent_usage_total{kind}` gauges. Alert on sustained queue growth, `recovery_required`, failed maintenance, quota saturation, artifact growth, provider error rate, browser worker mTLS failures, and MCP authentication/rate denials. Metrics and logs contain IDs, states, hashes, durations, token counts, costs, and bounded error codes only.

For suspected provider exfiltration: disable `agents.provider.enabled`, revoke provider secrets, retain the audit ledger, and inspect profile/version, skill-use, action, and destination metadata. For browser escape: disable `agents.browser.enabled`, revoke worker client certificates and signing keys, isolate the worker network, and retain gateway logs and artifact hashes. For MCP key compromise: revoke the API key, rotate request-state keys, keep the compromised key only in offline forensic material, and review proposals by requester API-key ID. For unsafe writes: disable `writes.enabled`, preserve proposals/approvals/executions/outbox rows, reconcile the page projection, and restore only through the normal page revision operation.
