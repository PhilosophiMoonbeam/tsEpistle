# Admin System Info REST Slice Plan

> For Hermes: use subagent-driven-development review discipline conceptually, but keep this as one narrow verified slice.

Goal: move the read-only bootstrap/refresh path in `client/components/admin/admin-system.vue` from GraphQL to the existing REST `/_api/system/info` endpoint while leaving upgrade behavior on GraphQL.

Architecture: reuse the already-landed `server/controllers/api/system.js` `GET /_api/system/info` route and the existing `client/helpers/system-api.js` helper module. Tighten helper validation so `fetchSystemInfo()` validates the richer admin-system payload instead of only the dashboard summary subset. Update only the admin system page bootstrap and refresh path.

Tech Stack: Vue 2, Apollo (retained for upgrade mutation only), fetch-based REST helper, Jest, Yarn.

---

### Task 1: Tighten system-info helper validation

Objective: make `fetchSystemInfo()` validate the richer `/info` payload used by the admin system page.

Files:
- Modify: `client/helpers/system-api.js`
- Modify: `client/helpers/system-api.test.js`

Steps:
1. Split summary validation from richer info validation.
2. Keep `fetchSystemSummary()` validating only dashboard-safe fields.
3. Make `fetchSystemInfo()` require the admin-system fields already rendered by `admin-system.vue`:
   - `configFile`
   - `cpuCores`
   - `currentVersion`
   - `dbHost`
   - `dbType`
   - `dbVersion`
   - `hostname`
   - `latestVersion`
   - `latestVersionReleaseDate`
   - `nodeVersion`
   - `operatingSystem`
   - `platform`
   - `ramTotal`
   - `upgradeCapable`
   - `workingDirectory`
4. Preserve existing error propagation semantics.

Verification:
- `corepack yarn jest --runInBand client/helpers/system-api.test.js`

### Task 2: Move admin system bootstrap/refresh to REST

Objective: remove the GraphQL info bootstrap from the admin system page and replace it with fetch-based loading.

Files:
- Modify: `client/components/admin/admin-system.vue`

Steps:
1. Remove the `system-query-info.gql` import.
2. Import `fetchSystemInfo` from `../../helpers/system-api`.
3. Add a `loadInfo()` method that:
   - fetches `/_api/system/info`
   - updates `this.info`
   - returns success/failure
   - reports failures via `pushGraphError` to preserve current UI behavior.
4. Replace `refresh()` so it calls `loadInfo()` and only shows the success notification when the reload succeeds.
5. Replace the Apollo `info` bootstrap block with a lifecycle bootstrap using `created()` and the same loading token currently used for the page.
6. Keep `performUpgrade()` on GraphQL and unchanged in scope.

Verification:
- `corepack yarn test`
- `corepack yarn build`

### Task 3: Review and verify the slice

Objective: confirm the slice stays narrow, respects existing UX, and is merge-safe.

Files:
- Review diff for:
  - `client/helpers/system-api.js`
  - `client/helpers/system-api.test.js`
  - `client/components/admin/admin-system.vue`

Steps:
1. Run targeted tests if needed.
2. Run full test suite.
3. Run production build.
4. Dispatch independent subagent review for spec compliance.
5. Dispatch independent subagent review for code quality.
6. Commit only if both reviews approve and verification stays green.

Commit target:
- `[verified] feat: move admin system info bootstrap to REST`
