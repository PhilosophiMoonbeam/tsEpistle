# Admin Export Status Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin utilities export status polling/read path from GraphQL to REST while preserving the existing GraphQL export mutation and export workflow behavior.

**Architecture:** Add a narrow `GET /_api/system/export-status` endpoint under the existing system REST controller with exact `manage:system` permission parity. Add a focused client helper and replace only the `system.exportStatus` `$apollo.query` polling read in `admin-utilities-export.vue` with the REST helper.

**Tech Stack:** Express system REST controller, Vue 2 admin component, existing `client/helpers/system-api.js`, Jest controller/helper tests.

---

## Scope

Implement only:
- `GET /_api/system/export-status`
- `fetchSystemExportStatus(fetchImpl, fallbackMessage)` helper
- migration of `client/components/admin/admin-utilities-export.vue` export status polling read from GraphQL to REST
- focused tests

Keep out of scope:
- `system.export` mutation migration
- export job implementation changes
- export path validation changes
- import/export UI redesign
- dependency changes
- Phase Three dependency modernization

## Parity Sources

Current client polling read:
- `client/components/admin/admin-utilities-export.vue`, `checkProgress()`

GraphQL resolver/schema:
- `server/graph/resolvers/system.js`, `SystemQuery.exportStatus`
- `server/graph/schemas/system.graphql`, `exportStatus: SystemExportStatus @auth(requires: ["manage:system"])`

Existing REST patterns:
- `server/controllers/api/system.js`
- `server/test/controllers/api.system.test.js`
- `client/helpers/system-api.js`
- `client/helpers/system-api.test.js`

## Required Server Behavior

Modify `server/controllers/api/system.js`:

- Add `buildSystemExportStatus()` returning:
  - `status: WIKI.system.exportStatus.status`
  - `progress: Math.ceil(WIKI.system.exportStatus.progress)`
  - `message: WIKI.system.exportStatus.message`
  - `startedAt: WIKI.system.exportStatus.startedAt`
- Add `router.get('/export-status', handler)`.
- Use existing `requireSystemAccess(req, res)`.
  - This preserves GraphQL `@auth(requires: ["manage:system"])` parity.
- Return only the four status fields.
- Do not return exported entities, paths, user records, config, archive paths, secrets, or any export output content.

Optional hardening:
- Set `Cache-Control: no-store` before returning the status payload because export status is operational/admin-only state.

## Required Client Helper Behavior

Modify `client/helpers/system-api.js`:

- Add `normalizeSystemExportStatusPayload(payload, fallbackMessage)`.
- Add and export `fetchSystemExportStatus(fetchImpl, fallbackMessage = 'Export status response is invalid')`.

Request:
- URL: `/_api/system/export-status`
- `credentials: 'same-origin'`
- `Accept: application/json`

Validation:
- root payload must be an object and not an array
- `status` must be a string
- `progress` must be a finite number
- `message` must be a string or null
- `startedAt` must be a string or null
- return only the four expected fields

GraphQL schema marks these fields nullable, so the helper should permit `message`/`startedAt` as null but should keep `status` and `progress` strict because the export UI switch depends on status and progress.

## Required Component Behavior

Modify `client/components/admin/admin-utilities-export.vue`:

- Keep `gql` import because `system.export` mutation remains GraphQL.
- Remove `_get` import only if no longer used after replacing status query.
- Import `fetchSystemExportStatus` from `../../helpers/system-api`.
- In `checkProgress()`:
  - replace the `$apollo.query` block with:
    - `const respStatusObj = await fetchSystemExportStatus(window.fetch.bind(window), 'Export status response is invalid')`
  - preserve the existing switch behavior for `error`, `running`, `success`, and default invalid status.
- Keep `startExport()` mutation exactly on GraphQL.
- Preserve current polling cadence and UI transitions.

## Required Tests

Modify `server/test/controllers/api.system.test.js`:

- Include handler extraction for `/export-status` in `loadHandlers()`.
- Route registration test should assert handler exists.
- Unauthorized system requests test should call `exportStatus` and increase expected 403 count.
- Add authorized export status test:
  - set benign `global.WIKI.system.exportStatus` fields
  - assert `progress` is rounded with `Math.ceil`
  - assert response contains exactly `status`, `progress`, `message`, `startedAt`
  - assert `Cache-Control: no-store` if implemented

Modify `client/helpers/system-api.test.js`:

- Import `fetchSystemExportStatus`.
- Add tests for:
  - successful fetch path/options and normalized shape
  - strips extra fields
  - rejects malformed root
  - rejects invalid status/progress/message/startedAt types
  - surfaces JSON API errors
  - rejects successful non-JSON responses

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
- Scan staged added lines before commit.
- Use benign placeholder status values only.
- Do not include real export paths, credentials, keys, tokens, certs, passwords, connection strings, or production hostnames.

## Commit

After targeted tests, full tests/build, staged secret scan, and independent reviews pass:

```bash
git add docs/.planning/2026-04-25_121807-admin-export-status-bootstrap-rest-slice-plan.md \
  server/controllers/api/system.js server/test/controllers/api.system.test.js \
  client/helpers/system-api.js client/helpers/system-api.test.js \
  client/components/admin/admin-utilities-export.vue

git commit -m "[verified] feat: move admin export status polling to REST"
```
