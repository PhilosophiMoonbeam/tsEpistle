# External REST API versioning

tsEpistle exposes its supported external REST API under `/api/v1`. The live OpenAPI 3.1 contract is available without authentication at `/api/v1/openapi.json`.

## Supported v1 surface

- `GET /api/v1/pages` — bounded, permission-filtered page metadata pagination.
- `GET /api/v1/pages/{id}` — metadata for one readable page.

All other `/api/v1` requests are unsupported. Bearer API keys inherit the permissions and page rules of their assigned group; the API does not bypass private-page ownership or group rules.

## API-key transport boundary

Bearer API keys are admitted only on the exact GraphQL endpoint `/graphql` and the `/api/v1` namespace. The exact `/mcp` endpoint is a separate mount: it accepts only a resource-bound API key and additionally requires `use:mcp` or system authority. API keys are rejected before principal state is assigned on browser routes, internal `/_api` routes, REST-prefix lookalikes, and MCP paths outside that dedicated mount.

This is transport confinement, not a reduction of the key's permissions. Operators must enable and expose API or MCP access deliberately, use TLS, and keep bearer values out of logs and untrusted clients. A stolen key can exercise the live permissions and page rules of its assigned group on every admitted transport until it is revoked; a key carrying the MCP resource claim can also reach `/mcp` when its group has the required permission.

The executable contract is `shared/api-access.ts` together with `server/test/core/auth.api-access.test.ts`; MCP's separate mount and resource/permission checks are exercised by `server/test/agents/mcp.test.ts`. GraphQL and MCP are not covered by the REST v1 compatibility promise below.

## Browser profile account binding

Browser self-service profile mutations require `X-TsEpistle-Profile-Account`, containing the account ID returned by the profile read. This applies to profile details, preferences, avatar upload/removal, and password changes under `/_api/users/profile`, and to the corresponding GraphQL mutations. The header is not an authorization credential: the current authenticated human principal must still satisfy the operation's verification and provider requirements.

Missing or malformed draft identities are rejected before account lookup or persistence (`400` in REST). A valid identity that differs from the current cookie principal is rejected with REST `409`; GraphQL returns its ordinary failure envelope with the `STALE_PROFILE` slug. Clients must reload the new account's profile rather than retargeting an old draft. Profile reads do not require this header. The internal browser and GraphQL contracts are outside the `/api/v1` compatibility promise below.

## Internal browser page directory

The Knowledge Workbench inventories use `GET /_api/pages/directory`, not the external v1 API. It accepts bounded `limit` (1–100, default 25) and `offset`. The remaining filters cover search, locale, visibility, publication, creator/editor, tags, and untagged pages, with `orderBy` and `orderByDirection` controlling sort order. Creator/editor filtering is an OR for account-scoped inventories. Search applies all terms to supported metadata fields; tag matching resolves canonical identities and historical aliases.

Responses contain `items`, `nextOffset`, and `scanned`. Filtering applies before window progression. A result window scans at most 1,000 authorized candidates and can legitimately contain no visible items with a non-null `nextOffset`; clients must continue rather than call that an exhausted corpus. An empty terminal window also describes only that window, not the corpus: prior windows remain reachable without promising an unavailable Next action. Unreadable pages do not advance the reported offset or scan count. Publication filters respect field projection, including readers who cannot see publication metadata. Loaded-window counts are not corpus totals. Filtered JSON inventory export follows every continuation instead of exporting only the loaded UI window.

Unrestricted read authority has a direct query path. Restricted page policies require a content-free authorization pass over all matching candidates before pagination, so the window bound is **not** a bound on total authorization work. Offsets are not snapshots: concurrent inserts, removals, or sort-key changes can shift later windows. This endpoint remains outside the `/api/v1` compatibility promise.

Account inventories wait for a positive signed-in account ID and discard stale responses after account changes; they never request identity `0` or fall back to an unscoped inventory. Internal page-detail and route reads return normalized `pageFeatures`, so saved Links, Ratings, and Last Editor settings remain consistent when reopening the editor or reading the page. Existing page and field authorization still applies.

## Compatibility policy

Within `/api/v1`, releases may add endpoints, optional request fields and parameters, response fields, response status codes, or enum values. They must not add required request-body properties; add required query, path, or header parameters; remove documented endpoints, parameters, responses, required response fields, enum values, or authentication requirements; narrow accepted numeric or string ranges; or change documented field types and meanings.

A breaking contract requires a new major path such as `/api/v2`. The prior major remains available until its separately announced removal date.

`server/contracts/openapi-v1-baseline.json` is the minimum released v1 contract. Update it only when cutting a release after the current contract has passed review. `pnpm run openapi:check` compares the implementation-owned document against that baseline and runs the Redocly OpenAPI 3.1 validator. CI rejects structural errors and backward-incompatible changes.
