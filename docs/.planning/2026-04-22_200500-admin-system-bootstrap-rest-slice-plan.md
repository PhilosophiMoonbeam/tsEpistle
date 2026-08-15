# Admin system bootstrap REST slice plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move the admin shell/dashboard bootstrap summary from GraphQL to the existing REST system surface by expanding `GET /_api/system/info` with dashboard-safe aggregate counts and switching `client/components/admin.vue` to load its bootstrap info via REST.

**Architecture:** Keep the current `admin/info` vuex state shape and sidebar/dashboard consumers intact. Extend `server/controllers/api/system.js` with only the low-risk aggregate fields already used by the admin shell (`groupsTotal`, `pagesTotal`, `usersTotal`, `tagsTotal`) and leave broader host/DB/system-details GraphQL queries for a later slice.

**Tech Stack:** Express REST controller under `/_api/system`, Vue 2 admin shell, vuex-pathify admin store, small CommonJS client helper tests, Jest controller tests, full `corepack yarn test` and `corepack yarn build` verification.

---

## Scope

### In scope
- expand `GET /_api/system/info`
- move `client/components/admin.vue` bootstrap stats query from GraphQL to REST
- add/update helper tests and controller tests
- preserve current dashboard/sidebar count + version consumers unchanged

### Out of scope
- admin-system.vue host/runtime details migration
- SSL/system-config field migration
- telemetry migration (already REST-covered but not part of this slice)
- loginsPastDay or mail-status additions unless directly needed by current baseline consumers

## Files
- Modify: `server/controllers/api/system.js`
- Modify: `server/test/controllers/api.system.test.js`
- Modify: `client/helpers/system-api.js`
- Modify: `client/helpers/system-api.test.js`
- Modify: `client/store/admin.js`
- Modify: `client/components/admin.vue`

## Acceptance criteria
- admin shell no longer depends on `client/graph/admin/dashboard/dashboard-query-stats.gql`
- `admin/info` still provides:
  - currentVersion
  - latestVersion
  - groupsTotal
  - pagesTotal
  - usersTotal
  - tagsTotal
- sidebar badges and dashboard version/count cards continue to work
- endpoint remains `manage:system` gated
- tests/build stay green
