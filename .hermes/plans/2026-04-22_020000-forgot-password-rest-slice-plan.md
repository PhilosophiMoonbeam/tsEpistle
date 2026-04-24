# Forgot-password REST slice plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move the public forgot-password initiation flow from GraphQL to the additive REST auth surface without changing the existing email-token browser handoff or reset-password continuation flow.

**Architecture:** Reuse the existing baseline `WIKI.models.users.loginForgotPassword(...)` model behavior and existing `/login-reset/:token` browser handoff. Add one thin REST endpoint to `server/controllers/api/auth.js`, add a small status-response helper on the client so `login.vue` can consume non-login auth REST responses safely, and keep registration and other auth flows unchanged.

**Tech Stack:** Express REST controller under `/_api/auth`, Vue 2 login page, small CommonJS client helper tests, existing auth model methods, full `corepack yarn test` and `corepack yarn build` verification.

---

## Scope

### In scope
- add `POST /_api/auth/forgot-password`
- move `client/components/login.vue` forgot-password submit from GraphQL to REST
- add/update helper tests for status-style auth responses
- preserve existing email reset token + `/login-reset/:token` handoff behavior

### Out of scope
- registration REST
- changing reset-token semantics
- changing `/login-reset/:token`
- changing password-change continuation flow
- social/OAuth auth changes

## Acceptance criteria
- `login.vue` no longer uses GraphQL for forgot-password submission
- forgot-password success still returns a generic user-facing success path
- nonexistent/inactive accounts remain non-enumerating
- tests/build remain green

## Files
- Modify: `server/controllers/api/auth.js`
- Modify: `server/test/controllers/api.auth.test.js`
- Modify: `client/helpers/auth-api.js`
- Modify: `client/helpers/auth-api.test.js`
- Modify: `client/components/login.vue`

## Implementation notes
- Server endpoint should validate `email` is a non-empty string.
- Server endpoint should call `WIKI.models.users.loginForgotPassword({ email }, { req, res })`.
- Use brute-force middleware on the endpoint to preserve a bounded public-surface posture.
- Return a small JSON payload like `{ message: 'Password reset request processed.' }`.
- Client helper should add a status-style request path for non-login auth actions instead of overloading login-response validation.
- Client should keep the same toast and screen reset behavior after success.
