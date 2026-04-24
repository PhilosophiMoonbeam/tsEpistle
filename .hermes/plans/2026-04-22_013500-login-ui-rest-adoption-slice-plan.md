# Login UI REST adoption slice plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Switch the login page’s form-auth strategy loading and form-auth continuation flow from GraphQL to the new REST auth endpoints, while preserving existing social/OAuth redirects and other deferred auth branches.

**Architecture:** Keep the current login Vue component and post-login redirect/JWT behavior intact. Introduce a tiny client-side auth REST helper for JSON fetches so the form-auth path can move to `/_api/auth/*` without changing the rest of the app’s Apollo usage. Keep forgot-password on GraphQL for now.

**Tech Stack:** Vue 2.6 login component, browser `fetch`, existing REST auth controllers under `server/controllers/api/auth.js`, Jest CommonJS helper tests, full `corepack yarn test` and `corepack yarn build` verification.

---

## Scope

### In scope
- replace login strategy bootstrap query with `GET /_api/auth/strategies`
- replace form login submit with `POST /_api/auth/login`
- replace TFA continuation submit with `POST /_api/auth/login/tfa`
- replace change-password continuation submit with `POST /_api/auth/login/change-password`
- add a tiny client helper with unit tests for REST request/response normalization

### Out of scope
- social/OAuth redirect login initiation (`/login/:strategy`)
- forgot-password flow
- register flow
- other Apollo usage outside login page
- auth contract redesign

## Exact implementation shape

1. Create `client/helpers/auth-api.js`
   - expose `fetchAuthStrategies(fetchImpl)`
   - expose `submitAuthRequest(fetchImpl, path, payload)`
   - treat HTTP 4xx auth failures as normal JSON `{ error }`
   - normalize strategies ordering client-side if needed
   - throw generic error for malformed/non-JSON server responses

2. Create `client/helpers/auth-api.test.js`
   - verify strategies fetch sorts by `order`
   - verify login POST sends JSON payload and returns parsed body
   - verify 4xx JSON error becomes thrown `Error(message)`
   - verify non-ok response without JSON falls back to generic error

3. Modify `client/components/login.vue`
   - remove inline GraphQL auth mutations for login/TFA/change-password
   - remove Apollo `strategies` block
   - load strategies in `mounted()` via helper and preserve store loading notifications
   - keep `selectedStrategyKey` watcher behavior for social/OAuth redirects
   - keep `handleLoginResponse()` and JWT/redirect semantics unchanged
   - leave forgot-password mutation on GraphQL for now

4. Verification
   - `corepack yarn jest --runInBand client/helpers/auth-api.test.js`
   - `corepack yarn test`
   - `corepack yarn build`
   - independent review before commit

## Risks to guard against
- accidentally breaking the initial strategy-selection watcher when strategies load asynchronously
- changing redirect precedence or JWT cookie behavior
- widening scope into forgot-password or social login
- assuming every error response has GraphQL-style shape after the REST switch

## Acceptance criteria
- login page no longer uses GraphQL for strategies, form login, TFA verification, or change-password continuation
- non-form strategies still redirect through existing `/login/:strategy` flow
- forgot-password remains unchanged
- full tests/build stay green
