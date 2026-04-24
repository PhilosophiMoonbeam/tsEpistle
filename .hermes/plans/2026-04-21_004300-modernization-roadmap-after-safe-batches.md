# Wiki.js modernization roadmap after safe dependency batches

> For Hermes: this is planning only. Do not execute any higher-risk dependency or architecture changes from this document without explicit user approval. Use subagent-driven-development if/when executing approved sections.

Goal: capture the state after completing the safe micro-batch dependency work, define exactly where low-risk updates stop being low-risk, and lay out the next approved modernization lanes in a way that preserves a stable, shippable main-based legacy branch.

Architecture: preserve the current legacy runtime as the production baseline while treating remaining modernization as controlled subsystem upgrades. From this point forward, prefer subsystem-by-subsystem campaigns with explicit entry criteria, rollback points, and verification gates instead of opportunistic package bumps.

Tech stack baseline:
- Branch: `hermes/wiki-consolidation-baseline`
- Runtime target: `.nvmrc` = `v24.12.0`
- Current live stack:
  - Node 24 target / Yarn 1 lockfile
  - Vue 2 + Vuetify 2 + Vuex 3 + Vue Router 3
  - Webpack 4 build pipeline
  - Express 4 + Apollo Server 2 + GraphQL 15
  - Knex 0.21 + Objection 2
- Local validation gates:
  - `corepack yarn test`
  - `corepack yarn build`

---

## Current modernization status

### Consolidation work already landed
Verified branch-derived / baseline work on this branch:
- baseline quality-gate stabilization
- metrics endpoint baseline
- server-backed admin user pagination/search
- source-view download action
- page source/download path helper consolidation

### Safe modernization work already landed
Verified modernization commits now on branch:
- `4d9794a5` `[verified] chore: align CI and ARM build runtime with Node 24`
- `e2a55857` `[verified] chore: refresh core utility dependencies batch 1`
- `befd91c0` `[verified] chore: refresh templating and logging dependencies batch 2`
- `2cd41a17` `[verified] chore: refresh database runtime dependencies batch 3`
- `34fc901b` `[verified] chore: refresh session and sanitization dependencies batch 4`
- `4c033807` `[verified] chore: refresh client and middleware utilities batch 5`
- `c7197c9b` `[verified] chore: refresh dormant upload and graphql helpers batch 6`
- `19e59904` `[verified] chore: refresh graphql document tooling batch 7`

### What those batches accomplished
Completed direct updates already verified:
- runtime / CI alignment:
  - Windows CI now uses `.nvmrc`
  - ARM build Dockerfile moved to Node 24
- utility/runtime packages:
  - `prom-client`
  - `remove-markdown`
  - `semver`
  - `simple-git`
  - `turndown`
  - `winston`
  - `pug`
  - `pug-lint`
  - `pug-plain-loader`
  - `pg`
  - `mysql2`
  - `cross-env`
  - `dompurify`
  - `express-session`
  - `moment-timezone`
  - `sanitize-filename`
  - `cors`
  - `cash-dom`
  - `emoji-regex`
  - `graphql-list-fields`
  - `filepond-plugin-file-validate-type`
  - `graphql-tag`
- important correction made during batching:
  - forced `pg-pubsub/**/pg` to `8.20.0` so the HA listener path does not lag behind direct `pg`

### Standing non-blocking note
During installs, optional native package `cpu-features` fails to build under local Node 22, but Yarn marks it optional and install/test/build still succeed. This is an environment nuisance, not currently a branch blocker.

---

## Threshold assessment: why we should stop opportunistic micro-batching here

The remaining outdated packages are no longer mostly tiny isolated utilities. They now cluster into subsystems where even minor-version movement can change compiler behavior, bundler semantics, runtime imports, AST transforms, browser compatibility, or active UI behavior.

The remaining pool falls into four buckets:

### Bucket A: still technically patch/minor, but tied to active build/runtime subsystems
Examples:
- `babel-loader` 8.1.0 -> 8.4.1
- `webpack-hot-middleware` 2.25.3 -> 2.26.1
- `webpack-merge` 5.2.0 -> 6.0.1
- `file-loader` 6.1.1 -> 6.2.0
- `whatwg-fetch` 3.6.2 -> 3.6.20
- `moment-timezone-data-webpack-plugin` 1.3.0 -> 1.5.1
- `babel-plugin-prismjs` 2.0.1 -> 2.1.0
- `babel-plugin-graphql-tag` 3.1.0 -> 3.3.0

Why not opportunistic anymore:
- these are coupled to the webpack/babel pipeline and can alter output shape or loader/plugin behavior
- they need grouped verification beyond just “build passed once”

### Bucket B: active app dependencies with broader behavioral surface
Examples:
- `filepond` 4.21.1 -> 4.32.12
- `vue-apollo` 3.0.5 -> 3.1.2
- `vuescroll` 4.16.1 -> 4.18.1
- `highlight.js` 10.3.1 -> 11.11.1
- `js-cookie` 2.2.1 -> 3.0.5
- `cheerio` 1.0.0-rc.5 -> 1.2.0
- `fs-extra` 9.0.1 -> 11.3.4
- `js-yaml` 3.14.0 -> 4.1.1
- `uuid` 9.0.0 -> 14.0.0

Why not opportunistic anymore:
- these affect live editor/admin/runtime behavior, SSR helpers, parsing, or browser interactions
- they deserve scenario-specific smoke tests, not only broad build/test

### Bucket C: major-version upgrades inside the current architecture
Examples:
- `express` 4 -> 5
- `graphql` 15 -> 16
- `apollo-server(-express)` 2 -> 3
- `knex` 0.21 -> 3
- `objection` 2 -> 3
- `jest` 26 -> 30
- `eslint` 7 -> 10
- `webpack` 4 -> 5
- `vue-template-compiler` 2.6 -> 2.7

Why these need explicit approval and design:
- they can break assumptions across dozens of files and multiple layers
- these are architectural modernization lanes, not dependency hygiene

### Bucket D: framework/platform migration work
Examples:
- Vue 2 -> Vue 3
- Vuetify 2 -> Vuetify 4
- Vuex 3 -> 4 or Pinia migration decisions
- webpack-era client pipeline -> newer bundler strategy

Why these are a separate project:
- they imply component, tooling, testing, and styling migration
- should be designed as migration programs with milestone branches

Bottom line:
- We have extracted nearly all genuinely low-risk micro-batch value.
- Remaining work should be executed by subsystem campaign, not grab-bag update batches.

---

## Recommended modernization campaigns from here

## Campaign 1: Build and asset pipeline stabilization lane

Purpose: modernize the current webpack/babel pipeline just enough to reduce fragility without attempting a bundler migration.

Candidate packages in this lane:
- `babel-loader` 8.1.0 -> 8.4.1
- `babel-plugin-graphql-tag` 3.1.0 -> 3.3.0
- `babel-plugin-prismjs` 2.0.1 -> 2.1.0
- `file-loader` 6.1.1 -> 6.2.0
- `moment-timezone-data-webpack-plugin` 1.3.0 -> 1.5.1
- `webpack-hot-middleware` 2.25.3 -> 2.26.1
- maybe `simple-progress-webpack-plugin` 1.1.2 -> 2.0.0 if prior changes stay clean

Do not mix into this lane yet:
- `webpack` 5
- `webpack-cli` 7
- `webpack-dev-middleware` 8
- `html-webpack-plugin` 5
- `copy-webpack-plugin` 14
- `css-loader` 7
- `sass-loader` 16
- `mini-css-extract-plugin` 2

Acceptance criteria:
- `corepack yarn test` passes
- `corepack yarn build` passes
- emitted `server/views/*.pug` still render correctly in app
- GraphQL `.gql` assets still compile through loader chain
- dev watch still boots without loader resolution failures

Suggested smoke checks:
- open login page
- open admin users page
- open editor page
- open source/history page
- confirm GraphQL mutations still work in at least one admin view

Risks:
- silent webpack loader behavior drift
- output hash or asset path differences
- HMR / watch instability

Recommendation: this is the best next execution lane if the user wants another approved modernization sprint that is still relatively bounded.

---

## Campaign 2: Active upload/editor UI dependency lane

Purpose: upgrade the still-active client packages that touch upload/editor experience without jumping frameworks.

Candidate packages in this lane:
- `filepond` 4.21.1 -> 4.32.12
- maybe later `vue-filepond` 6.0.3 -> 7.0.4, but only after validating Vue 2 compatibility carefully
- `highlight.js` 10.3.1 -> 11.11.1
- `whatwg-fetch` 3.6.2 -> 3.6.20
- potentially `js-cookie` 2.2.1 -> 3.0.5 if current usage remains compatible

Key current code hotspots:
- `client/components/editor/editor-modal-media.vue`
- editor markdown/preview helpers
- any auth/session helpers that use cookies/fetch

Acceptance criteria:
- upload modal opens and uploads file successfully
- asset rename/delete still works
- editor preview/highlight still renders common languages
- no regression in login/admin/editor flows
- `corepack yarn test` and `corepack yarn build` pass

Risks:
- CSS/theme drift in editor modal
- FilePond option changes or plugin registration assumptions
- highlight.js language import/registration changes if major jumps are included

Recommendation: do this after Campaign 1, not before.

---

## Campaign 3: Server utility and parser modernization lane

Purpose: modernize non-framework server helpers with moderate surface area.

Candidate packages in this lane:
- `fs-extra` 9.0.1 -> 11.3.4
- `js-yaml` 3.14.0 -> 4.1.1
- `cheerio` 1.0.0-rc.5 -> 1.2.0
- `image-size` 0.9.2 -> 2.0.2
- `klaw` 3.0.0 -> 4.1.0
- maybe `mime-types` 2.1.35 -> 3.0.2

Key current code hotspots:
- page/model parsing and migration helpers
- storage/import/export flows
- rendering/security sanitization helpers
- file upload / asset metadata handling

Acceptance criteria:
- import/export still works
- page parsing frontmatter still behaves identically for representative samples
- asset metadata extraction still works
- `corepack yarn test` and `corepack yarn build` pass

Risks:
- YAML parse behavior changes
- cheerio parsing differences on legacy HTML content
- file helper semantics changing around fs-extra sync/async edge cases

Recommendation: moderate value, but only after Build lane is stable.

---

## Campaign 4: GraphQL/Apollo server modernization planning lane

Purpose: design the move off the oldest server stack components without executing them yet.

Topics in scope:
- `graphql` 15 -> 16
- `apollo-server` / `apollo-server-express` 2 -> 3 or alternative server integration path
- `graphql-tools` 7 -> current supported approach
- `graphql-rate-limit-directive` replacement or migration strategy
- `subscriptions-transport-ws` deprecation path

This should produce:
- exact breakpoints in current schema/resolver boot path
- migration spike plan
- compatibility matrix for GraphQL client documents and loaders
- decision whether to modernize Apollo-in-place or replace pieces incrementally

Do not execute without approval.

---

## Campaign 5: ORM and DB abstraction modernization planning lane

Purpose: design the data-layer migration with explicit risk control.

Topics in scope:
- `knex` 0.21 -> 3.x
- `objection` 2 -> 3.x
- `connect-session-knex` 2 -> 5
- validation of pg/mysql/sqlite support across CI matrix
- migration script compatibility audit

Critical note:
- this repo’s real value lies in keeping all supported DBs working
- this lane needs test expansion and likely Docker-backed validation

Do not execute without approval.

---

## Campaign 6: Frontend framework / bundler future-state planning lane

Purpose: answer “what replaces the legacy frontend stack?” without prematurely rewriting it.

Topics in scope:
- Vue 2 / Vuetify 2 end-state decision
- Vue 2.7 bridge vs direct Vue 3 migration
- webpack continuation vs Vite migration path
- component-by-component migration feasibility
- how to handle GraphQL documents, theming, SSR, editor modules, and admin area

Deliverable should be a design memo, not code.

---

## Recommended execution order

### Immediate next approved execution lane
1. Campaign 1: Build and asset pipeline stabilization lane

Reason:
- still bounded
- highest leverage on remaining modernization friction
- less user-facing than upload/editor lane
- provides cleaner foundation for later dependency work

### After that
2. Campaign 2: Active upload/editor UI dependency lane
3. Campaign 3: Server utility and parser lane
4. Campaign 4 planning memo
5. Campaign 5 planning memo
6. Campaign 6 planning memo

---

## Proposed first executable plan: Campaign 1

### Goal
Safely modernize the legacy build pipeline’s low-risk same-architecture packages without changing bundler/framework generation.

### Candidate batch structure

Batch 1A:
- `babel-loader` 8.1.0 -> 8.4.1
- `babel-plugin-graphql-tag` 3.1.0 -> 3.3.0
- `babel-plugin-prismjs` 2.0.1 -> 2.1.0`

Batch 1B:
- `file-loader` 6.1.1 -> 6.2.0
- `moment-timezone-data-webpack-plugin` 1.3.0 -> 1.5.1

Batch 1C:
- `webpack-hot-middleware` 2.25.3 -> 2.26.1
- optionally `simple-progress-webpack-plugin` 1.1.2 -> 2.0.0 if 1A/1B are clean

### Verification after each batch
1. `corepack yarn install --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`
4. manual smoke checks:
   - login page loads
   - editor page loads
   - admin users page loads
   - source/history page loads
5. independent code/dependency review
6. commit verified batch

### Stop conditions
Stop the lane and switch to planning if any of these happen:
- webpack loader path breaks (`graphql-tag/loader`, css loaders, pug loaders, file loaders)
- emitted server view templates stop rendering
- editor/admin pages fail to boot because of compiled asset changes
- multiple transitive incompatibilities appear across webpack plugins/loaders

---

## Files likely to matter in Campaign 1

Build config:
- `package.json`
- `yarn.lock`
- `dev/webpack/webpack.dev.js`
- `dev/webpack/webpack.prod.js`
- `dev/templates/*.pug`

Likely smoke-check entrypoints:
- `client/components/login.vue`
- `client/components/editor.vue`
- `client/components/admin/admin-users.vue`
- `client/components/source.vue`
- `client/components/history.vue`

---

## Risks and tradeoffs

### If we keep micro-batching beyond this point
Pros:
- continued incremental movement
Cons:
- risk shifts from package-level to subsystem-level, making “small” updates deceptively risky
- harder to reason about failures because multiple active build assumptions are involved

### If we switch to subsystem campaigns now
Pros:
- cleaner risk accounting
- easier rollback and review
- better alignment with your “propose before executing major changes” rule
Cons:
- slower than one-package-at-a-time movement
- requires more explicit planning up front

Recommendation:
- switch to subsystem campaigns now
- use Campaign 1 as the next approved execution lane

---

## Open questions for the next approval step

1. Do you want the next executed lane to be the build/asset pipeline stabilization campaign?
2. If yes, should we keep it strictly to the three proposed micro-batches (1A/1B/1C) and stop at first sign of loader/bundler instability?
3. After Campaign 1, do you want to prioritize upload/editor dependencies or jump straight to planning the GraphQL/server modernization track?

## Suggested next action

Approve Campaign 1 as the next bounded modernization sprint.

If approved, execution should proceed as:
- 1A batch with verification and commit
- 1B batch with verification and commit
- 1C batch with verification and commit
- stop and reassess before any larger build-tool changes
