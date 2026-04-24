# Admin API read bootstrap REST slice plan

## Objective
Move the read-only bootstrap for `client/components/admin/admin-api.vue` from Apollo smart queries to a narrow REST endpoint while preserving existing GraphQL mutations for create, revoke, and global enable/disable.

## Scope
- Add `GET /_api/auth/api` under the existing Express auth REST controller.
- Return one focused payload:
  - `enabled`: strict boolean from `WIKI.config.api.isEnabled === true`
  - `keys`: API key metadata only, ordered like GraphQL and with no full key material.
- Add a client helper to fetch, validate, and sanitize this payload.
- Update `admin-api.vue` so initial load, refresh, and post-mutation refresh use REST for reads.
- Keep GraphQL mutations unchanged in this slice.

## Out of scope
- Do not port Scarlett Fastify/ky/Pinia/API-client architecture.
- Do not migrate create/revoke/setApiState mutations to REST in this slice.
- Do not change API key model schema, id type, or auth/session model.
- Do not add organizational features.

## Parity requirements
- Permission parity with GraphQL schema:
  - `manage:system` or `manage:api`
- Key query parity with GraphQL resolver:
  - `WIKI.models.apiKeys.query().orderBy(['isRevoked', 'name'])`
- Response key mapping parity:
  - `id`
  - `name`
  - `keyShort: '...' + key.substring(key.length - 20)`
  - `isRevoked`
  - `expiration`
  - `createdAt`
  - `updatedAt`
- Never return `key` or any extra model fields.

## Implementation steps
1. Backend
   - Add route-level permission helper in `server/controllers/api/auth.js`.
   - Add safe API-key row mapper.
   - Add `GET /api` route returning `{ enabled, keys }`.
   - Forward unexpected errors to `next(err)`.

2. Backend tests
   - Extend `server/test/controllers/api.auth.test.js` with `WIKI.config.api` and `WIKI.models.apiKeys` mocks.
   - Cover route registration, permission parity, authorized payload, strict enabled normalization, no full key leakage, unauthorized 403, and error forwarding.

3. Client helper
   - Add `fetchAdminApiBootstrap` to `client/helpers/auth-api.js`.
   - Validate root payload and key rows.
   - Return sanitized root/key objects and strip unexpected fields.

4. Client helper tests
   - Add fetch options/path expectation.
   - Validate sorting is backend-owned, not client-side for this payload.
   - Cover malformed root rows, malformed key rows, API JSON errors, and no extra field propagation.

5. Vue component
   - Import `fetchAdminApiBootstrap`.
   - Replace Apollo smart queries for `enabled` and `keys` with `mounted()` + REST refresh.
   - Preserve existing loading tokens where practical:
     - `admin-api-state-refresh`
     - `admin-api-keys-refresh`
   - Use REST refresh after successful `setApiState`, create-dialog refresh, and revoke success.
   - Keep mutation GraphQL code in place.

## Verification
- Targeted Jest:
  - `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js client/helpers/auth-api.test.js`
- Full verification:
  - `corepack yarn test`
  - `corepack yarn build`
- Independent subagent review after implementation.
- Commit only after passing tests/build and resolving review findings.
