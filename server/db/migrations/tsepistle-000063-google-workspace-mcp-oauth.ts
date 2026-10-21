import type { Knex } from 'knex'

export const up = async (db: Knex): Promise<void> => {
  if (db.client.config.client === 'pg') {
    // Existing deployments have generated check names; select by definition, not guessed names.
    const checks = await db.raw(`SELECT conname FROM pg_constraint WHERE conrelid = '"agentExternalMcpServers"'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%authMode%'`)
    for (const row of checks.rows as { conname: string }[]) await db.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['agentExternalMcpServers', row.conname])
    await db.schema.alterTable('agentExternalMcpServers', table => {
      table.check(`"authMode" IN ('none', 'bearer', 'google')`, [], 'external_mcp_auth_mode')
      table.check(`("authMode" IN ('none', 'google') AND "secretReference" IS NULL) OR ("authMode" = 'bearer' AND "secretReference" LIKE 'managed:%' AND "secretReference" IS NOT NULL)`, [], 'external_mcp_auth_secret')
    })
  }
  await db.schema.createTable('agentExternalMcpOAuthGrants', table => {
    table.uuid('id').primary()
    table.integer('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('serverId').notNullable().references('id').inTable('agentExternalMcpServers').onDelete('CASCADE')
    table.integer('serverRevision').notNullable()
    table.integer('authVersion').notNullable()
    table.text('authorizationStamp').notNullable()
    table.string('secretReference', 128).nullable()
    table.unique(['userId', 'serverId'])
  })
  await db.schema.createTable('agentExternalMcpOAuthPending', table => {
    table.string('stateHash', 64).primary()
    table.uuid('grantId').notNullable().references('id').inTable('agentExternalMcpOAuthGrants').onDelete('CASCADE')
    table.string('sessionHash', 64).notNullable()
    table.string('secretReference', 128).notNullable()
    table.timestamp('expiresAt', { useTz: true }).notNullable()
    table.index('expiresAt')
  })
  // Cascades (including account deletion) must not orphan encrypted credentials.
  if (db.client.config.client === 'pg') {
    await db.raw(`CREATE FUNCTION external_mcp_oauth_secret_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "agentProviderSecrets" WHERE id::text = substring(OLD."secretReference" from 9); RETURN OLD; END $$`)
    for (const table of ['agentExternalMcpOAuthGrants', 'agentExternalMcpOAuthPending'])
      await db.raw('CREATE TRIGGER external_mcp_oauth_secret_cleanup AFTER DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION external_mcp_oauth_secret_cleanup()', [table])
    // Provider secrets use ON DELETE RESTRICT. Remove only OAuth-owned rows before
    // user foreign-key checks, leaving restrictions for unrelated provider credentials intact.
    await db.raw(`CREATE FUNCTION external_mcp_oauth_user_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "agentExternalMcpOAuthGrants" WHERE "userId" = OLD.id; RETURN OLD; END $$`)
    await db.raw('CREATE TRIGGER external_mcp_oauth_user_cleanup BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION external_mcp_oauth_user_cleanup()')
  } else {
    for (const table of ['agentExternalMcpOAuthGrants', 'agentExternalMcpOAuthPending'])
      await db.raw(`CREATE TRIGGER "${table}_secret_cleanup" AFTER DELETE ON "${table}" BEGIN DELETE FROM "agentProviderSecrets" WHERE id = substr(OLD."secretReference", 9); END`)
    await db.raw(`CREATE TRIGGER external_mcp_oauth_user_cleanup BEFORE DELETE ON users BEGIN DELETE FROM "agentExternalMcpOAuthGrants" WHERE "userId" = OLD.id; END`)
  }
}

export const down = async (): Promise<void> => {
  throw new Error('Google OAuth credentials require a forward migration; refusing to discard grants.')
}
