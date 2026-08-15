# TS-1 Check-Only TypeScript Tooling Proposal

> **For Hermes:** This is an approval-gated implementation proposal. Do not install TypeScript, change `package.json`, add `tsconfig`, or alter build/test tooling from this document until the TS-1 lane is explicitly approved.

**Goal:** Introduce TypeScript as a non-runtime, advisory check-only tool after TS-0 inventory, without starting Vue 3, SFC conversion, Webpack integration, or CI-blocking type enforcement.

**Architecture:** Keep the current Vue 2.6.14 / Vuetify 2 / Vuex 3 / Webpack 4 application unchanged. TS-1 should prove a narrowly scoped `tsc --noEmit` workflow over selected JavaScript boundary files, while avoiding Vue SFC, Jest, Webpack, Babel, ESLint, and runtime TypeScript integration.

**Tech Stack:** Node >=20, Yarn 1 via Corepack, TypeScript candidate `5.9.3`, Vue 2.6.14, vue-template-compiler 2.6.14, Webpack 4.44.2, Jest 27.5.1, ESLint 7.12.0.

---

## Executive decision requested

Approve or reject a narrow TS-1 check-only tooling lane with these boundaries:

- Add TypeScript as a dev-only tool, not a runtime/build input.
- Add a dedicated check-only TypeScript config scoped to stable JS boundary files.
- Add an advisory script such as `typecheck:ts1`.
- Do not wire typechecking into `test`, `build`, CI, precommit hooks, or release gates in this first slice.
- Do not install `vue-tsc`, `@vue/compiler-sfc`, `ts-loader`, `fork-ts-checker-webpack-plugin`, `ts-jest`, Babel TypeScript transforms, or `@typescript-eslint/*`.
- Do not rename `.js` to `.ts`.
- Do not convert `.vue` SFCs to `<script lang="ts">` or `<script setup>`.
- Do not change Webpack/Jest/Babel/Vue-loader runtime behavior.

Recommended decision: approve only as a small, advisory, non-runtime tooling slice after reviewing the gates below.

---

## Current baseline

Confirmed during TS-0 / TS-1 planning:

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
| `jest` | `27.5.1` |
| `eslint` | `7.12.0` |

Current direct TypeScript-related package state in `package.json`:

- `typescript`: absent
- `vue-tsc`: absent
- `@vue/compiler-sfc`: absent as a direct dependency/devDependency
- `tsconfig*.json`: absent
- first-party `.ts` / `.tsx` files: none

Note: `yarn.lock` already contains transitive `@vue/compiler-sfc` entries through existing tooling. TS-1 must not add `@vue/compiler-sfc` as a direct dependency or start consuming it in repo-local build/test code.

Current scripts:

- `test`: `eslint --format codeframe --ext .js,.vue . && pug-lint server/views && jest`
- `build`: `cross-env NODE_OPTIONS=--openssl-legacy-provider webpack --profile --config dev/webpack/webpack.prod.js`

Current Jest config is inline in `package.json` and intentionally simple:

- `testEnvironment: jsdom`
- `testRunner: jest-jasmine2`
- `transform: {}`
- `setupFiles: test/jest/setup-globals.js`

Current Webpack config is JS/Vue-only:

- entries are `.js`
- `resolve.extensions`: `.js`, `.json`, `.vue`
- no TypeScript loader
- no `ts-jest`
- no Babel TypeScript transform

---

## Why TS-1 should be check-only

TS-0 found major frontend blockers:

- 94 / 94 first-party SFCs use Options API.
- Vuex pathify appears in 33 SFCs with 247 occurrences.
- Vuetify `v-*` template usage appears in 92 / 94 SFCs with 4,957 occurrences.
- `$refs`, filters, and `$root` event-bus coupling are common.

A full TypeScript/Vue conversion would therefore couple several architectural migrations at once. TS-1 should avoid that trap and only establish whether TypeScript can be introduced safely as a standalone check tool.

---

## Package recommendation

### Add: `typescript@5.9.3`

Recommended future command after approval:

```bash
corepack yarn add --dev --exact typescript@5.9.3 --non-interactive
```

Rationale:

- `typescript@5.9.3` is modern and supports Node >=14.17, compatible with this repo's Node >=20 baseline.
- It avoids starting on the fresh TypeScript 6 major line.
- A temporary smoke test showed `typescript@6.0.3` reports deprecation friction around legacy-compatible `moduleResolution: node` / `node10` behavior, which is avoidable in TS-1 by pinning a stable TS 5 release.
- TS-1 does not need Vue template typechecking, so `typescript` alone is enough for the first approved slice.

Metadata checks to rerun before implementation:

```bash
npm view typescript@5.9.3 version engines --json
npm view typescript dist-tags version engines --json
```

Expected installed version check:

```bash
corepack yarn tsc --version
# Expected: Version 5.9.3
```

### Do not add: `vue-tsc`

Current `vue-tsc` latest observed during planning: `3.2.7`.

Risk:

- `vue-tsc@3.2.7` depends on `@vue/language-core@3.2.7` and Vue 3 compiler packages such as `@vue/compiler-dom` / `@vue/shared` 3.x.
- Older `vue-tsc@1.8.27` depends on `@vue/language-core@1.8.27`, which expects `vue-template-compiler ^2.7.14` plus Vue 3 compiler packages.
- This repo is Vue 2.6.14 with `vue-template-compiler@2.6.14`.

Conclusion: `vue-tsc` belongs to a later Vue 2.7/Vue 3/SFC tooling decision, not TS-1.

### Do not add: `@vue/compiler-sfc`

Current facts:

- `@vue/compiler-sfc` latest is Vue 3 line.
- `@vue/compiler-sfc@2.7.16` exists for Vue 2.7.
- `@vue/compiler-sfc@2.6.14` does not exist.
- Current repo already uses the appropriate Vue 2.6 compiler package: `vue-template-compiler@2.6.14`.

Conclusion: do not introduce `@vue/compiler-sfc` while the app remains Vue 2.6.14.

### Do not add: Webpack/Jest/Babel/ESLint TypeScript integrations

Avoid in TS-1:

- `ts-loader`
- `fork-ts-checker-webpack-plugin`
- `ts-jest`
- Babel TypeScript transform / preset
- `@typescript-eslint/parser`
- `@typescript-eslint/eslint-plugin`

Reasons:

- Runtime/build integration is not needed for `tsc --noEmit`.
- Current latest `ts-loader` / `fork-ts-checker` lines target Webpack 5-oriented workflows, while this repo remains on Webpack 4.
- Current `@typescript-eslint/*` requires newer ESLint than repo `eslint@7.12.0`.
- Jest currently has `transform: {}`; do not disturb that stable test harness in TS-1.

---

## Proposed implementation after approval

### Files to modify/create

Modify:

- `package.json`

Create:

- `tsconfig.ts1.json`

No source files should be modified.
No `.js` files should be renamed.
No `.vue` files should be changed.
No Webpack/Jest/Babel/ESLint config should change.

### Proposed package.json changes

Add devDependency:

```json
"typescript": "5.9.3"
```

Add script:

```json
"typecheck:ts1": "tsc -p tsconfig.ts1.json --noEmit --pretty false"
```

Do not change the existing `test` or `build` scripts.

### Proposed `tsconfig.ts1.json`

Recommended starting config:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM"],
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "strict": false,
    "noImplicitAny": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "types": []
  },
  "include": [
    "client/helpers/*-api.js"
  ],
  "exclude": [
    "node_modules",
    "assets",
    "dev",
    "server",
    "test",
    "client/**/*.test.js",
    "client/**/*.vue",
    "client/graph/**/*",
    "client/libs/**/*",
    "client/modules/**/*",
    "client/store/**/*",
    "client/themes/**/*",
    "client/scss/**/*"
  ]
}
```

Why this scope:

- `client/helpers/*-api.js` contains stable REST/API helper boundaries added during consolidation.
- It avoids Vue SFCs, tests, GraphQL loader assets, server code, generated/build output, and store/pathify internals.
- `allowJs: true` lets TypeScript include JS files without forcing conversion.
- `checkJs: false` makes TS-1 an infrastructure baseline rather than a broad JS refactor gate.
- `noEmit: true` ensures TS-1 cannot produce runtime artifacts.
- `types: []` disables automatic ambient `@types/*` discovery so the first advisory check is not blocked by unrelated transitive type packages already present in the dependency tree.

Potential stricter follow-up after the first approved TS-1 slice:

- TS-1B could set `checkJs: true` only for selected helper files if the first check-only setup proves stable.
- TS-2 could introduce declaration files for DTOs and helper payloads.
- SFC/template typechecking remains out of scope until Vue tooling strategy is approved.

---

## Verification plan for future TS-1 implementation

Before changes:

```bash
git status --short --branch
```

Package metadata:

```bash
npm view typescript@5.9.3 version engines --json
npm view vue-tsc@3.2.7 version peerDependencies dependencies --json
npm view @vue/compiler-sfc dist-tags version dependencies --json
```

Install:

```bash
corepack yarn add --dev --exact typescript@5.9.3 --non-interactive
```

TypeScript check:

```bash
corepack yarn typecheck:ts1
```

Expected:

- exit code 0
- no emitted files
- no source file changes

Existing quality gates:

```bash
corepack yarn check --integrity
git diff --check
corepack yarn test
corepack yarn build
```

Diff review:

```bash
git diff -- package.json yarn.lock tsconfig.ts1.json
git diff --name-status
```

Expected changed files only:

- `package.json`
- `yarn.lock`
- `tsconfig.ts1.json`

Stop if any of these appear unexpectedly:

- `.vue` changes
- `.js` source edits
- Webpack config changes
- Jest config changes
- Babel config changes
- ESLint config changes
- runtime `.ts` imports
- new `vue-tsc`, `@vue/compiler-sfc`, `ts-loader`, `ts-jest`, `fork-ts-checker-webpack-plugin`, or `@typescript-eslint/*` dependencies

---

## Risks and mitigations

### Risk: TS-1 creates false confidence

Mitigation:

- Name the script `typecheck:ts1`, not a broad `typecheck`, unless explicitly desired.
- Document that TS-1 does not check Vue templates or the full JS app.
- Keep the include set narrow and explicit.

### Risk: TypeScript config becomes a stealth build change

Mitigation:

- Do not change Webpack, Babel, Jest, Vue-loader, or runtime resolve extensions.
- Use `noEmit: true`.
- Do not import `.ts` files from runtime code.

### Risk: TypeScript 6 churn

Mitigation:

- Pin `typescript@5.9.3` exactly for TS-1.
- Revisit TypeScript 6 only after the app has a working check-only baseline.

### Risk: Ambient type packages block an intentionally narrow check

Mitigation:

- Set `types: []` in `tsconfig.ts1.json`.
- Add explicit `types` entries only in later lanes that deliberately introduce Node, Jest, or browser type surfaces.

### Risk: Vue SFC tooling mismatch

Mitigation:

- Exclude `.vue` files.
- Do not add `vue-tsc` or `@vue/compiler-sfc` while the app remains on Vue 2.6.14.

### Risk: ESLint/Jest typing scope explosion

Mitigation:

- Do not add `@typescript-eslint/*` in TS-1.
- Exclude tests in TS-1.
- Do not add Jest type packages unless a later test-typing lane is approved.

---

## Recommended next steps after TS-1 approval

1. Implement the exact TS-1 slice above.
2. If TS-1 passes, add a TS-1B proposal to enable `checkJs: true` for a very small helper subset.
3. Add a typed DTO boundary proposal for REST helper payload/response shapes.
4. Keep Vue SFC conversion, Vuex/pathify rewrite, Vuetify migration, and Vue 3 tooling as separate architecture lanes.

---

## Stop conditions

Stop and reassess before implementation if:

- the install wants to update Vue, Webpack, Jest, Babel, ESLint, or GraphQL packages
- `typescript@5.9.3` is unavailable or has changed metadata unexpectedly
- `tsc --noEmit` requires runtime config changes to pass
- TypeScript setup requires `.vue`, Jest, Webpack, Babel, or ESLint integration
- the proposed include set is too narrow to be meaningful or too broad to pass without source churn
- the slice cannot pass `corepack yarn test` and `corepack yarn build`
