# Admin Logging Loggers Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin logging loggers read/bootstrap/refresh path from GraphQL to REST while preserving the existing GraphQL save mutation and live trail subscription.

**Architecture:** Add a narrow Express REST controller at `GET /_api/logging/loggers`, mounted under the existing API shell. The endpoint mirrors `LoggingQuery.loggers(orderBy: "title ASC")` behavior using the existing `WIKI.models.loggers.getLoggers()` source and `WIKI.data.loggers` metadata, but returns only an explicit allowlist. The Vue component will load loggers through a small client helper and keep `updateLoggers` plus `loggingLiveTrail` on GraphQL.

**Tech Stack:** Express, Objection model calls, Vue 2, fetch with same-origin credentials, Jest.

---

## Scope

In scope:
- Add `GET /_api/logging/loggers`.
- Require `manage:system`, matching `server/graph/schemas/logging.graphql`.
- Serialize logger config with the same GraphQL wire shape: `{ key, value: JSON.stringify({ ...propsMetadata, value }) }`.
- Preserve GraphQL order used by the page: `orderBy: "title ASC"`.
- Add focused server and client helper tests.
- Replace only the Apollo `loggers` bootstrap/refetch in `client/components/admin/admin-logging.vue`.

Out of scope:
- `logging.updateLoggers` mutation migration.
- `loggingLiveTrail` subscription migration.
- Logger enablement/config business logic changes.
- Broader logging console, subscriptions, or logger service changes.
- Broad branch merge/cherry-pick from `origin/scarlett` or `origin/vega`.

---

## Parity Sources

- Client read path: `client/components/admin/admin-logging.vue` lines 113 and 165-173.
- GraphQL query: `client/graph/admin/logging/logging-query-loggers.gql`.
- Resolver: `server/graph/resolvers/logging.js` lines 19-40.
- Schema permission: `server/graph/schemas/logging.graphql` lines 21-25.
- Model source: `server/models/loggers.js` lines 34-36.
- Prior REST pattern: `server/controllers/api/analytics.js` and `client/helpers/analytics-api.js`.

---

## Task 1: Add logging REST controller

**Objective:** Create an admin-only read endpoint that mirrors the existing GraphQL logger bootstrap shape with explicit allowlisting.

**Files:**
- Create: `server/controllers/api/logging.js`
- Modify: `server/controllers/api/index.js`
- Test: `server/test/controllers/api.logging.test.js`
- Modify test: `server/test/controllers/api.index.test.js`

**Implementation details:**
- Add `requireSystemAccess(req, res)` using `WIKI.auth.checkAccess(req.user, ['manage:system'])` and `res.sendStatus(403)` on denial.
- Add `serializeLogger(logger)`:
  - Find metadata: `_.find(WIKI.data.loggers, ['key', logger.key]) || {}`.
  - Merge metadata and DB row for allowed scalar fields only.
  - Build `config` from `logger.config` using `_.transform` and `_.get(loggerInfo.props, key, {})`.
  - Sort config by key.
  - Return only:
    - `isEnabled`
    - `key`
    - `title`
    - `description`
    - `logo`
    - `website`
    - `level`
    - `config`
- Add `GET /loggers`:
  - Guard with `requireSystemAccess`.
  - `let loggers = await WIKI.models.loggers.getLoggers()`.
  - Map through `serializeLogger`.
  - Sort by `title` ascending to preserve the existing query's `orderBy: "title ASC"`.
  - `res.json(loggers)`.
  - Forward unexpected failures to `next(err)`.
- Mount from `server/controllers/api/index.js` as `router.use('/logging', require('./logging'))`.

**Tests:**
- Route registration for `/loggers`.
- API index mounts `/logging`.
- Unauthorized requests return `403`, do not query loggers.
- Authorized payload shape includes only the allowlisted fields.
- Raw `props`, unrelated metadata, and internal model fields are absent.
- Config rows are JSON strings with metadata plus stored value and sorted by config key.
- Response rows are sorted by title ascending.
- Unexpected model failure forwards to `next(err)`.
- Use benign fixture values only. Avoid real-looking logger service tokens, DSNs, API keys, or credentials.

---

## Task 2: Add logging REST client helper

**Objective:** Add a small helper that fetches, validates, sanitizes, parses config JSON, and preserves component-side config order behavior.

**Files:**
- Create: `client/helpers/logging-api.js`
- Test: `client/helpers/logging-api.test.js`

**Implementation details:**
- Follow the `client/helpers/analytics-api.js` pattern.
- Export `fetchLoggingLoggers(fetchImpl, fallbackMessage = 'Logging loggers response is invalid')`.
- Request `/_api/logging/loggers` with:
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Validate payload root is an array.
- Validate each logger row:
  - `isEnabled` boolean
  - `key`, `title` strings
  - `description`, `logo`, `website`, `level` strings (allow empty strings but require string type for parity with current UI assumptions)
  - `config` array
- Validate config rows have string `key` and string `value`; parse JSON value into an object.
- Return sanitized logger objects with only the allowed fields.
- Sort parsed config rows by `value.order`, with missing/non-finite orders last.
- Surface JSON `{ error }` / `{ message }` failures, and reject non-JSON successful responses with fallback error.

**Tests:**
- Request path/options.
- Successful payload parsing and sanitization.
- Config JSON parsing and order sorting.
- Extra provider/config fields are stripped.
- Malformed root/provider/config payloads reject.
- Malformed config JSON rejects.
- API JSON error propagation.
- Non-JSON success rejection.

---

## Task 3: Migrate admin logging component read/bootstrap only

**Objective:** Replace the Apollo smart query in `admin-logging.vue` with the REST helper while keeping GraphQL save/subscription behavior intact.

**Files:**
- Modify: `client/components/admin/admin-logging.vue`

**Implementation details:**
- Remove `loggersQuery` import.
- Add `import { fetchLoggingLoggers } from '../../helpers/logging-api'`.
- Add `created() { this.loadLoggers().catch(() => {}) }`.
- Add `async loadLoggers({ notifyError = true } = {})`:
  - Start loading token `admin-logging-refresh`.
  - Set `this.loggers = await fetchLoggingLoggers(window.fetch.bind(window), 'Logging loggers response is invalid')`.
  - On failure, optionally show `showNotification` red alert with `err.message`, then rethrow.
  - Stop loading token in `finally`.
- Change `refresh()` to `await this.loadLoggers()` and show success only after load succeeds.
- After successful GraphQL `save()`, `await this.loadLoggers({ notifyError: false })` before showing success so the UI reflects persisted values.
- Keep the existing GraphQL `loggersSaveMutation` import and mutation untouched.
- Keep `LoggingConsole` and its subscription behavior untouched.
- Remove the `apollo.loggers` block entirely.

**Tests / verification:**
- Existing build should catch syntax/template regressions.
- Helper and controller tests cover the new behavior.
- Manual diff review should confirm no GraphQL save/subscription migration occurred.

---

## Verification Checklist

Run after implementation:

1. Targeted Jest:
   `corepack yarn jest --runInBand server/test/controllers/api.logging.test.js client/helpers/logging-api.test.js server/test/controllers/api.index.test.js`

2. Full suite:
   `corepack yarn test`

3. Whitespace:
   `git diff --check`

4. Build:
   `corepack yarn build`

5. Secret scan:
   Scan staged added lines including new files for credential-like values. Fixture values must remain benign placeholders; do not include real-looking DSNs, tokens, API keys, passwords, or connection strings.

6. Independent reviews:
   - Spec/security review for permission parity, strict allowlisting, sensitive config exposure risk, GraphQL behavior parity, and scope boundaries.
   - Code-quality/integration review for route/helper/component behavior and tests.

7. Commit only if all checks/reviews pass:
   `[verified] feat: move logging loggers bootstrap to REST`
