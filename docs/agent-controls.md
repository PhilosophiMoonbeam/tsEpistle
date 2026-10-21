# Agent decision providers, external MCP, and model routing

These controls configure the existing Ax-first Wiki Agent; they do not replace Wiki permissions, approval requirements, quotas, or durable goals. Open **`/a/agents`** as a system administrator. Conversation **Providers**, **Agent Decision Providers**, external MCP, resources/skills, and routing are administrator controls. Ordinary users interact with **Agent**, **Skills**, **My tools**, and **Memories**. They do not see or choose generative model identities, providers, or model pins.

## Recommended setup order

1. Configure and check generative model profiles, their current versions, credentials, enabled state, group grants, native capabilities, context/output limits, and deliberate prices. Set an authorized all-user default; the server admits only models currently eligible for the conversation owner.
2. Configure a native **TypeSafe Jev** decision provider with an available credential and known pricing, run **Check connection**, then **Enable** and **Set default**. An accepted Jev model (`jev-1.13.0`, `jev-latest` or `jev-preview`) is a mandatory configured complement before production Agent inference. Prefer a checked version pin. A connection check performs a real classification request and may incur a charge.
3. Configure skills and resource access, then any trusted external MCP destinations. Review their data-sharing and mutation behavior, and grant the intended groups. Enable personal endpoint creation only for groups that should have it.
4. Declare the task sufficiency of each eligible generative model's current immutable version. Review routing thresholds and prices before opting in to per-turn optimization.
5. Users start or continue an Agent conversation without selecting a model. New user turns are routing boundaries; approval continuation is not a new model-selection or classification opportunity.

The deployment must have Agent and provider functionality enabled and the existing protected provider secret/keyring setup in place. Outbound external MCP is independent of the inbound Wiki `/mcp` service: configuring inbound MCP does not configure remote endpoints, and no outbound endpoints means no external tools.

## Decision providers

### Native TypeSafe / Jev versus custom endpoints

A decision provider returns a structured choice, probabilities, confidence, and usage; it is not the model that writes the conversation answer.

The configured companion is invoked where applicable: nonliteral Wiki assertions and actual untrusted narration receive narrow source-support checks; eligible model routing retains its existing classifier. Complete original source quotations, exact authoritative title quotations and admitted host observations are mechanically validated without a redundant native call. Ordinary answers do not require per-record or per-read completeness judgments. Native checks retain their complete own-source context, fresh read authorization, pinned provider and priced accounting. Both selected probability and confidence must exceed 0.8; uncertainty, missing credentials, unknown pricing or service failure cannot authorize an assertion requiring semantic support. A mechanical quotation is not an LLM-only fallback or a world-truth guarantee. Custom compatible providers remain available to configured routing, but do not satisfy the mandatory native companion. See [verification bounds and accounting](agents-deployment.md#ax-cutover-media-and-control-configuration).

| Configuration field | Native `typesafe` | Custom `openai-compatible` |
| --- | --- | --- |
| `model` | Default `jev-latest`; `jev-latest`, `jev-preview`, or a versioned ID such as `jev-1.13.0` | Required explicit configured model/alias |
| `timeoutMs` | Default 5,000; allowed 100–30,000 ms | Same |
| `baseUrl` | Native TypeSafe transport, not a custom URL | Required public HTTPS base URL |
| `dialect` | Native TypeSafe structured decision API | Required `chat-completions` or `completions` |
| `maxOutputTokens` | Native model limits | Default 1,024; allowed 64–4,096 |
| `pricing` | Verified metadata or `null` | Verified metadata or `null` |

Custom chat dialects use messages and `choices[].message.content`; legacy completions use a prompt and `choices[].text`. Choose the dialect explicitly, not by guessing from the model name. Custom destinations are guarded server-side: no embedded credentials, query or fragment, private/local destinations, unsafe URL paths, or redirects. Do not use an internal proxy address to bypass the public-egress policy.

Sampling controls (`temperature` and `top_p`) are intentionally omitted for custom decision models: the selected model has no declared sampling contract, and reasoning models may reject those parameters. Custom chat requires native JSON Schema `response_format` support and uses Ax's chat request builder/decoder. Legacy completions sends `prompt`, `max_tokens`, and a nonstreaming request; the prompt defines the same JSON contract and the server validates the result. An endpoint must actually support its configured dialect; a model-list entry alone does not prove inference compatibility.

Native TypeSafe uses the **Ax 25-exported `typesafe()` client**, `listModels()`, and `systemOne()` at the documented `/v1/models` and `/v1/systemone` endpoints. It is never forced through an OpenAI-compatible request. The narrow installed Ax transport gap is legacy `/completions`: Ax 25 has no native legacy-completions profile, so this explicitly selected dialect uses a bounded wire adapter around Ax's chat normalization. No automatic dialect detection or replacement TypeSafe SDK is involved.

TypeSafe discovery currently returns aliases; valid versioned Jev IDs may be absent. A pin is ready only after real inference reports **that exact version**. A listed native alias is ready only when inference reports a concrete versioned Jev ID, not merely the alias or an unrelated model. Check the current [TypeSafe model and alias contract](https://docs.typesafe.ai/models) and [System One API](https://docs.typesafe.ai/api) before changing administrator-selected versions.

For custom provider connection checks, discovery must include the configured name and the real request must use it. The returned bounded, nonempty `model` is the **observed** identity; compatible aliases and proxies may legitimately report a different concrete ID. The server does not invent an alias mapping, infer capabilities, or assign prices from that returned name. Invalid or credential-reflecting model/catalog identifiers are rejected, and independently validated inference usage is retained on failure.

### Credentials and readiness

Enter credentials only in the write-only password field or protected server secret configuration. Never put a key in a URL, example request, browser storage, screenshots, logs, or this documentation. Responses disclose readiness and `credentialSource` (`managed`, `environment`, or `none`), not the key or secret reference.

Native TypeSafe uses a managed credential when one is configured. Only when there is **no managed reference** does it fall back to server `TYPESAFE_API_KEY`. A broken/unavailable managed credential does not silently fall through to the environment key. Custom providers do not inherit the TypeSafe key.

For file-mounted deployment secrets, use `TYPESAFE_API_KEY_FILE` pointing to a protected readable file. A nonempty `TYPESAFE_API_KEY` takes precedence; otherwise the file is read as UTF-8 and trimmed, with a 64 KiB limit. An unreadable file is a credential error, not a successful fallback. Restrict access to the server identity and keep secrets out of version control. The existing provider encryption keyring also supports the shared environment/file mechanism; retain the established deployment key management rather than generating keys in the browser.

For API writes, omitted `secretValue` retains the credential on update, a nonempty value replaces it, and `null` clears the managed credential. Bearer values must contain 1–65,536 printable non-space ASCII characters; whitespace, control characters, and non-ASCII values are rejected before storage or dispatch. Clearing a native credential may expose the configured server fallback; it does not necessarily make the provider credential-free.

New records are disabled and not default. Saving **any** configuration update increments its revision, clears the successful-check marker, disables it, and clears its default status. Run **Check connection** again, then enable it. Enabling requires a successful check and an available credential. Setting default requires an enabled credential-ready record; only one default is retained. Disabling also clears default status. Runtime selection uses the routing policy's explicit provider, or the enabled default when the policy leaves that field blank. It rechecks availability and revision around execution; deleting or disabling a provider does not authorize stale runtime use.

Checks validate model availability and the structured Choice contract. Malformed choices, invalid probabilities/confidence, unusable usage, missing models, timeouts, and provider failures are failures rather than evidence that a provider is ready. Public errors are sanitized; raw provider payloads are not Wiki evidence.

### Prices and usage are different facts

`pricing` is either `null` (unknown, not free) or verified USD metadata containing `inputPerMillion`, `outputPerMillion`, `perRequest`, `revision`, `source`, and `verifiedAt` (date). Prices are nonnegative finite values, capped at 1,000,000 each. Enter the source and review date deliberately. The source-defined Jev 1.13 metadata is USD 0.042 per million input tokens, zero output and per-request rates, reviewed 2026-10-04 against <https://docs.typesafe.ai/models>; it is not a price promise for arbitrary native/custom models. New UI drafts leave pricing unknown unless configured.

Observed latency and validated token counters describe the request that ran. `estimatedCost`/`estimatedCostMicros` apply configured prices; they are **not measured billing**. `inputTokens`, `outputTokens`, and `totalTokens` remain independent safe nonnegative integers. `totalTokensSource` is `reported` when supplied by the protocol, or `derived` only when the protocol omits a total and the safe directional sum is used. A supplied total must be at least that sum; malformed totals cannot be silently repaired. Any excess is unclassified, not inferred reasoning or cache usage. Cost estimates price that residual at the higher directional rate, plus the configured per-request amount.

## External MCP endpoints

### Administration and personal ownership

Admin endpoints have a display name, public HTTPS `endpointUrl`, `status` (`enabled`/`disabled`), `authMode` (`none`/`bearer`/`oauth`), optional write-only bearer `secretValue`, and group grants (`groupIds`). Admin creation includes grants; grants can also be changed separately. An enabled admin endpoint is usable only through the user's **current** group membership and its current grants. OAuth registrations belong to the endpoint, while each Wiki user authorizes and stores their own resource-access grant.

Group policy `allowPersonalEndpoints` is denied by default (an absent policy has revision zero). At least one currently joined group must allow it for personal endpoint access/creation. In **My tools**, users can add, edit, disable, delete, and discover their own endpoints, and inspect enabled admin endpoints currently available to them. Personal records and credentials are owner-isolated; another user's endpoint is not a shared alternative. Revoking group permission also blocks use of previously created personal endpoints. Permission-denied UI does not offer a usable create path.

Bearer secrets are managed server-side, never reflected in list/discovery responses. Responses reflecting the active bearer value in headers, status text, body, or decoded JSON strings fail closed rather than publishing the token; they are not rewritten or automatically retried. Omission retains an existing endpoint credential; `authMode: none` removes it. Do not submit secret references. For bearer mode, provide a usable credential rather than assuming `null` makes authentication work. Personal bearer values are bounded to 8,192 printable non-space ASCII characters.

**Review the destination before granting access.** Model-generated tool arguments and relevant conversation data may leave the Wiki. A remote tool can mutate external systems; an endpoint grant authorizes external operations, not just reading. Remote claims that a tool is safe/read-only are not host authority. Wiki mutation proposals and their human approvals remain separate and are not bypassed by external results. Disabling an endpoint or revoking access prevents subsequent calls, but cannot undo a completed remote mutation.

### Generic OAuth connections

**OAuth is a general external-MCP authentication mode**, available for administrator-managed shared endpoints and policy-approved personal endpoints. It is not restricted to Google. The Wiki Agent remains the MCP client; the remote MCP server is the protected resource. OAuth account connections are separate from wiki sign-in and inbound Wiki MCP access keys.

1. Configure the public HTTPS MCP endpoint and choose **OAuth** in **Administration → Agents → External MCP**, or in an approved user's **My tools**. **Generic OAuth server** is the default; it does not require Google credentials. Save and enable the endpoint, grant the intended groups for shared use, and review its destination and requested scopes.
2. Choose the provider's client-registration arrangement:

   | Registration | Configuration |
   | --- | --- |
   | Automatic | Uses the authorization server's advertised client metadata support first, then advertised dynamic client registration. If neither is available, configure a preregistered client. Registration occurs only on explicit Connect, not status inspection. |
   | Preregistered public client | Enter the explicit issuer and registered client ID; choose token authentication `none`. |
   | Preregistered confidential client | Enter the explicit issuer and client ID; choose `client_secret_basic` or `client_secret_post` as supported by the provider and enter the write-only client secret. |

   An omitted secret retains a compatible saved credential; a replacement updates it; explicit clear removes it. Changing client identity/authentication requires appropriate new credentials. Unrelated name or group edits cannot silently authorize sending an existing client secret to a changed token endpoint.
3. Register the exact callback displayed in the saved endpoint's connection status. Its deployment-neutral structure is:
   ```
   <canonical-wiki-https-origin>/agents/oauth/callback
   ```
   The callback is derived from the canonical persisted Wiki `host`, never an incoming Host header or smoke-tool `SITE_URL`. Each deployment origin needs its own exact registered HTTPS callback. An HTTP Wiki origin leaves OAuth unavailable without disabling ordinary providers or none/bearer MCP connections.
4. Each user selects **Connect account** in **Profile → External tool connections** (`/p/profile#external-mcp-connections`) or **My tools**, completes the provider's consent flow, and returns to Wiki. Shared connections remain available when personal endpoint creation is denied. Administrators can connect their own account directly on an enabled admin endpoint for configuration discovery without a runtime group grant; that exception does not grant Agent execution access.
5. Refresh live status, discover the catalog, and verify a permitted read-only tool. A callback message is not proof of a working connection. Missing registration, denied consent, expired/replayed state, changed authority, revoked access or lost Wiki permissions require the indicated recovery; tool operations are not automatically replayed.

Discovery follows the [MCP authorization contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): credential-free protected-resource challenges and path/root well-known metadata, OAuth authorization-server or OIDC metadata including issuer paths, PKCE S256, resource indicators, and exact authorization-response issuer validation. A configured issuer must match the selected advertised authority. Saved clients, callbacks, token destinations and grants are bound to their issuer, resource and configuration; a discovered authority change cannot redirect retained credentials.

Requested scopes are optional. Otherwise the challenge or protected-resource metadata supplies the initial scope set. Review provider permissions before consent; external tools may change data. Unsupported registration/authentication/metadata arrangements fail with actionable errors rather than guessing endpoints or reusing another issuer's client. The hosted metadata-client document is at `/agents/oauth/client-metadata`, uses the canonical HTTPS origin, and contains public registration metadata only.

Authorization state is short-lived, single-use, and bound to the initiating browser session, current Wiki account/session version, endpoint revision and access policy. PKCE verifiers, client secrets and per-user tokens are encrypted server-side with the existing provider keyring. Tokens never enter browser persistent storage or Agent prompts/state. Grants survive application restart; database locks fence refresh, reconfiguration and disconnect across application instances. Providers may omit refresh tokens or expiry; the application does not invent a token lifetime, and rejected/expired credentials require reconnect when renewal is unavailable.

**Disconnect is endpoint-local:** it removes this Wiki user's stored grant and pending consent for that endpoint and blocks subsequent use by old bindings. It does not automatically invoke a provider-wide revocation operation that might affect sibling connections. Use the provider's account settings to revoke app access there. Account/endpoint deletion cleans up OAuth-owned secrets without weakening unrelated provider-secret deletion restrictions.

#### Optional Google Workspace preset

**Google Workspace convenience preset** is an optional registration shortcut for the nine official Workspace MCP services and their service-specific scopes. Selecting it offers the official service endpoints and permissions; generic issuer, registration and client-secret fields are not submitted for preset connections. Switching presets resets those inactive fields. Other MCP providers continue to use the default generic flow without Google credentials.

For this preset only, configure a Google **Web application** OAuth client on the Wiki server using `GOOGLE_WORKSPACE_MCP_CLIENT_ID` and `GOOGLE_WORKSPACE_MCP_CLIENT_SECRET`, or their protected `_FILE` counterparts. Register the exact callback displayed by the saved endpoint:

```
<canonical-wiki-https-origin>/agents/oauth/google/callback
```

This is separate from wiki sign-in and from the default generic callback, `<canonical-wiki-https-origin>/agents/oauth/callback`. Both derive their origin from the installation's canonical persisted HTTPS Wiki `host`, never `SITE_URL` or an incoming request header. Every installation needs its own exact registered callback. Missing or partial Google credentials leave only this preset unconfigured; generic OAuth and none/bearer endpoints remain available. Each user still connects their own account and must review the service permissions before consent.

#### Migration and environment

Forward migration `tsepistle-000064-generic-mcp-oauth` adds generic configuration and encrypted client-registration bindings. Migration `tsepistle-000065-retire-mcp-oauth-presets` retires the former provider-specific preset: affected endpoints are disabled and their revisions incremented, with the exact previous configuration archived and encrypted credentials/grant references preserved. An administrator or owner must explicitly configure the endpoint's generic issuer and registered client before re-enabling and reconnecting it using the generic callback. Existing bindings cannot be reused silently. Generic OAuth and none/bearer endpoints are unchanged. Deploy the new application with its migrations; do not run older writers against the new domain or discard credentials through a down migration.

Forward migration `tsepistle-000066-restore-google-workspace-mcp-preset` restores eligible archived Google preset configurations without rewriting migration 65. It restores only disabled endpoints whose current configuration still exactly matches migration 65's retirement placeholder, whose archive is a valid Google preset configuration, and whose endpoint is an official Workspace service. Later endpoint edits are not overwritten. The archive is retained, the endpoint revision is incremented, and encrypted credential, grant, registration and PKCE records are not changed. No endpoint is automatically re-enabled and no account is silently reconnected: review the restored preset, configure the optional Google application credentials and exact Google callback, then explicitly enable and reconnect. Endpoints not eligible for automatic restoration require an administrator or owner to choose and save their intended generic or Google preset configuration. Generic OAuth and none/bearer endpoints are unchanged.

The root `.env.example` uses a reserved example domain only for local smoke-tool setup. OAuth callbacks and public client metadata use the installation's canonical persisted HTTPS Wiki origin. Generic provider client credentials are configured per endpoint through the protected UI; the optional Google preset alone uses the server-side Google environment values described above. Editing local `.env` does not update a container's configured environment or mounts. Preserve the existing encryption keyring; never generate replacement roots to enable OAuth. Keep issued secrets out of chat, Git, `VITE_*`, URLs and screenshots.


### Network, discovery, and execution boundaries

Endpoints must be public HTTPS on the default/443 port, without URL credentials, query, fragment, local hostnames, or forbidden address ranges. DNS answers are checked and outbound connections are pinned to permitted addresses; redirects are denied. Discovery goes through the Wiki server's guarded API, never a direct browser fetch. Limits include a 30-second request timeout, 256 KiB request bodies, 2 MiB responses/catalogs, 256 catalog entries across at most four pages, at most 16 clients per run, and 16 personal endpoints per owner.

Discovery inspects a bounded native MCP catalog, not a permanent authorization grant. System administrators may inspect enabled admin endpoints for configuration using current server-checked `manage:system` authority, even without a personal group grant. That inspection authority does **not** grant Agent execution access. Runtime catalog access and invocation remain owner/group-grant scoped. Current account/group/endpoint/grant state, revisions, outbound enablement, and egress are revalidated at catalog and model-dispatch boundaries and again before invocation, including cached catalogs. Revocation or endpoint/credential revision changes block stale calls. Calls consume the admitted run's tool budget, honor cancellation, and close owner-scoped clients when finished. No external tool is configured implicitly.

External MCP functions are exposed only to the **root Agent** execution path with native tool calling and no restricted action allowlist. Ordinary Chat mode, planner/subagent paths, and restricted flows do not gain these functions. Changing models mid-call is not a workaround for missing capabilities.

Descriptions, text, structured content, resources, links, and binary results are attributed **UNTRUSTED external data**. They are not instructions, permission changes, approvals, or authoritative Wiki citation evidence. An answer may describe an attributed external result, but must not promote it to a Wiki source receipt or claim unread content was verified.

Ax 25's native MCP executor does not validate tool arguments against the advertised JSON Schema. tsEpistle closes that boundary with Ajv 8.20.0 in one reusable isolated Bun process per execution context. Compilation and validation each have a two-second hard deadline; cancellation, timeout, and context cleanup kill the process and await its exit. This prevents untrusted schema regexes from blocking Wiki's event loop. Supported synchronous Draft 7, 2019-09, and 2020-12 schemas retain their pattern/composite semantics; local references work, external references are never fetched, and asynchronous/unresolved schemas fail closed. Format keywords remain annotations. Valid arguments are forwarded unchanged: no coercion, stripping, or inserted defaults. Invalid arguments or validation timeout do not invoke the external tool or authorize another paid model call.

Native function results can carry text, images, audio, and embedded file resources within the bounded transport/result envelope. Gemini GenerateContent and Responses/OpenResponses preserve binary function content; Anthropic preserves images only; Chat Completions and legacy Completions reject binary function results. The selected model must additionally advertise the returned media type, MIME format, and native size limit through Ax. User-upload support alone is not proof of function-result support. Unsupported/oversized media is rejected before another paid model call, without silently substituting text or retrying the remote operation. Binary byte size is not a measured model-token count: context admission uses conservative unmeasured-media exposure, rather than asserting that a 2 MiB result fits every model's context.

Required legacy MCP tool tasks use Ax's native task creation and `waitForTask`; ordinary modern calls retain Ax's native auto-await. The host waits for the terminal native result before reporting completion or buying another model step. Failed, cancelled, or input-required tasks do not masquerade as completed work. Abort and context cleanup cancel only handles created by the owning client, through a bounded cleanup lane that still checks current authorization and egress. If access is revoked before cancellation, the remote outcome remains unknown; the host neither claims completion nor replays the side effect. This task lifecycle does not add a background LLM delegation worker.

## Automatic model admission and per-turn optimization

### Policy and declarations

Model admission is server-controlled even when optional classification-based routing is disabled. For an owner, the server prefers the current eligible all-user default; when it is unavailable, it selects a current eligible profile by administrator-controlled display name and then profile ID. Current account/group grants, enabled state, credentials, conformance, and Agent capability remain mandatory. Historical stored profile bindings are not a user model pin or an authorization grant.

Classification-based optimization is disabled by default. Administrative task declarations describe sufficiency; they do not grant model access or fabricate intelligence benchmarks. Each declaration names the **current immutable** `profileVersionId`, unique task classes and complexities, and nullable `estimatedLatencyMs`. Updating a profile makes its old declaration stale; review and redeclare its new version.

Task classes are `conversation`, `retrieval`, `writing`, `coding`, `analysis`, and `planning`; complexities are `simple`, `moderate`, and `complex`. At least one class/complexity must be declared. Optional latency is a positive integer up to 3,600,000 ms; blank means unknown and is not a measured performance claim.

| Policy field | Default | Allowed range/meaning |
| --- | --- | --- |
| `enabled` | `false` | Explicit automatic-routing switch |
| `decisionProviderId` | `null` | Explicit provider UUID, or enabled default |
| `minimumConfidence` | 0.95 | 0.8–1; both choice probability and confidence must meet it |
| `minimumSavingsRatio` | 0.2 | 0.05–1; required net estimated savings relative to incumbent |
| `minimumSavingsMicros` | 1,000 | 1–1,000,000,000 µUSD |
| `switchCostMicros` | 1,000 | 0–1,000,000,000 µUSD estimated switching-loss allowance |
| `classifierMaxStateBytes` | 4,096 | 256–16,384 bytes of bounded classification state |

Legacy `specialist*` policy values may remain in stored records for historical/pending-run compatibility; they do not enable delegation for new automatic routing. Current administrator controls do not advertise them as an executable feature.

The classifier sees bounded current-message/summary state and fixed task criteria, not an unrestricted copy of conversation history. Oversized current messages skip classification rather than silently truncating the requested work. User/history content cannot directly grant a model or override host selection rules.

### Eligibility and safe fallback

Candidates come from the live owner-scoped registry: enabled, credential-ready, conformed primary conversation models currently authorized for **that owner**. Deterministic checks enforce attachment modalities, generation tools/transcription, native tools/external MCP, native JSON schema, output ceilings, and context capacity including model-specific framing, tools, and schema. An acceptable task declaration must match the candidate's current version and the classified task/complexity. Unknown alternative sufficiency or prices do not become permission to choose the cheapest-looking model.

For a fresh conversation, admission starts with the administrator's eligible default, or a deterministic authorized fallback. Later turns may retain the same session's last trusted automatic routing selection only while its recorded owner, profile/version, default generation, policy/declaration revisions, and live authority remain current. Saved historical user profile preferences are not an input. A default, policy, declaration, credential, or grant change invalidates reuse and returns admission to current administrator configuration; retaining an incumbent does not itself prove a prompt-cache hit.

The administrator's current authorized, compatible default/fallback is the safe choice when current-task classification is unavailable, invalid, or below the confidence threshold. A previously routed nondefault must requalify against the **new** task declaration; a known insufficient incumbent upgrades to a sufficient eligible model even when that costs more. A configured default rejected by current-request framing/schema preflight is never dispatched: unknown classification may retain the still-authorized compatible admitted binding, but known insufficiency with neither a sufficient alternative nor a compatible safe default fails explicitly. Classifier failure alone does not block ordinary conversation; no model can bypass live authority, capability, or budget fences.

The comparison includes classifier overhead, expected output, input/output prices, and switching loss. The incumbent may retain its usable compacted history. An alternative must account for **canonical history replay**, candidate-specific frames/tools/schema, and loss of incompatible hidden continuation/compaction. A switch cannot inherit another provider's compacted state as free context. Unknown prompt-cache pricing or reuse earns **no assumed discount**. Expected history tokens and savings are estimates, not provider-observed usage or measured delegation savings.

Cost is the primary economic ranking. Configured latency breaks equal-cost sufficient-candidate ties only when every equally cheap candidate has an administrator latency estimate; otherwise UUID ordering is deterministic and unknown latency earns no invented comparison. Receipts label these values `administrator-estimates`, separately from observed classifier latency. Savings thresholds govern discretionary downgrades, not upgrades required by a confidently classified task.

### Hard quota reserve versus expected estimate

Before paying for a discretionary downgrade classification, the host checks whether expected savings could cover the bounded request's estimated overhead. A retained nondefault instead needs current-task validation even when there is no cheaper alternative: prior-task sufficiency is not proof for new work. Both paths use an explicitly labelled serialized-byte/framing cost proxy, not a tokenizer measurement, and both require the hard budget reserve below.

Classification then requires a separate **hard admission reserve** through the existing owner/day/run/goal budget. For supported native Jev names (`jev-1.13.0`, `jev-latest`, `jev-preview`), the bound is the documented 64,000-token whole-request context exposure, priced at the maximum configured directional rate plus per-request cost; it is not the expected number of tokens in a short classification. Other native model names with unknown limits do not classify automatically. Custom compatible classification reserves the host-enforced 128 KiB serialized-body input proxy plus configured `maxOutputTokens`; this is labelled a byte/token proxy, not a verified native tokenizer/context limit. See the native limit source at <https://docs.typesafe.ai/models#current-models>.

After a response, validated **full totals**, including independent reported residual tokens, reconcile the reservation exactly once. Routing decisions durably bind owner/session/run, policy/model/provider revisions, classifier usage and total provenance, selection, latency, reservation basis, expected-cost basis, estimated costs/savings, and failure exposure. Replay/approval continuation reuses that decision and its accounting rather than classifying or charging its receipt twice. A reservation is not added to terminal measured usage. If a paid request has no usable receipt, its unmeasured exposure remains held/accounted; failure is not free inference. Budget overrun is a normal explicit failure, not permission to erase paid usage and run the fallback anyway.

### Workspace behavior and existing goals

Users do not select a provider, choose a “default model,” or pin/unpin a model. Conversation pinning in History remains a separate organizational action. Session creation accepts retention settings, not a model selection; ordinary profile-catalog and session-profile mutation endpoints are not part of the user workspace.

Automatic optimization chooses **stay** or **swap** between durable turns/runs, before paid root/task inference, tools, or approval activity. Stay retains an authorized root binding and its compatible native continuation. Swap changes the root model at that boundary, replays canonical history with candidate-specific frames/tools/schema, and drops incompatible binding-specific hidden state/compaction. It cannot inherit the previous model's provider cache as free context. Approval replay keeps the admitted binding and routing/accounting receipt rather than reclassifying midway through an approval.

There is no automatic specialist delegation or asynchronous Ax subagent worker in this routing path. A separate specialist history plus handoff and root synthesis is not a free cache-saving substitute for a cold swap; Ax does not guarantee a cross-model prompt-cache hit. Existing Wiki research/goal orchestration and historical specialist records are preserved, not promoted into current routing capabilities. Eligible new durable-goal continuations retain their existing quotas, tool limits, deadlines, native continuation, and authorization.

Routing receipts and generative model/version bindings are internal operational records, not workspace choices or visible model-selection diagnostics. The ordinary workspace reports Agent/task activity, approvals, tool availability, and outcomes without displaying providers, model versions, classifier estimates, or speculative cache savings. Skills, personal MCP controls, Memories, conversation history, and goals retain their existing ownership and permission boundaries.

## Control API and conflict handling

All routes below are under `/_api/agents`. They require authenticated current-account Agent access (`use:agents`); writes use the existing same-origin/CSRF boundary. Admin routes additionally require current `manage:system`, and services independently check the current actor. Actor/owner identity comes from authentication, not a request-body impersonation field.

| Control | Routes |
| --- | --- |
| Decision providers | `GET/POST /admin/decision-providers`; `PUT/DELETE /admin/decision-providers/:id`; `POST .../:id/check`, `.../:id/enabled`, `.../:id/default` |
| Admin MCP records | `GET/POST /admin/external-mcp`; `PUT/DELETE /admin/external-mcp/:id`; `PUT .../:id/grants` |
| Personal-create group policies | `GET /admin/external-mcp/group-policies`; `PUT .../group-policies/:groupId` |
| Personal records | `GET/POST /personal-mcp`; `PUT/DELETE /personal-mcp/:id` |
| Currently available MCP / discovery | `GET /external-mcp`; `POST /external-mcp/:id/discover` |
| Per-user OAuth account | `GET /external-mcp/:id/oauth`; `POST .../oauth/connect`; `DELETE .../oauth` |
| Routing | `GET/PUT /admin/routing`; `PUT/DELETE /admin/routing/models/:profileId` |

Record updates/deletes and state actions send the latest `expectedRevision`; decision create uses `displayName`, `config`, and optional `secretValue`. Enable sends `enabled`; default/check send the revision. MCP grant updates send `groupIds`; group-policy writes send `allowPersonalEndpoints`. Routing writes send the complete policy, and declarations send the current version, `acceptableTasks`, and nullable latency. First creation of a model declaration or absent group policy uses revision zero. A stale revision returns a conflict: refresh, review the current record, and intentionally resubmit instead of overwriting newer changes. Check responses and catalog displays are safe diagnostics, not raw credential-bearing responses.

This guide describes implemented configuration and runtime contracts, not a deployment attestation. It does not claim completed integrated build/test gates, deployed UI verification, or end-to-end runtime proof. For the surrounding deployment controls and operational limits, see [Agent deployment and operations](agents-deployment.md); for everyday conversation interaction, see [Wiki Agent workspace](agent-workspace.md).
