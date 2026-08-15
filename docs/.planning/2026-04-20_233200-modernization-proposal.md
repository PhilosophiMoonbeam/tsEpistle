# Wiki.js consolidation status and modernization proposal

> For Hermes: do not execute major dependency or architecture upgrades from this plan without explicit user approval.

Goal: record the current consolidation state, capture which remaining branch-derived candidates were audited and rejected, and define the next safe modernization lane for approval.

Architecture: continue preserving the current main-based legacy stack as the stable baseline. Treat branch harvesting and stack modernization as separate tracks. Only perform low-risk, verifiable changes on the live branch; stage larger runtime/toolchain/dependency shifts as explicit, approved work packages.

Tech stack baseline:
- Node target in repo: `.nvmrc` = `v24.12.0`
- Local validation currently works with Node 22 + `corepack yarn 1.22.22`
- CI workflow still hardcodes Node 20 on Windows and uses legacy Cypress image `cypress/included:4.9.0`
- Frontend stack remains Vue 2 + Vuetify 2 + Webpack 4
- Server stack remains Express 4 + Apollo Server 2 + GraphQL 15 + Knex 0.21 + Objection 2

---

## Completed low-risk consolidation ports

Verified branch-derived work already landed on `hermes/wiki-consolidation-baseline`:
- baseline quality-gate stabilization
- metrics endpoint baseline
- server-backed admin user pagination/search
- source-view download action
- page source/download path helper consolidation

## Additional branch-derived candidates audited after page-action polish

These were reviewed and rejected as current-branch implementation targets because they are either already present, architecture-mismatched, or not worth the risk:
- `da9d2529` hide unfinished editors from welcome screen
- `d9523fe3` rename / move page + styling fixes
- `291fe262` asset rename + asset delete dialogs + linting fixes
- `05fe4957` missing pako package + deprecated dev extension
- `7a3d78bb` assetById permissions + PostgreSQL 16 minimum
- `70d4998b` vega-only lint fix in removed UX file
- `7425a74b` page duplicate + styling fixes

Assessment summary:
- several vega/scarlett commits target the newer `ux/` + `.mjs` stack and are not clean low-risk ports to the legacy `client/` + `.js` stack
- some headline features already exist in stronger form on current main
- remaining worthwhile work has shifted from branch harvesting to stack modernization planning

## Evidence from package/runtime audit

Runtime/tooling drift now visible in-tree:
- `.nvmrc` requests Node `v24.12.0`
- GitHub Actions Windows build still uses `node-version: 20.x`
- current app builds locally but emits long-standing Browserslist staleness warnings

`npm outdated --json` shows a very large backlog. The important split is:

### Safe-looking patch/minor candidates worth batching first
These stay on the same major and are plausible first-pass stabilization updates:
- `pg` 8.16.3 -> 8.20.0
- `mysql2` 3.16.0 -> 3.22.2
- `prom-client` 15.0.0 -> 15.1.3
- `pug` 3.0.3 -> 3.0.4
- `remove-markdown` 0.6.2 -> 0.6.3
- `semver` 7.7.3 -> 7.7.4
- `simple-git` 3.30.0 -> 3.36.0
- `winston` 3.8.2 -> 3.19.0
- `turndown` 7.2.2 -> 7.2.4
- `cross-env` 10.0.0 -> 10.1.0
- `pug-lint` 2.6.0 -> 2.7.0
- `pug-plain-loader` 1.0.0 -> 1.1.0

### Higher-risk same-stack upgrades that likely need isolated batches
These may still be viable later, but should not be mixed with patch-level stabilization:
- Babel toolchain 7.12.x -> 7.28/7.29
- `elasticsearch7` 7.9.1 -> 7.17.14
- `elasticsearch8` 8.15.0 -> 8.19.1
- `sass` 1.27.0 -> 1.99.0
- `vue-template-compiler` 2.6.14 -> 2.7.16
- `webpack-hot-middleware` 2.25.3 -> 2.26.1

### Explicitly major / architectural upgrades to defer for a later approved lane
These are not low-risk baseline work:
- Vue 2 -> Vue 3
- Vuetify 2 -> Vuetify 4
- Webpack 4 -> Webpack 5
- Jest 26 -> Jest 30
- ESLint 7 -> ESLint 10
- Apollo Server 2 -> 3+
- GraphQL 15 -> 16
- Knex 0.21 -> 3
- Objection 2 -> 3
- Express 4 -> 5
- Cypress 5 -> 15

## Proposed next phase for approval

### Proposal A: runtime and CI alignment only
Purpose: remove environment drift before any package churn.

Scope:
1. align CI Node version with `.nvmrc` where safe
2. audit Dockerfiles/devcontainer for Node version consistency
3. keep application dependency graph unchanged
4. verify with:
   - `corepack yarn test`
   - `corepack yarn build`

Expected value:
- more deterministic local/CI behavior
- better baseline for later dependency work

Risk:
- low to moderate, but still needs approval because CI/runtime changes can affect release packaging

### Proposal B: patch/minor stabilization batch
Purpose: reduce security/deprecation pressure without crossing major-version boundaries.

Suggested initial batch:
- `pg`
- `mysql2`
- `prom-client`
- `pug`
- `remove-markdown`
- `semver`
- `simple-git`
- `winston`
- `turndown`

Execution constraints:
- update in very small batches, not all at once
- after each batch run:
  - `corepack yarn install --non-interactive`
  - `corepack yarn test`
  - `corepack yarn build`
- commit each verified batch separately

Expected value:
- low-friction modernization progress
- reduced dependency staleness while staying on current architecture

Risk:
- moderate but controlled

### Proposal C: deferred architecture modernization track
Purpose: plan, but do not execute yet, the heavier upgrades.

Topics to plan separately:
- GraphQL/Apollo modernization
- frontend bundler modernization
- lint/test toolchain modernization
- Vue/Vuetify migration strategy
- ORM/database layer modernization

This track should become a dedicated design/planning effort, not opportunistic branch harvesting.

## Recommended immediate next action

Ask for approval on one of these two practical next moves:
1. runtime/CI alignment proposal
2. first patch/minor stabilization batch

Recommendation: start with Proposal A, then Proposal B in small verified slices.
