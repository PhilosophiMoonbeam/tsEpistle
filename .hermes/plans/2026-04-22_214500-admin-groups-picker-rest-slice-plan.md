# Admin groups picker REST slice plan

> For Hermes: use subagent-driven-development style execution with independent review before commit.

Goal: move the shared read-only admin groups picker bootstrap off GraphQL onto REST, while preserving all existing group write flows and the heavier admin-groups table/detail GraphQL surfaces.

Architecture:
- Add a narrow `GET /_api/groups` endpoint that returns only the minimal shared picker payload: `[{ id, name, isSystem }]`.
- Keep the endpoint admin-only and align its permissions to the real shared picker consumers: `write:groups`, `manage:groups`, `manage:system`, `write:users`, `manage:users`, `manage:navigation`, or `manage:api`.
- Add a small client helper for fetching/validating group options and migrate only the existing picker consumers. Do not touch group mutations or the full groups admin table/detail GraphQL surfaces in this slice.

Tech stack: Express router controllers, existing `WIKI.auth.checkAccess(...)` and Objection models, Vue 2 admin components, Jest controller/helper tests, full `corepack yarn test` and `corepack yarn build` verification.

Implementation tasks:
1. Create `server/controllers/api/groups.js` with `GET /_api/groups` minimal picker payload and JSON 403 behavior.
2. Mount the groups router in `server/controllers/api/index.js` and extend `server/test/controllers/api.index.test.js` accordingly.
3. Add `server/test/controllers/api.groups.test.js` covering route registration, permission denial, minimal payload shape, and non-leakage of extra group fields.
4. Create `client/helpers/groups-api.js` with `fetchGroupOptions(fetchImpl)` plus `client/helpers/groups-api.test.js`.
5. Migrate only these picker/bootstrap consumers from GraphQL to the REST helper:
   - `client/components/admin/admin-users-create.vue`
   - `client/components/admin/admin-users-edit.vue`
   - `client/components/admin/admin-api-create.vue`
   - `client/components/admin/admin-auth.vue`
   - `client/components/admin/admin-navigation.vue`
6. Leave these out of scope for now:
   - `client/components/admin/admin-groups.vue`
   - `client/components/admin/admin-groups-edit.vue`
   - `client/components/admin/admin-groups-edit-users.vue`
   - any group create/update/delete/assign/unassign mutations
7. Run targeted Jest for groups controller/helper and API shell tests, then full `corepack yarn test`, then full `corepack yarn build`.
8. Run independent spec and code-quality reviews; fix findings before committing.

Guardrails:
- Do not broaden access beyond current GraphQL parity in this slice.
- Do not add full group-table fields like `userCount`, `createdAt`, or `updatedAt` to the REST picker payload.
- Do not filter out Guests or Administrators server-side in this slice; keep client-side consumer behavior unchanged.
- Do not widen this work into group detail or mutation REST migration.
