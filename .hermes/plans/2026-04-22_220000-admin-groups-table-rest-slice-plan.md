# Admin groups table REST slice plan

> For Hermes: use subagent-driven-development style execution with independent review before commit.

Goal: move the admin groups table read path off GraphQL onto REST, while preserving the existing group create mutation and all group detail/edit flows on GraphQL.

Architecture:
- Keep the existing shared picker endpoint `GET /_api/groups` unchanged with its broader admin-picker permission envelope and minimal payload.
- Add a separate stricter list endpoint, `GET /_api/groups/list`, returning only the admin groups table payload:
  - `id`
  - `name`
  - `isSystem`
  - `userCount`
  - `createdAt`
  - `updatedAt`
- Gate the table route with the current GraphQL groups-list parity permission set:
  - `write:groups`
  - `manage:groups`
  - `manage:system`
- Extend the groups REST helper with a dedicated table-list fetcher and migrate only `client/components/admin/admin-groups.vue` read/refresh behavior to REST. Keep the create mutation on GraphQL for now.

Tech stack: Express controllers, current Objection group model query patterns, Vue 2 admin component, Jest controller/helper tests, full `corepack yarn test` and `corepack yarn build` verification.

Implementation tasks:
1. Extend `server/controllers/api/groups.js` with `GET /list` using a stricter groups-admin permission check and a minimal explicit response mapper.
2. Expand `server/test/controllers/api.groups.test.js` for route registration, table-list permission denial, and table payload shape/non-leakage.
3. Extend `client/helpers/groups-api.js` with `fetchGroupsList(fetchImpl)` and add helper tests for the table payload validator.
4. Migrate `client/components/admin/admin-groups.vue` from Apollo read/refetch to REST list loading/refresh while keeping `createGroupMutation` on GraphQL.
5. After successful group creation, refresh the REST list instead of mutating the Apollo cache for the old list query.
6. Leave out of scope:
   - `client/components/admin/admin-groups-edit.vue`
   - `client/components/admin/admin-groups-edit-users.vue`
   - group create/update/delete/assign/unassign REST migration
   - any widening of the existing picker route
7. Run targeted Jest for groups controller/helper/API shell as needed, then full `corepack yarn test`, then `corepack yarn build`.
8. Run independent spec and code-quality reviews; fix findings before committing.

Guardrails:
- Do not widen the existing `GET /_api/groups` picker payload or permissions.
- Do not reuse the broad picker permissions for the table route.
- Do not add server-side filtering/sorting/pagination in this slice; keep parity with the current full-list GraphQL read.
- Do not move the create mutation to REST in this batch.
