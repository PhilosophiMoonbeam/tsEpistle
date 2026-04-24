# Higher-risk modernization program map for Wiki.js legacy baseline

> For Hermes: planning only. Do not execute any section without explicit approval. This document exists to turn the remaining modernization backlog into deliberate campaigns rather than ad hoc dependency bumps.

Goal: flesh out the remaining modernization work beyond Campaign 1 into a concrete multi-campaign program with objectives, package candidates, likely code hotspots, required validation, and decision points.

Architecture: preserve the current main-based legacy branch as the stable shipping line. Treat each remaining campaign as either an execution lane (bounded same-architecture work) or a planning lane (architecture-impacting work). Do not blur the two.

---

## Program overview

After safe batches 1-7, the remaining backlog is no longer best handled by package-at-a-time updates. The rest of the work should be split into:

Execution lanes:
1. Build / asset pipeline stabilization
2. Active upload / editor UI stabilization
3. Server utility / parser stabilization

Planning lanes:
4. GraphQL / Apollo modernization
5. ORM / database modernization
6. Frontend framework and bundler future state

The first execution lane already has its own detailed plan file:
- `.hermes/plans/2026-04-21_004800-campaign1-build-pipeline-execution-plan.md`

This document fleshes out Campaigns 2-6.

---

## Campaign 2: Active upload and editor UI stabilization

### Purpose
Upgrade active frontend dependencies that directly affect authoring and upload workflows while keeping Vue 2 / Vuetify 2 / Webpack 4 intact.

### Candidate packages
Primary candidates:
- `filepond` 4.21.1 -> 4.32.12
- `highlight.js` 10.3.1 -> 11.11.1
- `whatwg-fetch` 3.6.2 -> 3.6.20
- `js-cookie` 2.2.1 -> 3.0.5

Deferred / caution candidates:
- `vue-filepond` 6.0.3 -> 7.0.4
  - only after confirming Vue 2 compatibility and plugin registration expectations

### Why this is a separate lane
These packages touch high-value user-facing surfaces:
- file upload / asset modal
- markdown and source editing UX
- auth/session token handling in the browser
- syntax highlighting and preview behavior

A green webpack build is not enough to validate them.

### Likely code hotspots
Upload/editor surfaces:
- `client/components/editor/editor-modal-media.vue`
- `client/components/editor/editor-markdown.vue`
- `client/components/editor/editor-modal-conflict.vue`
- `client/components/editor/editor-redirect.vue`
- markdown preview helpers under `client/components/editor/markdown/`
- `client/components/source.vue`

Session/fetch surfaces:
- `client/client-app.js`
- any code using `js-cookie`
- auth/login components

Highlighting surfaces:
- rendering/editor preview modules
- server/client rendering helpers that rely on highlight.js output

### Recommended internal micro-batches
Batch 2A:
- `whatwg-fetch`
- `js-cookie`

Batch 2B:
- `filepond`

Batch 2C:
- `highlight.js`

Optional Batch 2D, only after 2B is verified:
- `vue-filepond`

### Validation requirements
Required automated gates:
- `corepack yarn test`
- `corepack yarn build`

Required manual checks:
- open media upload modal
- upload a file successfully
- rename asset
- delete asset
- insert uploaded asset into page
- ensure login/auth still works if cookie behavior changed
- verify markdown/highlight preview still renders common fenced languages

### Risks
- CSS drift in FilePond-related UI
- upload transport option differences
- preview/highlight regressions not caught by current tests
- cookie API behavior changes around defaults / sameSite usage

### Suggested success criteria
- upload modal behaves identically for core flows
- no visible regression in editor/admin asset workflows
- syntax highlighting still works on representative code blocks
- no auth regressions in browser session behavior

### Stop conditions
Stop and revert batch if:
- uploads fail or hang
- asset modal UI breaks visually or functionally
- auth cookies stop being read/written as expected
- highlighting output becomes materially degraded

---

## Campaign 3: Server utility and parser stabilization

### Purpose
Refresh non-framework server-side helpers with moderate blast radius while keeping the same storage/rendering architecture.

### Candidate packages
High-value candidates:
- `fs-extra` 9.0.1 -> 11.3.4
- `js-yaml` 3.14.0 -> 4.1.1
- `cheerio` 1.0.0-rc.5 -> 1.2.0
- `image-size` 0.9.2 -> 2.0.2
- `klaw` 3.0.0 -> 4.1.0
- `mime-types` 2.1.35 -> 3.0.2

Maybe later:
- `js-beautify` 1.13.5 -> 1.15.4
- `remove-markdown` already updated

### Likely code hotspots
- `server/models/pages.js`
- `server/controllers/upload.js`
- import/export or migration helpers under `server/`
- rendering modules under `server/modules/rendering/`
- asset helpers / metadata extraction

### Why this is a separate lane
These packages often change parsing semantics more than their version number suggests.
Examples:
- YAML parser behavior can differ on duplicate keys or edge syntax
- Cheerio can parse legacy HTML differently across versions
- fs-extra can tighten path or copy behavior

### Recommended internal micro-batches
Batch 3A:
- `mime-types`
- `image-size`
- `klaw`

Batch 3B:
- `fs-extra`

Batch 3C:
- `js-yaml`
- `cheerio`

### Validation requirements
Automated gates:
- `corepack yarn test`
- `corepack yarn build`

Additional targeted checks:
- import/export still runs for a representative content set
- frontmatter parsing still behaves the same for markdown/html samples
- upload path sanitization + metadata extraction still works
- any cheerio-based HTML transformations still preserve expected markup

### Suggested test expansion before or during execution
If this lane is approved, add targeted regression tests around:
- frontmatter extraction and page normalization
- HTML cleanup / transformation helpers
- asset metadata extraction

### Risks
- subtle parsing differences invisible until specific content is processed
- file helper behavior changes during copy/move/import tasks
- server-side HTML transform changes that current tests may not cover

### Success criteria
- representative import/export data round-trips cleanly
- frontmatter parsing unchanged for known samples
- build/test pass with no new warnings promoted to failures

---

## Campaign 4: GraphQL / Apollo modernization planning memo

### Purpose
Design the migration off the aging GraphQL/Apollo stack before touching production code.

### Packages in scope
- `graphql` 15.3.0 -> 16.x
- `apollo-server` 2.25.2 -> 3.x or alternative path
- `apollo-server-express` 2.25.2 -> 3.x
- `graphql-tools` 7.0.0 -> current supported approach
- `graphql-rate-limit-directive` 1.2.1 -> newer pattern / replacement
- `graphql-subscriptions` and `subscriptions-transport-ws` deprecation path
- `graphql-persisted-document-loader` future compatibility

### Questions this memo must answer
1. Can Apollo Server 2 be incrementally modernized in place, or should the server composition be refactored first?
2. What breaks first when moving GraphQL 15 -> 16 in this codebase?
3. Which schema/resolver utilities are using deprecated GraphQL-tools patterns?
4. How are persisted documents and webpack loaders coupled to the current stack?
5. Is `subscriptions-transport-ws` still materially used, and what should replace it?

### Likely files to study
- `server/core/kernel.js`
- GraphQL bootstrapping under `server/graph/`
- schema files under `server/graph/schemas/`
- resolvers under `server/graph/resolvers/`
- client GraphQL document loading path in webpack config
- admin/client files that depend on current query/mutation shapes

### Deliverables
- compatibility matrix of current GraphQL/Apollo packages
- list of deprecated APIs in current codebase
- recommended upgrade order
- risk ranking by subsystem
- proposal for whether this should be one migration branch or multiple branchlets

### Non-goals
- do not execute the migration
- do not change schema/runtime behavior yet

---

## Campaign 5: ORM and database modernization planning memo

### Purpose
Design the data-layer upgrade without breaking multi-database support.

### Packages in scope
- `knex` 0.21.7 -> 3.x
- `objection` 2.2.18 -> 3.x
- `connect-session-knex` 2.0.0 -> 5.x
- DB-adjacent dependencies already partially modernized:
  - `pg`
  - `mysql2`
  - `pg-pubsub`

### Why this needs planning before execution
This repo supports multiple databases and contains:
- migrations for multiple engines
- DB-specific search modules
- session storage on Knex
- query builder behavior embedded in resolvers/models

A straight dependency bump here is high risk.

### Questions this memo must answer
1. Which query APIs in current models/resolvers are incompatible with modern Knex/Objection?
2. Do any custom plugins/helpers depend on legacy Knex internals?
3. What DB matrix do we need to validate locally vs in CI?
4. How should session store migration be handled?
5. Are sqlite/mysql/postgres feature assumptions already diverging?

### Likely files to study
- `server/core/db.js`
- `server/models/**/*.js`
- `server/db/`
- `server/graph/resolvers/**/*.js`
- session setup in `server/master.js`
- comments/search/storage subsystems that run DB-specific logic

### Deliverables
- incompatibility inventory
- required test coverage expansion
- DB matrix plan
- recommended migration branch strategy
- rollback strategy

---

## Campaign 6: Frontend framework and bundler future-state planning memo

### Purpose
Define the long-term client architecture instead of sleepwalking into framework churn.

### Decision domains
- Vue 2.6 vs Vue 2.7 bridge vs direct Vue 3 migration
- Vuetify 2 end-of-life path
- Vuex future vs Pinia or compatibility bridge
- webpack continuation vs Vite migration
- how to handle GraphQL docs, theme assets, SSR entry templates, editor modules, and admin views in any new architecture

### Questions this memo must answer
1. Is a Vue 2.7 bridge milestone worthwhile here?
2. Can the app benefit from a split approach where admin/editor moves first and legacy SSR pages move later?
3. What parts of the app are hardest to migrate?
4. What asset/template generation assumptions currently tie the frontend to server views?
5. How much of the current component library can be preserved vs rewritten?

### Likely files/areas to study
- `client/components/**`
- `client/themes/default/**`
- `client/client-app.js`
- `client/client-setup.js`
- webpack configs and emitted server Pug templates
- router/store setup
- editor subsystem

### Deliverables
- future-state architecture recommendation
- migration phases with milestone branches
- hard blockers and expensive subsystems
- recommended sequencing relative to GraphQL/ORM modernization

---

## Program sequencing recommendation

Recommended order after the current safe-batch line:
1. Execute Campaign 1
2. Execute Campaign 2
3. Execute Campaign 3
4. Write Campaign 4 memo
5. Write Campaign 5 memo
6. Write Campaign 6 memo

Alternative if user wants less execution and more strategy now:
1. Execute Campaign 1
2. Write Campaign 4/5/6 memos immediately
3. Reassess whether Campaign 2 or 3 should happen before larger architecture work

---

## Decision threshold guidance

### Good to execute now
- same-architecture packages
- bounded subsystem
- clear smoke checks
- easy rollback after each batch

### Planning required first
- major versions across central frameworks/toolchains
- anything that changes the app/server contract
- anything with unclear compatibility surface across DB matrix or UI framework

---

## Suggested next action

Approve Campaign 1 for execution using the dedicated plan file.

After Campaign 1 completes cleanly, choose one of:
- approve Campaign 2 execution
- approve Campaign 3 execution
- request Campaign 4/5/6 memos before any more execution
