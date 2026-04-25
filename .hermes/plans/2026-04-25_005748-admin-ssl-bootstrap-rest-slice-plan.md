# Admin SSL Bootstrap REST Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move only the admin SSL status/bootstrap/refresh read path from GraphQL to REST while preserving existing SSL redirection and certificate-renewal GraphQL mutations.

**Architecture:** Add a narrow read-only `GET /_api/system/ssl` endpoint in the existing system REST controller. It returns only the eight SSL/port fields currently selected by `admin-ssl.vue` from `system.info`, with `manage:system` permission parity. Add a focused helper `fetchSystemSsl()` and replace the Apollo smart query in `admin-ssl.vue` with a manual REST loader.

**Tech Stack:** Express controller under `server/controllers/api/system.js`, Vue 2 component, existing `client/helpers/system-api.js`, Jest controller/helper tests.

---

## Scope

Implement only:
- `GET /_api/system/ssl`
- `fetchSystemSsl(fetchImpl, fallbackMessage)` helper
- admin SSL bootstrap/refresh migration in `client/components/admin/admin-ssl.vue`
- focused tests

Keep out of scope:
- `system.setHTTPSRedirection` mutation migration
- `system.renewHTTPSCertificate` mutation migration
- SSL/certificate service behavior changes
- expanding `/_api/system/info` for this page
- any dependency changes

## Parity Sources

Component:
- `client/components/admin/admin-ssl.vue`

GraphQL resolver/schema:
- `server/graph/resolvers/system.js`
- `server/graph/schemas/system.graphql`

Existing REST helper/controller/tests:
- `server/controllers/api/system.js`
- `client/helpers/system-api.js`
- `server/test/controllers/api.system.test.js`
- `client/helpers/system-api.test.js`

## Required REST Endpoint

Add to `server/controllers/api/system.js`:
- `buildSystemSslInfo()` returning only:
  - `httpPort`
  - `httpRedirection`
  - `httpsPort`
  - `sslDomain`
  - `sslExpirationDate`
  - `sslProvider`
  - `sslStatus`
  - `sslSubscriberEmail`
- `router.get('/ssl', ...)`

Permission:
- Require `WIKI.auth.checkAccess(req.user, ['manage:system'])` via existing `requireSystemAccess`.
- If unauthorized, `res.sendStatus(403)` and do not return JSON.

Field parity with GraphQL `SystemInfo` resolvers:
- `httpPort`:
  - `WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0`
- `httpRedirection`:
  - `_.get(WIKI.config, 'server.sslRedir', false)`
- `httpsPort`:
  - `WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0`
- `sslDomain`:
  - `WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.domain : null`
- `sslExpirationDate`:
  - `WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? _.get(WIKI.config.letsencrypt, 'payload.expires', null) : null`
- `sslProvider`:
  - `WIKI.config.ssl.enabled ? WIKI.config.ssl.provider : null`
- `sslStatus`:
  - `'OK'`
- `sslSubscriberEmail`:
  - `WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.subscriberEmail : null`

Do not expose:
- raw `WIKI.config.ssl`
- raw `WIKI.config.letsencrypt`
- certificate paths
- ACME payloads
- private keys
- any fields outside the eight-field allowlist

## Required Client Helper

Modify `client/helpers/system-api.js`:
- Add `normalizeSystemSslPayload(payload, fallbackMessage)`.
- Add `fetchSystemSsl(fetchImpl, fallbackMessage = 'SSL status response is invalid')`.
- Export `fetchSystemSsl`.

Request shape:
- URL: `/_api/system/ssl`
- options:
  - `credentials: 'same-origin'`
  - `headers.Accept: 'application/json'`

Validation:
- root payload must be a plain object, not null/array
- `httpPort`: finite number
- `httpRedirection`: boolean
- `httpsPort`: finite number
- `sslStatus`: string
- nullable string fields must be either string or null:
  - `sslDomain`
  - `sslExpirationDate`
  - `sslProvider`
  - `sslSubscriberEmail`

Return a sanitized object containing only the eight fields.

## Required Component Changes

Modify `client/components/admin/admin-ssl.vue`:
- Keep `gql` import because mutations remain inline GraphQL.
- Import `fetchSystemSsl` from `../../helpers/system-api`.
- Remove the Apollo `info` smart query.
- Add `created() { this.loadInfo().catch(() => {}) }`.
- Add `async loadInfo({ notifyError = true } = {})`.

Loader behavior:
- start loading token `admin-ssl-refresh`
- call `fetchSystemSsl(window.fetch.bind(window), 'SSL status response is invalid')`
- assign `this.info` on success
- on failure, keep the component stable by resetting `this.info` to its default empty SSL shape
- if `notifyError`, push/report the error using existing admin conventions (`pushGraphError` is acceptable for Error objects in this component)
- always stop loading token in `finally`
- rethrow after reporting so future callers can gate success notifications

Keep unchanged:
- `toggleRedir()` GraphQL mutation
- `renewCertificate()` GraphQL mutation
- UI/template behavior

## Tests

Modify `server/test/controllers/api.system.test.js`:
- Add `ssl` handler to `loadHandlers()` from path `/ssl`.
- Route registration test should assert `typeof handlers.ssl === 'function'`.
- Unauthorized system requests test should include `ssl` and expect one additional 403.
- Add authorized Let’s Encrypt test:
  - set `global.WIKI.config.server.sslRedir = true`
  - set `global.WIKI.config.ssl = { enabled: true, provider: 'letsencrypt', domain: 'docs.example.test', subscriberEmail: 'ops@example.test' }`
  - set `global.WIKI.config.letsencrypt = { payload: { expires: '2026-06-01T00:00:00.000Z' } }`
  - keep mocked HTTP/HTTPS ports from existing fixture
  - expect exact eight-field JSON payload
- Add disabled/custom provider/nullability test:
  - disabled SSL returns `sslProvider`, `sslDomain`, `sslExpirationDate`, `sslSubscriberEmail` as null
  - missing http/https servers return ports 0 if practical
- Ensure no raw SSL/letsencrypt config fields are returned.

Modify `client/helpers/system-api.test.js`:
- import `fetchSystemSsl`.
- Add valid payload test that asserts request path/options and sanitized return shape.
- Add nullable field test for disabled SSL.
- Add malformed payload tests for invalid ports/boolean/nullable string fields.
- Add JSON API error propagation test.
- Add non-JSON successful response rejection test if not already covered by a shared helper path.

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
- Avoid real credentials in fixtures; use `docs.example.test` / `ops@example.test` only.

## Commit

After targeted tests, full tests/build, secret scan, and independent reviews pass:
```bash
git add .hermes/plans/2026-04-25_005748-admin-ssl-bootstrap-rest-slice-plan.md \
  server/controllers/api/system.js server/test/controllers/api.system.test.js \
  client/helpers/system-api.js client/helpers/system-api.test.js client/components/admin/admin-ssl.vue

git commit -m "[verified] feat: move admin SSL bootstrap to REST"
```
