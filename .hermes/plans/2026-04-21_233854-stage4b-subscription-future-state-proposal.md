# Stage 4B: subscription future-state proposal

> Planning only. Do not execute these changes without explicit approval.

## Goal
Choose the safest next isolated lane for the project’s only active GraphQL subscription so we can reduce Apollo migration coupling before touching server-runtime modernization.

## Current grounded context

### What is actually live today
- There is only one active GraphQL subscription consumer in the repo:
  - `client/components/admin/admin-logging-console.vue`
- It subscribes to:
  - `client/graph/admin/logging/logging-subscription-livetrail.gql`
- Server-side exposure is narrow and isolated:
  - `server/graph/schemas/logging.graphql` exposes `loggingLiveTrail`
  - `server/graph/resolvers/logging.js` returns `WIKI.GQLEmitter.asyncIterator('livetrail')`
  - `server/graph/index.js` publishes logger events on `livetrail`

### Why this matters
The product blast radius is low, but the architectural coupling is high:
- `client/client-app.js` globally wires Apollo websocket transport
- `server/core/servers.js` globally wires Apollo Server v2 subscription boot/auth
- current transport stack is deprecated:
  - `subscriptions-transport-ws`
  - `apollo-link-ws`

This single feature is the only reason the project still needs a GraphQL websocket lane.

## Options considered

### Option B1: preserve GraphQL and migrate the live trail to `graphql-ws`

#### What this means
Keep the live admin log feature as a GraphQL subscription, but replace the deprecated websocket transport on both server and client.

#### Likely files to change
- `server/core/servers.js`
- `client/client-app.js`
- `package.json`
- likely tests:
  - `server/test/core/servers.graphql-subscriptions.test.js`
  - possible client transport tests if added later

#### Likely files that mostly stay conceptually intact
- `server/graph/schemas/logging.graphql`
- `server/graph/resolvers/logging.js`
- `client/graph/admin/logging/logging-subscription-livetrail.gql`
- `client/components/admin/admin-logging-console.vue`

#### Pros
- preserves current feature semantics most closely
- smallest user-facing behavior change
- keeps admin logging inside existing GraphQL mental model

#### Cons
- still preserves a special GraphQL websocket lane through the modernization
- server boot must move from Apollo v2 subscription internals to manual websocket integration
- client is still Apollo Client 2 era, so `graphql-ws` likely needs a compatibility bridge rather than a clean drop-in
- does less to simplify the later Apollo server/runtime migration

#### Risk
- moderate
- not because the feature is big, but because transport integration is global on both client and server

#### Best use case
Choose this only if exact feature preservation is more important than shrinking GraphQL/Apollo complexity now.

---

### Option B2: replace the live trail with a non-GraphQL transport

Two grounded sub-options exist.

#### B2a: SSE endpoint (recommended non-GraphQL path)

##### What this means
Replace the GraphQL subscription with a same-origin server-sent events stream, e.g. an authenticated admin endpoint that streams log lines while the dialog is open.

##### Why this fits the repo well
- the feature is one-way server -> client streaming
- Express auth/middleware already exists and is easier to reuse than websocket auth glue
- same-origin cookie auth works naturally for SSE
- this repo already contains EventSource polyfill support in legacy assets per audit findings
- it avoids carrying GraphQL websocket transport concerns into the Apollo modernization

##### Likely files to change
- `client/components/admin/admin-logging-console.vue`
- likely new or extended controller route under server HTTP stack, e.g. in `server/controllers/**`
- `server/graph/index.js` or a small new logging stream helper to fan out logger events without GraphQL PubSub
- `client/client-app.js` if Apollo websocket wiring is fully removed
- `server/core/servers.js` if Apollo subscription boot is fully removed
- `package.json` for removing deprecated websocket subscription packages once unused

##### Pros
- best reduction of Apollo migration coupling
- simpler auth model than websocket transport
- good behavioral fit for one-way log streaming
- removes the only active GraphQL subscription reason from the system

##### Cons
- feature leaves GraphQL entirely
- requires a focused UI + controller rewrite instead of transport-only swap
- needs explicit stream lifecycle / cleanup handling

##### Risk
- low to moderate
- much lower architectural coupling risk than `graphql-ws`

#### B2b: short-interval polling

##### What this means
Replace live streaming with a small authenticated endpoint that returns recent log entries; the dialog polls while open.

##### Pros
- simplest infrastructure
- easiest to test and reason about
- fully removes GraphQL websocket coupling

##### Cons
- highest behavior drift from true live console semantics
- needs bounded in-memory buffering/cursors to avoid data loss or duplication
- poorer UX than current stream

##### Risk
- lowest transport risk
- highest product-behavior compromise

---

### Option B3: temporarily remove/deprecate the feature during GraphQL modernization

#### What this means
Turn off the live console during the migration and revisit it later.

#### Pros
- maximum simplification of the GraphQL migration problem

#### Cons
- explicit feature regression
- requires product sign-off
- likely unnecessary because the feature is isolated enough to handle now

#### Risk
- technically low
- product risk potentially high

## Recommendation

### Recommended choice: Option B2a — replace the admin live trail with SSE

Why this is the strongest next move:
1. It removes the only active GraphQL subscription from the product surface.
2. It shrinks the future Apollo migration problem much more than a `graphql-ws` swap does.
3. It matches the actual feature shape better: one-way authenticated server push.
4. It keeps the next lane isolated and evidence-backed without bundling in schema/runtime modernization.
5. It avoids building new compatibility glue around Apollo Client 2 just to preserve a transport model we want to escape anyway.

### Secondary fallback if exact preservation is required
- Option B1 (`graphql-ws`)

Use this only if the project wants to keep the live console explicitly as GraphQL and accepts that Stage 4B will still leave websocket/Apollo transport concerns in place.

## Proposed Stage 4B execution order if approved

### Path A: recommended SSE lane
1. add/expand regression coverage for current logging stream contract where useful
2. implement a small authenticated SSE endpoint for admin live logging
3. update `client/components/admin/admin-logging-console.vue` to use EventSource instead of `$apollo.subscribe`
4. remove the now-unused GraphQL logging subscription wiring
5. verify tests/build and manually smoke-test admin live console behavior
6. only after that, reassess whether Apollo websocket wiring and deprecated subscription packages can be cleanly removed in the same lane or a follow-up infra slice

### Path B: graphql-ws lane
1. design client compatibility bridge for Apollo Client 2
2. replace server Apollo v2 subscription boot with explicit websocket server integration
3. preserve auth semantics from current `onConnect`
4. keep schema/resolver shape stable
5. verify reconnect/auth/error behavior manually and with tests

## Files most likely to change under the recommended SSE path
- `client/components/admin/admin-logging-console.vue`
- likely one or more server controller files under `server/controllers/`
- likely `server/graph/index.js` or a small new shared logging stream helper
- possibly `client/client-app.js`
- possibly `server/core/servers.js`
- `package.json`
- corresponding tests under `server/test/**`

## Validation requirements for any approved Stage 4B lane
- admin user can open live console and see incoming log lines
- unauthorized/non-admin access is rejected
- closing and reopening the dialog does not leak duplicate listeners/subscriptions
- `corepack yarn test` passes
- `corepack yarn build` passes
- independent review passes before commit

## Open approval questions
1. Do you want to preserve the admin live console exactly as a GraphQL subscription, or is replacing its transport acceptable if behavior stays equivalent?
2. Is removing GraphQL from this one admin live-stream feature desirable if it materially simplifies the larger Apollo modernization?
3. Should Stage 4B prioritize architectural simplification (SSE) over minimal user-facing code churn (`graphql-ws`)?

## Recommended approval decision
Approve a focused Stage 4B implementation proposal for the SSE path.

That is the cleanest next move to reduce coupling before we approach Stage 4C directive/schema refactoring and Stage 4D server runtime modernization.