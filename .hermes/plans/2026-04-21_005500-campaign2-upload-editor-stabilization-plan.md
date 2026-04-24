# Campaign 2: Active upload and editor UI stabilization plan

> For Hermes: execution only after explicit approval. Use subagent-driven-development if approved.

Goal: modernize the active client-side upload/editor dependencies that touch author workflows while preserving Vue 2, Vuetify 2, Vue Apollo 3, and Webpack 4.

Architecture: keep the current editor/admin UI structure intact. Treat upload, fetch/cookie auth helpers, and syntax highlighting as bounded user-facing surfaces. Execute in small batches with browser-oriented smoke checks after each one.

Tech stack in scope:
- Vue 2 + Vuetify 2
- `vue-filepond` + `filepond`
- `whatwg-fetch`
- `js-cookie`
- `highlight.js`

---

## Grounded code hotspots

Primary upload/editor surface:
- `client/components/editor/editor-modal-media.vue`
  - imports `vue-filepond`
  - imports `filepond/dist/filepond.min.css`
  - creates `const FilePond = vueFilePond()`
  - uses JWT cookie injection for upload process requests
  - contains FilePond-specific styling hooks (`.filepond--root`, etc.)

Browser/auth/fetch path:
- `client/client-app.js`
  - imports `js-cookie`
  - injects JWT into batched GraphQL fetch headers
  - reads refreshed JWT from `new-jwt` response header
  - uses browser `fetch` path directly
- `client/helpers/compatibility.js`
  - requires `whatwg-fetch`
- `client/store/user.js`, `client/components/login.vue`, `client/components/profile/profile.vue`, `client/components/admin/admin-utilities-auth.vue`
  - use `js-cookie`

Highlighting/editor-related surface:
- editor and preview paths under `client/components/editor/**`
- page/source/history rendering surfaces
- any markdown rendering path relying on current syntax highlighting behavior

Related packages still current after safe batches:
- `filepond` 4.21.1
- `vue-filepond` 6.0.3
- `highlight.js` 10.3.1
- `whatwg-fetch` 3.6.2
- `js-cookie` 2.2.1

---

## Recommended batch structure

### Batch 2A: fetch and cookie helpers
- `whatwg-fetch` 3.6.2 -> 3.6.20
- `js-cookie` 2.2.1 -> 3.0.5

Why first:
- narrower than upload UI packages
- easier to validate auth/session interactions before touching FilePond

### Batch 2B: FilePond core only
- `filepond` 4.21.1 -> 4.32.12

Why isolated:
- directly affects upload modal behavior and CSS
- should be validated without also changing wrapper integration

### Batch 2C: syntax highlighting lane
- `highlight.js` 10.3.1 -> 11.11.1

Why isolated:
- can change language registration/markup behavior
- should be evaluated separately from upload changes

### Batch 2D: wrapper update, only if 2B is clean
- `vue-filepond` 6.0.3 -> 7.0.4

Gate for inclusion:
- confirm Vue 2 compatibility from package metadata/changelog
- confirm current usage `vueFilePond()` remains compatible
- if compatibility is ambiguous, defer this batch entirely

---

## Detailed execution steps

## Batch 2A

### Objective
Update browser fetch/cookie helpers without changing GraphQL/Apollo architecture.

### Files likely to matter
- `package.json`
- `yarn.lock`
- `client/client-app.js`
- `client/helpers/compatibility.js`
- cookie-using components/stores under `client/`

### Commands
1. `corepack yarn add js-cookie@3.0.5 whatwg-fetch@3.6.20 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Smoke checks
- login page loads
- successful login still stores/uses JWT
- admin page loads after auth
- GraphQL requests still receive/send JWT header correctly
- refreshed `new-jwt` handling still works

### Review focus
- cookie API compatibility (`Cookies.get`, `Cookies.set` still valid)
- fetch polyfill compatibility with current browserslist/boot path

### Commit message
- `[verified] chore: stabilize upload auth helpers batch 2A`

---

## Batch 2B

### Objective
Update FilePond core while preserving current wrapper and modal behavior.

### Files likely to matter
- `package.json`
- `yarn.lock`
- `client/components/editor/editor-modal-media.vue`

### Commands
1. `corepack yarn add filepond@4.32.12 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Smoke checks
- open media upload modal
- upload a file successfully
- asset appears in list
- insert asset into editor content
- rename asset still works
- delete asset still works
- FilePond CSS still renders correctly

### Review focus
- CSS class stability for local styles in `editor-modal-media.vue`
- upload process config compatibility
- no change in accepted default behavior around upload lifecycle

### Commit message
- `[verified] chore: stabilize upload widget core batch 2B`

---

## Batch 2C

### Objective
Update syntax highlighting while preserving markdown/editor output expectations.

### Files likely to matter
- `package.json`
- `yarn.lock`
- markdown/editor rendering paths under `client/components/editor/`
- any server/client rendering code that references `highlight.js`

### Commands
1. `corepack yarn add highlight.js@11.11.1 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Smoke checks
- render representative fenced code blocks in markdown editor/preview
- verify source/history page still displays code cleanly
- confirm no obvious CSS class or markup regressions on common languages

### Review focus
- language registration/import compatibility
- markup/class output changes that affect theme CSS

### Commit message
- `[verified] chore: stabilize syntax highlighting batch 2C`

---

## Batch 2D

### Objective
Only if safe, update the Vue wrapper around FilePond.

### Preconditions
- Batch 2B clean
- explicit compatibility confirmation with Vue 2

### Commands
1. `corepack yarn add vue-filepond@7.0.4 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Smoke checks
Repeat all upload modal checks from Batch 2B.

### Commit message
- `[verified] chore: stabilize upload wrapper batch 2D`

### Default recommendation
Defer unless compatibility is clearly proven.

---

## Global acceptance criteria
- `corepack yarn test` passes after each batch
- `corepack yarn build` passes after each batch
- upload modal remains functional
- auth/session behavior remains functional
- editor preview still behaves correctly
- independent review passes before commit

## Stop conditions
Stop and reassess if any of these happen:
- login/auth cookie behavior changes unexpectedly
- upload modal breaks visually or functionally
- FilePond wrapper usage stops working
- syntax highlighting output materially changes in common flows
- any batch requires touching unrelated framework/bundler infrastructure

## Suggested next action after Campaign 1
If Campaign 1 finishes cleanly, Campaign 2 is the best next execution lane.