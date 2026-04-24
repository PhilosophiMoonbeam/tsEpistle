# Admin locale bootstrap REST slice plan

> For Hermes: use subagent-driven-development style execution with independent review before commit.

Goal: move the admin locale bootstrap read path off GraphQL onto REST, while also reusing the same locale list helper for the admin navigation locale picker.

Architecture:
- Keep the existing public `GET /_api/locales` list endpoint as the canonical REST source for locale metadata.
- Add a narrow `GET /_api/locales/config` endpoint for locale configuration bootstrap (`locale`, `autoUpdate`, `namespacing`, `namespaces`) with `manage:system` protection.
- Add a small client helper for locale list/config fetches and migrate only bootstrap reads in `admin-locale.vue` and `admin-navigation.vue`. Leave save/download mutations on GraphQL for now.

Tech stack: Express router controllers, current Wiki.js config/model services, Vue 2 admin components, Jest controller/helper tests, full `corepack yarn test` and `corepack yarn build` verification.

Implementation tasks:
1. Extend `server/controllers/api/locales.js` with a protected `GET /config` route that returns the current localization config shape already used by GraphQL.
2. Expand `server/test/controllers/api.locales.test.js` to cover route registration, auth enforcement, and config payload shape.
3. Create `client/helpers/locales-api.js` with validated `fetchLocales(fetchImpl)` and `fetchLocaleConfig(fetchImpl)` helpers plus `client/helpers/locales-api.test.js`.
4. Migrate `client/components/admin/admin-locale.vue` bootstrap reads from repeated Apollo queries to a single REST bootstrap load while preserving existing GraphQL mutations for save/download.
5. Migrate `client/components/admin/admin-navigation.vue` locale list bootstrap from inline GraphQL to the shared REST locale helper only; keep navigation and groups GraphQL as-is.
6. Run targeted tests for locales controller/helper, then full `corepack yarn test`, then `corepack yarn build`.
7. Run independent spec and code-quality reviews; address findings before committing.

Guardrails:
- Do not widen this slice into locale save/download REST mutations.
- Do not change the existing `GET /_api/locales/:code/strings` contract.
- Do not broaden `/_api/locales/config` access beyond `manage:system`.
- Preserve current admin loading/notification behavior as much as practical.
