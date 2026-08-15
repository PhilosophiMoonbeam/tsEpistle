# Admin Group Detail REST Slice Plan

> For Hermes: execute as one narrow verified slice with subagent review before commit.

Goal: move the read-only bootstrap and refresh path in `client/components/admin/admin-groups-edit.vue` from GraphQL to a new REST detail endpoint while leaving all group mutations and user assignment mutations on GraphQL.

Architecture: extend the existing groups REST controller/helper/test surface with a single detail endpoint, `GET /_api/groups/:id`, that returns the exact group shape currently consumed by `admin-groups-edit.vue`. Preserve the page’s single-object contract so the permissions, rules, and users tabs continue to receive one shared `group` object. Keep all writes and business-rule enforcement on existing GraphQL mutations.

Tech Stack: Express, Objection/Knex, Vue 2, Apollo for mutations only, fetch-based REST helper, Jest, Yarn.

---

### Task 1: Add groups detail REST endpoint

Objective: expose the current admin group detail bootstrap payload as a narrow read-only REST route.

Files:
- Modify: `server/controllers/api/groups.js`
- Modify: `server/test/controllers/api.groups.test.js`

Steps:
1. Add `GET /_api/groups/:id` behind the same access envelope as GraphQL `groups.single` and REST `/list`:
   - `write:groups`
   - `manage:groups`
   - `manage:system`
2. Validate the `id` param as a positive integer; return JSON `400` for malformed ids.
3. Return JSON `404` if the group does not exist.
4. Query the group by id and explicitly map only the fields needed by `admin-groups-edit.vue`:
   - `id`
   - `name`
   - `redirectOnLogin`
   - `isSystem`
   - `permissions`
   - `pageRules`
   - `users: [{ id, name, email }]`
   - `createdAt`
   - `updatedAt`
5. Avoid leaking extra user/group fields.
6. Forward unexpected errors to `next(err)`.

Verification:
- `corepack yarn jest --runInBand server/test/controllers/api.groups.test.js`

### Task 2: Add client helper for group detail bootstrap

Objective: add a REST helper that validates the group detail payload expected by the edit page.

Files:
- Modify: `client/helpers/groups-api.js`
- Modify: `client/helpers/groups-api.test.js`

Steps:
1. Add `fetchGroupDetails(fetchImpl, id, fallbackMessage)`.
2. Validate:
   - scalar group fields
   - `permissions` as string array
   - `pageRules` rows with `id`, `path`, `roles`, `match`, `deny`, `locales`
   - `users` rows with `id`, `name`, `email`
3. Reuse existing JSON parsing/error propagation patterns.

Verification:
- `corepack yarn jest --runInBand client/helpers/groups-api.test.js`

### Task 3: Move admin group edit bootstrap to REST

Objective: remove the GraphQL bootstrap query from `admin-groups-edit.vue` and replace it with REST loading while keeping all mutations unchanged.

Files:
- Modify: `client/components/admin/admin-groups-edit.vue`

Steps:
1. Remove the Apollo `group` bootstrap query.
2. Import `fetchGroupDetails` from `../../helpers/groups-api`.
3. Add `loadGroup()` using the route param id and `window.fetch.bind(window)`.
4. Keep the existing `admin-groups-refresh` loading token.
5. Make `refresh()` call `loadGroup()`.
6. Preserve the page’s shared `group` object contract for the tabs.
7. Keep these on GraphQL and unchanged in scope:
   - `updateGroup`
   - `deleteGroup`
   - `assignUser`
   - `unassignUser`

Verification:
- `corepack yarn test`
- `corepack yarn build`

### Task 4: Independent review and commit

Objective: ensure the slice remains narrow, compatible, and merge-safe.

Files:
- Review diff for:
  - `server/controllers/api/groups.js`
  - `server/test/controllers/api.groups.test.js`
  - `client/helpers/groups-api.js`
  - `client/helpers/groups-api.test.js`
  - `client/components/admin/admin-groups-edit.vue`

Steps:
1. Run targeted tests if needed.
2. Run full test suite.
3. Run production build.
4. Dispatch spec review.
5. Dispatch code-quality review.
6. Commit only if reviews approve and verification stays green.

Commit target:
- `[verified] feat: move admin group detail bootstrap to REST`
