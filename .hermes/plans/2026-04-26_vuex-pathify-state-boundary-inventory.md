# Vuex Pathify State-Boundary Inventory

> **For Hermes:** This is a planning/inventory artifact only. Do not rewrite Vuex, remove vuex-pathify, add Pinia/Vuex 4, convert SFCs, edit runtime source, or expand TypeScript checking from this document without a separately approved implementation lane.

**Goal:** Map the current Vuex/vuex-pathify state boundary so future TypeScript and Vue modernization work can target explicit state contracts instead of string-path assumptions.

**Architecture:** Keep the current Vue 2.6.14 / Vuex 3.5.1 / vuex-pathify 1.4.5 / Vuetify 2 / Webpack 4 application unchanged. This inventory classifies store modules, pathify helper usage, direct Vuex commits, high-churn coupling, and future typed-boundary lanes without changing runtime behavior.

**Tech Stack:** Vue 2.6.14, vue-template-compiler 2.6.14, Vuex 3.5.1, vuex-pathify 1.4.5, Vuetify 2.3.15, Vue Router 3.4.7, Webpack 4.44.2, TypeScript 5.9.3 check-only TS-1 baseline.

---

## Executive summary

The next safe frontend modernization step is still boundary mapping, not a Vuex/pathify rewrite.

Current state management is dominated by implicit string paths and generated `make.mutations(state)` contracts:

- `vuex-pathify` imports appear in 36 frontend files.
- Pathify helper calls in helper-importing files total 134:
  - `get(...)`: 84
  - `sync(...)`: 50
  - `call(...)`: 0
- Pathify plugin store API calls total 145:
  - `this.$store.get(...)`: 85
  - `this.$store.set(...)`: 60
  - `this.$store.sync(...)`: 0
- Active direct Vuex commit calls total 431, including 393 static/literal mutation-name commits and 38 conditional dynamic loading commits.
- No `this.$store.dispatch(...)` usage was found in the scanned frontend state boundary.

Primary conclusion: Vuex/pathify is not a quick dependency or syntax cleanup. It is a hidden application contract that should be frozen, documented, and wrapped in additive typed boundaries before any removal or migration attempt.

Recommended next implementation-adjacent lane after this inventory: a proposal for a root UI facade and store-shape declarations, still additive and check-only. Do not replace pathify behavior yet.

---

## Scope and guardrails

This document is planning-only.

Allowed here:

- Inventory `client/store/*.js` modules.
- Count and classify pathify helper usage.
- Count direct Vuex commits.
- Identify high-risk/high-churn consumers.
- Propose future typed-boundary sequencing.
- Identify stop conditions for later implementation.

Not allowed from this document alone:

- No source edits.
- No package installs/removals.
- No `package.json`, `yarn.lock`, `tsconfig`, Webpack, Jest, Babel, ESLint, Vue-loader, or CI changes.
- No Vuex/pathify rewrite.
- No Pinia, Vuex 4, Vue 2.7, Vue 3, Vuetify 3, router, Vite, or Webpack migration.
- No SFC conversion to `<script lang="ts">` or `<script setup>`.
- No runtime `.ts` imports.
- No filter, `$refs`, `$root`, event-bus, or Vuetify fixes bundled into this inventory.

TS-1 note: the current TypeScript baseline is advisory and check-only. It intentionally includes only `client/helpers/*-api.js`; it does not typecheck `client/store/**/*` or SFCs.

---

## Baseline dependency state

Confirmed before this inventory:

| Package | Current |
| --- | ---: |
| `vue` | `2.6.14` |
| `vue-template-compiler` | `2.6.14` |
| `vue-loader` | `15.9.8` |
| `vuex` | `3.5.1` |
| `vuex-pathify` | `1.4.5` |
| `vuetify` | `2.3.15` |
| `vue-router` | `3.4.7` |
| `webpack` | `4.44.2` |
| `typescript` | `5.9.3` |

Preflight also confirmed:

- Branch: `hermes/wiki-consolidation-baseline`
- Working tree was clean before creating this document.
- `corepack yarn typecheck:ts1` passed.

---

## Scan summary

Scanned current first-party frontend files under `client/`:

- 148 files total:
  - 94 `.vue`
  - 54 `.js`
- Test files were excluded from the state-boundary interpretation.
- `node_modules` and vendored/example SFCs were ignored.

### Usage count summary

| Category | Count | Notes |
| --- | ---: | --- |
| Files importing `vuex-pathify` | 36 | Includes 6 store files and 30 consumer files. |
| `vuex-pathify` import statements | 37 | `client/store/index.js` imports both default `pathify` and `{ make }`. |
| Pathify helper calls | 134 | Counted only in files importing pathify helpers. |
| `get(...)` helper calls | 84 | Main computed read pattern. |
| `sync(...)` helper calls | 50 | Main two-way computed binding pattern. |
| `call(...)` helper calls | 0 | No active pathify `call` helper use found. |
| `this.$store.get(...)` calls | 85 | Pathify plugin runtime API. |
| `this.$store.set(...)` calls | 60 | Pathify plugin runtime API. |
| `this.$store.sync(...)` calls | 0 | No active runtime sync calls found. |
| `this.$store.commit(...)` calls | 431 | 393 static/literal mutation-name commits, 38 conditional dynamic loading forms. |
| `this.$store.dispatch(...)` calls | 0 | No direct dispatch usage found. |
| `make.mutations(...)` calls | 6 | Root plus five modules. |
| `pathify.plugin` references | 1 | Installed in `client/store/index.js`. |

Important counting note: pathify helper counts exclude unrelated functions such as lodash `_.get(...)` and D3/Array `call(...)`; the scan counted helper calls only where helpers are imported from `vuex-pathify`.

---

## Store module contract

### Root store: `client/store/index.js`

Runtime setup:

- `Vue.use(Vuex)`
- `strict: process.env.NODE_ENV !== 'production'`
- plugin: `pathify.plugin`
- static modules: `page`, `site`, `user`

Root state:

- `loadingStack: []`
- `notification.message`
- `notification.style`
- `notification.icon`
- `notification.isActive`

Root getter:

- `isLoading`: derived from `loadingStack.length > 0`

Root mutations:

- generated `make.mutations(state)`
- `loadingStart(st, stackName)`
- `loadingStop(st, stackName)`
- `showNotification(st, opts)`
- `updateNotificationState(st, newState)`
- `pushGraphError(st, err)`

Root actions:

- none

Primary risk:

- Root commits are extremely widespread and mostly drive loading/notification behavior. These are good facade candidates because they are high-value and conceptually small.

### Page module: `client/store/page.js`

Registration:

- Static module in root store.
- `namespaced: true`
- `mutations: make.mutations(state)`

State shape:

- identity/metadata: `id`, `authorId`, `authorName`, `createdAt`, `updatedAt`
- page location/content metadata: `locale`, `path`, `title`, `description`, `tags`
- publication metadata: `isPublished`, `publishStartDate`, `publishEndDate`
- editor/runtime metadata: `editor`, `mode`, `scriptJs`, `scriptCss`
- permissions: `effectivePermissions.comments`, `history`, `source`, `pages`, `system`
- counts and shortcuts: `commentsCount`, `editShortcuts.*`

Primary risk:

- This is the highest-volume pathified module. It is read and written by editor, theme, shell, source/history, and permissions UI.

### Site module: `client/store/site.js`

Registration:

- Static module in root store.
- `namespaced: true`
- `mutations: make.mutations(state)`

State shape:

- branding/config: `company`, `contentLicense`, `footerOverride`, `title`, `logoUrl`
- theme/runtime: `dark`, `tocPosition`, `mascot`, `printView`
- search UI: `search`, `searchIsFocused`, `searchIsLoading`, `searchRestrictLocale`, `searchRestrictPath`

Primary risk:

- Lower count than page/editor, but globally visible in navigation, theme, and search surfaces.

### User module: `client/store/user.js`

Registration:

- Static module in root store.
- `namespaced: true`
- generated `make.mutations(state)` plus custom `REFRESH_AUTH`

State shape:

- identity/profile: `id`, `email`, `name`, `pictureUrl`, `localeCode`
- preferences: `defaultEditor`, `timezone`, `dateFormat`, `appearance`
- authorization/session: `permissions`, `iat`, `exp`, `authenticated`

Custom mutation:

- `REFRESH_AUTH` decodes the `jwt` cookie and fills user state.

Primary risk:

- Auth/session state is sensitive. Future typing must preserve current silent authentication behavior and JWT field mappings.

### Editor module: `client/store/editor.js`

Registration:

- Dynamic module, not present at initial root store creation.
- `namespaced: true`
- generated `make.mutations(state)` plus custom media stack mutations.

Known dynamic registration sites:

- `client/components/editor.vue`
- `client/components/admin/admin-security.vue`
- `client/components/admin/admin-general.vue`

State shape:

- `editor`
- `editorKey`
- `content`
- `mode`
- `activeModal`
- `activeModalData`
- `media.folderTree`
- `media.currentFolderId`
- `media.currentFileId`
- `checkoutDateActive`

Custom mutations:

- `pushMediaFolderTree`
- `popMediaFolderTree`

Primary risk:

- Editor is dynamic and high-volume. Typed accessors must account for registration timing.
- Current source sets `editor/id`, but `client/store/editor.js` does not declare `id` in state. This is a stop-and-review item before strict editor typing.

### Admin module: `client/store/admin.js`

Registration:

- Dynamic module, not present at initial root store creation.
- Registered by `client/components/admin.vue`.
- `namespaced: true`
- `mutations: make.mutations(state)`

State shape:

- `info.currentVersion`
- `info.latestVersion`
- `info.groupsTotal`
- `info.pagesTotal`
- `info.usersTotal`
- `info.tagsTotal`

Primary risk:

- Small state surface, but dynamic registration must be preserved.

---

## Module access totals

Pathify helper plus `this.$store.get/set` access by first path segment:

| Module/root path | Total | Helper `get` | Helper `sync` | `$store.get` | `$store.set` | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `page` | 148 | 52 | 11 | 55 | 30 | Highest-volume state boundary. |
| `editor` | 85 | 11 | 20 | 25 | 29 | Dynamic module; high editor risk. |
| `site` | 23 | 6 | 17 | 0 | 0 | Mostly computed helper usage. |
| `user` | 18 | 12 | 0 | 5 | 1 | Auth/session/profile surface. |
| `admin` | 2 | 1 | 1 | 0 | 0 | Small dynamic module. |
| `notification` | 2 | 1 | 1 | 0 | 0 | Root notification state. |
| `isLoading` | 1 | 1 | 0 | 0 | 0 | Root getter. |

Most-used helper paths:

| Path | Count |
| --- | ---: |
| `editor/activeModal` | 14 |
| `page/path` | 12 |
| `page/locale` | 12 |
| `editor/mode` | 7 |
| `page/title` | 5 |
| `page/id` | 4 |
| `user/permissions` | 3 |
| `user/authenticated` | 3 |
| `editor/editorKey` | 3 |
| `admin/info` | 2 |
| `site/title` | 2 |
| `site/logoUrl` | 2 |
| `site/company` | 2 |
| `site/contentLicense` | 2 |
| `site/footerOverride` | 2 |
| `page/effectivePermissions@comments` | 2 |
| `user/name` | 2 |
| `site/search` | 2 |
| `site/searchIsFocused` | 2 |
| `site/searchIsLoading` | 2 |
| `site/searchRestrictLocale` | 2 |
| `site/searchRestrictPath` | 2 |

Most-used `$store.get/set` paths:

| Path | Count |
| --- | ---: |
| `editor/content` | 32 |
| `editor/editorKey` | 10 |
| `page/locale` | 10 |
| `page/path` | 10 |
| `page/id` | 8 |
| `page/title` | 7 |
| `page/description` | 6 |
| `page/tags` | 6 |
| `page/isPublished` | 6 |
| `publishStartDate` / `publishEndDate` | 5 each |
| `page/scriptCss` / `page/scriptJs` | 5 each |
| `editor/mode` | 5 |
| `editor/activeModalData` | 4 |
| `page/effectivePermissions` | 4 |

---

## Direct commit surface

Static root-level commits dominate direct Vuex usage. Counts below use active-source counts with commented-out commits excluded:

| Commit target | Static count | Notes |
| --- | ---: | --- |
| `showNotification` | 163 | Primary global notification API. |
| `loadingStart` | 80 | Global loading stack start. |
| `loadingStop` | 79 | Global loading stack stop. |
| `pushGraphError` | 58 | GraphQL error notification bridge. |
| `page/SET_MODE` | 5 | Generated pathify mutation use. |
| `page/SET_ID` | 2 | Generated pathify mutation use. |
| `page/SET_LOCALE` | 2 | Generated pathify mutation use. |
| `page/SET_PATH` | 2 | Generated pathify mutation use. |
| `editor/pushMediaFolderTree` | 1 | Custom editor media mutation. |
| `editor/popMediaFolderTree` | 1 | Custom editor media mutation. |

Planning implication:

- A root UI facade is likely the safest first implementation-adjacent lane because repeated commit patterns are high-volume, root-scoped, and conceptually simple.
- Direct `page/SET_*` and editor media commits must remain compatible with `make.mutations(state)` and custom module mutations.
- The 38 non-static/dynamic commit forms are active conditional loading commits of the form ``this.$store.commit(`loading${isLoading ? 'Start' : 'Stop'}`, ...)``. They should be handled by the same future loading facade rather than treated as arbitrary mutation targets.

---

## Top pathify-boundary consumers

| Rank | File | Total pathify/get-set refs | Helper `get` | Helper `sync` | `$store.get` | `$store.set` | Risk |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `client/components/editor.vue` | 80 | 2 | 4 | 57 | 17 | Critical editor shell. |
| 2 | `client/themes/default/components/page.vue` | 27 | 11 | 1 | 0 | 15 | Critical public page/theme surface. |
| 3 | `client/components/common/nav-header.vue` | 25 | 17 | 5 | 3 | 0 | Critical global shell/search/nav surface. |
| 4 | `client/components/editor/editor-markdown.vue` | 13 | 3 | 1 | 5 | 4 | High editor content surface. |
| 5 | `client/components/editor/editor-modal-properties.vue` | 13 | 3 | 10 | 0 | 0 | High page/editor metadata surface. |
| 6 | `client/components/editor/editor-asciidoc.vue` | 12 | 3 | 1 | 4 | 4 | High editor content surface. |
| 7 | `client/components/editor/editor-modal-conflict.vue` | 11 | 5 | 2 | 2 | 2 | High conflict-resolution surface. |
| 8 | `client/components/editor/editor-code.vue` | 9 | 3 | 1 | 2 | 3 | Editor content surface. |
| 9 | `client/components/admin/admin-general.vue` | 7 | 0 | 6 | 0 | 1 | Admin settings plus dynamic editor module registration. |
| 10 | `client/components/editor/editor-ckeditor.vue` | 7 | 2 | 1 | 2 | 2 | Editor content surface. |

---

## High-churn coupling table

| File | Churn | Recent | Pathify/store get-set | Direct Vuex | Risk | Notes |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `client/components/editor.vue` | 73 | 0 | 80 | 4 | Critical | Central editor shell; high `$store.get/set`; save/content/modal lifecycle. |
| `client/themes/default/components/page.vue` | 84 | 3 | 27 | 0 | Critical | Highest-churn current Vue file; public page rendering depends on page/site/user state. |
| `client/components/common/nav-header.vue` | 79 | 2 | 25 | 4 | Critical | Global shell/nav/search; broad site/user/page coupling. |
| `client/components/editor/editor-markdown.vue` | 70 | 1 | 13 | 3 | High | Main markdown editor; content sync and editor modal state. |
| `client/components/admin.vue` | 70 | 1 | 3 | 4 | Medium-high | Admin shell and dynamic admin module registration. |
| `client/components/login.vue` | 53 | 4 | 2 | 9 | High | Auth-critical; notification/loading commits. |
| `client/components/admin/admin-auth.vue` | 51 | 2 | 0 | 13 | High | Auth admin; user/security-sensitive direct commits. |
| `client/components/admin/admin-general.vue` | 47 | 0 | 8 | 5 | High | Settings surface; pathify sync and direct commits. |
| `client/components/admin/admin-storage.vue` | 38 | 0 | 0 | 9 | Medium-high | Storage/provider settings; direct commits. |
| `client/components/editor/editor-modal-properties.vue` | 37 | 3 | 15 | 0 | High | Dense pathify sync/get for page/editor metadata. |
| `client/components/admin/admin-locale.vue` | 37 | 1 | 0 | 8 | Medium-high | Locale settings; direct commits. |
| `client/components/admin/admin-dashboard.vue` | 36 | 3 | 3 | 6 | Medium-high | Admin dashboard/info state. |
| `client/components/admin/admin-theme.vue` | 35 | 1 | 2 | 7 | Medium-high | Theme config; active modal plus direct commits. |
| `client/components/admin/admin-navigation.vue` | 32 | 2 | 0 | 13 | High | Navigation config; global UX impact. |
| `client/components/editor/editor-modal-media.vue` | 31 | 1 | 7 | 22 | Critical | Media modal; high direct commit count plus editor/page state. |
| `client/components/admin/admin-users-edit.vue` | 27 | 3 | 4 | 35 | Critical | Highest direct commit count; user/admin-sensitive. |
| `client/components/admin/admin-api.vue` | 15 | 1 | 0 | 14 | High | API key/admin surface. |
| `client/components/comments.vue` | 12 | 0 | 7 | 15 | High | User-facing comments; pathify plus commits. |
| `client/store/index.js` | 12 | 0 | 2 | 1 | Critical foundation | Installs pathify plugin and generated root mutations. |
| `client/store/editor.js` | 12 | 0 | 1 | 0 | Critical foundation | Generated editor mutation contract plus media mutations. |
| `client/store/page.js` | 10 | 0 | 2 | 0 | Critical foundation | Generated page mutation contract. |
| `client/store/site.js` | 11 | 0 | 2 | 0 | Critical foundation | Generated site mutation contract. |
| `client/store/admin.js` | 6 | 1 | 2 | 0 | Critical foundation | Generated admin mutation contract. |
| `client/store/user.js` | 3 | 0 | 1 | 0 | Critical foundation | Generated user mutations plus `REFRESH_AUTH`. |

Note: churn counts are based on current tracked file paths in git history. They are useful for relative risk but may undercount older renamed/moved logical components.

---

## Risk clusters

| Cluster | Files coupled | Churn sum | Pathify/store get-set | Direct Vuex | Risk |
| --- | ---: | ---: | ---: | ---: | --- |
| Admin console | 41 | 793 | 24 | 323 | Broad admin risk; repeated loading/notification commits across many settings screens. |
| Editor/page-editing | 14 | 270 | 193 | 34 | Highest semantic risk; content, metadata, modals, media, checkout, conflict handling. |
| Shell/common/auth/theme | 12 | 303 | 87 | 31 | High user-visible risk; navigation, page theme, login, search, global UI. |
| Page/profile/user-facing | 7 | 93 | 14 | 50 | Medium-high; history/source/comments/profile use direct page/loading/notification commits. |
| Store modules | 6 | 54 | 10 | 1 | Critical foundation; `make.mutations` and `pathify.plugin` define implicit contracts. |

---

## Suspicious or fragile state paths

### `editor/id`

Current source sets `editor/id`, but `client/store/editor.js` does not declare an `id` field in its state.

Implication:

- This may be tolerated today because pathify/Vuex state mutation is dynamic enough not to fail loudly.
- It must be classified before strict typing or store-shape declarations become enforcement.
- Future work should decide whether `editor/id` is:
  - a latent valid field that should be declared,
  - a typo or stale write,
  - or an intentional transient path that needs a compatibility wrapper.

Stop condition:

- Do not add strict editor state typing or replace editor pathify writes until `editor/id` is resolved.

### Nested `@` path syntax

Paths such as `page/effectivePermissions@pages.write` and `page/effectivePermissions@comments` use pathify nested path syntax.

Implication:

- These are not simple slash-delimited module/key paths.
- Future typed accessors must model nested permissions explicitly.
- Do not mechanically replace these strings without tests around permissions display and gating.

### Dynamic commit forms

There are 38 non-static/dynamic commit forms. Current active-source scanning found these are conditional loading commits, not arbitrary dynamic mutation targets.

Implication:

- Broad commit replacement should still preserve this conditional loading pattern deliberately.
- Root UI facade work can start with known static root commits and include a tested wrapper path for the conditional loading pattern.

---

## Recommended future sequencing

### Lane 1: Root UI facade proposal

Scope:

- `loadingStart`
- `loadingStop`
- `showNotification`
- `updateNotificationState`
- `pushGraphError`
- `isLoading`
- root `notification` state

Why first:

- Highest direct commit volume.
- Root-scoped and not dynamically registered.
- Conceptually small: loading and notifications.
- Good candidate for additive helper functions or JSDoc/`.d.ts` declarations before any source migration.

Guardrail:

- Do not remove or rename existing root mutations.
- Do not wire TypeScript into runtime.

### Lane 2: Page state read/write contract

Scope:

- `id`, `locale`, `path`, `title`, `description`, `tags`
- publication fields
- `scriptCss`, `scriptJs`, `mode`, `editor`
- `effectivePermissions`
- `commentsCount`
- `editShortcuts`

Why second:

- `page` has the largest pathified access count: 148.
- It connects editor, theme, permissions, source/history, and public page behavior.

Guardrail:

- Preserve pathify string paths and generated `SET_*` mutations while adding documentation/type contracts.

### Lane 3: Editor state contract after `editor/id` review

Scope:

- `content`, `editorKey`, `editor`, `mode`
- `activeModal`, `activeModalData`
- `media.folderTree`, `media.currentFolderId`, `media.currentFileId`
- `checkoutDateActive`
- custom media mutations

Why third:

- High semantic risk and dynamic registration.
- `editor.vue` alone has the densest store API usage.

Guardrail:

- Resolve `editor/id` first.
- Account for dynamic `registerModule('editor', editorStore)` call sites.

### Lane 4: Site/search state contract

Scope:

- branding/config fields
- theme/runtime fields
- search UI fields

Why fourth:

- Lower count and simpler than page/editor.
- Still globally visible through navigation and theme surfaces.

### Lane 5: User auth/profile state contract

Scope:

- identity/profile fields
- `permissions`
- `authenticated`
- token timestamps
- `REFRESH_AUTH`

Why fifth:

- Smaller pathify count, but security-sensitive.
- Needs careful preservation of JWT cookie decoding and silent failure behavior.

### Lane 6: Dynamic admin state contract

Scope:

- `admin/info.*`
- dynamic admin module registration

Why sixth:

- Smallest state surface.
- Should still preserve registration timing from `client/components/admin.vue`.

---

## Future typed-boundary options

These are future proposals only, not implementation steps in this inventory.

Possible additive artifacts:

1. Store-shape declaration file for documentation/check-only use.
   - Example future path: `client/types/store-shapes.d.ts` or `.hermes/plans` schema tables.
   - Must not be imported by runtime code unless a later approved lane enables it.

2. JSDoc typedefs near helper wrappers.
   - Useful only after deciding whether helper wrappers are allowed.

3. Root UI helper facade.
   - Additive wrappers around commits like `showNotification` and `loadingStart`.
   - Must preserve direct commit compatibility.

4. Page/editor DTO declarations.
   - Could align with REST helper payloads and editor property modal data.

5. Test-only or check-only state path assertions.
   - Useful after store shapes are documented.
   - Must not force runtime migration in the same slice.

---

## Stop conditions for future implementation lanes

Stop and reassess if any future lane requires:

- Replacing `vuex-pathify` in the same slice as adding type declarations.
- Changing module registration timing.
- Removing generated `make.mutations(state)` behavior.
- Renaming or deleting existing mutation names.
- Changing root loading/notification behavior.
- Changing `REFRESH_AUTH` cookie/JWT behavior.
- Touching `.vue` files before an explicit component migration plan.
- Expanding TS-1 include scope without a separate proposal.
- Adding `vue-tsc`, direct `@vue/compiler-sfc`, `ts-loader`, `fork-ts-checker-webpack-plugin`, `ts-jest`, Babel TypeScript transforms, or `@typescript-eslint/*`.
- Starting Pinia/Vuex 4/Vue 3/Vuetify 3/router/build-system migration.
- Treating conditional dynamic loading commits as safe without an explicit wrapper/test plan.
- Treating pathify nested `@` syntax as a simple key path without tests.
- Ignoring `editor/id` mismatch.

---

## Reproducibility commands

Baseline:

```bash
git status --short --branch
node - <<'NODE'
const pkg = require('./package.json')
for (const name of ['vue', 'vue-template-compiler', 'vue-loader', 'vuex', 'vuex-pathify', 'vuetify', 'vue-router', 'webpack', 'typescript']) {
  console.log(`${name}: ${pkg.dependencies?.[name] || pkg.devDependencies?.[name] || 'absent'}`)
}
NODE
corepack yarn typecheck:ts1
```

Store files:

```bash
find client/store -maxdepth 1 -type f -name '*.js' | sort
```

Pathify source scan:

```bash
grep -R "vuex-pathify\|\$store\.get\|\$store\.set\|\$store\.commit\|\$store\.dispatch" client --include='*.vue' --include='*.js'
```

Note: the grep command is a discovery aid, not the final counting method. Final counts in this document filter out commented-out imports/store calls and exclude unrelated component methods named `get()` plus non-pathify `call(...)` usages.

High-churn frontend paths:

```bash
git log --name-only --pretty=format: -- client | sed '/^$/d' | sort | uniq -c | sort -nr
```

Review hygiene for this document:

```bash
git diff --check
git diff --stat
git status --short
```

---

## Recommended next action

Do not start a source migration from this document.

Recommended next planning/implementation-adjacent action:

1. Create a root UI facade proposal that is additive and test-backed.
2. Keep it scoped to loading/notification/root getter behavior.
3. Preserve all existing direct commits.
4. Use tests or static scans to prove the wrapper does not change runtime behavior.

Alternative if staying purely in planning:

- Create a dedicated `editor/id` investigation note before any editor state contract work.
- Create a page state DTO/store-shape declaration proposal.
