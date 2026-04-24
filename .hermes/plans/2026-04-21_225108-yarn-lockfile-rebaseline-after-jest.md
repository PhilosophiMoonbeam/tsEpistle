# Yarn lockfile rebaseline after Jest modernization

Goal: unblock further dependency work after the focused Jest modernization by restoring a coherent Yarn v1 dependency state.

Current grounded state
- Landed:
  - `b18c37dd` `[verified] chore: modernize jest tooling baseline`
- Current repo behavior:
  - `corepack yarn test` passes
  - `corepack yarn build` passes
- Current blocker:
  - `corepack yarn add ...` and `corepack yarn install` fail with
    - `could not find a copy of semver to link in node_modules/@vue/babel-preset-app/node_modules/@babel/core/node_modules`

Root-cause finding
- Independent diagnosis indicates this is not primarily a node_modules contamination issue.
- The most plausible cause is package.json / yarn.lock skew after the Jest+Babel changes, specifically around the direct `@babel/core` bump.
- Fresh lock generation in a temp copy succeeds.
- Old lock + reverted `@babel/core` range also succeeds.
- Therefore the clean fix is a dedicated Yarn lockfile rebaseline.

Recommended next execution lane
1. Remove `node_modules`
2. Regenerate `yarn.lock` with current package.json using `corepack yarn install`
3. Re-run:
   - `corepack yarn test`
   - `corepack yarn build`
4. Review the lockfile diff separately
5. Commit as an isolated infrastructure/dependency-state baseline commit
6. Only after that, retry the isolated `cheerio@1.2.0` bump

Why separate this from Cheerio
- The lockfile refresh is likely to be noisy because the repo uses many caret ranges.
- Mixing lockfile rebaseline and Cheerio upgrade would hide causality.
- A dedicated baseline commit preserves debuggability and rollback safety.

Stop conditions
- If fresh `corepack yarn install` introduces broad runtime regressions in test/build
- If the regenerated lockfile pulls in unexpected major shifts outside the intended Jest/Babel surface
- If further dependency churn appears unrelated to the Jest modernization and suggests deeper package-manager instability

Recommendation
- Treat this as the next approval-required infrastructure step before any further dependency bumping.
- After a successful lockfile rebaseline, retry the Cheerio modernization as a separate isolated verified batch.
