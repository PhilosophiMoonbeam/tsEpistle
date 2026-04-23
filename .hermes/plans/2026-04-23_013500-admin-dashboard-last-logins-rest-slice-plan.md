# Admin Dashboard Last Logins REST Slice Plan

> For Hermes: use subagent-driven-development review discipline for this slice, but implement it directly in one narrow verified batch.

Goal: move only the admin dashboard last-logins widget off GraphQL and onto a narrow users REST endpoint.

Architecture:
- Extend the existing users REST lane with a compact read-only `GET /_api/users/last-logins` endpoint.
- Reuse the current dashboard permission semantics exactly.
- Keep recent pages on GraphQL for now.

Tech stack: Express controller under `server/controllers/api`, existing Jest controller-shell tests, Vue 2 admin dashboard, `client/helpers/users-api.js`.

---

Scope
- Add `GET /_api/users/last-logins`.
- Add helper `fetchLastLogins(fetchImpl, fallbackMessage)`.
- Replace only the `lastLogins` Apollo bootstrap in `client/components/admin/admin-dashboard.vue`.

Out of scope
- `recentPages` dashboard widget.
- admin users paginated list.
- any user mutations.
- broader dashboard GraphQL cleanup.

Files
- Modify: `server/controllers/api/users.js`
- Modify: `server/test/controllers/api.users.test.js`
- Modify: `client/helpers/users-api.js`
- Modify: `client/helpers/users-api.test.js`
- Modify: `client/components/admin/admin-dashboard.vue`

Endpoint contract
- Route: `GET /_api/users/last-logins`
- Permissions: exactly the dashboard’s current `canViewLastLogins` set:
  - `manage:system`
  - `manage:groups`
  - `write:groups`
  - `manage:users`
  - `write:users`
- Response:
  - array of rows
  - each row: `{ id: integer, name: string, lastLoginAt: string }`
- Query behavior:
  - select only `id`, `name`, `lastLoginAt`
  - `whereNotNull('lastLoginAt')`
  - `orderBy('lastLoginAt', 'desc')`
  - `limit(10)`

Implementation notes
- Register `/last-logins` before `/:id` so the detail route does not swallow it.
- Return JSON 403 with a route-appropriate message.
- Keep response mapping explicit even though the query is already narrow.
- In the helper, validate every row and reject malformed payloads.
- In the dashboard component:
  - import `fetchLastLogins`
  - load in `created()` only when `canViewLastLogins`
  - preserve `lastLoginsLoading`
  - preserve store loading token `admin-dashboard-lastlogins`
  - on failure, notify the user and keep the widget stable

Verification
- Targeted Jest:
  - `corepack yarn jest --runInBand server/test/controllers/api.users.test.js client/helpers/users-api.test.js`
- Full suite:
  - `corepack yarn test`
  - `corepack yarn build`
- Independent review after implementation:
  - spec review
  - code-quality review

Commit boundary
- `[verified] feat: move dashboard last logins to REST`
