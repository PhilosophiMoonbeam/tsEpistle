# Root UI Facade Proposal

> **For Hermes:** This is an approval-gated implementation proposal. Do not create helper files, edit Vue/Vuex source, migrate component commits, change package/tooling config, or expand TypeScript scope from this document until the root UI facade lane is explicitly approved.

**Goal:** Add a tiny, tested, additive helper facade around existing root Vuex loading/notification behavior so future frontend migration work can replace repeated raw commit strings safely and incrementally.

**Architecture:** Preserve the current Vue 2.6.14 / Vuex 3.5.1 / vuex-pathify 1.4.5 runtime. The first approved slice should add CommonJS helper wrappers and tests only; it must delegate to existing root mutations/getters without renaming, removing, or changing root store behavior.

**Tech Stack:** Vue 2.6.14, Vuex 3.5.1, vuex-pathify 1.4.5, Webpack 4.44.2, Jest 27.5.1 with `transform: {}`, TypeScript 5.9.3 check-only TS-1 baseline.

---

## Executive decision requested

Approve or reject a narrow root UI facade implementation lane with these boundaries:

- Add an additive helper module for root UI store operations.
- Add focused unit tests for the helper module.
- Do not migrate existing SFC call sites in the first slice.
- Do not remove or rename existing root Vuex mutations/getters.
- Do not change `client/store/index.js` behavior in the first slice.
- Do not expand TS-1 typechecking scope.
- Do not introduce runtime TypeScript imports.
- Do not touch Vuex/pathify module registration, generated `make.mutations(state)` behavior, Vue SFCs, Webpack, Jest, Babel, ESLint, or CI.

Recommended decision: approve only as a small, additive, test-backed helper slice after reviewing the stop conditions and implementation steps below.

---

## Why this is the next safe lane

The verified Vuex pathify/state-boundary inventory found that root loading/notification commits are both high-volume and lower conceptual risk than page/editor state typing:

| Surface | Active count | Notes |
| --- | ---: | --- |
| `showNotification` static commits | 163 | Primary global notification path. |
| `loadingStart` static commits | 80 | Root loading stack start. |
| `loadingStop` static commits | 79 | Root loading stack stop. |
| `pushGraphError` static commits | 58 | GraphQL error notification bridge. |
| Conditional dynamic loading commits | 38 | ``this.$store.commit(`loading${isLoading ? 'Start' : 'Stop'}`, key)``. |
| `updateNotificationState` direct commits | 0 | Mutation exists; notification UI mostly uses pathify sync. |
| `this.$store.dispatch(...)` | 0 | No action surface to wrap. |

Root UI is a good first facade because:

1. It is root-scoped, not dynamically registered.
2. It avoids the unresolved `editor/id` mismatch.
3. It avoids the high-risk page/editor pathify contract.
4. It does not require Vuex/pathify removal.
5. It can be covered with pure Jest tests without Webpack, Vue SFC compilation, or Jest transform changes.
6. It creates a stable target for future opportunistic call-site migrations.

---

## Current root store behavior to preserve

File: `client/store/index.js`

Current root state:

```js
const state = {
  loadingStack: [],
  notification: {
    message: '',
    style: 'primary',
    icon: 'cached',
    isActive: false
  }
}
```

Current getter:

```js
isLoading: state => { return state.loadingStack.length > 0 }
```

Current root mutations:

```js
loadingStart (st, stackName) {
  st.loadingStack = _.union(st.loadingStack, [stackName])
}

loadingStop (st, stackName) {
  st.loadingStack = _.without(st.loadingStack, stackName)
}

showNotification (st, opts) {
  st.notification = _.defaults(opts, {
    message: '',
    style: 'primary',
    icon: 'cached',
    isActive: true
  })
}

updateNotificationState (st, newState) {
  st.notification.isActive = newState
}

pushGraphError (st, err) {
  WIKI.$store.commit('showNotification', {
    style: 'red',
    message: _.get(err, 'graphQLErrors[0].message', err.message),
    icon: 'alert'
  })
}
```

Behavioral details that must stay unchanged:

- `loadingStart` deduplicates repeated stack names via `_.union`.
- `loadingStop` removes all matching stack-name entries via `_.without` and tolerates missing names.
- `isLoading` is true when `loadingStack.length > 0`.
- `showNotification` applies defaults in the mutation, not in the facade.
- `showNotification` currently uses `_.defaults(opts, defaults)`, so the payload object is part of current mutation semantics.
- `updateNotificationState` only changes `notification.isActive`.
- `pushGraphError` prefers `graphQLErrors[0].message` and falls back to `err.message`.
- `pushGraphError` currently commits through global `WIKI.$store` from inside the mutation.
- `client/components/common/notify.vue` currently uses pathify `get('notification')` and `sync('notification@isActive')`; do not migrate it in the first slice.

---

## Proposed implementation after approval

### Files to create

Create:

- `client/helpers/root-ui-store.js`
- `client/helpers/root-ui-store.test.js`

Do not modify in the first slice:

- `client/store/index.js`
- `.vue` files
- `package.json`
- `yarn.lock`
- `tsconfig.ts1.json`
- Webpack/Jest/Babel/ESLint/Vue-loader config
- CI/release/precommit scripts

### Proposed helper API

Use CommonJS because current Jest config has `transform: {}` and existing helper tests already run without Babel transform.

Proposed `client/helpers/root-ui-store.js`:

```js
function loadingStart (store, stackName) {
  store.commit('loadingStart', stackName)
}

function loadingStop (store, stackName) {
  store.commit('loadingStop', stackName)
}

function setLoading (store, stackName, isLoading) {
  store.commit(isLoading ? 'loadingStart' : 'loadingStop', stackName)
}

function showNotification (store, opts) {
  store.commit('showNotification', opts)
}

function updateNotificationState (store, isActive) {
  store.commit('updateNotificationState', isActive)
}

function pushGraphError (store, err) {
  store.commit('pushGraphError', err)
}

function isLoading (store) {
  return Boolean(store.getters && store.getters.isLoading)
}

function getNotification (store) {
  return store.state && store.state.notification
}

module.exports = {
  loadingStart,
  loadingStop,
  setLoading,
  showNotification,
  updateNotificationState,
  pushGraphError,
  isLoading,
  getNotification
}
```

Design notes:

- The facade accepts `store` explicitly.
- The facade must not import the global Vuex store.
- The facade must not access `WIKI`.
- The facade must not parse GraphQL errors itself in the first slice.
- The facade must not apply notification defaults itself.
- The facade delegates existing mutation/getter names exactly.
- `setLoading(store, key, isLoading)` exists specifically to replace conditional dynamic loading commits in later migrations.
- `getNotification(store)` is read-only convenience and should not clone, normalize, or mutate state.

---

## Proposed TDD test plan after approval

Create `client/helpers/root-ui-store.test.js` first and run it before creating the helper.

Because this is a new helper, the RED failure should be `Cannot find module './root-ui-store'` or missing exported function, not a syntax/config failure.

### Test file sketch

```js
const rootUiStore = require('./root-ui-store')

describe('root UI store facade', () => {
  const createStore = (overrides = {}) => ({
    commit: jest.fn(),
    getters: {},
    state: {},
    ...overrides
  })

  test('loadingStart commits the existing root mutation', () => {
    const store = createStore()

    rootUiStore.loadingStart(store, 'example')

    expect(store.commit).toHaveBeenCalledWith('loadingStart', 'example')
  })

  test('loadingStop commits the existing root mutation', () => {
    const store = createStore()

    rootUiStore.loadingStop(store, 'example')

    expect(store.commit).toHaveBeenCalledWith('loadingStop', 'example')
  })

  test('setLoading routes true to loadingStart and false to loadingStop', () => {
    const store = createStore()

    rootUiStore.setLoading(store, 'watcher', true)
    rootUiStore.setLoading(store, 'watcher', false)

    expect(store.commit).toHaveBeenNthCalledWith(1, 'loadingStart', 'watcher')
    expect(store.commit).toHaveBeenNthCalledWith(2, 'loadingStop', 'watcher')
  })

  test('showNotification passes the payload through unchanged', () => {
    const store = createStore()
    const payload = { style: 'red', message: 'Failed', icon: 'alert' }

    rootUiStore.showNotification(store, payload)

    expect(store.commit).toHaveBeenCalledWith('showNotification', payload)
  })

  test('updateNotificationState commits active state', () => {
    const store = createStore()

    rootUiStore.updateNotificationState(store, false)
    rootUiStore.updateNotificationState(store, true)

    expect(store.commit).toHaveBeenNthCalledWith(1, 'updateNotificationState', false)
    expect(store.commit).toHaveBeenNthCalledWith(2, 'updateNotificationState', true)
  })

  test('pushGraphError delegates existing mutation behavior', () => {
    const store = createStore()
    const err = new Error('Broken')

    rootUiStore.pushGraphError(store, err)

    expect(store.commit).toHaveBeenCalledWith('pushGraphError', err)
  })

  test('isLoading reads the root getter safely', () => {
    expect(rootUiStore.isLoading(createStore({ getters: { isLoading: true } }))).toBe(true)
    expect(rootUiStore.isLoading(createStore({ getters: { isLoading: false } }))).toBe(false)
    expect(rootUiStore.isLoading(createStore({ getters: {} }))).toBe(false)
    expect(rootUiStore.isLoading(createStore({ getters: null }))).toBe(false)
  })

  test('getNotification returns current notification state', () => {
    const notification = { message: 'Hi', style: 'primary', icon: 'cached', isActive: true }
    const store = createStore({ state: { notification } })

    expect(rootUiStore.getNotification(store)).toBe(notification)
  })
})
```

Do not import `client/store/index.js` in this first helper test because:

- it is an ES module store file,
- it installs Vuex/pathify side effects,
- Jest currently has `transform: {}`,
- importing it would force an unrelated test-tooling/build integration decision.

### Verification commands after approval

Run the RED step first after writing only the test:

```bash
corepack yarn jest client/helpers/root-ui-store.test.js --runInBand
```

Expected RED before helper exists:

- FAIL due missing `./root-ui-store` module or missing exported functions.

Run GREEN after adding the helper:

```bash
corepack yarn jest client/helpers/root-ui-store.test.js --runInBand
```

Expected GREEN:

- `client/helpers/root-ui-store.test.js` passes.

Then run existing gates:

```bash
corepack yarn typecheck:ts1
corepack yarn check --integrity
git diff --check
corepack yarn test
corepack yarn build
```

Expected changed files only in first implementation slice:

- `client/helpers/root-ui-store.js`
- `client/helpers/root-ui-store.test.js`

Expected unchanged files:

- `package.json`
- `yarn.lock`
- `tsconfig.ts1.json`
- `client/store/index.js`
- all `.vue` files
- Webpack/Jest/Babel/ESLint/Vue-loader config

---

## Future migration sequence after facade lands

These are future approved lanes, not part of the first helper slice.

### Phase 1: Facade only

- Add helper and tests.
- No SFC migrations.
- No root store behavior changes.

### Phase 2: Bootstrap/client-app notification pilot

Candidate:

- `client/client-app.js`

Why:

- It already has non-SFC access to `store.commit('showNotification', ...)`.
- It avoids template/pathify complexity.
- It is a reasonable first caller migration after the helper exists.

Guardrail:

- Import the helper in the smallest possible way.
- Preserve current Apollo/network error notification payloads.
- Keep all direct commit paths working.

### Phase 3: Conditional loading pilot

Candidate pattern:

```js
this.$store.commit(`loading${isLoading ? 'Start' : 'Stop'}`, 'some-key')
```

Future replacement pattern:

```js
setLoading(this.$store, 'some-key', isLoading)
```

Start with isolated low-risk screens, not:

- `client/components/editor.vue`
- `client/components/editor/editor-modal-media.vue`
- `client/components/admin/admin-users-edit.vue`
- `client/components/login.vue`
- auth/security-sensitive admin screens

### Phase 4: Opportunistic static commit migrations

When touching files for other approved reasons, migrate repeated root commits to helper calls:

- `loadingStart(this.$store, key)`
- `loadingStop(this.$store, key)`
- `showNotification(this.$store, payload)`
- `pushGraphError(this.$store, err)`

Avoid broad codemods until the pilot phases have passed review.

### Phase 5: Notification/pathify boundary decision

Candidate:

- `client/components/common/notify.vue`

Current behavior:

- `notification: get('notification')`
- `notificationState: sync('notification@isActive')`

Do not migrate this in the first helper slice. It is a pathify boundary decision and should wait until after the helper exists and root behavior is tested.

---

## Stop conditions

Stop and reassess if an implementation lane requires any of the following:

- Editing source files before the helper/test slice is explicitly approved.
- Changing `client/store/index.js` behavior in the first slice.
- Removing, renaming, or changing existing root mutations/getters.
- Removing direct commit compatibility.
- Importing the global store or `WIKI` inside the helper.
- Reimplementing notification defaults or GraphQL error parsing inside the helper.
- Importing `.ts` from runtime code.
- Expanding `tsconfig.ts1.json` include scope.
- Adding `vue-tsc`, direct `@vue/compiler-sfc`, `ts-loader`, `fork-ts-checker-webpack-plugin`, `ts-jest`, Babel TypeScript transforms, or `@typescript-eslint/*`.
- Changing Jest transform/config to test the helper.
- Editing `.vue` files in the first helper slice.
- Touching `client/components/common/notify.vue` before a pathify notification-boundary proposal.
- Starting Vuex/pathify removal, Pinia/Vuex 4 migration, Vue 3/Vuetify 3/router/build-system migration, or SFC conversion.
- Bundling filter, `$refs`, `$root` event-bus, auth/session, page/editor state, or Vuetify changes into this slice.
- Failing `corepack yarn test` or `corepack yarn build` after the helper slice.

---

## Review checklist for future implementation

Before committing the future helper slice, require an independent review to confirm:

- Changed files are exactly `client/helpers/root-ui-store.js` and `client/helpers/root-ui-store.test.js`.
- Helper delegates to existing root mutation/getter names exactly.
- Helper does not import the store, Vue, Vuex, pathify, or `WIKI`.
- Helper does not apply defaults, parse GraphQL errors, or mutate payloads.
- Tests cover static loading commits, conditional loading wrapper, notification payload pass-through, notification state update, pushGraphError delegation, `isLoading`, and notification read access.
- RED/GREEN evidence exists for the new test file.
- `corepack yarn jest client/helpers/root-ui-store.test.js --runInBand` passed.
- `corepack yarn typecheck:ts1` passed.
- `corepack yarn check --integrity` passed.
- `git diff --check` passed.
- `corepack yarn test` passed.
- `corepack yarn build` passed.
- No package, lockfile, config, Vue SFC, root store, or TS scope changes slipped in.

---

## Recommended next step after this proposal

If approved, implement only Phase 1:

1. Write `client/helpers/root-ui-store.test.js` first.
2. Run the targeted Jest command and confirm RED.
3. Add `client/helpers/root-ui-store.js`.
4. Run targeted Jest and confirm GREEN.
5. Run TS-1, integrity, diff, full tests, and build.
6. Run independent review.
7. Commit as a verified helper slice.

Do not migrate call sites until the helper-only slice is committed and reviewed.
