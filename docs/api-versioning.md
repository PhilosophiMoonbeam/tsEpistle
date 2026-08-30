# External REST API versioning

tsFranki exposes its supported external REST API under `/api/v1`. The live OpenAPI 3.1 contract is available without authentication at `/api/v1/openapi.json`.

## Supported v1 surface

- `GET /api/v1/pages` — bounded, permission-filtered page metadata pagination.
- `GET /api/v1/pages/{id}` — metadata for one readable page.

All other `/api/v1` requests are unsupported. Bearer API keys inherit the permissions and page rules of their assigned group; the API does not bypass private-page ownership or group rules.

## API-key transport boundary

Bearer API keys are admitted only on the exact GraphQL endpoint `/graphql` and the `/api/v1` namespace. The exact `/mcp` endpoint is a separate mount: it accepts only a resource-bound API key and additionally requires `use:mcp` or system authority. API keys are rejected before principal state is assigned on browser routes, internal `/_api` routes, REST-prefix lookalikes, and MCP paths outside that dedicated mount.

This is transport confinement, not a reduction of the key's permissions. Operators must enable and expose API or MCP access deliberately, use TLS, and keep bearer values out of logs and untrusted clients. A stolen key can exercise the live permissions and page rules of its assigned group on every admitted transport until it is revoked; a key carrying the MCP resource claim can also reach `/mcp` when its group has the required permission.

The executable contract is `shared/api-access.ts` together with `server/test/core/auth.api-access.test.ts`; MCP's separate mount and resource/permission checks are exercised by `server/test/agents/mcp.test.ts`. GraphQL and MCP are not covered by the REST v1 compatibility promise below.

## Compatibility policy

Within `/api/v1`, releases may add endpoints, optional request fields and parameters, response fields, response status codes, or enum values. They must not add required request-body properties; add required query, path, or header parameters; remove documented endpoints, parameters, responses, required response fields, enum values, or authentication requirements; narrow accepted numeric or string ranges; or change documented field types and meanings.

A breaking contract requires a new major path such as `/api/v2`. The prior major remains available until its separately announced removal date.

`server/contracts/openapi-v1-baseline.json` is the minimum released v1 contract. Update it only when cutting a release after the current contract has passed review. `pnpm run openapi:check` compares the implementation-owned document against that baseline and runs the Redocly OpenAPI 3.1 validator. CI rejects structural errors and backward-incompatible changes.
