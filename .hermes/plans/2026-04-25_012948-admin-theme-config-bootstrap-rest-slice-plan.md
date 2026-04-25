# Admin Theme Config Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin theme config bootstrap/read path from GraphQL to REST while preserving the existing GraphQL save mutation and all current theme behavior.

**Architecture:** Add a narrow `GET /_api/theming/config` endpoint with exact `manage:theme` / `manage:system` permission parity and strict field allowlisting. Add a focused client helper, replace only the `admin-theme.vue` Apollo config smart query with a REST loader, and keep `theming.setConfig` on GraphQL.

**Tech Stack:** Express REST controller, Vue 2 admin component, CleanCSS, Jest controller/helper tests.

---

## Scope

Implement only:
- `GET /_api/theming/config`
- `client/helpers/theming-api.js`
- `client/helpers/theming-api.test.js`
- `server/test/controllers/api.theming.test.js`
- API index mount coverage for `/theming`
- migration of `client/components/admin/admin-theme.vue` config bootstrap from GraphQL to REST

Keep out of scope:
- `theming.setConfig` mutation migration
- theme package download/install features
- any dark-mode UX rewrite
- any sanitization or mutation of `injectHead` / `injectBody`
- dependency changes

## Parity Sources

Current GraphQL read:
- `client/graph/admin/theme/theme-query-config.gql`

Current component:
- `client/components/admin/admin-theme.vue`

GraphQL resolver/schema:
- `server/graph/resolvers/theming.js`
- `server/graph/schemas/theming.graphql`

Existing REST patterns:
- `server/controllers/api/search.js`
- `server/test/controllers/api.search.test.js`
- `client/helpers/search-api.js`
- `client/helpers/search-api.test.js`
- `server/controllers/api/index.js`
- `server/test/controllers/api.index.test.js`

## Required Server Behavior

Create `server/controllers/api/theming.js`:

- Use an Express router.
- Add `router.get('/config', handler)`.
- Check access with:
  - `WIKI.auth.checkAccess(req.user, ['manage:theme', 'manage:system'])`
- If unauthorized:
  - `res.sendStatus(403)`
  - do not call `res.json`
- On success, return only these fields:
  - `theme`
  - `iconset`
  - `darkMode`
  - `tocPosition`
  - `injectCSS`
  - `injectHead`
  - `injectBody`

Exact GraphQL read parity:

```js
{
  theme: WIKI.config.theming.theme,
  iconset: WIKI.config.theming.iconset,
  darkMode: WIKI.config.theming.darkMode,
  tocPosition: WIKI.config.theming.tocPosition || 'left',
  injectCSS: new CleanCSS({ format: 'beautify' }).minify(WIKI.config.theming.injectCSS).styles,
  injectHead: WIKI.config.theming.injectHead,
  injectBody: WIKI.config.theming.injectBody
}
```

Security constraints:
- Do not expose any extra theming fields.
- Do not expose broader `WIKI.config`.
- Do not log `injectCSS`, `injectHead`, or `injectBody` contents.
- Do not sanitize or escape `injectHead` / `injectBody`; GraphQL currently returns raw admin-authored values. Authorization is the safety boundary for this slice.

Mount it in `server/controllers/api/index.js`:
- `router.use('/theming', require('./theming'))`

## Required Client Helper Behavior

Create `client/helpers/theming-api.js`:

- Implement local `parseJsonResponse(response, fallbackMessage)` matching existing helpers.
- Implement `fetchThemeConfig(fetchImpl, fallbackMessage = 'Theme config response is invalid')`.
- Request:
  - URL: `/_api/theming/config`
  - `credentials: 'same-origin'`
  - `Accept: 'application/json'`
- Validate payload:
  - root is object and not array
  - `theme`: string
  - `iconset`: string
  - `darkMode`: boolean
  - `tocPosition`: string
  - `injectCSS`: string or null/undefined normalized to `''`? Prefer strict string if server mirrors GraphQL fixtures; if current GraphQL can return null for nullable fields, normalize nullable injection fields to `''` only if tests document this as client hardening.
  - `injectHead`: string
  - `injectBody`: string
- Return a sanitized object with only the seven expected fields.

Recommended strict helper shape:
- Require all seven fields to be present as the types the current admin component expects.
- Do not pass through extra/private fields.

## Required Component Behavior

Modify `client/components/admin/admin-theme.vue`:

- Remove import of `themeConfigQuery`.
- Keep import of `themeSaveMutation`.
- Add import:
  - `import { fetchThemeConfig } from '../../helpers/theming-api'`
- Remove only the `apollo.config` smart query.
- Add method `async loadConfig()`:
  - start `admin-theme-refresh`
  - fetch config with `fetchThemeConfig(window.fetch.bind(window), 'Theme config response is invalid')`
  - assign result to `this.config`
  - on error: `this.$store.commit('pushGraphError', err)`
  - always stop `admin-theme-refresh`
  - rethrow after reporting if useful for future callers
- Call `this.loadConfig().catch(() => {})` from `mounted()` or `created()`.

Dark mode constraint:
- Preserve current behavior as closely as possible.
- Do not change the v-switch binding from `darkMode` to `config.darkMode`.
- Do not change save variables; save must still use `darkMode: this.darkMode`.
- Do not add a separate dark-mode sync behavior in this slice unless tests prove parity. The current Apollo assignment sets `config.darkMode` but the UI switch uses Vuex `site/dark`.
- Preserve `mounted()` behavior that records `darkModeInitial = this.darkMode` and `beforeDestroy()` reset behavior.

## Required Tests

Create `server/test/controllers/api.theming.test.js`:

- Mock Express router like other controller tests.
- Mock `global.WIKI.auth.checkAccess`.
- Mock `global.WIKI.config.theming` with benign placeholder values only.
- Tests:
  1. registers `/config` route
  2. API index mounts `/theming`
  3. unauthorized request returns 403 and no JSON
  4. calls `checkAccess(req.user, ['manage:theme', 'manage:system'])`
  5. authorized request returns exactly the seven expected fields
  6. manage:theme-only user is allowed when `checkAccess` returns true
  7. tocPosition defaults to `'left'` when config value is missing/falsy
  8. injectCSS is beautified using CleanCSS read behavior
  9. injectHead and injectBody are returned unchanged

Create `client/helpers/theming-api.test.js`:

- Tests:
  1. fetches `/_api/theming/config` with same-origin JSON options
  2. validates and sanitizes a valid config payload
  3. strips extra fields
  4. rejects malformed roots and missing/wrong field types
  5. surfaces JSON API error messages on non-ok responses
  6. rejects successful non-JSON responses

Modify `server/test/controllers/api.index.test.js`:
- Include `/theming` in mounted route assertions.

## Verification Commands

Targeted:
```bash
corepack yarn jest --runInBand server/test/controllers/api.theming.test.js client/helpers/theming-api.test.js server/test/controllers/api.index.test.js
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
- Scan staged added lines before commit.
- Use benign placeholder fixture values only.
- Do not include real injection snippets, analytics IDs, tokens, keys, credentials, certs, passwords, or connection strings.

## Commit

After targeted tests, full tests/build, staged secret scan, and independent reviews pass:

```bash
git add .hermes/plans/2026-04-25_012948-admin-theme-config-bootstrap-rest-slice-plan.md \
  server/controllers/api/theming.js server/test/controllers/api.theming.test.js \
  server/controllers/api/index.js server/test/controllers/api.index.test.js \
  client/helpers/theming-api.js client/helpers/theming-api.test.js \
  client/components/admin/admin-theme.vue

git commit -m "[verified] feat: move admin theme config bootstrap to REST"
```
