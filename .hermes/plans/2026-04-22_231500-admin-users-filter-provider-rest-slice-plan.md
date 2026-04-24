# Admin users provider filter REST slice plan

> For Hermes: use subagent-driven-development style execution with independent review before commit.

Goal: move the provider-filter bootstrap in `client/components/admin/admin-users.vue` off GraphQL and onto the existing admin-scoped REST providers endpoint, while preserving disabled-provider visibility for legacy-user management and leaving the paginated users list query on GraphQL.

Architecture:
- Reuse the existing `GET /_api/auth/providers` endpoint and existing `fetchAdminAuthProviders(fetchImpl)` helper.
- Migrate only the provider-filter bootstrap in `admin-users.vue` from GraphQL `authentication.activeStrategies` to REST.
- Preserve current provider filter behavior:
  - include disabled providers
  - prepend synthetic `{ key: 'all', displayName: 'All Providers' }`
  - preserve raw `providerKey` fallback when no label match exists
- Keep the paginated users list GraphQL query unchanged for now.

Tech stack: existing auth REST controller/helper, Vue 2 admin component, Jest/full repo verification, independent review before commit.

Implementation tasks:
1. Replace the GraphQL strategies bootstrap in `client/components/admin/admin-users.vue` with a REST loader using `fetchAdminAuthProviders(window.fetch.bind(window), ...)`.
2. Preserve list/filter behavior:
   - `filterStrategy` semantics stay unchanged
   - row label lookup still falls back to raw provider key
   - disabled providers remain present in the filter dropdown
3. Keep out of scope:
   - the GraphQL `users.list(...)` table query
   - any backend changes
   - any changes to user create/edit/delete mutations
4. Run verification:
   - `corepack yarn test`
   - `corepack yarn build`
5. Run independent spec and code-quality reviews; fix findings before committing.

Guardrails:
- Do not reduce the filter dropdown to enabled-only providers.
- Do not widen this slice into the full users list REST migration.
- Do not change the users table response contract in this batch.
