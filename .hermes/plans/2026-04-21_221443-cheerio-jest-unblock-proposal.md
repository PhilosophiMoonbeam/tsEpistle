# Cheerio / Jest unblock proposal

Goal: define the smallest approval-worthy path to safely revisit the deferred Cheerio modernization lane without destabilizing the Wiki.js fork baseline.

Current grounded state
- Branch: `hermes/wiki-consolidation-baseline`
- Landed parser prep:
  - `0e2bc231` `[verified] test: add parser and toc regression coverage`
  - `2fd4f960` `[verified] chore: stabilize yaml parser helpers batch 3C1`
- Current safe parser stack:
  - `js-yaml` 4.1.1
  - `cheerio` 1.0.0-rc.5
- Current test stack:
  - `jest` 26.6.1
  - `babel-jest` 26.6.1
  - minimal inline Jest config only

What was proven
1. `cheerio@1.2.0` is not blocked by app runtime Node support here.
   - Repo engine is `node >=20`
   - local runtime is Node 22.19.0

2. The actual blocker is the current Jest 26 resolver/runtime.
   - `cheerio@1.2.0` pulls code that imports `node:stream`
   - Jest 26 in this repo fails to resolve `node:` builtins correctly
   - a plain `^node:(.+)$ -> $1` mapper is not sufficient

3. Jest 27 resolves this class of issue.
   - independent subagent verification showed Jest 27.5.1 handles `node:` builtins correctly
   - repo-local test surface is small and simple enough that a focused Jest-only modernization appears relatively self-contained

4. Tactical shims are possible but inferior.
   - a narrow Jest 26 shim for `node:stream` could unblock the exact observed failure
   - this would be stopgap debt, not a root-cause fix

Repo-specific blast radius assessment
- Small test corpus: 8 suites / 23 tests
- No snapshots
- No vue-jest / ts-jest / custom transform stack
- No custom resolver today
- Tests are mostly server-side CommonJS unit tests
- This makes a focused Jest modernization materially safer than many other toolchain upgrades in this repo

## Approval-ready options

### Option A — Recommended
Focused Jest modernization before retrying Cheerio.

Proposed change set
- `jest` -> `27.5.1`
- `babel-jest` -> `27.5.1`
- Make config explicit to preserve old behavior:
  - `testEnvironment: 'jsdom'`
  - `testRunner: 'jest-jasmine2'`

Why this is preferred
- fixes the root cause generically for modern packages using `node:` builtins
- avoids accumulating brittle compatibility shims
- keeps scope narrow: test tooling only, no app runtime behavior change intended
- lower risk than jumping to Jest 28/29

Verification plan
1. Upgrade only Jest-related packages
2. Run targeted parser tests
3. Run full `corepack yarn test`
4. Run full `corepack yarn build`
5. If green, retry isolated Cheerio bump with current regression tests

Expected follow-up if approved
- create a dedicated verified commit for Jest modernization
- then attempt isolated Cheerio retry as a separate verified commit

### Option B — Tactical stopgap
Keep Jest 26 and add a very narrow Jest-only shim for `node:stream`.

Why not preferred
- only addresses the currently observed builtin import
- future dependencies may hit `node:fs`, `node:buffer`, etc.
- increases local test-only maintenance burden
- not a real modernization step

Use only if
- the team wants the smallest immediate unblock and explicitly accepts short-term shim debt

### Option C — Defer Cheerio and pivot elsewhere
Do not touch the test stack or Cheerio now. Treat Cheerio modernization as dependent on later approved tooling work.

Why this may be reasonable
- current baseline is stable
- `js-yaml` half of the parser lane is already complete
- avoids mixing parser work with test tooling changes right now

Downside
- leaves a known modernization blocker unresolved
- postpones the riskiest DOM helper refresh indefinitely

## Recommendation
Approve Option A.

Rationale
- smallest change that fixes the actual blocker
- evidence-backed
- contained blast radius in this repo
- preserves the project’s stability-first guardrails better than a shim or a broad tooling migration

## Proposed execution sequence if approved
1. Isolated Jest modernization branch work
   - bump `jest` and `babel-jest` to 27.5.1
   - pin `testEnvironment` and `testRunner`
   - run full verification
2. Isolated Cheerio retry
   - bump `cheerio` to 1.2.0
   - run targeted parser/render tests
   - run full verification
3. Reassess whether additional DOM/render regression coverage is still needed before any further parser lane work

## Stop conditions
Stop and escalate if any of these occur during execution:
- Jest upgrade causes non-trivial config/transform cascade beyond test environment/runner adjustments
- full suite regresses outside the known `node:` resolver issue
- Cheerio 1.2.0 still changes HTML transform behavior despite the tooling fix
- build pipeline starts depending on wider Babel/Jest coordination changes
