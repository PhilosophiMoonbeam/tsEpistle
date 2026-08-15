# Phase Three Modernization Proposal

> **For Hermes:** This is an approval-gated modernization proposal, not an implementation plan for immediate dependency changes. Do not execute dependency bumps from this document until the user approves a specific campaign.

**Goal:** Move from historical consolidation into a rock-solid modernization baseline through small, evidence-backed dependency/tooling campaigns.

**Architecture:** Preserve the current stable application architecture while reducing stale dependency risk. Keep Vue 2.6.14, Webpack 4, Apollo 2 / GraphQL 15, Knex 0.21 / Objection 2, and JWT + continuation-token auth unless a later separately approved architectural campaign replaces one of those foundations.

**Tech Stack:** Node >=20, Yarn via Corepack, Vue 2.6.14, Vuetify 2, Webpack 4, Jest 27, Apollo Server 2, GraphQL 15, Knex 0.21, Objection 2.

---

## Executive Decision

The safe scarlett / vega consolidation harvest is now effectively exhausted.

Independent archaeology found no remaining self-contained scarlett or vega feature/fix that is safer than entering Phase Three modernization. Remaining branch-only material is either already harvested, obsolete against the current baseline, or coupled to excluded architectural rewrites such as Fastify, Drizzle, multisite, scheduler internals, auth/session, registration, or broad frontend REST migration.

Recommended next move: approve one narrow Phase Three modernization campaign at a time, starting with dependency patches that preserve the existing architecture.

---

## Current Baseline

- Branch: `hermes/wiki-consolidation-baseline`
- Latest consolidation commit at proposal time: `77f37721 [verified] feat: move admin export status polling to REST`
- Local branch is ahead of `origin/hermes/wiki-consolidation-baseline` by 9 commits before this proposal document.
- Working tree was clean before writing this proposal.
- Recent verified baseline:
  - `corepack yarn test` passed: 38 suites, 333 tests.
  - `corepack yarn build` passed.
  - Expected warnings only: Vue `setup` PascalCase warning, SQLite default-values warning in some tests, webpack asset-size / entrypoint warnings.

---

## Non-Negotiable Guardrails

Do not change these in the first Phase Three campaigns:

- Keep Vue at `2.6.14`.
- Keep `vue-template-compiler` aligned at `2.6.14`.
- Keep `vue-filepond@6.0.3` and `filepond@4.32.12`.
- Do not upgrade to `vue-filepond@7`, because it targets Vue 3.
- Keep JWT + continuation-token auth behavior.
- Keep GraphQL mutations and detail-heavy screens unless a later narrow migration explicitly targets a safe read path.
- Keep Webpack 4 for now.
- Keep Apollo Server 2 / GraphQL 15 for now.
- Keep Knex 0.21 / Objection 2 for now.
- Do not port scarlett Fastify/session/multisite auth architecture.
- Do not use raw merges from `origin/scarlett` or `origin/vega`.

Approval is required before any of these architectural campaigns:

- Vue 2.6 -> Vue 2.7 or Vue 3.
- Webpack 4 -> Webpack 5.
- Apollo Server 2 -> Apollo Server 3+.
- GraphQL 15 -> GraphQL 16+.
- Knex / Objection major upgrades.
- Express 4 -> Express 5.
- body-parser 1 -> 2.
- multer 1 -> 2.
- Passport/auth/session strategy refresh.
- Broad upload, registration, or auth policy rewrites.

---

## Recommended Campaign Order

### Campaign 1: Frontend Leaf Widgets Batch

**Status:** Recommended first approval target.

**Packages:**

- `canvas-confetti`: `1.3.1` -> `1.9.4`
- `js-beautify`: `1.13.5` -> `1.15.4`

**Why first:**

These are narrow client-side leaf dependencies with direct, limited usage:

- `canvas-confetti` is used by setup completion UI only.
- `js-beautify` is used by CKEditor HTML formatting only.

They do not touch auth, REST/GraphQL transport, Vue core, routing, state management, database, upload, storage, or Webpack architecture.

**Compatibility evidence:**

- `npm view canvas-confetti@1.9.4` resolves.
- `npm view js-beautify@1.15.4` resolves.
- `js-beautify@1.15.4` declares Node `>=14`, compatible with this repo's Node `>=20` baseline.

**Expected files changed:**

- `package.json`
- `yarn.lock`

**Potential runtime files to inspect if issues appear:**

- `client/components/setup.vue`
- `client/components/editor/editor-ckeditor.vue`

**Implementation command after approval:**

```bash
corepack yarn add --dev --exact canvas-confetti@1.9.4 js-beautify@1.15.4 --non-interactive
```

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

- Confirm `js-beautify/js/lib/beautifier.min.js` still resolves.
- Confirm setup page bundle builds with `canvas-confetti` import.

**Stop conditions:**

- `js-beautify` import path changes or becomes ESM-only.
- Setup or CKEditor bundle fails.
- Any test/build failure beyond known baseline warnings.

---

### Campaign 2: Small Server Rendering Utilities Batch

**Packages:**

- `@joplin/turndown-plugin-gfm`: `1.0.45` -> `1.0.64`
- `markdown-it-multimd-table`: `4.0.3` -> `4.2.3`

**Why second:**

This is a narrow rendering utility batch with direct usage:

- `@joplin/turndown-plugin-gfm` is used in page HTML-to-markdown conversion.
- `markdown-it-multimd-table` is used by one optional markdown rendering module.

**Expected files changed:**

- `package.json`
- `yarn.lock`

**Potential runtime files to inspect if issues appear:**

- `server/models/pages.js`
- `server/modules/rendering/markdown-multi-table/renderer.js`

**Implementation command after approval:**

```bash
corepack yarn add --exact @joplin/turndown-plugin-gfm@1.0.64 markdown-it-multimd-table@4.2.3 --non-interactive
```

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

- HTML-to-markdown conversion through the page import/conversion path.
- Markdown page containing multi-table syntax.

**Stop conditions:**

- Markdown table rendering changes in a way that breaks existing output expectations.
- Page HTML-to-markdown conversion throws or loses GFM output.
- Any API change requires touching broad rendering infrastructure.

---

### Campaign 3: Localization Utility Candidate

**Package:**

- `dotize`: `0.3.0` -> `0.6.0`

**Why separate:**

Although usage is narrow, `dotize` is a `0.x` dependency, so a minor version bump can contain breaking behavior.

**Direct usage:**

- `server/core/localization.js`
- `dotize.convert(data)` for localization key flattening.

**Expected files changed:**

- `package.json`
- `yarn.lock`

**Implementation command after approval:**

```bash
corepack yarn add --exact dotize@0.6.0 --non-interactive
```

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

- Compare representative nested localization input before/after `dotize.convert(...)`.
- Confirm locale strings API still returns flattened keys as expected.

**Stop conditions:**

- Flattened localization key output changes unexpectedly.
- The package changes CommonJS export shape.

---

### Campaign 4: Sanitizer Patch Candidate

**Package:**

- `dompurify`: `3.4.0` -> `3.4.1`

**Why separate:**

Patch-only and likely desirable, but sanitizer changes are security-sensitive. Keep this isolated and review carefully.

**Direct usage:**

- `client/components/editor/editor-markdown.vue`
- `client/components/editor/editor-asciidoc.vue`
- `server/jobs/sanitize-svg.js`
- `server/modules/rendering/html-security/renderer.js`
- `server/modules/comments/default/comment.js`

**Compatibility evidence:**

- `npm view dompurify@3.4.1` resolves.

**Expected files changed:**

- `package.json`
- `yarn.lock`

**Implementation command after approval:**

```bash
corepack yarn add --exact dompurify@3.4.1 --non-interactive
```

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

- Markdown preview sanitization.
- AsciiDoc preview sanitization.
- Comment rendering sanitization.
- SVG sanitization job.
- HTML security renderer behavior for existing allowed draw.io / foreignObject handling.

**Stop conditions:**

- Sanitizer output broadens allowed HTML unexpectedly.
- Existing draw.io / SVG / comment sanitization behavior regresses.
- Any sanitizer config changes are required beyond package metadata.

---

### Campaign 5: Webpack 4-Compatible Tooling Micro-Refresh

**Packages:**

- `@babel/core`: `7.28.4` -> `7.29.0`
- `terser`: `5.3.8` -> `5.46.2`
- `sass-resources-loader`: `2.1.1` -> `2.2.5`
- Optional ceiling: `vuetify-loader`: `1.6.0` -> `1.7.3`

**Important constraint:**

Do not upgrade `vuetify-loader` to `1.9.2` while preserving Vue 2.6.14. `npm view vuetify-loader@1.9.2 peerDependencies` declares `vue: ^2.7.2`, which violates the current baseline. `vuetify-loader@1.7.3` peers on `vue-template-compiler: ^2.6.10` and Webpack 4/5, making it the safer ceiling for this baseline.

**Why later:**

This is still Webpack 4-compatible, but build-output blast radius is broader than leaf runtime packages.

**Expected files changed:**

- `package.json`
- `yarn.lock`

**Potential config files to inspect if issues appear:**

- `dev/webpack/webpack.prod.js`
- `dev/webpack/webpack.dev.js`
- `.babelrc`

**Implementation command after approval:**

```bash
corepack yarn add --dev --exact @babel/core@7.29.0 terser@5.46.2 sass-resources-loader@2.2.5 vuetify-loader@1.7.3 --non-interactive
```

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

- Inspect generated asset list for unexpected missing assets.
- Confirm Vue/Vuetify component resolution still works in production build.

**Stop conditions:**

- Any dependency resolution changes Vue or `vue-template-compiler` away from `2.6.14`.
- Any plugin requires Webpack 5-only APIs.
- Any broad Webpack config rewrite becomes necessary.
- Production assets fail to inject correctly into server views.

---

### Campaign 6: Storage / Mail Adapter Patch Campaigns

**Candidates:**

- `@azure/storage-blob`: `12.29.1` -> `12.31.0`
- `ssh2`: `1.11.0` -> `1.17.0`, only after confirming `ssh2-promise` compatibility.
- `tar-fs`: `2.1.1` -> latest safe `2.x`, not `3.x`.
- `nodemailer`: `6.9.1` -> latest safe `6.x`, not `8.x`.

**Why later:**

Code surface is small, but meaningful validation may require external test services. Keep these split by provider unless reliable smoke tests exist.

**Likely files if issues appear:**

- `server/modules/storage/azure/storage.js`
- `server/modules/storage/sftp/storage.js`
- `server/core/mail.js`

**Required verification:**

```bash
corepack yarn test
corepack yarn build
git diff --check
```

**Extra probes:**

```bash
corepack yarn why ssh2
corepack yarn why ssh2-promise
```

Manual/integration smoke tests should use non-production services only.

**Stop conditions:**

- Any provider requires credential/schema/config migration.
- Any package becomes ESM-only for a CommonJS call site.
- Any smoke test requires production credentials.

---

## Explicitly Deferred Subsystem Campaigns

These should not be included in early Phase Three package batches:

### GraphQL / Apollo

- `apollo-server`
- `apollo-server-express`
- `graphql`
- `graphql-tools`
- `graphql-subscriptions`
- `subscriptions-transport-ws`
- Apollo client/link/cache packages

Reason: touches schema, resolvers, transport, subscriptions, and remaining GraphQL mutation/detail screens.

### Vue / Vuetify / Router / State

- `vue`
- `vue-template-compiler`
- `vue-router`
- `vuex`
- `vuex-pathify`
- `vuex-persistedstate`
- `vuetify`
- `vue-loader`
- `@vue/babel-preset-app`

Reason: framework-level blast radius; current baseline explicitly preserves Vue 2.6.14.

### Database / ORM

- `knex`
- `objection`
- major DB driver upgrades
- `connect-session-knex`

Reason: requires DB matrix testing and session/storage compatibility review.

### Express / Middleware / Upload / Auth

- `express` 5
- `body-parser` 2
- `multer` 2
- `passport` / strategy refresh
- `express-session` / auth-session changes

Reason: risks route semantics, upload authorization, JWT behavior, TFA continuation, password-change continuation, registration, and sessions.

### Broad Rendering Engines

- `markdown-it` major
- broad `markdown-it-*` plugin sweep
- `katex`
- `mathjax`
- `mermaid`
- `asciidoctor`
- `prismjs` beyond a separate rendering campaign

Reason: content correctness and editor preview behavior need focused fixture coverage first.

---

## Standard Execution Protocol for Each Approved Campaign

1. Confirm clean baseline:

```bash
git status --short --branch
git log --oneline --decorate -5
```

2. Inspect actual usage:

```bash
# Use targeted searches for each package name and import shape.
```

3. Confirm metadata:

```bash
npm view <package>@<target> version engines dependencies peerDependencies
```

4. Apply exact dependency updates only after approval:

```bash
corepack yarn add ... --exact --non-interactive
```

5. Inspect diff and lockfile changes:

```bash
git diff --stat
git diff -- package.json yarn.lock
git diff --check
```

6. Run targeted probes where relevant.

7. Run full validation:

```bash
corepack yarn test
corepack yarn build
```

8. Run added-line secret/security scan.

9. Request independent subagent review with:

- exact diff,
- package usage findings,
- package metadata findings,
- test/build results,
- known expected warnings.

10. Fix review blockers, rerun validation, and re-review.

11. Commit only after approval and verification:

```bash
git add package.json yarn.lock <any required source/test files>
git commit -m "[verified] chore: <campaign summary>"
```

---

## Recommended Approval Request

Approve Campaign 1 first:

```bash
corepack yarn add --dev --exact canvas-confetti@1.9.4 js-beautify@1.15.4 --non-interactive
```

Rationale: smallest blast radius, no architecture changes, direct usage is limited, and verification is straightforward.

If Campaign 1 passes, proceed one campaign at a time in the order above, with a separate `[verified]` commit for each.
