# Admin system flags REST slice plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move the admin developer flags screen from GraphQL to the existing REST system surface by adding a write endpoint for system flags and switching the admin UI to REST for both read and write operations.

**Architecture:** Keep the current admin-dev-flags UI and current flag data shape (`[{ key, value }]`) intact. Extend `server/controllers/api/system.js` with an authenticated write endpoint that mirrors the existing GraphQL `system.updateFlags` behavior, then add a tiny client helper for admin system REST calls so the screen can stop depending on GraphQL for flags.

**Tech Stack:** Express REST controller under `/_api/system`, Vue 2 admin UI, existing `WIKI.configSvc.applyFlags()` / `saveToDb(['flags'])`, Jest controller/helper tests, full `corepack yarn test` and `corepack yarn build` verification.

---

## Scope

### In scope
- add authenticated system-flags write endpoint
- move `client/components/admin/admin-dev-flags.vue` flags read from GraphQL to REST
- move `client/components/admin/admin-dev-flags.vue` flags save from GraphQL to REST
- add/update helper tests and system controller tests

### Out of scope
- broader admin dashboard stats migration
- telemetry/system-info migration
- other admin GraphQL pages
- flag schema redesign

## Files
- Modify: `server/controllers/api/system.js`
- Modify: `server/test/controllers/api.system.test.js`
- Create: `client/helpers/system-api.js`
- Create: `client/helpers/system-api.test.js`
- Modify: `client/components/admin/admin-dev-flags.vue`

## Acceptance criteria
- admin developer flags screen no longer uses `dev-query-flags.gql` or `dev-mutation-save-flags.gql`
- flags list still loads correctly
- flags save still applies + persists flags through existing config service
- endpoint remains permission-gated by `manage:system`
- tests/build stay green
