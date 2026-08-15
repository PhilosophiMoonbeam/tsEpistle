# Admin Dashboard Recent Pages REST Slice Plan

> For Hermes: use subagent-driven-development review discipline for this slice, but implement as one narrow verified batch.

Goal: move only the admin dashboard recent-pages widget off GraphQL and onto a dashboard-specific pages REST endpoint.

Architecture:
- Add a narrow `GET /_api/pages/recent` endpoint under the existing API shell.
- Mirror current GraphQL dashboard behavior for route-level and per-row access checks.
- Keep this dashboard-specific; do not create a generic pages list API yet.

Tech Stack: Express controller under `server/controllers/api`, existing Jest controller-shell tests, Vue 2 admin dashboard, small client helper module.

---

Scope
- Add `GET /_api/pages/recent`.
- Add helper `fetchRecentPages(fetchImpl, fallbackMessage)`.
- Replace only the `recentPages` Apollo bootstrap in `client/components/admin/admin-dashboard.vue`.
- Leave last-logins REST as-is.

Out of scope
- Full admin pages list REST.
- Page detail/edit REST.
- Page mutations.
- Page tree/links/visualization REST.
- Tags REST.

Files
- Create: `server/controllers/api/pages.js`
- Create: `server/test/controllers/api.pages.test.js`
- Create: `client/helpers/pages-api.js`
- Create: `client/helpers/pages-api.test.js`
- Modify: `server/controllers/api/index.js`
- Modify: `server/test/controllers/api.index.test.js`
- Modify: `client/components/admin/admin-dashboard.vue`

Endpoint contract
- Route: `GET /_api/pages/recent`
- Route-level permissions match current GraphQL/dashboard gate:
  - `manage:system`
  - `read:pages`
- Per-row access filter mirrors `PageQuery.list`:
  - `WIKI.auth.checkAccess(req.user, ['read:pages'], { path, locale })`
- Response:
  - array of at most 10 rows
  - each row: `{ id, locale, path, title, updatedAt }`
- Query behavior:
  - `WIKI.models.pages.query()`
  - `column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])`
  - `orderBy('updatedAt', 'desc')`
  - `limit(10)`
  - filter after limiting, preserving GraphQL parity where restricted users may see fewer than 10 rows

Implementation notes
- Do not include private/publish metadata in the REST payload because the dashboard does not render it.
- Do not copy Scarlett’s stub pages implementation.
- Keep dashboard REST loading reactive to permission changes, as done for last-logins.
- Remove `graphql-tag` import and the `apollo` block from `admin-dashboard.vue` once recent pages is migrated.

Verification
- Targeted Jest:
  - `corepack yarn jest --runInBand server/test/controllers/api.pages.test.js server/test/controllers/api.index.test.js client/helpers/pages-api.test.js`
- Full verification:
  - `corepack yarn test`
  - `corepack yarn build`
- Independent review:
  - spec review
  - code-quality review

Commit boundary
- `[verified] feat: move dashboard recent pages to REST`
