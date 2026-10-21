import type { Knex } from 'knex'

// SQLite must suspend FK enforcement before BEGIN while rebuilding the referenced parent.
// Both backends still apply this entire forward migration in an application-owned transaction.
export const config = { transaction: false }

interface SqliteSchemaObject { readonly type: string; readonly name: string; readonly sql: string | null }
interface SqliteColumn { readonly name: string }
const upgradeSqliteEndpoints = async (tx: Knex.Transaction): Promise<void> => {
  const table = 'agentExternalMcpServers'
  const replacement = 'agentExternalMcpServers_oauth_upgrade'
  const schema = await tx<SqliteSchemaObject>('sqlite_master').where('tbl_name', table).whereIn('type', ['table', 'index', 'trigger']).select('type', 'name', 'sql')
  const definition = schema.find(object => object.type === 'table' && object.name === table)?.sql
  if (!definition) throw new Error('External MCP endpoint schema is unavailable')
  const columns = await tx.raw('PRAGMA table_info(??)', [table]) as SqliteColumn[]
  const legacy = await tx.raw('PRAGMA legacy_alter_table') as { legacy_alter_table: number }[]
  const foreignKeys = await tx.raw('PRAGMA foreign_keys') as { foreign_keys: number }[]
  if (foreignKeys[0]?.foreign_keys !== 0) throw new Error('External MCP SQLite reconstruction requires its independent migration transaction')
  const body = definition.indexOf('(')
  if (body < 0) throw new Error('External MCP endpoint schema cannot be reconstructed')
  await tx.raw(`CREATE TABLE "${replacement}" ${definition.slice(body).replaceAll("'google'", "'oauth'")}`)
  const selection = columns.map(column => {
    if (column.name === 'authMode') return tx.raw('CASE WHEN ?? = ? THEN ? ELSE ?? END AS ??', ['authMode', 'google', 'oauth', 'authMode', column.name])
    if (column.name === 'oauthConfiguration') return tx.raw('CASE WHEN ?? = ? THEN ? ELSE ?? END AS ??', ['authMode', 'google', JSON.stringify({ preset: 'google-workspace', registrationMode: 'preregistered' }), column.name, column.name])
    return tx.ref(column.name)
  })
  await tx(replacement).insert(tx(table).select(selection))
  // Legacy rename semantics leave dependent views/triggers naming the canonical
  // table intact while its replacement is renamed back into that exact name.
  await tx.raw('PRAGMA legacy_alter_table = ON')
  try {
    await tx.schema.dropTable(table)
    await tx.schema.renameTable(replacement, table)
    for (const object of schema) if (object.type !== 'table' && object.sql) await tx.raw(object.sql)
  } finally {
    await tx.raw(`PRAGMA legacy_alter_table = ${legacy[0]?.legacy_alter_table === 1 ? 'ON' : 'OFF'}`)
  }
}

/** Forward-only: preserve existing encrypted grants; unbound legacy grants require consent again. */
const applyMigration = async (db: Knex.Transaction): Promise<void> => {
  if (db.client.config.client === 'pg') {
    const checks = await db.raw(`SELECT conname FROM pg_constraint WHERE conrelid = '"agentExternalMcpServers"'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%authMode%'`)
    for (const row of checks.rows as { conname: string }[]) await db.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['agentExternalMcpServers', row.conname])
  }
  await db.schema.alterTable('agentExternalMcpServers', table => {
    table.text('oauthConfiguration').nullable()
    table.string('oauthClientSecretReference', 128).nullable()
  })
  if (db.client.config.client === 'pg') {
    await db('agentExternalMcpServers').where('authMode', 'google').update({ authMode: 'oauth', oauthConfiguration: JSON.stringify({ preset: 'google-workspace', registrationMode: 'preregistered' }) })
  } else {
    await upgradeSqliteEndpoints(db)
  }
  if (db.client.config.client === 'pg') await db.schema.alterTable('agentExternalMcpServers', table => {
    table.check(`"authMode" IN ('none', 'bearer', 'oauth')`, [], 'external_mcp_auth_mode')
    table.check(`("authMode" IN ('none', 'oauth') AND "secretReference" IS NULL) OR ("authMode" = 'bearer' AND "secretReference" LIKE 'managed:%' AND "secretReference" IS NOT NULL)`, [], 'external_mcp_auth_secret')
  })
  await db.schema.alterTable('agentExternalMcpOAuthGrants', table => { table.text('binding').nullable() })
  await db.schema.createTable('agentExternalMcpOAuthRegistrations', table => {
    table.uuid('serverId').primary().references('id').inTable('agentExternalMcpServers').onDelete('CASCADE')
    table.string('configurationHash', 64).notNullable()
    table.text('binding').notNullable()
    table.string('secretReference', 128).notNullable()
  })
  if (db.client.config.client === 'pg') {
    await db.raw('CREATE TRIGGER external_mcp_oauth_secret_cleanup AFTER DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION external_mcp_oauth_secret_cleanup()', ['agentExternalMcpOAuthRegistrations'])
    await db.raw(`CREATE FUNCTION external_mcp_oauth_client_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "agentProviderSecrets" WHERE id::text = substring(OLD."oauthClientSecretReference" from 9); RETURN OLD; END $$`)
    await db.raw('CREATE TRIGGER external_mcp_oauth_client_cleanup AFTER DELETE ON "agentExternalMcpServers" FOR EACH ROW EXECUTE FUNCTION external_mcp_oauth_client_cleanup()')
    await db.raw(`CREATE OR REPLACE FUNCTION external_mcp_oauth_user_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE client_secrets text[];
      BEGIN
      DELETE FROM "agentExternalMcpOAuthGrants" WHERE "userId" = OLD.id;
      SELECT array_agg("oauthClientSecretReference") INTO client_secrets FROM "agentExternalMcpServers"
        WHERE (scope = 'personal' AND "ownerId" = OLD.id) OR "oauthClientSecretReference" IN
          (SELECT 'managed:' || id::text FROM "agentProviderSecrets" WHERE "createdBy" = OLD.id);
      DELETE FROM "agentExternalMcpOAuthRegistrations" WHERE "serverId" IN
        (SELECT id FROM "agentExternalMcpServers" WHERE scope = 'personal' AND "ownerId" = OLD.id)
        OR "secretReference" IN (SELECT 'managed:' || id::text FROM "agentProviderSecrets" WHERE "createdBy" = OLD.id);
      DELETE FROM "agentProviderSecrets" WHERE ('managed:' || id::text) = ANY(client_secrets);
      UPDATE "agentExternalMcpServers" SET "oauthClientSecretReference" = NULL WHERE "oauthClientSecretReference" = ANY(client_secrets);
      RETURN OLD; END $$`)
  } else {
    await db.raw(`CREATE TRIGGER agentExternalMcpOAuthRegistrations_secret_cleanup AFTER DELETE ON "agentExternalMcpOAuthRegistrations" BEGIN DELETE FROM "agentProviderSecrets" WHERE id = substr(OLD."secretReference", 9); END`)
    await db.raw(`CREATE TRIGGER external_mcp_oauth_client_cleanup AFTER DELETE ON "agentExternalMcpServers" BEGIN DELETE FROM "agentProviderSecrets" WHERE id = substr(OLD."oauthClientSecretReference", 9); END`)
    await db.raw(`CREATE TRIGGER external_mcp_oauth_personal_cleanup BEFORE DELETE ON users BEGIN
      DELETE FROM "agentExternalMcpOAuthRegistrations" WHERE "serverId" IN (SELECT id FROM "agentExternalMcpServers" WHERE scope = 'personal' AND "ownerId" = OLD.id)
        OR "secretReference" IN (SELECT 'managed:' || id FROM "agentProviderSecrets" WHERE "createdBy" = OLD.id);
      DELETE FROM "agentProviderSecrets" WHERE id IN (SELECT substr("oauthClientSecretReference", 9) FROM "agentExternalMcpServers" WHERE scope = 'personal' AND "ownerId" = OLD.id)
        OR ("createdBy" = OLD.id AND ('managed:' || id) IN (SELECT "oauthClientSecretReference" FROM "agentExternalMcpServers"));
      UPDATE "agentExternalMcpServers" SET "oauthClientSecretReference" = NULL WHERE "oauthClientSecretReference" IS NOT NULL
        AND "oauthClientSecretReference" NOT IN (SELECT 'managed:' || id FROM "agentProviderSecrets");
      END`)
  }
}

export const up = async (db: Knex): Promise<void> => {
  if (db.client.config.client === 'pg') {
    await db.transaction(tx => applyMigration(tx))
    return
  }
  if (db.client.transacting) throw new Error('External MCP SQLite migration must run outside an existing transaction')
  await db.transaction(async tx => {
    await applyMigration(tx)
    const violations = await tx.raw('PRAGMA foreign_key_check') as unknown[]
    if (violations.length) throw new Error('External MCP SQLite migration would violate foreign keys')
  }, { enforceForeignCheck: false })
}
export const down = async (): Promise<void> => { throw new Error('OAuth credentials require a forward migration; refusing to discard grants.') }
