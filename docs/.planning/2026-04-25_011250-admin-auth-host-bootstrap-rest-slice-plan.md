# Admin Auth Host Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin authentication page's site-host bootstrap read from GraphQL to REST while leaving auth strategy reads and all auth mutations unchanged.

**Architecture:** Add a narrow read-only endpoint under the existing system API controller that returns only `{ host }` with `manage:system` parity. Add a focused `fetchSystemHost()` helper and replace only the `host` Apollo smart query in `admin-auth.vue` with a manual REST loader.

**Tech Stack:** Express system REST controller, Vue 2 admin component, existing `client/helpers/system-api.js`, Jest controller/helper tests.

---

## Scope

Implement only:
- `GET /_api/system/host`
- `fetchSystemHost(fetchImpl, fallbackMessage)` helper
- migration of `admin-auth.vue` host bootstrap from GraphQL to REST
- focused tests

Keep out of scope:
- `authentication.strategies` read migration
- `authentication.activeStrategies` read migration
- `authentication.updateStrategies` mutation migration
- public login/auth strategy behavior
- site/general/security config migration
- dependency changes

## Parity Sources

Current host query:
- `client/graph/admin/auth/auth-query-host.gql`

Current component:
- `client/components/admin/admin-auth.vue`

GraphQL source:
- `server/graph/resolvers/site.js`
- `server/graph/schemas/site.graphql`

Existing REST patterns:
- `server/controllers/api/system.js`
- `client/helpers/system-api.js`
- `server/test/controllers/api.system.test.js`
- `client/helpers/system-api.test.js`

## Required Server Behavior

Modify `server/controllers/api/system.js`:
- Add `buildSystemHost()` returning:
  - `{ host: WIKI.config.host }`
- Add `router.get('/host', ...)`.
- Use existing `requireSystemAccess(req, res)`.
  - This preserves GraphQL `site.config @auth(requires: ["manage:system"])` parity.
  - If unauthorized, `res.sendStatus(403)` and do not return JSON.
- Return only the `host` field.
- Do not return any broader `site.config` values such as title, security config, auth config, upload settings, SEO, analytics IDs, etc.

## Required Client Helper Behavior

Modify `client/helpers/system-api.js`:
- Add `normalizeSystemHostPayload(payload, fallbackMessage)`.
- Add `fetchSystemHost(fetchImpl, fallbackMessage = 'Site host response is invalid')`.
- Export `fetchSystemHost`.

Request shape:
- URL: `/_api/system/host`
- `credentials: 'same-origin'`
- `Accept: 'application/json'`

Validation:
- root payload must be a plain object
- `host` must be a string
- Return sanitized `{ host: payload.host }`

## Required Component Behavior

Modify `client/components/admin/admin-auth.vue`:
- Remove `hostQuery` import.
- Keep `gql` import because strategy queries and update mutation remain inline GraphQL.
- Import `fetchSystemHost` from `../../helpers/system-api`.
- Add `async loadHost({ notifyError = true } = {})`.
- Call `this.loadHost().catch(() => {})` from `created()` alongside `this.loadGroups()`.
- Replace the Apollo `host` smart query by removing only the `host: { query: hostQuery, ... }` block.
- Keep `strategies` and `activeStrategies` Apollo smart queries unchanged.

Loader behavior:
- start loading key `admin-auth-host-refresh`
- call `fetchSystemHost(window.fetch.bind(window), 'Site host response is invalid')`
- set `this.host = response.host` on success
- set `this.host = ''` on failure
- if `notifyError`, show a red notification with the error message, matching `loadGroups()` style
- always stop loading key `admin-auth-host-refresh`
- rethrow after reporting so future callers can gate success if needed

Refresh behavior:
- Existing `refresh()` refetches `strategies` and `activeStrategies` and then shows success.
- Add `await this.loadHost()` before showing success so the visible host/callback URLs refresh too.
- Keep all strategy behavior unchanged.

## Tests

Modify `server/test/controllers/api.system.test.js`:
- Add `host` handler to `loadHandlers()` from path `/host`.
- Route registration test should assert `typeof handlers.host === 'function'`.
- Unauthorized system requests test should include `host` and expect one additional `403`.
- Add authorized host test:
  - set `global.WIKI.config.host = 'https://docs.example.test'`
  - call host handler
  - expect `{ host: 'https://docs.example.test' }`
  - assert the response has only `host` as a key

Modify `client/helpers/system-api.test.js`:
- import `fetchSystemHost`.
- Add valid host payload test asserting request path/options and sanitized return shape.
- Add extra-field stripping test if not covered by the valid payload.
- Add malformed payload rejection for missing/non-string `host`.
- Add JSON API error propagation test.
- Add non-JSON successful response rejection test if not already covered for this helper.

## Verification Commands

Targeted:
```bash
corepack yarn jest --runInBand server/test/controllers/api.system.test.js client/helpers/system-api.test.js
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

Secret scan:
- Run staged added-line secret scan before committing.
- Use only benign fixture hosts such as `https://docs.example.test`.

## Commit

After targeted tests, full tests/build, secret scan, and independent reviews pass:
```bash
git add docs/.planning/2026-04-25_011250-admin-auth-host-bootstrap-rest-slice-plan.md \
  server/controllers/api/system.js server/test/controllers/api.system.test.js \
  client/helpers/system-api.js client/helpers/system-api.test.js client/components/admin/admin-auth.vue

git commit -m "[verified] feat: move admin auth host bootstrap to REST"
```
