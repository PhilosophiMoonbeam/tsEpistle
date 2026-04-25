# Admin Rendering Renderers Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin rendering renderers read/bootstrap/refresh path from GraphQL to REST while preserving the existing GraphQL save mutation.

**Architecture:** Add a narrow Express REST controller at `GET /_api/rendering/renderers`, mounted under the existing API shell. The endpoint mirrors `RenderingQuery.renderers` behavior using `WIKI.models.renderers.getRenderers()` and `WIKI.data.renderers` metadata, but returns only an explicit allowlist. The Vue component will load flat renderers through a focused helper, keep its existing dependency-graph tree construction client-side, and keep `rendering.updateRenderers` on GraphQL.

**Tech Stack:** Express, Objection model calls, Vue 2, dependency-graph client transform, fetch with same-origin credentials, Jest.

---

## Scope

In scope:
- Add `GET /_api/rendering/renderers`.
- Require `manage:system`, matching `server/graph/schemas/rendering.graphql`.
- Serialize renderer config with the same GraphQL wire shape: `{ key, value: JSON.stringify({ ...propsMetadata, value }) }`.
- Preserve the resolver behavior that only emits config keys that exist in `rendererInfo.props`.
- Add focused server and client helper tests.
- Replace only the Apollo `renderers` bootstrap/refetch in `client/components/admin/admin-rendering.vue`.
- Preserve the component's existing client-side dependency graph/tree transform.

Out of scope:
- `rendering.updateRenderers` mutation migration.
- Rendering pipeline/service changes.
- Renderer dependency graph redesign.
- Broad branch merge/cherry-pick from `origin/scarlett` or `origin/vega`.

---

## Parity Sources

- Client read path: `client/components/admin/admin-rendering.vue` lines 141 and 202-241.
- GraphQL query: `client/graph/admin/rendering/rendering-query-renderers.gql`.
- Resolver: `server/graph/resolvers/rendering.js` lines 14-37.
- Schema permission: `server/graph/schemas/rendering.graphql` lines 17-21.
- Model source: `server/models/renderers.js` lines 34-36.
- Prior REST patterns: `server/controllers/api/logging.js`, `client/helpers/logging-api.js`, and their tests.

---

## Task 1: Add rendering REST controller

**Objective:** Create an admin-only read endpoint that mirrors the existing GraphQL renderer bootstrap shape with explicit allowlisting.

**Files:**
- Create: `server/controllers/api/rendering.js`
- Modify: `server/controllers/api/index.js`
- Test: `server/test/controllers/api.rendering.test.js`
- Modify test: `server/test/controllers/api.index.test.js`

**Implementation details:**
- Add `requireSystemAccess(req, res)` using `WIKI.auth.checkAccess(req.user, ['manage:system'])` and `res.sendStatus(403)` on denial.
- Add `serializeRenderer(renderer)`:
  - Find metadata: `_.find(WIKI.data.renderers, ['key', renderer.key]) || {}`.
  - Merge metadata and DB row only for allowed scalar fields.
  - Build `config` from `renderer.config` using `_.transform` and `_.get(rendererInfo.props, key, false)`.
  - Only push a config row if config metadata exists, matching the GraphQL resolver's `if (configData)` guard.
  - Sort config by key.
  - Return only:
    - `isEnabled`
    - `key`
    - `title`
    - `description`
    - `icon`
    - `dependsOn`
    - `input`
    - `output`
    - `config`
- Add `GET /renderers`:
  - Guard with `requireSystemAccess`.
  - `const renderers = await WIKI.models.renderers.getRenderers()`.
  - Map through `serializeRenderer`.
  - `res.json(renderers)`; no extra server ordering because the current GraphQL query does not pass `orderBy`, and the component handles tree ordering.
  - Forward unexpected failures to `next(err)`.
- Mount from `server/controllers/api/index.js` as `router.use('/rendering', require('./rendering'))`.

**Tests:**
- Route registration for `/renderers`.
- API index mounts `/rendering`.
- Unauthorized requests return `403`, do not query renderers.
- Authorized payload shape includes only the allowlisted fields.
- Raw `props`, unrelated metadata, and internal model fields are absent.
- Config rows are JSON strings with metadata plus stored value and sorted by config key.
- Unknown config keys without `rendererInfo.props` metadata are omitted, matching GraphQL parity.
- Unexpected model failure forwards to `next(err)`.
- Use benign fixture values only. Avoid secret-like fixture names/values.

---

## Task 2: Add rendering REST client helper

**Objective:** Add a small helper that fetches, validates, sanitizes, parses config JSON, and preserves component-side config order behavior.

**Files:**
- Create: `client/helpers/rendering-api.js`
- Test: `client/helpers/rendering-api.test.js`

**Implementation details:**
- Follow the `client/helpers/logging-api.js` pattern.
- Export `fetchRenderingRenderers(fetchImpl, fallbackMessage = 'Rendering renderers response is invalid')`.
- Request `/_api/rendering/renderers` with:
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Validate payload root is an array.
- Validate each renderer row:
  - `isEnabled` boolean
  - `key`, `title` strings
  - `description`, `icon`, `input`, `output` strings
  - `dependsOn` string or `null` because core renderers use null and dependent renderers use a key string.
  - `config` array
- Validate config rows have string `key` and string `value`; parse JSON value into an object.
- Return sanitized renderer objects with only the allowed fields.
- Sort parsed config rows by `value.order`, with missing/non-finite orders last.
- Surface JSON `{ error }` / `{ message }` failures, and reject non-JSON successful responses with fallback error.

**Tests:**
- Request path/options.
- Successful payload parsing and sanitization.
- Config JSON parsing and order sorting.
- `dependsOn: null` and `dependsOn: 'markdownCore'` both accepted.
- Extra renderer/config fields are stripped.
- Malformed root/renderer/config payloads reject.
- Malformed config JSON rejects.
- API JSON error propagation.
- Non-JSON success rejection.

---

## Task 3: Migrate admin rendering component read/bootstrap only

**Objective:** Replace the Apollo smart query in `admin-rendering.vue` with the REST helper while keeping the GraphQL save mutation intact.

**Files:**
- Modify: `client/components/admin/admin-rendering.vue`

**Implementation details:**
- Remove `renderersQuery` import.
- Add `import { fetchRenderingRenderers } from '../../helpers/rendering-api'`.
- Extract the existing Apollo `update` body into a method such as `buildRendererTree(renderers)` that:
  - takes the flat normalized renderers from the helper,
  - builds `children` for each core renderer exactly as the Apollo update currently does,
  - constructs the `DepGraph` exactly as today,
  - returns `orderedCores`.
- Add `created() { this.loadRenderers().catch(() => {}) }`.
- Add `async loadRenderers({ notifyError = true } = {})`:
  - Start loading token `admin-rendering-refresh`.
  - Fetch flat renderers with `fetchRenderingRenderers(window.fetch.bind(window), 'Rendering renderers response is invalid')`.
  - Set `this.renderers = this.buildRendererTree(flatRenderers)`.
  - On failure, optionally show `showNotification` red alert with `err.message`, then rethrow.
  - Stop loading token in `finally`.
- Change `refresh()` to `await this.loadRenderers()` and show success only after load succeeds.
- Wrap `save()` in `try/finally` for the existing save loading token. Keep the GraphQL mutation variables exactly compatible.
- After successful GraphQL `save()`, `await this.loadRenderers({ notifyError: false })` before showing success so the UI reflects persisted values.
- Keep `renderersSaveMutation` import and mutation untouched.
- Remove the `apollo.renderers` block entirely.

**Tests / verification:**
- Existing build should catch syntax/template regressions.
- Helper and controller tests cover the new transport contract.
- Manual diff review should confirm no GraphQL save migration occurred.

---

## Verification Checklist

Run after implementation:

1. Targeted Jest:
   `corepack yarn jest --runInBand server/test/controllers/api.rendering.test.js client/helpers/rendering-api.test.js server/test/controllers/api.index.test.js`

2. Full suite:
   `corepack yarn test`

3. Whitespace:
   `git diff --check`

4. Build:
   `corepack yarn build`

5. Secret scan:
   Scan staged/added lines including new files for credential-like values. Fixture values must remain benign placeholders; do not include real-looking DSNs, tokens, API keys, passwords, or connection strings.

6. Independent reviews:
   - Spec/security review for permission parity, strict allowlisting, sensitive config exposure risk, GraphQL behavior parity, and scope boundaries.
   - Code-quality/integration review for route/helper/component behavior, dependency graph preservation, and tests.

7. Commit only if all checks/reviews pass:
   `[verified] feat: move rendering renderers bootstrap to REST`
