# Admin Search Engines REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin search engine list/bootstrap/refresh path from GraphQL to REST while preserving the existing GraphQL save and rebuild mutations.

**Architecture:** Add a narrow Express REST endpoint under `/_api/search/engines` that mirrors the current GraphQL `search.searchEngines(orderBy: "title")` resolver source and permission semantics. Add a focused client helper to fetch, validate, sanitize, and parse the REST payload. Update `admin-search.vue` to use the helper for bootstrap/refresh only.

**Tech Stack:** Express controller, existing `WIKI.models.searchEngines`, Vue 2 admin component, focused CommonJS client helper, Jest controller/helper tests.

---

## Scope

Implement only:
- `GET /_api/search/engines`
- client helper `fetchSearchEngines(fetchImpl, fallbackMessage)`
- admin search bootstrap/refresh migration in `client/components/admin/admin-search.vue`
- focused tests

Keep out of scope:
- `search.updateSearchEngines` mutation migration
- `search.rebuildIndex` mutation migration
- search engine runtime/indexing behavior changes
- storage/search broader subsystem redesign
- dependency updates

## Parity Sources

Existing GraphQL query:
- `client/graph/admin/search/search-query-engines.gql`

Existing component:
- `client/components/admin/admin-search.vue`

Existing resolver/schema:
- `server/graph/resolvers/search.js`
- `server/graph/schemas/search.graphql`

Existing REST patterns to mirror:
- `server/controllers/api/analytics.js`
- `server/controllers/api/logging.js`
- `server/controllers/api/rendering.js`
- `client/helpers/analytics-api.js`
- `server/test/controllers/api.analytics.test.js`

## Required Server Behavior

Create `server/controllers/api/search.js`:
- Define an Express router.
- Add `GET /engines`.
- Require `WIKI.auth.checkAccess(req.user, ['manage:system'])`.
  - If unauthorized, `res.sendStatus(403)` and do not query models.
- Fetch source data with `WIKI.models.searchEngines.getSearchEngines()`.
- For each engine:
  - find metadata with `_.find(WIKI.data.searchEngines, ['key', engine.key]) || {}`.
  - merge metadata + model row for GraphQL parity.
  - serialize only declared config keys from metadata `props`.
  - config row shape must stay `{ key, value }` where `value` is a JSON string containing prop metadata plus persisted value.
  - sort config rows by config key to match resolver behavior.
- Sort returned engines by title ascending to match the current client query `orderBy: "title"`.
- Return only strict allowlisted fields:
  - `isEnabled`
  - `key`
  - `title`
  - `description`
  - `logo`
  - `website`
  - `isAvailable`
  - `config`
- Do not return raw `props`, raw config object, private/internal model fields, unrelated module metadata, or undeclared persisted config keys.
- Forward unexpected failures to `next(err)`.

Mount in `server/controllers/api/index.js`:
- `router.use('/search', require('./search'))`

## Required Client Helper Behavior

Create `client/helpers/search-api.js`:
- Export `fetchSearchEngines(fetchImpl, fallbackMessage = 'Search engines response is invalid')`.
- Fetch `/_api/search/engines` with:
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Parse only JSON responses.
- For non-OK JSON responses, propagate `{ error }` or `{ message }` if present.
- Require root payload to be an array.
- Validate each engine row:
  - `isEnabled`: boolean
  - `key`: string
  - `title`: string
  - `description`: string
  - `logo`: string
  - `website`: string
  - `isAvailable`: boolean
  - `config`: array
- Validate each config row:
  - `key`: string
  - `value`: JSON string parsing to a plain object
- Return sanitized objects with only the allowlisted fields.
- Parse config JSON into `value` objects.
- Sort parsed config rows by `value.order`, with missing/non-finite order values last, preserving the existing Apollo update behavior.

## Required Component Behavior

Modify `client/components/admin/admin-search.vue`:
- Remove `enginesQuery` import.
- Keep `enginesSaveMutation` and `enginesRebuildMutation` imports unchanged.
- Import `fetchSearchEngines` from `../../helpers/search-api`.
- Replace the Apollo `engines` smart query with a manual loader:
  - `created() { this.loadEngines().catch(() => {}) }`
  - `async loadEngines({ notifyError = true } = {}) { ... }`
- Loader must:
  - start `admin-search-refresh` loading token
  - call `fetchSearchEngines(window.fetch.bind(window), 'Search engines response is invalid')`
  - assign `this.engines` on success
  - clear `this.engines` on failure
  - show notification or push graph error consistently with nearby admin screens
  - always stop `admin-search-refresh` token in `finally`
  - rethrow after reporting so callers can gate notifications
- Change `refresh()` to call `loadEngines()` and show success only if reload succeeds.
- Optionally after successful `save()`, call `await this.loadEngines({ notifyError: false })` before showing save success, so the UI is current. Keep the mutation itself on GraphQL.
- Keep `rebuild()` on GraphQL unchanged.

## Tests

Create `server/test/controllers/api.search.test.js` covering:
- route registration for `/engines`
- API index mounting at `/search`
- unauthorized request returns 403 and does not call `getSearchEngines()`
- authorized request calls `WIKI.models.searchEngines.getSearchEngines()`
- response has only allowlisted top-level fields
- raw props/internal/private fields are absent
- config rows serialize declared prop metadata + persisted value as JSON strings
- undeclared persisted config keys are omitted
- config rows sorted by key
- engines sorted by title ascending
- model failure forwards to `next(err)`

Modify `server/test/controllers/api.index.test.js`:
- include `/search` in route-shell mount expectations.

Create `client/helpers/search-api.test.js` covering:
- request path/options
- valid payload parsing/sanitization
- config JSON parsing and order sorting
- extra fields stripped
- malformed root payload rejection
- malformed engine row rejection
- malformed config row rejection
- malformed config JSON rejection
- JSON API error propagation
- non-JSON successful response rejection

## Verification Commands

Targeted verification:
```bash
corepack yarn jest --runInBand server/test/controllers/api.search.test.js client/helpers/search-api.test.js server/test/controllers/api.index.test.js
```

Whitespace:
```bash
git diff --check
```

Full verification before commit:
```bash
corepack yarn test
corepack yarn build
```

Also run a staged added-line secret scan before commit because real search engine configs can contain endpoints/API keys. Test fixtures must use benign placeholders only.

## Commit

After implementation, targeted tests, full tests/build, secret scan, and independent reviews pass:
```bash
git add docs/.planning/2026-04-25_003336-admin-search-engines-bootstrap-rest-slice-plan.md \
  server/controllers/api/search.js server/controllers/api/index.js server/test/controllers/api.search.test.js server/test/controllers/api.index.test.js \
  client/helpers/search-api.js client/helpers/search-api.test.js client/components/admin/admin-search.vue

git commit -m "[verified] feat: move search engines bootstrap to REST"
```
