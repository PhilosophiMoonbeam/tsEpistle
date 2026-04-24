# Shared Admin User Search REST Slice Plan

> For Hermes: execute as one narrow verified slice with subagent review before commit.

Goal: move the shared admin user-search dialog in `client/components/common/user-search.vue` from GraphQL to REST so both admin group-user assignment and admin user-delete replacement flows use the same read-only REST bootstrap.

Architecture: add a minimal `GET /_api/users/search?query=...` endpoint to the existing users REST controller, guarded by the same permissions as GraphQL `users.search`. Create a small `client/helpers/users-api.js` helper that validates the minimal dialog payload. Replace only the GraphQL bootstrap in the shared dialog component; keep all consuming admin mutations unchanged.

Tech Stack: Express, Objection/Knex, Vue 2, fetch-based REST helper, Jest, Yarn.

---

### Task 1: Add users search REST endpoint

Objective: expose the current shared admin user-search query as a narrow REST route.

Files:
- Modify: `server/controllers/api/users.js`
- Modify: `server/test/controllers/api.users.test.js`

Steps:
1. Add `GET /_api/users/search`.
2. Guard it with the same effective access as GraphQL `users.search`:
   - `write:groups`
   - `manage:groups`
   - `write:users`
   - `manage:users`
   - `manage:system`
3. Read `req.query.query`, trim it, and if its length is below 2 return `[]`.
4. Query users by `email` or `name` with the same simple search semantics and limit `10`.
5. Return only the minimal dialog payload:
   - `id`
   - `name`
   - `email`
6. Do not leak `providerKey`, `createdAt`, or other user fields.
7. Forward unexpected errors to `next(err)`.

Verification:
- `corepack yarn jest --runInBand server/test/controllers/api.users.test.js`

### Task 2: Add shared client helper

Objective: add a tiny REST helper for the shared dialog.

Files:
- Create: `client/helpers/users-api.js`
- Create: `client/helpers/users-api.test.js`

Steps:
1. Add `searchUsers(fetchImpl, query, fallbackMessage)`.
2. Validate the returned array rows as:
   - integer `id`
   - non-empty string `name`
   - non-empty string `email`
3. Reuse the same JSON parsing / API error propagation style as the other helpers.
4. Return an empty array without a fetch when the trimmed query is under 2 chars.

Verification:
- `corepack yarn jest --runInBand client/helpers/users-api.test.js`

### Task 3: Move the shared dialog to REST

Objective: replace the Apollo bootstrap in the shared user-search component with helper-backed REST loading.

Files:
- Modify: `client/components/common/user-search.vue`

Steps:
1. Remove the inline GraphQL query/apollo block.
2. Import `searchUsers` from `../../helpers/users-api`.
3. Add a watcher-driven/manual search loader that preserves current UX:
   - min 2 chars before searching
   - loading spinner behavior
   - clears results when search becomes too short
4. Add stale-request protection so older async search responses cannot overwrite newer typing results.
5. Keep emitted selected payload behavior compatible with current callers.

Verification:
- `corepack yarn test`
- `corepack yarn build`

### Task 4: Independent review and commit

Objective: ensure the slice remains narrow, shared, and safe.

Files:
- Review diff for:
  - `server/controllers/api/users.js`
  - `server/test/controllers/api.users.test.js`
  - `client/helpers/users-api.js`
  - `client/helpers/users-api.test.js`
  - `client/components/common/user-search.vue`

Steps:
1. Run targeted tests if needed.
2. Run full test suite.
3. Run production build.
4. Dispatch spec review.
5. Dispatch code-quality review.
6. Commit only if reviews approve and verification stays green.

Commit target:
- `[verified] feat: move shared admin user search to REST`
