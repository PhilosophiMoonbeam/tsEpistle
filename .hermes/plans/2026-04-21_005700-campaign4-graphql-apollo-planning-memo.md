# Campaign 4: GraphQL and Apollo modernization planning memo

> For Hermes: planning only. Do not execute migrations from this memo without explicit approval.

Goal: map the concrete breakpoints for moving the current GraphQL/Apollo stack forward while preserving the current app contract and build pipeline.

Current grounded stack from repo inspection:
- `server/core/servers.js`
  - `const { ApolloServer } = require('apollo-server-express')`
  - creates ApolloServer with `subscriptions` config inline
  - calls `installSubscriptionHandlers()` on HTTP/HTTPS servers
- `server/graph/index.js`
  - builds `typeDefs` by concatenating schema files
  - merges resolvers from `graph/resolvers`
  - uses `graphql-subscriptions`.PubSub
  - uses `graphql-rate-limit-directive`
  - uses `graphql-tools` via directive visitor implementation in `server/graph/directives/auth.js`
- client build pipeline:
  - webpack rules use `graphql-persisted-document-loader` + `graphql-tag/loader`
  - many Vue components import `gql` from `graphql-tag`

---

## Key modernization targets
- `graphql` 15.3.0 -> 16.x
- `apollo-server` / `apollo-server-express` 2.25.2 -> newer supported path
- `graphql-tools` 7.0.0 -> current maintained usage pattern
- `graphql-rate-limit-directive` migration/replacement
- `subscriptions-transport-ws` / subscription path deprecation handling

---

## Known grounded risk points

### 1. Apollo Server 2 subscription model is embedded in current server boot
Current code relies on:
- `this.servers.graph.installSubscriptionHandlers(this.servers.http)`
- `this.servers.graph.installSubscriptionHandlers(this.servers.https)`
- websocket auth logic inside Apollo `subscriptions.onConnect`
- dedicated path `/graphql-subscriptions`

This means upgrading Apollo is not just a package bump; it affects HTTP/HTTPS boot order and websocket auth wiring.

### 2. Schema directives rely on older `graphql-tools` patterns
Current code uses:
- `SchemaDirectiveVisitor` in `server/graph/directives/auth.js`

This is a high-probability breakpoint because newer GraphQL-tools patterns differ significantly from the older directive visitor model.

### 3. Client document pipeline is tightly coupled to current GraphQL packages
Current code relies on:
- `graphql-tag/loader`
- `graphql-persisted-document-loader`
- many direct `import gql from 'graphql-tag'`

Any GraphQL core upgrade has to preserve document compilation and runtime behavior across both webpack and Vue component usage.

### 4. Rate-limit directive integration is schema-level and custom
Current boot path injects:
- `createRateLimitTypeDef()`
- custom directive factory under `server/graph/directives/rate-limit.js`

This needs explicit audit before upgrading GraphQL/Apollo tooling.

---

## Questions this planning lane must answer

1. What is the smallest viable path from Apollo Server 2 to a maintained server stack without breaking subscriptions or auth?
2. Which current GraphQL-tools directive patterns must be rewritten?
3. Can GraphQL 16 be adopted before Apollo server migration, or do those upgrades need to travel together?
4. Is the current subscription path still materially used, and if so by what clients?
5. How do persisted documents and webpack loaders constrain the migration order?

---

## Suggested discovery tasks for this memo

### Task 4.1: inventory current GraphQL server boot path
Files:
- `server/core/servers.js`
- `server/graph/index.js`
- `server/graph/directives/*.js`

Deliverable:
- list every deprecated Apollo/GraphQL-tools/subscriptions pattern in active use

### Task 4.2: inventory client GraphQL document/tooling usage
Files:
- `dev/webpack/webpack.dev.js`
- `dev/webpack/webpack.prod.js`
- `client/components/**/*.vue`
- `client/graph/**`

Deliverable:
- exact compatibility surface for document loaders, gql imports, and persisted docs

### Task 4.3: map subscription usage and websocket auth
Files:
- `server/core/servers.js`
- client files using subscriptions

Deliverable:
- whether subscriptions are active enough to justify in-place migration vs staged deprecation

### Task 4.4: produce recommended migration order
Expected output:
- option A: GraphQL core first
- option B: Apollo server first
- option C: replace subscription path first
- recommended choice with rationale

---

## Desired final deliverable of Campaign 4
A decision memo answering:
- recommended migration order
- compatibility blockers
- files/areas requiring refactor before package changes
- whether this should be one branch or multiple staged branches
- what test coverage must be added first

## Recommendation
Do this as a memo before any execution. This is not safe for direct implementation without design.