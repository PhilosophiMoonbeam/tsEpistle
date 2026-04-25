# Admin Comments Providers Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin comments provider read/bootstrap/refresh path from GraphQL to REST while preserving the existing GraphQL save mutation.

**Architecture:** Follow the already verified analytics/logging/rendering provider-list REST pattern. Add a narrow Express controller under `server/controllers/api/comments.js`, mount it under `/_api/comments`, add a focused client helper, and update `admin-comments.vue` to fetch provider bootstrap state through REST. Reuse the current GraphQL resolver semantics and current model source; do not port Scarlett/Vega runtime code.

**Tech Stack:** Node/CommonJS, Express 4, Vue 2, Jest 27, existing Wiki.js REST API shell, existing GraphQL mutations.

---

## Scope

In scope:
- Add `GET /_api/comments/providers`.
- Preserve GraphQL permission parity: `manage:system`.
- Reuse `WIKI.models.commentProviders.getProviders()`.
- Merge provider disk metadata from `WIKI.data.commentProviders`.
- Preserve GraphQL config wire shape: `config: [{ key, value: JSON.stringify({ ...propMetadata, value }) }]`.
- Allowlist the provider payload fields used by `admin-comments.vue`:
  - `isEnabled`
  - `key`
  - `title`
  - `description`
  - `logo`
  - `website`
  - `isAvailable`
  - `config`
- Parse config JSON in the client helper and sort by `value.order`, matching the current Apollo `update` behavior.
- Migrate only bootstrap/refresh/post-save reload in `client/components/admin/admin-comments.vue`.
- Keep `comments.updateProviders` GraphQL mutation unchanged.

Out of scope:
- Comment create/update/delete REST work.
- Public comment list/single REST work.
- Comment runtime/provider service changes.
- Broad comments subsystem redesign.
- Search/storage/page/auth/session rewrites.
- Dependency changes.

## Parity Sources

- UI and current Apollo query:
  - `client/components/admin/admin-comments.vue`
- GraphQL resolver:
  - `server/graph/resolvers/comment.js`, `CommentQuery.providers`
- GraphQL schema/auth:
  - `server/graph/schemas/comment.graphql`, `providers: [CommentProvider] @auth(requires: ["manage:system"])`
- Model source:
  - `server/models/commentProviders.js`, `getProviders()` and provider metadata loading
- Similar verified patterns:
  - `server/controllers/api/analytics.js`
  - `server/controllers/api/logging.js`
  - `server/controllers/api/rendering.js`
  - `client/helpers/analytics-api.js`
  - `client/helpers/logging-api.js`
  - `client/helpers/rendering-api.js`

## Sensitive Data Guardrails

- Comment provider config may contain API keys or deployment-specific URLs in real installations.
- Do not expose raw provider registry objects, raw `props`, or unrelated model fields.
- Preserve exactly the admin-only `manage:system` access gate.
- Test fixtures must avoid real-looking service keys or tokens. Use benign placeholders such as `example-api-key` only if necessary, and avoid secret-like values in summaries.
- Run a staged added-lines secret scan before commit.

## Implementation Tasks

### Task 1: Add server comments REST controller

**Objective:** Create a narrow `GET /providers` route that mirrors GraphQL provider bootstrap semantics.

**Files:**
- Create: `server/controllers/api/comments.js`
- Modify: `server/controllers/api/index.js`
- Test: `server/test/controllers/api.comments.test.js`
- Modify test: `server/test/controllers/api.index.test.js` if route mount coverage is centralized there.

**Behavior:**
- `GET /_api/comments/providers`
- If `WIKI.auth.checkAccess(req.user, ['manage:system'])` is false, return `403` without querying providers.
- On success:
  - call `WIKI.models.commentProviders.getProviders()` with no filter.
  - for each provider, find metadata in `WIKI.data.commentProviders` by key.
  - merge metadata and DB row so DB row wins, matching the GraphQL resolver.
  - build `config` from `provider.config` only for keys declared in `providerInfo.props`.
  - serialize each config row as `{ key, value: JSON.stringify({ ...configData, value }) }`.
  - sort config rows by key, matching resolver behavior.
  - return only allowlisted fields.
- Forward unexpected errors to `next(err)`.

**Regression tests:**
- Route registration.
- API index mount for `/comments`.
- Unauthorized request returns 403 and does not query providers.
- Authorized request calls `getProviders()`.
- Response payload contains only allowlisted fields.
- Raw provider props/model internals/unrelated metadata are not returned.
- Config JSON includes prop metadata plus persisted value.
- Unknown persisted config keys not declared in props are omitted.
- Unexpected model failure calls `next(err)`.

### Task 2: Add client comments API helper

**Objective:** Add a focused helper that fetches and validates comments provider bootstrap data.

**Files:**
- Create: `client/helpers/comments-api.js`
- Create: `client/helpers/comments-api.test.js`

**Behavior:**
- Export `fetchCommentProviders(fetchImpl, fallbackMessage = 'Comment providers response is invalid')`.
- Fetch `/_api/comments/providers` with:
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Parse JSON only when content type is JSON.
- For non-OK JSON responses, surface `{ error }` or `{ message }`; otherwise throw fallback.
- Validate root payload is an array.
- Validate each provider row:
  - `isEnabled` boolean
  - `key` string
  - `title` string
  - `description` string
  - `logo` string
  - `website` string
  - `isAvailable` boolean
  - `config` array
- Validate each config row:
  - `key` string
  - `value` JSON string parsing to a non-array object
- Return sanitized rows only, not original objects.
- Sort parsed config rows by numeric `value.order`, with missing/non-finite order last, matching recent helper patterns.

**Regression tests:**
- Request path/options.
- Successful payload parsing and config JSON parsing.
- Sanitization strips extra provider/root/config fields.
- Config sorting by order.
- Malformed root/provider/config rows reject.
- Malformed config JSON rejects.
- JSON API errors propagate.
- Non-JSON success rejects with fallback.

### Task 3: Migrate admin comments bootstrap/read path

**Objective:** Replace only the Apollo smart query for provider bootstrap with the REST helper.

**Files:**
- Modify: `client/components/admin/admin-comments.vue`

**Behavior:**
- Remove `apollo.providers` block and the Apollo refetch in `refresh()`.
- Keep `graphql-tag` import because the save mutation remains inline GraphQL.
- Import `fetchCommentProviders` from `../../helpers/comments-api`.
- Add `created()` lifecycle hook that calls `loadProviders().catch(() => {})`.
- Add `loadProviders({ notifyError = true } = {})` method:
  - start loading token `admin-comments-refresh`.
  - call `fetchCommentProviders(window.fetch.bind(window), 'Comment providers response is invalid')`.
  - assign `this.providers` to the returned rows.
  - on failure, notify via `showNotification` and rethrow.
  - stop loading token in `finally`.
- Update `refresh()` to await `loadProviders()` and only then show refresh success.
- After successful `comments.updateProviders`, call `await this.loadProviders({ notifyError: false })` before showing save success, so UI is current.
- Preserve provider selection watcher behavior.
- Preserve GraphQL mutation payload shape.

### Task 4: Verify, review, and commit

**Targeted commands:**
- `corepack yarn jest --runInBand server/test/controllers/api.comments.test.js client/helpers/comments-api.test.js server/test/controllers/api.index.test.js`
- `git diff --check`

**Full verification commands:**
- `corepack yarn test`
- `corepack yarn build`

**Security scan:**
- Scan staged added lines, including untracked new files, for credential/secret patterns before committing.

**Independent reviews:**
- Spec/security review focused on:
  - `manage:system` parity
  - no raw provider props/internals
  - config key allowlisting
  - sensitive test fixture hygiene
  - mutation remains GraphQL
- Code-quality/integration review focused on:
  - helper validation/sanitization
  - UI loading and success-notification gating
  - consistency with analytics/logging/rendering patterns

**Commit:**
- After all verification and reviews pass, commit:
  - `[verified] feat: move comments providers bootstrap to REST`
