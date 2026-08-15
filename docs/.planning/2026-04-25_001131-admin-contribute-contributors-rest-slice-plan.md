# Admin Contribute Contributors REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin contribute sponsors/backers read/bootstrap path from GraphQL to REST.

**Architecture:** Add a narrow read-only Express REST endpoint that mirrors the current `contribute.contributors` GraphQL resolver’s upstream sponsors query and returns a strict allowlisted contributor list. Add a focused client helper and replace the single Apollo smart query in `admin-contribute.vue`. This is intentionally a tiny display-only transport swap, not a broader admin or sponsorship redesign.

**Tech Stack:** Node/CommonJS, Express 4, Vue 2, Jest 27, existing Wiki.js REST API shell, request-promise for parity with the existing resolver.

---

## Scope

In scope:
- Add `GET /_api/contribute/contributors`.
- Use the same upstream data source as GraphQL:
  - `POST https://graph.requarks.io`
  - GraphQL sponsors query for `list(kind: BACKER)`.
- Return a strict contributor allowlist:
  - `id`
  - `source`
  - `name`
  - `joined`
  - `website`
  - `twitter`
  - `avatar`
- Add `client/helpers/contribute-api.js` and tests.
- Replace only `admin-contribute.vue`’s Apollo `backers` query with a REST loader.
- Preserve the existing loading token: `admin-contribute-refresh`.

Out of scope:
- Any donation/static-link changes.
- Any persistence or database writes.
- Any auth/session changes.
- Any pages/users/storage/search migration.
- Any broad removal of GraphQL/Apollo.
- Any dependency changes.

## Parity Sources

- Client Apollo query:
  - `client/components/admin/admin-contribute.vue`
- GraphQL resolver:
  - `server/graph/resolvers/contribute.js`
- GraphQL schema:
  - `server/graph/schemas/contribute.graphql`
- Existing REST route shell:
  - `server/controllers/api/index.js`
- Existing helper/test patterns:
  - `client/helpers/comments-api.js`
  - `server/test/controllers/api.comments.test.js`

## Important Behavior Decisions

- Do not add a new permission gate. The current GraphQL query has no `@auth` directive and the data is public sponsor/backer display data. The route still lives under the authenticated app stack, but it should not require `manage:system`.
- On upstream request failure, return `[]` and log with `WIKI.logger.warn(err)`, matching the current resolver’s low-impact failure style while giving the client a stable array response.
- Strictly map/allowlist upstream rows so unexpected upstream fields are not reflected into REST output.
- Preserve nullable optional fields (`website`, `twitter`, `avatar`) as `null` when missing, while keeping required GraphQL fields required in the helper.

## Implementation Tasks

### Task 1: Add server contribute REST controller

**Objective:** Create the read-only contributors endpoint and mount it in the API shell.

**Files:**
- Create: `server/controllers/api/contribute.js`
- Modify: `server/controllers/api/index.js`
- Create: `server/test/controllers/api.contribute.test.js`
- Modify: `server/test/controllers/api.index.test.js`

**Behavior:**
- Register `GET /contributors` in the contribute router.
- Call `request-promise` with:
  - `method: 'POST'`
  - `uri: 'https://graph.requarks.io'`
  - `json: true`
  - body containing a sponsors list query for the exact fields consumed by the UI.
- Read upstream rows from `data.sponsors.list`, defaulting to `[]`.
- Return only:
  - `id`
  - `source`
  - `name`
  - `joined`
  - `website`
  - `twitter`
  - `avatar`
- Normalize missing optional fields (`website`, `twitter`, `avatar`) to `null`.
- On upstream error:
  - call `WIKI.logger.warn(err)` if available
  - return `[]`
- Mount as `router.use('/contribute', require('./contribute'))`.

**Tests:**
- Route registration for `/contributors`.
- API index mounts `/contribute`.
- Upstream request shape uses POST, expected URI, JSON, and sponsors BACKER query.
- Successful response is a strict allowlist and strips unknown upstream fields.
- Missing optional fields normalize to `null`.
- Missing `data.sponsors.list` returns `[]`.
- Upstream failure logs warning and returns `[]`.

### Task 2: Add client contribute API helper

**Objective:** Add a focused helper for fetching and validating the contributor list.

**Files:**
- Create: `client/helpers/contribute-api.js`
- Create: `client/helpers/contribute-api.test.js`

**Behavior:**
- Export `fetchContributors(fetchImpl, fallbackMessage = 'Contributors response is invalid')`.
- Fetch `/_api/contribute/contributors` with:
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Parse JSON only for JSON content type.
- For non-OK JSON responses, surface `{ error }` or `{ message }`; otherwise throw fallback.
- Validate root payload is an array.
- Validate each row:
  - `id`, `source`, `name`, `joined` are strings.
  - `website`, `twitter`, `avatar` are string or `null`.
- Return sanitized contributor rows only.

**Tests:**
- Request path/options.
- Valid payload parsing and sanitization.
- Optional `website`/`twitter`/`avatar` allow `null`.
- Malformed root/row payload rejects.
- Extra fields are stripped.
- API JSON errors propagate.
- Non-JSON success rejects with fallback.

### Task 3: Migrate admin contribute component bootstrap

**Objective:** Replace the single Apollo smart query with the REST helper.

**Files:**
- Modify: `client/components/admin/admin-contribute.vue`

**Behavior:**
- Remove `graphql-tag` import.
- Import `fetchContributors` from `../../helpers/contribute-api`.
- Add `created()` lifecycle hook that calls `loadBackers().catch(() => {})`.
- Add `loadBackers({ notifyError = true } = {})`:
  - start loading token `admin-contribute-refresh`.
  - call `fetchContributors(window.fetch.bind(window), 'Contributors response is invalid')`.
  - assign `this.backers` to returned rows.
  - on failure, set `this.backers = []`, optionally show a red notification, and rethrow.
  - stop loading token in `finally`.
- Remove `apollo` block.
- Preserve all template behavior and static contribution links.

### Task 4: Verify, review, and commit

**Targeted checks:**
- `corepack yarn jest --runInBand server/test/controllers/api.contribute.test.js client/helpers/contribute-api.test.js server/test/controllers/api.index.test.js`
- `git diff --check`

**Full checks:**
- `corepack yarn test`
- `corepack yarn build`

**Security/quality checks:**
- Scan staged added lines for credential/secret patterns.
- Independent spec/security review.
- Independent code-quality/integration review.

**Commit message:**
- `[verified] feat: move contribute backers bootstrap to REST`
