# Admin User Detail REST Slice Plan

> For Hermes: execute as one narrow verified slice with subagent review before commit.

Goal: move the read-only bootstrap and refresh path in `client/components/admin/admin-users-edit.vue` from GraphQL to a new REST detail endpoint while leaving all user mutations on GraphQL.

Architecture: extend the existing users REST controller/helper/test surface with a single detail endpoint, `GET /_api/users/:id`, that returns the exact user shape currently consumed by `admin-users-edit.vue`. Reuse the established groups/auth/detail migration pattern: explicit server-side payload shaping, helper validation, manual fetch-based page bootstrap, and no mutation transport changes.

Tech Stack: Express, Objection/Knex, Vue 2, Apollo for mutations only, fetch-based REST helper, Jest, Yarn.

---

### Task 1: Add user detail REST endpoint

Objective: expose the current admin user detail bootstrap payload as a narrow read-only REST route.

Files:
- Modify: `server/controllers/api/users.js`
- Modify: `server/test/controllers/api.users.test.js`

Steps:
1. Add `GET /_api/users/:id` after literal users routes like `/search` and `/whoami`.
2. Guard it with the same access envelope as GraphQL `users.single`:
   - `manage:users`
   - `manage:system`
3. Validate `id` as a positive integer string; return JSON `400` for malformed ids.
4. Return JSON `404` if the user does not exist.
5. Return only the fields consumed by `admin-users-edit.vue`:
   - `id`
   - `name`
   - `email`
   - `providerKey`
   - `providerName`
   - `providerId`
   - `providerIs2FACapable`
   - `location`
   - `jobTitle`
   - `timezone`
   - `isSystem`
   - `isActive`
   - `isVerified`
   - `createdAt`
   - `updatedAt`
   - `lastLoginAt`
   - `tfaIsActive`
   - `groups: [{ id, name }]`
6. Derive provider metadata safely from `WIKI.auth.strategies` and fall back cleanly if strategy metadata is missing.
7. Do not leak sensitive fields like `password`, `tfaSecret`, `permissions`, or other internals.
8. Forward unexpected errors to `next(err)`.

Verification:
- `corepack yarn jest --runInBand server/test/controllers/api.users.test.js`

### Task 2: Extend the shared users helper

Objective: add a REST helper for admin user detail bootstrap.

Files:
- Modify: `client/helpers/users-api.js`
- Modify: `client/helpers/users-api.test.js`

Steps:
1. Add `fetchUserDetails(fetchImpl, id, fallbackMessage)`.
2. Validate the top-level user fields listed above.
3. Validate nested `groups` rows as only:
   - `id`
   - `name`
4. Preserve the existing `searchUsers(...)` helper behavior unchanged.

Verification:
- `corepack yarn jest --runInBand client/helpers/users-api.test.js`

### Task 3: Move admin user detail bootstrap to REST

Objective: replace the Apollo bootstrap query in `admin-users-edit.vue` with helper-backed REST loading while keeping all mutations on GraphQL.

Files:
- Modify: `client/components/admin/admin-users-edit.vue`

Steps:
1. Remove the Apollo `user` bootstrap query.
2. Import `fetchUserDetails` from `../../helpers/users-api`.
3. Add `loadUser()` using the route param id and `window.fetch.bind(window)`.
4. Keep the existing `admin-users-refresh` loading token.
5. Make `refresh()` or route-change handling reuse the REST loader.
6. Add route-param reload handling and stale-request protection so old responses cannot overwrite newer route changes.
7. Keep these on GraphQL and unchanged in scope:
   - activate/deactivate
   - delete
   - update
   - verify
   - enable/disable TFA
8. Keep the existing groups picker REST bootstrap unchanged.

Verification:
- `corepack yarn test`
- `corepack yarn build`

### Task 4: Independent review and commit

Objective: ensure the slice remains narrow, safe, and merge-ready.

Files:
- Review diff for:
  - `server/controllers/api/users.js`
  - `server/test/controllers/api.users.test.js`
  - `client/helpers/users-api.js`
  - `client/helpers/users-api.test.js`
  - `client/components/admin/admin-users-edit.vue`

Steps:
1. Run targeted tests if needed.
2. Run full test suite.
3. Run production build.
4. Dispatch spec review.
5. Dispatch code-quality review.
6. Commit only if reviews approve and verification stays green.

Commit target:
- `[verified] feat: move admin user detail bootstrap to REST`
