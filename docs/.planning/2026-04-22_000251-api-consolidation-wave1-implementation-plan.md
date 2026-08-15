# API Consolidation Wave 1 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Establish a small REST foundation on the current verified baseline and land the first low-risk admin/bootstrap endpoints harvested from Scarlett without destabilizing the existing GraphQL-driven app.

**Architecture:** Keep the current Express + GraphQL baseline intact. Add a new modular REST surface under the existing server with conservative JSON endpoints that wrap already-proven baseline resolver/model logic rather than replacing domain behavior. Do not migrate frontend consumers in this wave except where a tiny smoke probe is required.

**Tech Stack:** Express routers, existing `req.user` auth stack from `server/master.js`, current model/resolver logic in `server/graph/resolvers/*`, Jest unit/controller tests, existing `corepack yarn test` and `corepack yarn build` verification.

---

## Scope of wave 1

In scope:
- introduce a small REST route shell under the current Express app
- add read/admin/bootstrap endpoints only:
  - `GET /_api/system/info`
  - `GET /_api/system/flags`
  - `POST /_api/system/check-for-update`
  - `GET /_api/locales`
  - `GET /_api/locales/:code/strings`
  - `GET /_api/users/whoami`
- optional if still small after the above: `GET /_api/auth/strategies`

Out of scope:
- replacing GraphQL generally
- frontend migration from Apollo to REST
- auth login/logout/change-password routes
- pages REST API
- users CRUD REST API
- OpenAPI/Swagger UI exposure if it requires meaningful package or app-boot churn
- Fastify adoption

Why this scope:
- these endpoints are either directly supported by current baseline logic or can be wrapped with minimal semantic porting
- they create a stable REST foothold without forcing architectural conflict with the existing GraphQL app

---

## Proposed file layout

### New files
- `server/controllers/api/index.js`
- `server/controllers/api/system.js`
- `server/controllers/api/locales.js`
- `server/controllers/api/users.js`
- `server/test/controllers/api.system.test.js`
- `server/test/controllers/api.locales.test.js`
- `server/test/controllers/api.users.test.js`

### Existing files to modify
- `server/master.js`
  - mount the new API router before the catch-all page routes
- possibly `server/controllers/common.js`
  - only if a tiny shared JSON/error helper is more natural there; avoid if not needed

### Existing files to read/reuse, not rewrite heavily
- `server/graph/resolvers/system.js`
- `server/graph/resolvers/localization.js`
- `server/graph/resolvers/user.js`
- `server/test/controllers/common.metrics.test.js`
- `server/test/graph/authentication.metrics.test.js`

---

## REST contract conventions for wave 1

Keep the API format intentionally simple and conservative.

Recommended response shapes:
- success reads: plain JSON objects/arrays
- auth failure: `403` or `401` matching current baseline semantics
- unexpected errors: `500 { error: 'message' }` or delegated to Express error middleware if already consistent

Do not introduce a large new response-envelope standard in wave 1 unless it is absolutely tiny and improves consistency without spreading churn.

Suggested auth rule split:
- admin/system endpoints require `manage:system`
- locale list/strings can likely be public/readable if they only expose currently available localization data
- `whoami` should always return 200 with authenticated state instead of treating anonymous as an error

---

## Task 1: Add the REST route shell

**Objective:** Create a minimal modular API router and mount it in the existing Express app without changing current GraphQL behavior.

**Files:**
- Create: `server/controllers/api/index.js`
- Modify: `server/master.js`
- Test: covered indirectly by subsequent controller tests

**Step 1: Write failing test**

Prefer a controller-router registration test only if route mounting is hard to reason about from later endpoint tests. Otherwise skip a dedicated shell-only test and let later route tests prove the shell is wired.

**Step 2: Implement minimal route shell**

Create `server/controllers/api/index.js` that:
- creates an Express router
- mounts subrouters for `system`, `locales`, and `users`
- exports the router

Patch `server/master.js` to mount it at:
- `app.use('/_api', ctrl.api)`

Placement guidance:
- mount after auth middleware is initialized so `req.user` exists
- mount before the catch-all view/page routes in `server/controllers/common.js`

**Step 3: Verify no boot-order regressions**

Run:
- `corepack yarn jest --runInBand server/test/controllers/common.metrics.test.js`
Expected: PASS

**Step 4: Commit**
- do not commit yet; wave 1 should commit after full verified slice

---

## Task 2: Add system REST endpoints

**Objective:** Expose low-risk system/admin reads via REST by reusing baseline resolver logic rather than duplicating system calculations.

**Files:**
- Create: `server/controllers/api/system.js`
- Create: `server/test/controllers/api.system.test.js`
- Read/reuse: `server/graph/resolvers/system.js`

**Step 1: Write failing tests**

Tests to add:
1. registers `GET /system/info`
2. registers `GET /system/flags`
3. registers `POST /system/check-for-update`
4. returns `403` for unauthorized system requests
5. returns flag list JSON for authorized request
6. returns info JSON for authorized request
7. delegates check-for-update to existing system/version logic and returns JSON result

Testing style should mirror `server/test/controllers/common.metrics.test.js`:
- mock `express`
- capture registered route handlers from `express.__router.get/post.mock.calls`
- stub global `WIKI`
- call handlers directly with fake `req`, `res`, `next`

**Step 2: Run test to verify failure**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js`
Expected: FAIL because the controller file/handlers do not exist yet.

**Step 3: Implement minimal controller**

Controller guidance:
- `GET /system/flags`
  - require `manage:system`
  - return the same array shape as `SystemQuery.flags()` in `server/graph/resolvers/system.js`
- `GET /system/info`
  - require `manage:system`
  - prefer reusing or lightly extracting the same aggregation logic used by `SystemQuery.info` rather than re-implementing it from scratch
- `POST /system/check-for-update`
  - require `manage:system`
  - reuse existing update-check logic already used in baseline system flows

Important design rule:
- if direct reuse of resolver code is clean, do that
- if the resolver currently mixes transport concerns and domain logic awkwardly, extract a tiny shared helper into a new internal module only if necessary and keep the extraction minimal

**Step 4: Run test to verify pass**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js`
Expected: PASS

**Step 5: Run nearby regression tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/common.metrics.test.js server/test/graph/authentication.metrics.test.js`
Expected: PASS

---

## Task 3: Add locales REST endpoints

**Objective:** Expose locale list and translation-string reads through REST, using existing localization logic.

**Files:**
- Create: `server/controllers/api/locales.js`
- Create: `server/test/controllers/api.locales.test.js`
- Read/reuse: `server/graph/resolvers/localization.js`

**Step 1: Write failing tests**

Tests to add:
1. registers `GET /locales`
2. registers `GET /locales/:code/strings`
3. returns locale list payload from existing localization sources
4. returns strings payload for a given locale code / namespace mapping decision
5. handles missing locale or translation-source failure predictably

Important design decision to settle in implementation:
- Baseline GraphQL `translations(locale, namespace)` expects a namespace argument.
- For REST wave 1, choose one of these minimal patterns and document it in tests:
  - `GET /locales/:code/strings?namespace=foo` returning one namespace, or
  - `GET /locales/:code/strings` returning a default namespace bundle if that is already easy to obtain.

Recommendation:
- use query param `namespace` because it maps directly to current baseline logic and avoids inventing aggregation behavior.

**Step 2: Run test to verify failure**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.locales.test.js`
Expected: FAIL

**Step 3: Implement minimal controller**

Controller guidance:
- `GET /locales`
  - can likely be public
  - reuse `LocalizationQuery.locales()` behavior
- `GET /locales/:code/strings?namespace=...`
  - if namespace is missing, return `400` with a small JSON error
  - reuse `WIKI.lang.getByNamespace(locale, namespace)` or the GraphQL resolver equivalent

**Step 4: Run test to verify pass**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.locales.test.js`
Expected: PASS

**Step 5: Run nearby regression tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.locales.test.js server/test/controllers/common.metrics.test.js`
Expected: PASS

---

## Task 4: Add `whoami` bootstrap endpoint

**Objective:** Provide a tiny authenticated-user bootstrap endpoint for future frontend/session hydration without committing to a broader auth rewrite.

**Files:**
- Create: `server/controllers/api/users.js`
- Create: `server/test/controllers/api.users.test.js`
- Read/reuse: `server/graph/resolvers/user.js`

**Step 1: Write failing tests**

Tests to add:
1. registers `GET /users/whoami`
2. returns `{ authenticated: false, user: null }` when `req.user` is absent/guest-like
3. returns a safe user summary when authenticated
4. does not leak sensitive fields such as password/tfa secrets/tokens

Recommended response shape:
```json
{
  "authenticated": true,
  "user": {
    "id": 123,
    "name": "Alice",
    "email": "alice@example.com",
    "providerKey": "local",
    "permissions": ["..."]
  }
}
```

Keep it intentionally small.

**Step 2: Run test to verify failure**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.users.test.js`
Expected: FAIL

**Step 3: Implement minimal controller**

Controller guidance:
- do not copy Scarlett’s simplistic hardcoded permissions approach
- derive from current `req.user`
- anonymous should not be an error
- sanitize aggressively

**Step 4: Run test to verify pass**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.users.test.js`
Expected: PASS

**Step 5: Run nearby regression tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.users.test.js server/test/graph/user.list.test.js`
Expected: PASS

---

## Task 5: Optional small auth endpoint (`GET /auth/strategies`)

**Objective:** Only if the previous tasks stay low-risk and green, add a simple REST strategy-list endpoint as the first auth REST wrapper.

**Files:**
- Create or modify: `server/controllers/api/auth.js`
- Create: `server/test/controllers/api.auth.test.js`
- Read/reuse: `server/graph/resolvers/authentication.js`

**Step 1: Write failing test**

Test only:
- `GET /auth/strategies` returns active strategies payload

Do not include login/change-password in wave 1 unless the first 4 tasks are trivial and still stable.

**Step 2: Run test to verify failure**
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: FAIL

**Step 3: Implement minimal controller**
- expose only the strategy read endpoint
- keep auth mutations for a later wave

**Step 4: Run test to verify pass**
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: PASS

---

## Final verification

After the chosen wave-1 tasks are complete, run:
- `corepack yarn jest --runInBand server/test/controllers/api.system.test.js server/test/controllers/api.locales.test.js server/test/controllers/api.users.test.js`
- if auth endpoint added: include `server/test/controllers/api.auth.test.js`
- `corepack yarn test`
- `corepack yarn build`

Expected baseline warnings that are non-blocking:
- Vue component naming warning for `setup`
- Browserslist/caniuse-lite notice if it appears
- webpack asset size warnings

---

## Review gates

Before commit:
1. spec-compliance review on the new API route files and tests
2. code-quality review on the same diff
3. confirm no secrets/tokens accidentally exposed in `whoami` or system info payloads

Commit format when verified:
- `[verified] feat: add API consolidation wave 1 REST endpoints`

---

## Risks and tradeoffs

### Main risks
- duplicating resolver logic instead of reusing it cleanly
- accidentally widening scope into auth/frontend migration
- exposing unsafe or overly broad system/user data via REST
- route mounting order mistakes causing catch-all controller interference

### Tradeoffs chosen deliberately
- keep Express instead of porting Fastify/OpenAPI runtime now
- prioritize useful endpoints over a perfect API framework
- allow GraphQL and REST to coexist during consolidation

---

## Open questions for implementation
- Should `GET /_api/locales/:code/strings` require an explicit `namespace` query param? Recommended: yes.
- Should `GET /_api/system/info` include all current GraphQL fields or a smaller safe subset? Recommended: smaller safe subset first.
- Should wave 1 include `GET /_api/auth/strategies` or defer all auth endpoints to wave 2? Recommended: defer unless the first 4 tasks land easily.

---

## Recommended execution choice

Execute wave 1 in this exact order:
1. route shell
2. system endpoints
3. locales endpoints
4. whoami endpoint
5. optional auth strategies endpoint only if still low-risk

This is the smallest evidence-backed API-consolidation slice that directly advances the project’s REST-oriented direction while preserving the stable baseline.