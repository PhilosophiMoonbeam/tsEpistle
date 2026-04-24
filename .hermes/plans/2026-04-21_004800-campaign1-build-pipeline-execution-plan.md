# Campaign 1: Build and asset pipeline stabilization execution plan

> For Hermes: use subagent-driven-development if executing this plan. Do not start execution until the user explicitly approves Campaign 1.

Goal: modernize the legacy webpack/babel asset pipeline in a bounded, reversible way without changing the framework generation, bundler family, or runtime architecture.

Architecture: keep Webpack 4, Vue 2, and the current GraphQL document pipeline intact. Upgrade only selected loader/plugin packages that remain inside the current architecture. Each micro-batch must keep both production build and core app entrypoints working before the next batch begins.

Tech stack in scope:
- Webpack 4
- Babel 7.12-era config with loader/plugin updates only
- GraphQL document compilation via `graphql-tag/loader` + `graphql-persisted-document-loader`
- Pug template emission for server-rendered entry views

---

## Why this lane exists

The safe utility-batch lane is effectively exhausted. The next remaining updates with the best leverage are now build-pipeline packages that still have same-architecture versions available.

This lane is intentionally narrow:
- no Webpack 5
- no Vite
- no Vue 3
- no ESLint/Jest major moves
- no HTML plugin family migration beyond what is already present

The purpose is to reduce fragility while preserving the exact app architecture.

---

## In-scope package updates

Planned micro-batches:

### Batch 1A: Babel-side stabilization
- `babel-loader` 8.1.0 -> 8.4.1
- `babel-plugin-graphql-tag` 3.1.0 -> 3.3.0
- `babel-plugin-prismjs` 2.0.1 -> 2.1.0

### Batch 1B: Asset emission support
- `file-loader` 6.1.1 -> 6.2.0
- `moment-timezone-data-webpack-plugin` 1.3.0 -> 1.5.1

### Batch 1C: Dev build/watch path stabilization
- `webpack-hot-middleware` 2.25.3 -> 2.26.1
- optional only if earlier batches stay clean:
  - `simple-progress-webpack-plugin` 1.1.2 -> 2.0.0

Not in scope for Campaign 1:
- `webpack`
- `webpack-cli`
- `webpack-dev-middleware`
- `html-webpack-plugin`
- `copy-webpack-plugin`
- `css-loader`
- `sass-loader`
- `mini-css-extract-plugin`
- `vue-loader`
- `vue-template-compiler`

---

## Repo areas most likely to be affected

### Build configuration
- `package.json`
- `yarn.lock`
- `dev/webpack/webpack.dev.js`
- `dev/webpack/webpack.prod.js`

### GraphQL document pipeline
- `.gql` / `.graphql` handling in webpack rules
- client GraphQL imports under:
  - `client/graph/`
  - many `client/components/**/*.vue`

### Server-rendered template emission
- `dev/templates/master.pug`
- `dev/templates/legacy.pug`
- `dev/templates/setup.pug`
- emitted outputs:
  - `server/views/master.pug`
  - `server/views/legacy/master.pug`
  - `server/views/setup.pug`

### Smoke-check UI surfaces
- `client/components/login.vue`
- `client/components/editor.vue`
- `client/components/admin/admin-users.vue`
- `client/components/source.vue`
- `client/components/history.vue`

---

## Preconditions before starting execution

1. Branch must be clean except `.hermes/`
2. Current validation must pass:
   - `corepack yarn test`
   - `corepack yarn build`
3. Record current baseline commit hash before starting
4. Keep changes one batch at a time with a commit boundary after each approved batch
5. Do not combine Campaign 1 with any branch-harvest feature work or unrelated dependency changes

---

## Batch 1A detailed plan

### Objective
Update Babel-adjacent packages without changing Webpack generation or active loader topology.

### Files
- Modify: `package.json`
- Modify: `yarn.lock`
- Read/verify only: `dev/webpack/webpack.dev.js`
- Read/verify only: `dev/webpack/webpack.prod.js`

### Step 1: Update dependencies
Run:
- `corepack yarn add -D babel-loader@8.4.1 babel-plugin-graphql-tag@3.3.0 babel-plugin-prismjs@2.1.0 --exact --non-interactive`

### Step 2: Verify resolved install shape
Checks:
- confirm `babel-loader` stays in webpack rule paths
- confirm no new peer/dependency conflict that breaks current Babel 7 chain
- confirm `graphql-tag` loader/doc import flow remains intact conceptually

### Step 3: Run validation gates
Run in order:
- `corepack yarn test`
- `corepack yarn build`

### Step 4: Smoke-check expected areas
At minimum validate:
- login page still loads
- editor page still loads
- admin users page still loads
- any GraphQL-backed admin page still boots without client parse errors

### Step 5: Independent review
Have a reviewer inspect:
- whether build output still preserves GraphQL document pipeline
- whether Babel plugin changes may alter compiled query/code generation semantics

### Step 6: Commit if approved
Suggested commit message:
- `[verified] chore: stabilize babel-side asset pipeline batch 1A`

### 1A stop conditions
Stop immediately if any of these happen:
- `.gql` assets fail to compile
- Vue component imports using `gql` fail at runtime or build time
- build output changes cause server views or major entry bundles to break

---

## Batch 1B detailed plan

### Objective
Refresh the asset emission helpers without changing how assets are referenced or copied.

### Files
- Modify: `package.json`
- Modify: `yarn.lock`
- Read/verify only: `dev/webpack/webpack.dev.js`
- Read/verify only: `dev/webpack/webpack.prod.js`

### Step 1: Update dependencies
Run:
- `corepack yarn add -D file-loader@6.2.0 moment-timezone-data-webpack-plugin@1.5.1 --exact --non-interactive`

### Step 2: Verify config assumptions
Check:
- `file-loader` options remain valid in current webpack rules
- timezone-data plugin constructor/options remain valid:
  - `startYear`
  - `endYear`

### Step 3: Run validation gates
Run:
- `corepack yarn test`
- `corepack yarn build`

### Step 4: Smoke-check expected areas
Validate:
- compiled fonts and svg assets still emit
- login/editor/admin pages load with no missing asset errors
- client app still initializes with timezone handling intact

### Step 5: Independent review
Focus review on:
- asset output path stability
- any change to emitted asset names or references in generated Pug files

### Step 6: Commit if approved
Suggested commit message:
- `[verified] chore: stabilize asset emission pipeline batch 1B`

### 1B stop conditions
Stop immediately if any of these happen:
- emitted asset paths differ in a way that breaks server templates
- fonts, icons, or svg bundles fail to load
- timezone plugin API drift breaks build

---

## Batch 1C detailed plan

### Objective
Improve dev-watch/hot middleware stability without taking broader webpack middleware changes.

### Files
- Modify: `package.json`
- Modify: `yarn.lock`
- Read/verify only: `dev/webpack/webpack.dev.js`

### Step 1: Update dependency
Run:
- `corepack yarn add -D webpack-hot-middleware@2.26.1 --exact --non-interactive`

### Step 2: Optional package only after clean 1A/1B
If the branch remains clean after 1A/1B and review says low risk, then optionally also update:
- `simple-progress-webpack-plugin@2.0.0`

This should be a separate mini-step and can be dropped entirely if anything gets noisy.

### Step 3: Run validation gates
Run:
- `corepack yarn test`
- `corepack yarn build`

### Step 4: Dev-watch smoke checks
In addition to the normal gates, verify:
- dev mode boot still starts
- HMR client path `webpack-hot-middleware/client` still resolves
- no console explosion from middleware incompatibility

### Step 5: Independent review
Review should focus on:
- whether dev-only middleware changes stay isolated from production output
- whether any config signatures need adaptation

### Step 6: Commit if approved
Suggested commit message:
- `[verified] chore: stabilize dev watch pipeline batch 1C`

### 1C stop conditions
Stop immediately if any of these happen:
- HMR client path breaks
- dev server/watch mode fails to boot
- runtime chunk or asset serving changes unexpectedly in development

---

## Global verification checklist for Campaign 1

After every batch:
- [ ] `corepack yarn test` passes
- [ ] `corepack yarn build` passes
- [ ] no new blocking ESLint/Pug/Jest failures appear
- [ ] generated server views still exist
- [ ] at least one GraphQL-driven admin screen still loads
- [ ] login and editor entrypoints still boot
- [ ] independent review passes
- [ ] commit created before moving to next batch

After all approved batches:
- [ ] summarize bundle/output differences if any
- [ ] re-run full validation once more
- [ ] pause and reassess before any larger build-tool upgrade

---

## Suggested smoke-test command set

Automated:
- `corepack yarn test`
- `corepack yarn build`

Read-only sanity checks after build:
- confirm generated views exist:
  - `server/views/master.pug`
  - `server/views/legacy/master.pug`
  - `server/views/setup.pug`
- inspect webpack config references if a batch fails:
  - `dev/webpack/webpack.dev.js`
  - `dev/webpack/webpack.prod.js`

Manual/browser-oriented checks after build/dev boot:
- login page
- admin users view
- editor route
- source/history route
- at least one GraphQL-backed mutation path

---

## Rollback guidance

If any batch fails:
1. do not continue to the next batch
2. inspect the exact failing subsystem
3. if fix is straightforward and still within Campaign 1 scope, patch and re-verify
4. if fix expands beyond scope, revert that batch and mark it for later planning
5. keep the branch at the last verified commit boundary

---

## Open execution decisions to make before approval

1. Should Batch 1C include `simple-progress-webpack-plugin`, or should that be dropped entirely for maximum safety?
2. Do you want browser/dev-watch smoke checks performed locally as part of the approval-backed execution, or is build/test plus config/output inspection sufficient for the first pass?
3. Should Campaign 2 be prepared immediately after Campaign 1 approval, or only once Campaign 1 finishes cleanly?

## Suggested next action

Approve Campaign 1 execution exactly as three bounded batches (1A/1B/1C), with explicit stop-at-first-instability discipline.