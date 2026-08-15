# TS-0 Frontend Migration Inventory

> **For Hermes:** This is a planning/inventory artifact only. Do not start TypeScript tooling installation, Vue/Vuetify/router/state modernization, or SFC conversion from this document without a separately approved implementation lane.

**Goal:** Capture the current Vue 2 frontend migration surface so a future TypeScript/Vue 3.5 lane can be scoped around real blockers instead of assumptions.

**Architecture:** Keep the current Vue 2.6.14 / Vuetify 2 / Vuex 3 / Webpack 4 application unchanged. This inventory classifies first-party Vue SFCs, identifies migration blockers, and highlights stable boundary modules that are good candidates for future type-first work.

**Tech Stack:** Vue 2.6.14, vue-template-compiler 2.6.14, vue-loader 15.9.8, Vuex 3.5.1, vuex-pathify 1.4.5, Vuetify 2.3.15, Vue Router 3.4.7, Webpack 4.44.2.

---

## Executive summary

The frontend is not ready for a broad TypeScript or Vue 3 conversion as a dependency-cleanup task.

The safe next frontend architecture move is still planning and boundary preparation, not source conversion:

1. Keep Vue 2.6.14 / Vuetify 2 / Webpack 4 stable for the current modernization baseline.
2. Do not mass-convert SFCs to `<script lang="ts">` or `<script setup>` yet.
3. Treat Vuex pathify, Vuetify 2, `$root` event-bus coupling, `$refs`, filters, and universal Options API usage as the primary blockers.
4. Prefer future type-first work around stable API/config/page metadata boundaries before component conversion.

This document implements the TS-0 inventory/risk-mapping step described in:

- `docs/.planning/2026-04-25_151415-typescript-vue35-migration-planning-addendum.md`

---

## Baseline dependency state

Confirmed from `package.json` during this inventory:

| Package | Current |
| --- | ---: |
| `vue` | `2.6.14` |
| `vue-template-compiler` | `2.6.14` |
| `vue-loader` | `15.9.8` |
| `vuex` | `3.5.1` |
| `vuex-pathify` | `1.4.5` |
| `vuetify` | `2.3.15` |
| `vue-router` | `3.4.7` |

This confirms the inventory targets a Vue 2 / Vuetify 2 / Vuex 3 / Webpack-era application.

---

## Vue SFC inventory

Raw `.vue` files in the repository:

- 122 total `.vue` files
- 94 first-party client SFCs under `client/`
- 28 vendored/example SFCs under `node_modules/`, ignored for migration planning

First-party split:

- `client/components`: 90 SFCs
- `client/themes`: 4 SFCs

### First-party SFC classification

| Subsystem | Count | Scope |
| --- | ---: | --- |
| Admin screens | 45 | `client/components/admin.vue`, `client/components/admin/*.vue` |
| Editor components | 17 | `client/components/editor.vue`, `client/components/editor/**/*.vue` |
| Setup/login/profile screens | 10 | `login.vue`, `register.vue`, `setup.vue`, `profile.vue`, `profile/*.vue`, `welcome.vue`, `unauthorized.vue`, `not-found.vue` |
| Common components | 13 | `client/components/common/*.vue` |
| Theme/public/page components | 4 | `client/themes/default/components/*.vue` |
| Other app screens | 5 | `comments.vue`, `history.vue`, `new-page.vue`, `source.vue`, `tags.vue` |

Helpers/store/router have no SFCs, but relevant JavaScript modules exist under:

- `client/store/`
- `client/helpers/`
- `client/modules/`
- `client/client-app.js`
- `client/client-setup.js`

---

## Migration blocker summary

Scanned 94 first-party client SFCs.

| Blocker category | SFC files | Occurrences | Notes |
| --- | ---: | ---: | --- |
| Options API `export default` | 94 | 94 | Universal across first-party SFCs. |
| Vuex pathify helpers | 33 | 247 | Broadest state-typing blocker after Options API. |
| Vuetify `v-*` component usage | 92 | 4,957 | Pug-style `v-*` template token scan; makes UI migration a major, separate lane. |
| `$refs` | 24 | 77 | Requires explicit DOM/component ref typing and runtime review. |
| Vue filters / likely template filter pipes | 24 | 46 | Vue 3 removes filters; needs helper/computed replacement strategy. |
| `$root` / global event-bus style usage | 15 | 51 | Concentrated in editor/theme/navigation code. |
| `mixins` option in SFCs | 0 | 0 | No SFC-local mixin usage found. |
| Global mixin registration | 1 JS file | 1 | `client/client-app.js` has the global pattern. |

### Interpretation

Primary blockers:

1. Options API is universal across all first-party SFCs.
2. Vuex pathify is the largest typing/state blocker.
3. Vuetify 2 is near-universal in the SFC layer, with Pug-style `v-*` component usage in 92 of 94 first-party SFCs, so UI migration cannot be mechanical.
4. `$root` event-bus coupling is smaller but high-risk because it sits in editor/theme/navigation surfaces.
5. `$refs` is common enough to require explicit migration patterns.
6. Filters need a dedicated replacement plan before Vue 3.
7. Mixins are not a major SFC-local blocker, but global bootstrap behavior still needs review.

---

## Files with notable blocker concentrations

### Filter / template-pipe candidates

Filters or likely template filter pipes appear in 24 SFCs, including:

- `client/components/history.vue`
- `client/components/tags.vue`
- `client/components/source.vue`
- `client/components/comments.vue`
- `client/themes/default/components/page.vue`
- `client/components/common/user-search.vue`
- `client/components/profile/profile.vue`
- `client/components/profile/pages.vue`
- `client/components/admin/admin-contribute.vue`
- `client/components/admin/admin-tags.vue`
- `client/components/admin/admin-pages.vue`
- `client/components/admin/admin-users-edit.vue`
- `client/components/admin/admin-system.vue`
- `client/components/admin/admin-ssl.vue`
- `client/components/admin/admin-users.vue`
- `client/components/admin/admin-api.vue`
- `client/components/admin/admin-groups.vue`
- `client/components/admin/admin-dashboard.vue`
- `client/components/admin/admin-pages-edit.vue`
- `client/components/editor/editor-modal-media.vue`
- `client/components/editor/editor-modal-conflict.vue`
- `client/components/editor/ckeditor/conflict.vue`

### `$root` / event-bus candidates

`$root` / event-bus style usage appears in 15 SFCs:

- `client/components/editor.vue`
- `client/themes/default/components/page.vue`
- `client/components/common/search-results.vue`
- `client/components/common/nav-header.vue`
- `client/components/admin/admin-security.vue`
- `client/components/admin/admin-general.vue`
- `client/components/editor/editor-ckeditor.vue`
- `client/components/editor/editor-asciidoc.vue`
- `client/components/editor/editor-code.vue`
- `client/components/editor/editor-markdown.vue`
- `client/components/editor/editor-modal-drawio.vue`
- `client/components/editor/editor-api.vue`
- `client/components/editor/editor-modal-media.vue`
- `client/components/editor/editor-modal-conflict.vue`
- `client/components/editor/ckeditor/conflict.vue`

### Highest `$refs` counts

- `client/components/editor/editor-markdown.vue`: 12
- `client/themes/default/components/tabset.vue`: 10
- `client/components/login.vue`: 9
- `client/components/register.vue`: 5
- `client/components/editor/editor-modal-properties.vue`: 5
- `client/components/editor/editor-modal-media.vue`: 5
- `client/components/admin/admin-pages-visualize.vue`: 5

### Highest Vuex pathify concentration

- `client/components/editor.vue`: 64
- `client/components/common/nav-header.vue`: 25
- `client/components/editor/editor-modal-properties.vue`: 14
- `client/themes/default/components/page.vue`: 13
- `client/components/editor/editor-markdown.vue`: 10
- `client/components/editor/editor-modal-conflict.vue`: 10
- `client/components/editor/editor-asciidoc.vue`: 9
- `client/components/editor/editor-modal-media.vue`: 8

### Highest Vuetify component usage

Pug-style `v-*` component usage appears in 92 of 94 first-party SFCs. Highest counts:

- `client/components/admin/admin-users-edit.vue`: 240
- `client/components/common/nav-header.vue`: 198
- `client/components/profile/profile.vue`: 184
- `client/components/editor/markdown/help.vue`: 181
- `client/components/admin/admin-navigation.vue`: 178
- `client/themes/default/components/page.vue`: 164
- `client/components/editor/editor-api.vue`: 152
- `client/components/editor/editor-markdown.vue`: 148
- `client/components/admin.vue`: 144
- `client/components/editor/editor-modal-media.vue`: 136
- `client/components/admin/admin-pages-edit.vue`: 136
- `client/components/admin/admin-storage.vue`: 126
- `client/components/admin/admin-contribute.vue`: 117
- `client/components/editor/editor-asciidoc.vue`: 110
- `client/components/admin/admin-utilities-importv1.vue`: 103

---

## High-churn frontend files with blocker hits

Based on full git history path frequency plus blocker matches:

| Changes | File | Blockers |
| ---: | --- | --- |
| 84 | `client/themes/default/components/page.vue` | filters, `$root`/events, `$refs`, pathify, Vuetify, Options API |
| 79 | `client/components/common/nav-header.vue` | `$root`/events, `$refs`, pathify, Vuetify, Options API |
| 73 | `client/components/editor.vue` | `$root`/events, pathify, Vuetify, Options API |
| 70 | `client/components/editor/editor-markdown.vue` | `$root`/events, `$refs`, pathify, Vuetify, Options API |
| 70 | `client/components/admin.vue` | pathify, Vuetify, Options API |
| 53 | `client/components/login.vue` | `$refs`, pathify, Vuetify, Options API |
| 51 | `client/components/admin/admin-auth.vue` | filters, Vuetify, Options API |
| 47 | `client/components/admin/admin-general.vue` | `$root`/events, pathify, Vuetify, Options API |
| 38 | `client/components/admin/admin-storage.vue` | filters, Vuetify, Options API |
| 37 | `client/components/editor/editor-modal-properties.vue` | `$refs`, pathify, Vuetify, Options API |
| 37 | `client/components/admin/admin-locale.vue` | Vuetify, Options API |
| 37 | `client/client-app.js` | global mixin, pathify |
| 36 | `client/components/admin/admin-dashboard.vue` | filters, pathify, Vuetify, Options API |
| 35 | `client/components/admin/admin-theme.vue` | pathify, Vuetify, Options API |
| 32 | `client/components/admin/admin-navigation.vue` | Vuetify, Options API |
| 31 | `client/components/editor/editor-modal-media.vue` | filters, `$root`/events, `$refs`, pathify, Vuetify, Options API |

Priority high-risk/high-churn cluster:

1. `client/themes/default/components/page.vue`
2. `client/components/common/nav-header.vue`
3. `client/components/editor.vue`
4. `client/components/editor/editor-markdown.vue`
5. `client/components/admin.vue`
6. `client/components/login.vue`
7. `client/client-app.js`
8. `client/components/editor/editor-modal-media.vue`

---

## Suggested typed-first boundary candidates

Good future TS-1 / TS-2 candidates before SFC conversion:

- Store/module shape declarations around `client/store/*.js`
- API payload and response shapes used by `client/helpers/*-api.js`
- Auth/session/bootstrap DTOs around:
  - `client/modules/boot.js`
  - `client/client-app.js`
  - `client/client-setup.js`
- Page metadata/editor property structures used by:
  - `client/components/editor.vue`
  - `client/components/editor/editor-modal-properties.vue`
  - `client/themes/default/components/page.vue`
- Admin module config schemas used by admin screens

Avoid first:

- Mass converting SFCs to `<script lang="ts">`
- Rewriting Vuex pathify, Vuetify, router, or event bus without a dedicated Vue 3 architecture lane
- Runtime `.ts` imports before build/test tooling supports them
- Installing `typescript`, `vue-tsc`, or `@vue/compiler-sfc` as part of this TS-0 inventory

---

## Recommended next planning steps

1. Add a TS-1 check-only tooling proposal.
   - Scope: `typescript` only, conservative `tsconfig.json`, `allowJs: true`, `checkJs: false`, `noEmit: true`, non-blocking or advisory script.
   - Do not include `vue-tsc` or SFC type-checking until the Vue 3 tooling strategy is approved.

2. Add a pathify/state-boundary inventory.
   - Scope: `client/store/*.js`, pathify imports/helpers, store module names, and SFC state access patterns.
   - Goal: prepare typed DTO/store-shape declarations without changing runtime state.

3. Add a filter replacement plan.
   - Scope: the 24 filter-using SFCs above.
   - Goal: define helper/computed replacement pattern for Vue 3 without converting components yet.

4. Add an event-bus isolation plan.
   - Scope: the 15 `$root`/event-bus SFCs above and bootstrap event registration.
   - Goal: make a future typed event contract possible without changing UX.

5. Keep framework upgrades gated.
   - Vue 2.6 -> Vue 2.7/Vue 3, Vuetify 2 -> 3, Vue Router, Vuex/Pinia, Webpack/Vite, and SFC TypeScript conversion remain separate approval-gated architecture campaigns.

---

## Reproducibility notes

Representative commands used to build this inventory:

```bash
# Count and classify first-party SFCs
python3 - <<'PY'
from pathlib import Path
root = Path('/home/bbferko/dev/wiki')
all_vue = sorted(root.rglob('*.vue'))
client_vue = sorted((root / 'client').rglob('*.vue'))
print('all vue', len(all_vue))
print('client vue', len(client_vue))
PY

# Confirm baseline versions
node - <<'NODE'
const pkg = require('/home/bbferko/dev/wiki/package.json')
for (const name of ['vue', 'vue-template-compiler', 'vue-loader', 'vuex', 'vuex-pathify', 'vuetify', 'vue-router']) {
  console.log(`${name}: ${pkg.dependencies?.[name] || pkg.devDependencies?.[name]}`)
}
NODE

# High-churn path list
cd /home/bbferko/dev/wiki
git log --name-only --pretty=format: -- client | sed '/^$/d' | sort | uniq -c | sort -nr
```

Detailed regex scans used local Python scripts over:

- `/home/bbferko/dev/wiki/client/**/*.vue`
- `/home/bbferko/dev/wiki/client/**/*.js`

with patterns for:

- `export default`
- `filters:` and template pipe candidates
- `mixins:`
- `$root` / `$emit` / `$on` / `$off`
- `$refs`
- `vuex-pathify`, `sync`, `call`, `get`, `dispatch`, `commit`
- Vuetify `v-*` component tags

---

## Stop conditions

Stop and write a separate implementation plan before any action that would:

- install TypeScript tooling
- add or change build scripts
- add `.ts` source files imported at runtime
- convert Vue SFCs to TypeScript
- alter Vuex/pathify runtime behavior
- replace Vuetify components
- replace `$root` event behavior
- remove filters from live components
- change router/state/auth/session behavior
