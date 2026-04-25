# TypeScript Adoption Addendum for Vue 3.5 Migration

> **For Hermes:** Use this as planning guidance only. Do not start framework-level Vue/Vuetify/router/state modernization without explicit approval. Continue current dependency modernization as isolated verified slices until a dedicated frontend architecture lane is approved.

**Goal:** Define when and how this Wiki.js fork should adopt TypeScript while moving from the current Vue 2.6 / Webpack 4 baseline toward Vue 3.5.x support.

**Current baseline:**

- Vue: `2.6.14`
- `vue-template-compiler`: `2.6.14`
- `vue-loader`: `15.9.8`
- Webpack: `4.44.2`
- TypeScript: absent
- `vue-tsc`: absent
- `@vue/compiler-sfc`: absent

**Official Vue 3 direction:** Vue 3 supports TypeScript in SFCs via `<script lang="ts">` with `defineComponent(...)`, and via `<script setup lang="ts">`. Vue 3's recommended modern SFC authoring path is Composition API plus `<script setup>`, with Volar / Vue Official tooling for IDE and template type support.

---

## Recommendation

Adopt TypeScript deliberately, but not immediately as a full-repo conversion.

The right point to adopt TypeScript is after the current stabilization/dependency-baseline phase is complete, and before the actual Vue 3.5 component migration begins.

Concretely:

1. Do not convert existing Vue 2 components to TypeScript during the current safe dependency campaign.
2. Add a TypeScript readiness lane before Vue 3.5 migration.
3. Start with type-checking infrastructure and type-safe boundaries, not mass `.js` / `.vue` rewrites.
4. Use TypeScript for new or substantially rewritten Vue 3-era frontend modules once the Vue 3 build toolchain is in place.
5. Avoid a big-bang TypeScript conversion of the legacy Vue 2 app.

---

## Decision Gate: When TypeScript Becomes Worth Adopting

TypeScript should become an explicit project goal when all of these are true:

- Historical consolidation work is stable and committed.
- Low-risk dependency modernization has produced a reliable baseline.
- The team is ready to approve a framework/tooling lane involving Vue, Vue loader/compiler, router/state, Vuetify, and build tooling.
- We have chosen the Vue 3 migration strategy:
  - compatibility-build bridge, or
  - parallel Vue 3 shell / island migration, or
  - direct frontend rebuild lane.
- We can afford to add a type-checking job to CI without blocking all unrelated modernization work.

Until then, TypeScript planning should inform API boundaries and future component design, but should not interrupt dependency stabilization.

---

## Phased TypeScript Adoption Plan

### TS-0: Inventory and Risk Mapping

**Objective:** Understand what will be hard to type before changing code.

**Actions:**

- Count Vue SFCs and classify them by subsystem:
  - admin screens,
  - editor components,
  - setup/login/profile screens,
  - common components,
  - helpers/store/router.
- Identify high-churn Vue 3 migration blockers:
  - filters,
  - mixins,
  - global event bus patterns,
  - `$root` / `$refs` heavy usage,
  - implicit Vuex pathify usage,
  - Vuetify 2-only APIs,
  - Options API components with broad `this` coupling.
- Identify stable boundary modules that can be typed first:
  - API helper payloads,
  - REST response DTOs,
  - auth/session client helper shapes,
  - page metadata structures,
  - admin module config schemas.

**Output:** A frontend migration inventory document. No source conversion yet.

---

### TS-1: Add TypeScript Tooling in Check-Only Mode

**Objective:** Introduce TypeScript as a safety net without forcing broad conversion.

**Timing:** After current safe dependency campaigns, before Vue 3 framework migration.

**Likely changes:**

- Add `typescript` as a dev dependency.
- Add a conservative `tsconfig.json`.
- Enable `allowJs: true` and `checkJs: false` initially.
- Use `noEmit: true`.
- Add type roots or local shims only where needed.
- Add a non-blocking or advisory `yarn typecheck` script first.
- Decide deliberately whether TypeScript linting is deferred or introduced only for opted-in typed files in a separate verified slice.

**Important build guardrail:** TS-1 is check-only. Under the current Webpack 4 / Vue 2 setup, `.ts` files are not part of the runtime import graph. Before dedicated TypeScript build integration is approved, prefer `.d.ts`, JSDoc, generated/schema-only types, or `.ts` files used only by `tsc --noEmit`. Runtime imports from `.ts` files must wait until Webpack/Jest/ESLint/build tooling explicitly supports them.

**Do not do yet:**

- Do not rename many files to `.ts`.
- Do not convert SFC scripts wholesale.
- Do not enforce strict mode globally on day one.
- Do not introduce `vue-tsc` until the Vue compiler/toolchain target is clear.

**Success criteria:**

- `corepack yarn test` still passes.
- `corepack yarn build` still passes.
- TypeScript tooling installs without destabilizing Webpack 4 / Vue 2.
- Typecheck command exists but does not become a migration blocker.

---

### TS-2: Type Boundary Modules First

**Objective:** Get real value from TypeScript before touching component internals.

**Preferred first targets:**

- Client API helper request/response shapes.
- Auth bootstrap/session DTOs.
- Admin module config schemas.
- Page metadata and rendering option shapes.
- Utility modules with pure data transformations.

**Why:** These boundaries will survive the Vue 3 migration and reduce risk when components are later rewritten.

**Rules:**

- Convert only narrow modules with clear inputs/outputs.
- Keep JavaScript interop clean.
- Prefer `.d.ts`, JSDoc annotations, schema-derived types, or `.ts` modules used only by `tsc --noEmit` before component rewrites.
- Do not import `.ts` modules from runtime JavaScript/Vue code until a dedicated build/test/lint integration slice supports that import path.
- Commit each slice separately with full verification.

---

### TS-3: Vue 3 Build Toolchain Decision

**Objective:** Decide the frontend target before converting SFCs.

**Open architecture choices:**

- Stay on Webpack and upgrade loader/compiler chain for Vue 3, or
- Move to Vite / modern Vue tooling in a dedicated build-system migration, or
- Use a temporary compatibility lane while preserving production build behavior.

**Coordinated TypeScript tooling decision:** When the Vue 3 path is chosen, select compatible versions for `typescript`, `vue-tsc`, Volar / Vue Official expectations, `@vue/compiler-sfc`, ESLint parser/plugin support, Jest transforms, and any Webpack/Vite TypeScript loader path as one reviewed tooling slice. Do not add a TypeScript version opportunistically if it may later conflict with Vue 3.5 or SFC type-check tooling.

**Decision inputs:**

- Vuetify migration path: Vuetify 2 -> Vuetify 3 is a major UI rewrite risk.
- Router/state migration path: Vue Router 3 -> 4, Vuex 3/4 -> Pinia or Vuex 4.
- Current Webpack asset pipeline complexity.
- Compatibility with existing Pug/Sass/global assets.

**TypeScript implication:** Do not mass-convert SFCs before this decision. The ideal SFC TypeScript shape depends on the compiler/build target.

---

### TS-4: Use TypeScript for Vue 3-Era Components

**Objective:** Adopt TypeScript where it aligns with Vue 3 migration work.

**Default pattern for new/reworked Vue 3 SFCs:**

```vue
<script setup lang="ts">
// Composition API + typed props/emits/composables
</script>
```

**Bridge pattern for Options API components that are not being rewritten yet:**

```vue
<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  // Existing Options API shape, typed incrementally
})
</script>
```

**Policy:**

- New Vue 3-era components should be TypeScript by default.
- Rewritten components should use `<script setup lang="ts">` unless there is a clear migration reason not to.
- Legacy components should remain JavaScript until they are already being touched for Vue 3 compatibility.
- Avoid pure mechanical conversions that produce huge diffs without reducing migration risk.

---

### TS-5: Increase Strictness Gradually

**Objective:** Move from permissive TypeScript to meaningful type safety without blocking delivery.

Suggested order:

1. Typecheck only explicit `.ts` and opted-in SFCs.
2. Enable stricter options for new typed modules.
3. Add typed route names, API clients, and store/composable interfaces.
4. Enable template type checking for migrated Vue 3 SFCs.
5. Ratchet strictness subsystem-by-subsystem.

Avoid enabling global strictness across legacy Vue 2/Options API code before the migration has reduced `this`-based ambiguity.

---

## Planning Goals to Add to the Roadmap

### New Goal: TypeScript Readiness Before Vue 3.5

Before starting a Vue 3.5 implementation lane, complete a TypeScript readiness campaign:

- Add TS check-only infrastructure.
- Define JS/TS interop conventions.
- Type stable API and config boundaries.
- Decide SFC authoring conventions for Vue 3 work.
- Establish a CI typecheck policy that starts advisory and becomes required only for opted-in typed modules.

### New Goal: TypeScript-by-Default for Vue 3-Era Work

Once the Vue 3 build path is chosen:

- New Vue 3 SFCs use `<script setup lang="ts">` by default.
- Reworked Vue 3 SFCs use TypeScript unless there is a clear compatibility reason to defer.
- Pure legacy Vue 2 SFCs stay JavaScript unless already being rewritten.

### New Non-Goal: Big-Bang TypeScript Conversion

Do not schedule a repo-wide JavaScript-to-TypeScript conversion as a prerequisite for Vue 3.5. It will create too much diff churn, obscure framework migration regressions, and slow the current stabilization objective.

---

## Guardrails

- TypeScript adoption must not destabilize the current verified baseline.
- No broad framework dependency bumps without approval.
- No mass file renames in the same commit as framework upgrades.
- No source-wide strictness ratchet until typed boundaries are established.
- Keep Vue 2 compatibility work and Vue 3 TypeScript conversion in separate commits where possible.
- Every TypeScript slice needs the same verification standard as dependency slices:
  - targeted probes/tests,
  - `corepack yarn test`,
  - `corepack yarn build`,
  - typecheck if present,
  - TS linting only when a dedicated ESLint parser/config slice has opted files into lint coverage,
  - `git diff --check`,
  - added-line secret scan,
  - independent review.

---

## Practical Answer

We should adopt TypeScript at the start of the Vue 3 readiness lane, not at the end and not immediately during low-risk dependency stabilization.

The best first TypeScript work is infrastructure plus boundary typing. The best first component-level TypeScript work is on components that are already being rewritten for Vue 3.5. That gives us the safety benefits of TypeScript without paying for a high-risk, low-value mechanical conversion of the existing Vue 2 codebase.
