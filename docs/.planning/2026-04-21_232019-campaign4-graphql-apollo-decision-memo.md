# Campaign 4: GraphQL and Apollo modernization decision memo

> Planning only. Do not execute package or architectural migrations from this memo without explicit approval.

## Goal
Define the safest staged modernization path for the current GraphQL/Apollo stack while preserving build stability, auth behavior, and the existing app contract.

## Current grounded state

### Server stack in active use
- `server/core/servers.js:123-164`
  - boots `ApolloServer` from `apollo-server-express`
  - passes `context: ({ req, res }) => ({ req, res })`
  - configures `subscriptions.onConnect`
  - uses websocket path `/graphql-subscriptions`
- `server/graph/index.js:6-23, 38-74`
  - uses `graphql-subscriptions`.`PubSub`
  - concatenates SDL files from `server/graph/schemas/`
  - autoloads resolvers and directives
  - exports `{ typeDefs, resolvers, schemaDirectives }`
- `server/graph/directives/auth.js:1-56`
  - implements `@auth` via `SchemaDirectiveVisitor` from `graphql-tools`
  - wraps field resolvers and depends on `context.req.user`
- `server/graph/directives/rate-limit.js:1-5`
  - uses `graphql-rate-limit-directive`
- `server/graph/resolvers/logging.js:13-16`
  - only active subscription resolver found; uses `WIKI.GQLEmitter.asyncIterator('livetrail')`
- `server/graph/schemas/logging.graphql:13-15`
  - extends `Subscription` with `loggingLiveTrail`

### Client stack in active use
- `client/client-app.js:80-130`
  - uses Apollo Client 2 era packages and `BatchHttpLink`
  - sends `includeExtensions: true`
  - strips `__typename` from outgoing variables
  - injects `Authorization` from JWT cookie
  - rotates renewed JWT from `new-jwt` response header
  - uses `WebSocketLink` with `connectionParams: { token }`
  - splits subscriptions to websocket transport at `/graphql-subscriptions`
- `dev/webpack/webpack.dev.js:163-168`
- `dev/webpack/webpack.prod.js:169-174`
  - `.gql` / `.graphql` files go through `graphql-persisted-document-loader` then `graphql-tag/loader`
- `client/graph/**`
  - 66 checked-in `.gql` documents
- `client/components/admin/admin-logging-console.vue:75-91`
  - only active `$apollo.subscribe(...)` consumer found

### Current package state
- `graphql`: `15.3.0`
- `apollo-server`: `2.25.2`
- `apollo-server-express`: `2.25.2`
- `graphql-tools`: `7.0.0`
- `graphql-subscriptions`: `1.1.0`
- `subscriptions-transport-ws`: `0.9.18`
- Apollo client stack remains `apollo-client` / `apollo-link-*` generation

### Upstream package signals checked during this memo
- `apollo-server-express` latest published line is `3.13.0`, and npm marks the package deprecated/end-of-life in favor of `@apollo/server`
- `subscriptions-transport-ws` is npm-deprecated and recommends `graphql-ws`
- current maintained schema utility path is under `@graphql-tools/*` packages, e.g. `@graphql-tools/schema`

## Main compatibility breakpoints

### 1. Apollo Server v2 boot model is embedded in live server startup
`server/core/servers.js` depends on patterns that do not carry forward cleanly:
- constructor-time `subscriptions` config
- `installSubscriptionHandlers()` model elsewhere in server boot
- websocket auth via legacy `webSocket.upgradeReq.headers.cookie`
- Apollo-owned websocket transport path management

This is the highest-centrality server migration file.

### 2. `SchemaDirectiveVisitor` is legacy and should be treated as a required refactor target
`server/graph/directives/auth.js` uses `SchemaDirectiveVisitor` from `graphql-tools`, mutates field resolvers in place, and relies on Apollo `schemaDirectives` integration. This is one of the clearest blockers to a modern explicit-schema stack.

### 3. Subscription transport is tightly coupled across server and client
Current live path is:
- client `apollo-link-ws` + `WebSocketLink`
- server Apollo v2 subscriptions config
- package `subscriptions-transport-ws`
- endpoint `/graphql-subscriptions`

This cannot be upgraded safely by changing only one side.

### 4. Persisted-document behavior is loader-driven and easy to break accidentally
The current request/document path spans:
- `graphql-persisted-document-loader`
- `graphql-tag/loader`
- inline `graphql-tag` usage in components
- `BatchHttpLink({ includeExtensions: true })`

This means document-loading modernization should not be the first change unless we first prove the exact extensions contract is preserved.

### 5. Auth semantics must be preserved in two distinct contexts
- HTTP GraphQL uses Express middleware-populated `req.user`
- subscriptions use independent JWT verification plus `manage:system` enforcement in `onConnect`

Any migration that preserves only query/mutation auth but forgets subscription auth will regress admin logging access behavior.

## Blast-radius assessment

### Low blast radius
- Subscription feature surface itself
  - only one active client consumer found: `client/components/admin/admin-logging-console.vue`
  - only one subscription field found: `loggingLiveTrail`

### High architectural coupling
- Server boot wiring in `server/core/servers.js`
- directive registration in `server/graph/index.js`
- auth directive implementation in `server/graph/directives/auth.js`
- Apollo client wiring in `client/client-app.js`
- webpack GraphQL loader chain in both webpack configs

Interpretation: subscriptions are narrow in product scope but broad in architectural coupling. This makes them a good candidate for an early isolated replacement or staged deprecation decision.

## Decision: recommended migration order

### Recommended choice: Option C
Replace or isolate the subscription path first, then modernize schema construction/server runtime, then consider GraphQL core and Apollo client upgrades.

Why this is the safest order:
1. The only active subscription is low-breadth and admin-only.
2. The current subscription transport is the most obviously deprecated part of the stack.
3. Removing or isolating legacy websocket coupling shrinks the server migration problem before touching query/mutation behavior.
4. Query/mutation execution is comparatively less Apollo-specific because resolvers mainly depend on Express `req` / `res` context.
5. The auth directive refactor can be tackled in a schema-construction lane after subscription risk is contained.

## Recommended staged execution plan

### Stage 4A: inventory + regression prep for GraphQL transport behavior
Do before any dependency changes.

Add/expand tests around:
- HTTP GraphQL auth context behavior for protected resolvers
- subscription auth behavior for admin logging path
- persisted-document request shape if covered by current test tooling
- logging live trail behavior at resolver level where possible

Likely files for test additions:
- `server/test/graph/**`
- new isolated tests around `server/graph/directives/auth.js`
- possible harness extraction around GraphQL server boot if needed

### Stage 4B: decide subscription future state
Pick one explicit path before package changes:
- B1: migrate admin logging from `subscriptions-transport-ws` to `graphql-ws`
- B2: replace admin live trail with a non-GraphQL realtime path or polling
- B3: temporarily deprecate/remove live trail during the server modernization branch, with explicit product sign-off

Recommendation inside 4B:
- prefer B1 if we want feature preservation now
- prefer B2 if we want the cleanest long-term GraphQL surface
- avoid dragging legacy `subscriptions-transport-ws` forward

### Stage 4C: replace legacy directive wiring with explicit schema transformation
Before adopting a modern Apollo server/runtime, refactor:
- `server/graph/directives/auth.js`
- `server/graph/index.js`

Desired end state:
- explicit schema creation
- explicit directive transform/wrapper registration
- no reliance on Apollo `schemaDirectives`
- preserve current `context.req.user` semantics

This is the prerequisite that most reduces Apollo migration uncertainty.

### Stage 4D: modernize server runtime
After 4B and 4C, move from Apollo Server 2 stack to a maintained server runtime.

Preferred destination to evaluate:
- `@apollo/server` with Express integration, if we want to stay on Apollo

Requirements to preserve:
- same `/graphql` HTTP contract
- same auth context shape `{ req, res }`
- same batching compatibility expectations for current client
- explicit replacement for websocket/subscription path if retained

### Stage 4E: only then evaluate GraphQL core / client package upgrades
After server runtime and directives are stabilized:
- reassess `graphql` 16 adoption
- reassess Apollo Client 2-era package migration
- reassess whether current webpack document loader chain should be preserved, simplified, or replaced

This should be a separate branch or sub-campaign, not bundled into the server move.

## What should not be bundled together
Do not combine these in one execution batch:
- subscription protocol replacement
- auth directive rewrite
- Apollo server runtime replacement
- GraphQL core major bump
- Apollo client major migration
- persisted-document loader redesign

That conflict tree will be too large and too ambiguous to debug safely.

## Files most likely to require refactor first

Priority 1
- `server/core/servers.js`
- `server/graph/index.js`
- `server/graph/directives/auth.js`

Priority 2
- `client/client-app.js`
- `server/graph/directives/rate-limit.js`
- `server/graph/resolvers/logging.js`
- `server/graph/schemas/logging.graphql`

Priority 3
- `dev/webpack/webpack.dev.js`
- `dev/webpack/webpack.prod.js`
- client files with inline `graphql-tag` usage
- `client/components/admin/admin-logging-console.vue`

## Open questions requiring approval before execution
1. Should admin logging live trail be preserved exactly, or is a replacement transport acceptable?
2. Do we want to keep Apollo on the server long-term, or only use it as a bridge toward a more neutral GraphQL server stack?
3. Is preserving batched HTTP behavior mandatory in the first server migration pass?
4. Should persisted-document behavior remain untouched for the entire Campaign 4 server lane?
5. Is it acceptable to stage Campaign 4 into multiple verified branches/PRs rather than one large migration branch?

## Recommendation to user
The next safe execution lane is not a package bump. It is a focused preparation lane:
1. add regression coverage around auth/subscription behavior
2. isolate and decide the fate of the single admin logging subscription
3. refactor directive/schema construction away from legacy `schemaDirectives`
4. only then propose a server runtime migration plan for approval

This preserves the project’s current baseline while shrinking the eventual Apollo migration risk into evidence-backed, reviewable slices.