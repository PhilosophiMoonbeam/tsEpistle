# Wiki.js Fork Consolidation and Modernization Baseline Plan

> For Hermes: use subagent-driven-development for implementation once the user approves the approach. Until approval, remain in audit/planning mode for major architectural changes and dependency modernization.

Goal: establish a safe, evidence-backed path to consolidate practical work from the historical `origin/scarlett` and `origin/vega` branches onto a new branch cut strictly from `main`, then modernize the stack without destabilizing the baseline.

Architecture:
- Treat `main` as the only executable baseline and all other branches as source material, not merge targets.
- Use selective cherry-picks only for truly isolated patches; prefer manual semantic ports for anything crossing runtime, API, schema, or frontend architecture boundaries.
- Sequence work as: baseline verification -> scarlett harvest -> vega harvest -> stack modernization.

Tech Stack (current main):
- Monorepo-style single package root
- Node 24 target in `.nvmrc`, `node >=20` in `package.json`
- Yarn 1 lockfile workflow
- Express + GraphQL + webpack + Vue 2 era client structure (`server/`, `client/`)
- Docker-based CI/CD with Cypress matrix testing

---

## Current audited context

### Branch topology
- Working tree currently on `main`
- Merge-base of `main`, `origin/scarlett`, and `origin/vega`: `b5b4b0880ae26f4b137242267b6674b51af8688c`
- `main...origin/scarlett`: `259` commits on main side, `270` on scarlett side
- `main...origin/vega`: `259` commits on main side, `258` on vega side
- `origin/vega...origin/scarlett`: `0/12`
- Conclusion: `origin/scarlett` fully contains `origin/vega` plus 12 additional commits.
- Naming note: the actual branch is `origin/scarlett`, not `origin/scarlet`.

### Main baseline shape
- Top-level runtime paths: `server/`, `client/`, `dev/`, `patches/`
- Package manager: `yarn.lock`
- CI build file: `.github/workflows/build.yml`
- Container build file: `dev/build/Dockerfile`
- Scripts from `package.json`:
  - `start`: `node server`
  - `dev`: `cross-env NODE_OPTIONS=--openssl-legacy-provider node dev`
  - `build`: `cross-env NODE_OPTIONS=--openssl-legacy-provider webpack --profile --config dev/webpack/webpack.prod.js`
  - `test`: `eslint --format codeframe --ext .js,.vue . && pug-lint server/views && jest`
- `.nvmrc`: `v24.12.0`
- Local environment note: `corepack yarn` is available, but `yarn` is not globally installed as a standalone binary in this shell.

### Scarlett branch assessment
`origin/scarlett` is an architectural fork, not a normal feature branch.

Primary shifts:
- `server/` -> `backend/`
- `client/ux` -> `frontend/`
- Express/GraphQL -> Fastify/REST/OpenAPI
- legacy models/migrations -> Drizzle schema + generated migrations
- new scheduler/worker/jobs subsystem
- split package manifests (`backend/package.json`, `frontend/package.json`)

Low-risk/manual-port candidates identified:
- `0385a9b6` fix: update to working twitch passport strategy
- `4bfd9f52` feat(mail): allow setting of mailer identifying name
- `1eefdb06` feat(admin): add sitemap option to general page
- `c011d714` feat(admin): add footerExtra field to admin general
- minor UI cleanup like `368493c3` if still relevant

Areas to avoid for direct cherry-pick:
- REST migration
- Fastify/Drizzle/package split
- scheduler admin API and worker subsystem
- large frontend/admin rewrite
- auth/session rewrites tied to new platform

### Vega branch assessment
`origin/vega` is also a long-lived alternate product line with large churn.

High-value low-hanging-fruit candidates only:
- `dec9272f` feat: metrics endpoint
- `81e0a67f` feat: admin users search + pagination
- `add3631b` feat: view page source + download page
- `b7d25473` feat: user welcome email
- `97ee3af4` feat: add basic media player block (only if block infrastructure matches)

Areas to avoid in Phase Two:
- ux platform migration / Vite/Quasar app fork
- passkeys/TFA/login flow chain
- page/tree mutation rewrites
- storage admin/file manager work
- scheduler work
- locale/site groundwork that touches boot/config broadly
- explicit WIP editor/blocks experiments

---

## Proposed execution strategy

### Task 1: Verify and document the `main` baseline before any porting

Objective: prove the baseline state and capture the exact local/CI build workflow before branching.

Files:
- Inspect: `package.json`
- Inspect: `.nvmrc`
- Inspect: `.github/workflows/build.yml`
- Inspect: `dev/build/Dockerfile`
- Possibly create: `docs/plans/` or `.hermes/plans/` notes only

Steps:
1. Use `corepack yarn` to install dependencies in a controlled way.
2. Run the baseline quality gates in the same order implied by the repo:
   - lint/test: `corepack yarn test`
   - production asset build: `corepack yarn build`
3. If local runtime configuration is required, prefer non-secret sample config only.
4. Record failures as baseline issues rather than fixing them opportunistically unless they block all future work.

Verification:
- `corepack yarn test`
- `corepack yarn build`
- Optional later: docker build smoke using `dev/build/Dockerfile`

Risk:
- Moderate install/build cost, but low architectural risk.

### Task 2: Create the consolidation branch from `main`

Objective: establish the single working branch for this sprint once baseline verification is complete.

Proposed branch name:
- `hermes/wiki-consolidation-baseline`

Steps:
1. Ensure working tree is clean.
2. Create branch strictly from local `main` after verifying it matches `origin/main`.
3. Do all subsequent ports onto this branch.

Verification:
- `git status --short --branch`
- `git rev-parse --abbrev-ref HEAD`
- `git log --oneline -1`

### Task 3: Audit scarlett commit-by-commit into a port backlog

Objective: turn scarlett findings into an approved port queue ordered by value and risk.

Artifacts to prepare:
- A short backlog table with:
  - commit hash
  - feature/fix summary
  - target files on main
  - port mode (`cherry-pick`, `manual-port`, `skip`)
  - validation scope

Initial candidate queue:
1. `0385a9b6` Twitch auth strategy fix
2. `4bfd9f52` mailer identifying name
3. `1eefdb06` sitemap option
4. `c011d714` footerExtra field
5. any tiny UI-only cleanups after exact file mapping

Validation per candidate:
- targeted tests if present
- affected GraphQL schema/resolver checks
- admin UI smoke review
- full `corepack yarn test`
- full `corepack yarn build`

### Task 4: Port scarlett candidates one at a time

Objective: land only practical, stable scarlett-derived improvements.

Method rules:
- If commit touches old-compatible paths and has low blast radius, attempt cherry-pick into a scratch review branch first.
- If commit depends on divergent architecture or has even moderate conflict surface, manually port semantics into main-style files.
- Refactor on arrival to current main conventions.

Likely main target areas:
- `server/modules/authentication/*`
- `server/core/mail.js`
- `server/models/settings.js`
- `server/models/sites.js`
- `server/graph/resolvers/*.js`
- `server/graph/schemas/*.graphql`
- matching admin Vue files under `client/` or legacy admin UI paths actually present on main

Verification after each port:
- focused grep/readback of changed schema and UI files
- `corepack yarn test`
- `corepack yarn build`
- if auth-related, inspect relevant module configuration paths for regressions

### Task 5: Build the Phase Two vega harvest queue

Objective: only after scarlett work is stable, review vega candidates against the newly consolidated branch.

Candidate order:
1. `dec9272f` metrics endpoint
2. `81e0a67f` admin users search + pagination
3. `add3631b` view page source + download page
4. `b7d25473` user welcome email
5. `97ee3af4` media player block only if infrastructure compatibility is confirmed

Rules:
- Skip any candidate that drags in the `ux/` platform assumptions or broad GraphQL resolver rewrites.
- Prefer manual ports with small surface area.
- Require a clear rollback path for each candidate.

### Task 6: Prepare the modernization proposal before touching core dependencies

Objective: produce an approval-gated modernization plan after functional consolidation.

Modernization scope to audit:
- runtime/version alignment:
  - `.nvmrc` (`24.12.0`) vs `package.json` (`>=20`)
- package manager and install determinism:
  - Yarn 1 lockfile health
  - `patch-package` usage
- legacy flags and debt:
  - `NODE_OPTIONS=--openssl-legacy-provider`
  - webpack/Babel/Jest/Cypress age
  - Apollo Server 2 / GraphQL stack age
  - Express and auth dependency posture
- CI/runtime container parity:
  - `.github/workflows/build.yml`
  - `dev/build/Dockerfile`

Deliverable before execution:
- a written modernization proposal grouping dependencies into:
  - safe patch/minor updates
  - medium-risk subsystem upgrades
  - architectural upgrade candidates requiring explicit approval

Execution rule:
- no major dependency bump wave without user approval.

---

## Proposed working principles

1. `main` remains the source of truth.
2. `origin/scarlett` and `origin/vega` are mined, not merged.
3. One feature/fix port at a time.
4. Full validation after every accepted port.
5. No net-new organizational features before consolidation and modernization complete.
6. Any branch-derived code should be rewritten to current main conventions rather than imported verbatim when outdated.

---

## Risks and tradeoffs

- Biggest risk: accidentally importing architecture drift from scarlett/vega into main.
- Second risk: spending too long on archaeology instead of extracting only high-yield items.
- Tradeoff: manual semantic ports are slower than merge/cherry-pick, but far safer here.
- Build/tooling risk: main currently mixes a Node 24 target with legacy webpack/OpenSSL compatibility flags; modernization must be staged carefully.

---

## Open questions for approval

1. Confirm that `origin/scarlett` is the intended branch despite the spelling difference from `scarlet`.
2. Approve the working branch name `hermes/wiki-consolidation-baseline`, or provide a preferred naming convention.
3. Approve Phase One order:
   - baseline verification first
   - then create branch
   - then scarlett candidate queue
4. Approve the initial scarlett candidate shortlist:
   - Twitch auth fix
   - mailer identifying name
   - sitemap option
   - footerExtra field
5. Confirm that large architecture migrations from scarlett/vega should remain out of scope unless later explicitly re-proposed.

---

## Ready next actions after approval

1. Verify local baseline on `main` with `corepack yarn` install/test/build.
2. Create `hermes/wiki-consolidation-baseline` from `main`.
3. Build the exact scarlett port backlog with per-commit file mapping.
4. Start the first low-risk port and validate it end-to-end.
