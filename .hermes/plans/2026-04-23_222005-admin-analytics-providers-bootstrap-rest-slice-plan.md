# Admin Analytics Providers Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move the read-only analytics provider bootstrap/refresh path in `client/components/admin/admin-analytics.vue` from Apollo GraphQL to a narrow REST endpoint while leaving provider update/save mutations on GraphQL.

**Architecture:** Add a new Express router at `server/controllers/api/analytics.js` mounted under `/_api/analytics`. The router exposes only `GET /providers`, preserves GraphQL `manage:system` permission semantics, and explicitly allowlists provider fields required by the current admin UI. Add a focused browser helper at `client/helpers/analytics-api.js` that validates/sanitizes the REST payload and preserves the component's parsed config shape.

**Tech Stack:** Express controllers, Wiki.js baseline global `WIKI`, Lodash, CommonJS client helpers, Jest controller/helper tests, Vue 2 admin component.

---

### Task 1: Add analytics providers REST controller and tests

**Objective:** Implement `GET /_api/analytics/providers` with GraphQL parity and strict output allowlisting.

**Files:**
- Create: `server/controllers/api/analytics.js`
- Modify: `server/controllers/api/index.js`
- Test: `server/test/controllers/api.analytics.test.js`

**Required behavior:**
- Register `router.get('/providers', ...)`.
- Mount from API index as `router.use('/analytics', require('./analytics'))`.
- Gate with `WIKI.auth.checkAccess(req.user, ['manage:system'])`.
- Accept optional query `isEnabled` only when exactly `true` or `false`; convert to boolean for `WIKI.models.analytics.getProviders(isEnabled)`. Otherwise pass `undefined`, matching the default GraphQL query use.
- Merge model rows with provider metadata from `WIKI.data.analytics` by `key`, mirroring `server/graph/resolvers/analytics.js`.
- Return only these provider fields: `isEnabled`, `key`, `title`, `description`, `isAvailable`, `logo`, `website`, `config`.
- Do not spread raw provider metadata/model rows into the JSON response.
- Shape `config` as an array of `{ key, value }`, where `value` is `JSON.stringify({ ...providerInfo.props[key], value })`, matching GraphQL resolver behavior.
- Keep config entry ordering by config key on the server. The client may then sort by parsed `order` just like the current component does.
- Forward unexpected errors to `next(err)`.

**Regression tests:**
- route registration for `/providers`.
- API index mounts `/analytics`.
- unauthorized access returns `403` and does not query providers.
- authorized response has the exact allowed shape and excludes raw/internal fields such as provider `props`, model `secret`, or metadata-only internals.
- config values are JSON strings containing merged metadata plus persisted value.
- `isEnabled=true` and `isEnabled=false` query values are converted to booleans.
- unexpected provider query failure calls `next(err)`.

**Target command:**
- `corepack yarn jest --runInBand server/test/controllers/api.analytics.test.js`

---

### Task 2: Add analytics client helper and tests

**Objective:** Add a focused helper that fetches and normalizes analytics provider bootstrap data for the admin component.

**Files:**
- Create: `client/helpers/analytics-api.js`
- Test: `client/helpers/analytics-api.test.js`

**Required behavior:**
- Export `fetchAnalyticsProviders(fetchImpl, fallbackMessage)`.
- Fetch `/_api/analytics/providers` with `credentials: 'same-origin'` and `Accept: 'application/json'`.
- Parse JSON responses using the same error behavior as other helpers: surface JSON `error` or `message`, reject non-JSON success payloads, reject malformed payloads.
- Require root payload to be an array.
- Validate each provider row for the UI contract:
  - `isEnabled` boolean
  - `key` non-empty string
  - `title`, `description`, `logo`, `website` strings
  - `isAvailable` boolean
  - `config` array
- For each config row, require `key` non-empty string and `value` JSON string that parses to an object.
- Return a sanitized provider object with only the allowed fields and config entries with parsed `value` objects.
- Sort each provider config array by `value.order`, preserving current component behavior.

**Regression tests:**
- request path/options are correct.
- valid payload is parsed, sanitized, and config entries are sorted by parsed order.
- extra provider/config fields are stripped.
- malformed root payload rejects.
- malformed provider row rejects.
- malformed config JSON rejects.
- API JSON error and non-JSON success rejection behavior are covered.

**Target command:**
- `corepack yarn jest --runInBand client/helpers/analytics-api.test.js`

---

### Task 3: Migrate admin analytics read/bootstrap to REST

**Objective:** Replace only the Apollo provider read/bootstrap path in `admin-analytics.vue` with the new REST helper while keeping the GraphQL update mutation unchanged.

**Files:**
- Modify: `client/components/admin/admin-analytics.vue`

**Required behavior:**
- Remove `providersQuery` import/use and the Apollo smart query for `providers`.
- Add `fetchAnalyticsProviders` import.
- Add `loadProviders({ notifyError = true } = {})` method using `window.fetch.bind(window)`.
- Wrap loads with existing loading token `admin-analytics-refresh`.
- On success, replace `this.providers` with normalized REST data.
- On failure, clear providers only when appropriate, call `pushGraphError` when `notifyError` is true, return `false`, and do not leave loading active.
- Call `this.loadProviders().catch(() => {})` from `created()`.
- Change refresh button from `this.$apollo.queries.providers.refetch()` to `loadProviders()`.
- Keep `updateProvidersMutation` and save payload construction unchanged except that after a successful save, refresh via REST and show the success notification only if the REST refresh succeeds.

**Regression focus:**
- No remaining Apollo smart query for analytics providers.
- Save still uses GraphQL mutation and current JSON-stringified config update payload.
- Success notifications are not shown after a successful GraphQL mutation if the follow-up REST refresh fails.

---

### Task 4: Verify, review, and commit

**Objective:** Prove the slice is stable and safe, then commit with `[verified]` prefix.

**Commands:**
- `corepack yarn jest --runInBand server/test/controllers/api.analytics.test.js client/helpers/analytics-api.test.js`
- `corepack yarn test`
- `corepack yarn build`
- `git diff --check`
- Added-line secret scan over `git diff --cached` or `git diff` before commit.

**Independent reviews:**
- Spec/security review: permission parity, strict allowlisting, no provider secret/internal leakage, no broadened mutation scope.
- Code-quality/integration review: helper/component behavior, refresh success gating, test coverage, route mounting.

**Commit:**
- Stage only implementation/test files, not `.hermes/plans/*.md` unless explicitly requested.
- Commit message: `[verified] feat: move analytics providers bootstrap to REST`
