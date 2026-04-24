# Admin utilities telemetry bootstrap REST slice

## Objective
Move the read-only telemetry bootstrap in `client/components/admin/admin-utilities-telemetry.vue` off its Apollo smart query and onto a narrow REST read path, while leaving telemetry mutations on GraphQL for this slice.

## Why this slice
- Small, read-only/bootstrap-only surface: `telemetry` and `telemetryClientId`.
- Existing REST system controller/helper patterns are already verified.
- Permission parity is straightforward: GraphQL fields require `manage:system`; REST will use `requireSystemAccess`.
- No dependency bump, auth-stack rewrite, registration work, or branch merge required.

## Scope

### Server
- Add a narrow `GET /_api/system/telemetry` endpoint in `server/controllers/api/system.js`.
- Use existing `requireSystemAccess(req, res)` gate.
- Return only:
  - `telemetry`: boolean, from `WIKI.telemetry.enabled` with safe fallback `false`.
  - `telemetryClientId`: string or null, from `WIKI.config.telemetry.clientId`.
- Add server tests in `server/test/controllers/api.system.test.js`:
  - route registration.
  - unauthorized requests include telemetry endpoint in 403 coverage.
  - authorized response matches GraphQL semantics.

### Client helper
- Add `fetchSystemTelemetry(fetchImpl, fallbackMessage)` to `client/helpers/system-api.js`.
- Validate response shape strictly:
  - root object, not array.
  - `telemetry` must be boolean.
  - `telemetryClientId` must be string or null.
- Return a sanitized object with only `telemetry` and `telemetryClientId`.
- Add helper tests in `client/helpers/system-api.test.js`:
  - success and fetch options.
  - null client ID support.
  - malformed payload rejection.
  - API error propagation.

### Vue component
- In `client/components/admin/admin-utilities-telemetry.vue`:
  - remove `utilities-query-telemetry.gql` import and Apollo smart query block.
  - import `fetchSystemTelemetry`.
  - add `created () { this.loadTelemetry() }`.
  - add `loadTelemetry()` using `window.fetch.bind(window)`, loading key `admin-utilities-telemetry-refresh`, and `pushGraphError` on failure.
  - after successful `resetClientId`, `await this.loadTelemetry()` before success notification.
- Keep `setTelemetry` and `resetTelemetryClientId` GraphQL mutations unchanged.

## Out of scope
- No telemetry mutation REST migration.
- No deletion of legacy GraphQL query file in this slice unless it becomes obviously unreferenced and safe.
- No dependency updates.
- No Scarlett/Vega raw merge/cherry-pick.

## Verification
1. `corepack yarn jest --runInBand server/test/controllers/api.system.test.js client/helpers/system-api.test.js`
2. `corepack yarn test`
3. `corepack yarn build`
4. Independent security/spec review subagent.
5. Independent client/helper quality review subagent.
6. `git diff --check`
7. Secret-pattern scan over changed diff.
8. Commit only if all checks pass with message prefix `[verified]`.
