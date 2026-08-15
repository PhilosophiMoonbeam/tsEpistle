# Scarlett Phase One Port Backlog

Goal: exact first-pass port queue for `hermes/wiki-consolidation-baseline`, using only low-risk scarlett-derived work.

Context:
- `origin/scarlett` fully contains `origin/vega` plus 12 additional commits.
- We are explicitly not merging or bulk cherry-picking the branch.
- Phase 0 baseline stabilization is now done on `hermes/wiki-consolidation-baseline` and local `corepack yarn test` / `corepack yarn build` both pass.

---

## Candidate 1: 0385a9b6 `fix: update to working twitch passport strategy (#5279)`

Status after exact diff review:
- Already present on main in practical terms.
- Current `server/modules/authentication/twitch/authentication.js` is identical to the scarlett version.
- `package.json` and `yarn.lock` already carry the same `passport-twitch-strategy` version (`2.2.0`).

Port mode:
- Skip; no action needed.

---

## Candidate 2: 4bfd9f52 `feat(mail): allow setting of mailer identifying name`

Status after exact diff review:
- Already effectively present on main.
- Main already exposes mail config through:
  - `client/components/admin/admin-mail.vue`
  - `server/graph/resolvers/mail.js`
  - `server/graph/schemas/mail.graphql`
- Main already includes the relevant `name` field in the admin form, GraphQL schema, and resolver persistence path.
- The scarlett GraphQL shape is actually older/simpler than main’s current nested `mail` query/mutation structure.

Port mode:
- Skip; no action needed.

---

## Candidate 3: 1eefdb06 `feat(admin): add sitemap option to general page`

Port mode:
- Manual semantic port.

Scarlett source files:
- `server/db/migrations/3.0.0.js`
- `server/graph/schemas/site.graphql`
- `server/models/sites.js`
- `ux/src/pages/AdminGeneral.vue`
- `ux/src/i18n/locales/en.json`
- plus non-functional IDE/icon files not needed on main

Main target files:
- `server/graph/schemas/site.graphql`
- `server/graph/resolvers/site.js`
- `client/components/admin/admin-general.vue`
- locale file(s) actually used by main

Notes:
- Main does not have `server/models/sites.js`; site config flows through `server/graph/resolvers/site.js` and `WIKI.config`.
- This must be mapped onto the current config model, not copied from scarlett literally.
- Need to verify whether main already exposes a sitemap-related config elsewhere before porting.

Checks before landing:
- Search for existing sitemap generation/flags in current main.
- Identify the exact config key shape needed in `WIKI.config` and persistence list in `server/graph/resolvers/site.js`.
- Run:
  - `corepack yarn test`
  - `corepack yarn build`

Likely risk:
- Medium.

---

## Candidate 4: c011d714 `feat(admin): add footerExtra field to admin general`

Port mode:
- Manual semantic port.

Scarlett source files:
- `server/db/migrations/3.0.0.js`
- `server/graph/schemas/site.graphql`
- `server/models/sites.js`
- `ux/src/pages/AdminGeneral.vue`
- `ux/src/pages/AdminLogin.vue`
- `ux/src/i18n/locales/en.json`
- icon asset not needed on main

Main target files:
- `server/graph/schemas/site.graphql`
- `server/graph/resolvers/site.js`
- `client/components/admin/admin-general.vue`
- possibly login-related UI/template file if scarlett surfaces this in login/footer rendering on the legacy main stack
- locale file(s) actually used by main

Notes:
- Main already has `footerOverride`; this commit needs semantic review to determine whether `footerExtra` is additive, redundant, or should be folded into the current footer model.
- Because main lacks `server/models/sites.js`, any persistence wiring must go through `server/graph/resolvers/site.js` and config save lists.

Checks before landing:
- Compare the scarlett behavior against main’s current `footerOverride` feature.
- Decide whether `footerExtra` is worth adding separately or should be skipped as overlapping functionality.
- Run:
  - `corepack yarn test`
  - `corepack yarn build`

Likely risk:
- Medium.

---

## Recommended execution order

1. `1eefdb06` sitemap option
2. `c011d714` footerExtra field, only after confirming it is not redundant with `footerOverride`

Already accounted for on main:
- `0385a9b6` Twitch auth fix
- `4bfd9f52` mailer identifying name

## Recommended skip/until-later items

Do not port yet from scarlett:
- scheduler admin API and worker system
- Fastify / Drizzle / package split work
- REST migration
- broad admin/frontend rewrites
- auth/session refactors tied to backend/frontend architecture changes

## Immediate next task

Perform exact source-vs-target diff review for candidate `0385a9b6` and determine whether it can be cherry-picked cleanly or should be hand-ported in one file.
