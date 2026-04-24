# Campaign 6: Frontend framework and bundler future-state planning memo

> For Hermes: planning only. Do not execute migrations from this memo without explicit approval.

Goal: define the long-term frontend modernization direction instead of letting dependency drift force an accidental migration path.

Grounded current frontend architecture from repo inspection:
- `client/client-app.js`
  - boots Vue 2 app
  - uses `VueRouter`, `VueApollo`, `Vuetify`, `Vuescroll`, `VueMoment`, `VueClipboards`
  - configures Apollo client with HTTP batching + websocket subscriptions
  - registers many async components
- `client/store/index.js`
  - Vuex 3 store with `vuex-pathify`
- dynamic theme loading from `client/index-app.js`
- server-rendered Pug templates emitted by webpack into `server/views/*.pug`
- extensive theme styling in `client/themes/default/scss/app.scss`
- key user-facing surfaces include admin, editor, page rendering, history, source, profile, tags, login

---

## Major future-state decisions required

1. Vue 2.6 -> Vue 2.7 bridge or direct Vue 3?
2. Vuetify 2 end-state: bridge, replace, or redesign?
3. Vuex path: keep Vuex through migration, or move to Pinia later?
4. Bundler path: stay on webpack longer, or plan a Vite migration?
5. How to preserve SSR/server-view emission and theme loading during migration?

---

## Grounded frontend complexity hotspots

### 1. App boot and provider composition are centralized in `client/client-app.js`
This file couples together:
- Vue app boot
- Apollo client setup
- websocket subscriptions
- cookies/auth handling
- Vuetify initialization
- theme/dark mode setup
- async component registration

This is a high-centrality migration file.

### 2. Theme and server-view coupling are strong
Current system relies on:
- webpack emitting Pug templates into `server/views/`
- dynamic theme imports from `client/index-app.js`
- extensive default theme SCSS under `client/themes/default/scss/app.scss`

That means a future bundler migration is not just a JS build swap.

### 3. Editor/admin surfaces are large and stateful
Large migration surfaces include:
- `client/components/editor.vue`
- `client/components/admin.vue`
- many admin/editor subcomponents
- upload/editor/history/source flows

### 4. Store and routing are legacy Vue 2 idioms
Current app uses:
- Vuex 3
- vuex-pathify
- Vue Router 3
- global component registration patterns

These require deliberate migration decisions, not patchwork changes.

---

## Questions this memo must answer

1. Is a Vue 2.7 bridge release worth doing to reduce migration risk?
2. Which parts of the UI can remain on the current stack longest?
3. Which parts should migrate first if Vue 3 is chosen?
4. Can theme emission to server views be preserved during a bundler migration?
5. Should GraphQL/server modernization happen before or after frontend migration?

---

## Suggested discovery tasks for this memo

### Task 6.1: inventory bootstrapping and global plugin usage
Files:
- `client/client-app.js`
- `client/client-setup.js`
- `client/index-app.js`
- `client/store/index.js`

Deliverable:
- boot/plugin dependency map

### Task 6.2: inventory high-cost component domains
Areas:
- editor
- admin
- page/theme rendering
- source/history/profile/tags/login

Deliverable:
- ranked migration difficulty map

### Task 6.3: inventory bundler and server-template coupling
Files:
- `dev/webpack/webpack.dev.js`
- `dev/webpack/webpack.prod.js`
- `dev/templates/*.pug`
- generated `server/views/*.pug`

Deliverable:
- constraints on bundler migration

### Task 6.4: recommend future-state path
Possible options to evaluate:
- Option A: Vue 2.7 bridge + webpack continuation
- Option B: Vue 2.7 bridge + later Vite migration
- Option C: direct Vue 3 migration with phased subsystem rewrite
- Option D: hybrid migration where admin/editor go first

Deliverable:
- recommended option with tradeoffs and milestone branches

---

## Desired final deliverable of Campaign 6
A design memo that answers:
- recommended frontend end-state
- migration order by subsystem
- required prerequisite work from GraphQL/build pipeline campaigns
- bundler strategy
- theme/server-view compatibility strategy
- milestone branch plan

## Recommendation
Do not let remaining dependency drift push the frontend into accidental migration. Produce this memo before any framework-level upgrade is attempted.