# Admin users create provider bootstrap REST slice plan

> For Hermes: use subagent-driven-development style execution with independent review before commit.

Goal: move the provider bootstrap in `client/components/admin/admin-users-create.vue` off GraphQL and onto a small admin-scoped REST provider list, while leaving the broader admin users list filter and all user mutations unchanged.

Architecture:
- Add a narrow admin-only auth providers endpoint that preserves the previous create-dialog semantics by returning all configured provider rows needed for admin user creation bootstrap.
- Expose a dedicated admin helper for fetching that provider list, rather than reusing the login-safe enabled-only strategies helper.
- Migrate only the provider dropdown bootstrap in `admin-users-create.vue` from GraphQL `authentication.activeStrategies` to REST.
- Keep `admin-users.vue` provider filter on GraphQL for now because it is a separate parity-sensitive surface.

Tech stack: existing auth REST controller/helper, Vue 2 admin component, Jest/full repo verification, independent review before commit.

Implementation tasks:
1. Replace the GraphQL providers bootstrap in `client/components/admin/admin-users-create.vue` with a REST loader using `fetchAuthStrategies(window.fetch.bind(window), ...)`.
2. Preserve existing UI behavior in the dialog:
   - provider dropdown still uses `key` / `displayName`
   - local/non-local conditional UI stays unchanged
   - user creation mutation remains GraphQL
3. Keep out of scope:
   - `client/components/admin/admin-users.vue`
   - any auth/admin server changes
   - any changes to `users.create` mutation behavior
4. Run targeted/full verification:
   - `corepack yarn test`
   - `corepack yarn build`
5. Run independent spec and code-quality reviews; fix findings before committing.

Guardrails:
- Do not broaden this slice to the admin users list filter.
- Do not add a new backend endpoint unless absolutely necessary.
- Do not change the existing auth helper contract unless required for this component.
