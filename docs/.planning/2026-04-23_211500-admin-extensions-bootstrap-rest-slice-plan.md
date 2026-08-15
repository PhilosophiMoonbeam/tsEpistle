# Admin Extensions Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move the read-only admin extensions bootstrap from GraphQL to a narrow REST endpoint while preserving current Vue 2 behavior and existing manage:system authorization semantics.

**Architecture:** Add `GET /_api/system/extensions` to the existing system REST controller, mirroring the current `system.extensions` GraphQL resolver shape. Add client-side normalization to `client/helpers/system-api.js` and update `admin-extensions.vue` to load extensions through REST on component creation. Do not touch install/mutation/commented-out extension code.

**Tech Stack:** Express REST controller, Jest unit tests, Vue 2 single-file component, existing `fetch` helper conventions.

---

## Scope

In scope:
- Add a read-only REST endpoint returning extension rows with:
  - `key`
  - `title`
  - `description`
  - `isInstalled`
  - `isCompatible`
- Reuse existing `requireSystemAccess` (`manage:system`) from `server/controllers/api/system.js`.
- Add controller tests and client helper tests.
- Remove Apollo smart-query usage from `client/components/admin/admin-extensions.vue` for this read path only.

Out of scope:
- Installing/uninstalling extensions.
- Any mutation migration.
- Broad provider/config stack modernization.
- Scarlett/Vega branch merges.

## Files

Modify:
- `server/controllers/api/system.js`
- `server/test/controllers/api.system.test.js`
- `client/helpers/system-api.js`
- `client/helpers/system-api.test.js`
- `client/components/admin/admin-extensions.vue`

Create:
- None.

## Task 1: Add server-side REST endpoint tests

**Objective:** Specify `GET /_api/system/extensions` behavior before implementation.

**Steps:**
1. In `server/test/controllers/api.system.test.js`, add extension fixture data to `global.WIKI`:
   - `WIKI.extensions.ext.alpha`
   - `WIKI.extensions.ext.beta`
   - include `isCompatible: jest.fn().mockResolvedValue(...)` per extension.
2. Update `loadHandlers()` to expose `extensions` from the registered `GET /extensions` route.
3. Update the route registration test to require `handlers.extensions` to be a function.
4. Update the unauthorized test to call `extensions(req, res)` and expect one additional 403.
5. Add a positive test asserting authorized response rows match the GraphQL resolver shape and compatibility calls are awaited.
6. Add a failure test where one `isCompatible()` rejects and assert `next(err)` is called with no response JSON.

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js`

Expected initially:
- Fails because `/extensions` is not registered yet.

## Task 2: Implement the server-side REST endpoint

**Objective:** Add the minimal REST implementation needed to pass controller tests.

**Steps:**
1. In `server/controllers/api/system.js`, add helper `buildSystemExtensions()` near other build helpers.
2. Mirror the GraphQL resolver behavior:
   - `const exts = Object.values(WIKI.extensions.ext).map(ext => _.pick(ext, ['key', 'title', 'description', 'isInstalled']))`
   - for each row, set `ext.isCompatible = await WIKI.extensions.ext[ext.key].isCompatible()`.
3. Add `router.get('/extensions', async (req, res, next) => { ... })` guarded by `requireSystemAccess`.
4. Respond with `res.json(await buildSystemExtensions())` and forward unexpected errors to `next(err)`.

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js`

Expected:
- Passes.

## Task 3: Add client helper tests

**Objective:** Specify a typed/sanitized helper for fetching extension rows.

**Steps:**
1. In `client/helpers/system-api.test.js`, import `fetchSystemExtensions`.
2. Add a success test that:
   - returns two rows with the exact five fields;
   - asserts fetch called with `/_api/system/extensions`, `credentials: 'same-origin'`, and `Accept: 'application/json'`.
3. Add malformed payload tests for:
   - root not array;
   - row missing string `key`/`title`/`description`;
   - row with non-boolean `isInstalled` or `isCompatible`.
4. Add error propagation coverage if existing helper tests do not already cover parseJsonResponse for GET helpers sufficiently.

Run:
- `corepack yarn jest --runInBand client/helpers/system-api.test.js`

Expected initially:
- Fails because `fetchSystemExtensions` does not exist.

## Task 4: Implement client helper

**Objective:** Add `fetchSystemExtensions()` following existing system helper conventions.

**Steps:**
1. In `client/helpers/system-api.js`, add `normalizeSystemExtensionsPayload(payload, fallbackMessage)`.
2. Validate root is an array.
3. Validate each row has:
   - `key`, `title`, `description` as strings;
   - `isInstalled`, `isCompatible` as booleans.
4. Return new row objects with only those five fields to keep UI input allowlisted.
5. Add `fetchSystemExtensions(fetchImpl, fallbackMessage = 'System extensions response is invalid')` using `/_api/system/extensions`.
6. Export `fetchSystemExtensions`.

Run:
- `corepack yarn jest --runInBand client/helpers/system-api.test.js`

Expected:
- Passes.

## Task 5: Move admin extensions component bootstrap to REST

**Objective:** Remove the Apollo read bootstrap from `admin-extensions.vue` and load extension rows through the helper.

**Steps:**
1. Replace imports:
   - remove `lodash` and `graphql-tag` imports if no longer used;
   - add `import { fetchSystemExtensions } from '../../helpers/system-api'`.
2. Add `created () { this.loadExtensions() }`.
3. Add `async loadExtensions ()` method:
   - commit `loadingStart` with `admin-extensions-refresh` before request;
   - set `this.extensions = await fetchSystemExtensions(fetch.bind(window))`;
   - catch errors with `this.$store.commit('pushGraphError', err)` for existing error UX parity;
   - finally commit `loadingStop` with `admin-extensions-refresh`.
4. Remove the `apollo` block.
5. Leave the commented-out `save()` mutation block untouched if possible, except for removing now-unused `_` references if required. If `_` is only inside comments, no import is needed.

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js client/helpers/system-api.test.js`

Expected:
- Passes.

## Task 6: Full verification and review

**Objective:** Ensure the slice is stable and independently reviewed before commit.

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js client/helpers/system-api.test.js`
- `corepack yarn test`
- `corepack yarn build`
- `git diff --check`
- static scan of added lines for secrets/injection/eval/unsafe deserialization/SQL formatting.

Then request independent reviews:
1. Spec compliance review against this plan.
2. Security/code-quality review of the git diff.

Address any blocking review findings and rerun targeted tests plus any affected broader checks.

## Commit

If all checks and reviews pass:

```bash
git add server/controllers/api/system.js server/test/controllers/api.system.test.js client/helpers/system-api.js client/helpers/system-api.test.js client/components/admin/admin-extensions.vue
git commit -m "[verified] feat: move admin extensions bootstrap to REST"
```

Do not stage untracked `docs/.planning/*.md` files unless explicitly requested.
