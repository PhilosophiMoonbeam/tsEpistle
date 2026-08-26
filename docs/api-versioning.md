# External REST API versioning

tsFranki exposes its supported external REST API under `/api/v1`. The live OpenAPI 3.1 contract is available without authentication at `/api/v1/openapi.json`.

## Supported v1 surface

- `GET /api/v1/pages` — bounded, permission-filtered page metadata pagination.
- `GET /api/v1/pages/{id}` — metadata for one readable page.

All other `/api/v1` requests are unsupported. Bearer API keys inherit the permissions and page rules of their assigned group; the API does not bypass private-page ownership or group rules.

## Compatibility policy

Within `/api/v1`, releases may add endpoints, optional request fields, response fields, response status codes, or enum values. They must not remove documented endpoints, parameters, responses, required response fields, enum values, or authentication requirements; narrow accepted numeric or string ranges; or change documented field types and meanings.

A breaking contract requires a new major path such as `/api/v2`. The prior major remains available until its separately announced removal date.

`server/contracts/openapi-v1-baseline.json` is the minimum released v1 contract. Update it only when cutting a release after the current contract has passed review. `pnpm run openapi:check` compares the implementation-owned document against that baseline and runs the Redocly OpenAPI 3.1 validator. CI rejects structural errors and backward-incompatible changes.
