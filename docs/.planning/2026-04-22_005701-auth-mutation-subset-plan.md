# API Consolidation Wave 2: Auth mutation subset plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add the next safest REST auth mutation slice on the current verified baseline by exposing form-login and mandatory-change-password flows through REST, without destabilizing existing browser/social/TFA/passkey flows.

**Architecture:** Keep the current JWT-cookie baseline and single-site strategy model intact. Add thin REST wrappers over existing baseline auth model methods instead of importing Scarlett’s session-based/multisite implementation. Restrict this wave to the JSON form-auth continuation flow only.

**Tech Stack:** Express REST shell under `/_api`, existing auth models in `server/models/users.js` and `server/models/authentication.js`, current browser auth controllers in `server/controllers/auth.js`, current login UI in `client/components/login.vue`, Jest controller/unit tests, full `corepack yarn test` and `corepack yarn build` verification.

---

## Why this is the next safe slice

Grounded audit findings:
- Current baseline already has reusable model logic for:
  - form login
  - TFA continuation
  - mandatory password-change continuation
- Existing REST auth foothold already exists:
  - `GET /_api/auth/strategies`
- Scarlett provides useful pattern direction, but its auth layer is not directly portable because it differs on:
  - multisite route shape (`/sites/:siteId/...`)
  - session-based auth state
  - partially migrated TFA/register/passkey flows

Therefore, the safest next baseline move is:
- expose only the baseline’s JSON-oriented auth continuation subset
- do not try to port Scarlett’s broader auth architecture

---

## Recommended scope

### In scope
- `POST /_api/auth/login`
- `POST /_api/auth/login/tfa`
- `POST /_api/auth/login/change-password`
- minimal route/controller tests for these endpoints
- if necessary, tiny shared auth response shaping helper

### Explicitly out of scope
- social/OAuth redirect login via REST
- register REST
- forgot-password REST
- passkey REST
- logout/refresh redesign
- browser redirect cookie behavior (`loginRedirect`)
- full frontend migration off GraphQL auth in the same slice

Why the scope boundary matters:
- baseline login can branch into TFA or mandatory password change
- login without `login/tfa` is incomplete
- broader auth items rapidly expand into browser flow and architecture decisions

---

## Proposed REST contract

Use a stable JSON response envelope that mirrors the current baseline auth branches closely enough for future frontend migration.

### Success payload shape
```json
{
  "jwt": "... or null",
  "mustChangePwd": false,
  "mustProvideTFA": false,
  "mustSetupTFA": false,
  "continuationToken": null,
  "redirect": null,
  "tfaQRImage": null
}
```

Rationale:
- this aligns with current baseline model behavior
- it avoids inventing a new auth state machine in the same slice
- it minimizes future translation work if `login.vue` later switches from GraphQL to REST

### Error handling
- keep using the API shell’s JSON error behavior
- controller-level validation errors should return small explicit 4xx JSON payloads where useful
- do not leak internal auth/provider configuration details

---

## Proposed file layout

### New or modified files
- Modify: `server/controllers/api/auth.js`
  - add mutation endpoints alongside `GET /strategies`
- Modify: `server/test/controllers/api.auth.test.js`
  - expand with login/tfa/change-password coverage

### Existing files to read/reuse, not heavily rewrite
- `server/models/users.js`
- `server/models/userKeys.js`
- `server/graph/resolvers/authentication.js`
- `server/controllers/auth.js`
- `client/components/login.vue`
- `server/helpers/common.js`

### Only if strictly necessary
- new tiny helper under `server/controllers/api/` or `server/helpers/` to normalize auth responses

Avoid touching wider auth architecture files unless tests prove it is necessary.

---

## Key design rules

1. Form strategies only for REST login
- reject non-form/social strategies at the REST endpoint
- browser redirect/social login remains under existing `/login/:strategy` controller flow

2. Preserve current baseline token semantics
- continue using baseline continuation tokens as implemented in `server/models/userKeys.js`
- do not import Scarlett’s strategyId/siteId token assumptions

3. Keep JWT behavior baseline-compatible
- successful completion returns `jwt` in the body
- do not redesign cookie/renewal semantics in this slice

4. Include TFA because login depends on it
- baseline `users.login()` can return `mustProvideTFA` or `mustSetupTFA`
- therefore `login/tfa` belongs in the same slice as login

5. Do not migrate the frontend in the same commit by default
- land REST endpoints first
- verify backend slice cleanly
- frontend adoption can be a separate reviewed slice

---

## Task 1: Extend auth controller tests for login branches

**Objective:** Lock down the baseline auth continuation contract before implementing REST mutation handlers.

**Files:**
- Modify: `server/test/controllers/api.auth.test.js`
- Read: `server/models/users.js`
- Read: `client/components/login.vue`

**Step 1: Write failing tests**

Add tests for:
1. `POST /login` route is registered
2. rejects non-form strategy for REST login
3. successful form login returns `jwt`
4. login returns `mustChangePwd` + `continuationToken`
5. login returns `mustProvideTFA` + `continuationToken`
6. login returns `mustSetupTFA` + `continuationToken` + `tfaQRImage`
7. `POST /login/tfa` route is registered
8. TFA completion returns `jwt`
9. setup-TFA completion path returns expected payload shape
10. `POST /login/change-password` route is registered
11. change-password continuation returns `jwt`
12. invalid/expired continuation token forwards a clean error path
13. controllers do not leak password or provider config on error/success payloads

Use the same lightweight mocked-controller style already established in the API controller tests.

**Step 2: Run test to verify failure**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: FAIL

---

## Task 2: Implement `POST /_api/auth/login`

**Objective:** Expose baseline form login through REST without taking on social/browser redirect flows.

**Files:**
- Modify: `server/controllers/api/auth.js`
- Test: `server/test/controllers/api.auth.test.js`

**Step 1: Implement minimal handler**

Request shape:
```json
{
  "strategy": "local",
  "username": "alice@example.com",
  "password": "secret"
}
```

Implementation rules:
- verify the strategy exists and is form-based before calling model login
- call baseline auth model logic through `WIKI.models.users.login(...)`
- return only the normalized auth response fields
- do not perform redirect cookie handling here

**Step 2: Run targeted tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: login-related tests PASS or isolate remaining failures to TFA/change-password handlers not yet implemented.

---

## Task 3: Implement `POST /_api/auth/login/tfa`

**Objective:** Complete the REST login continuation path for TFA-enabled flows.

**Files:**
- Modify: `server/controllers/api/auth.js`
- Test: `server/test/controllers/api.auth.test.js`

**Step 1: Implement minimal handler**

Request shape:
```json
{
  "continuationToken": "...",
  "securityCode": "123456",
  "setup": false
}
```

Implementation rules:
- delegate to `WIKI.models.users.loginTFA(...)`
- return only normalized auth response fields
- preserve baseline setup-vs-provide TFA semantics

**Step 2: Run targeted tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: TFA-related tests PASS

---

## Task 4: Implement `POST /_api/auth/login/change-password`

**Objective:** Complete the mandatory-change-password continuation path for REST login.

**Files:**
- Modify: `server/controllers/api/auth.js`
- Test: `server/test/controllers/api.auth.test.js`

**Step 1: Implement minimal handler**

Request shape:
```json
{
  "continuationToken": "...",
  "newPassword": "new-secret"
}
```

Implementation rules:
- delegate to `WIKI.models.users.loginChangePassword(...)`
- return only normalized auth response fields
- do not bundle forgot-password or token-reset browser flows here

**Step 2: Run targeted tests**

Run:
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js`
Expected: PASS

---

## Task 5: Focused regression verification

**Objective:** Prove the new auth REST slice did not disturb adjacent API/auth behavior.

**Files:**
- Test only

**Run:**
- `corepack yarn jest --runInBand server/test/controllers/api.auth.test.js server/test/controllers/api.index.test.js server/test/controllers/api.users.test.js server/test/graph/authentication.metrics.test.js`
Expected: PASS

Then run:
- `corepack yarn test`
- `corepack yarn build`
Expected: PASS

---

## Review gates

Before commit:
1. spec-compliance review on auth controller/tests
2. code-quality review on same diff
3. explicit security check for:
   - no strategy config leakage
   - no password leakage
   - no accidental support for non-form strategy login via REST
   - no malformed auth continuation responses

Commit format when verified:
- `[verified] feat: add REST auth mutation subset`

---

## Risks and cautions

### Main risks
- accidentally exposing strategy/provider configuration in auth responses
- drifting from baseline continuation-token semantics
- trying to support social/browser flows in a JSON-only route
- bundling TFA/register/passkey into the same slice and ballooning complexity

### Deliberate tradeoffs
- preserve baseline JWT/cookie model
- preserve baseline auth model methods
- keep frontend migration separate
- keep response contract close to existing GraphQL auth payload shape

---

## Explicit defer list after this wave
These should be a later auth-rest wave, not part of the next slice:
- register
- forgot password
- verify/reset browser handoff routes
- passkey login
- logout/refresh redesign
- social/OAuth redirect login via REST

---

## Recommendation

Execute this next auth slice in this exact order:
1. test expansion
2. `POST /auth/login`
3. `POST /auth/login/tfa`
4. `POST /auth/login/change-password`
5. full verification and independent review

This is the smallest complete REST auth continuation slice that matches baseline behavior and builds directly on the already-landed `GET /_api/auth/strategies` endpoint.