import type { Knex } from 'knex'

const privateCount = async (knex: Knex, table: string): Promise<number> => {
  const row = await knex(table).where('isPrivate', true).count<{ count: string }[]>({ count: '*' }).first()
  return Number(row?.count ?? 0)
}

const databaseClient = (knex: Knex): string => String(knex.client.config.client)

const dropLegacyIdentity = async (knex: Knex) => {
  const client = databaseClient(knex)
  if (client === 'pg') {
    await knex.raw('ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_localecode_path_unique')
    await knex.raw('DROP INDEX IF EXISTS pages_localecode_path_unique')
    return
  }
  if (client === 'mysql2') {
    const index = await knex('information_schema.statistics')
      .whereRaw('table_schema = DATABASE()')
      .where({ table_name: 'pages', index_name: 'pages_localecode_path_unique' })
      .first()
    if (index) await knex.raw('ALTER TABLE pages DROP INDEX pages_localecode_path_unique')
    return
  }
  if (client === 'mssql') {
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'pages_localecode_path_unique' AND object_id = OBJECT_ID('pages'))
        DROP INDEX pages_localecode_path_unique ON pages
      IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pages_localecode_path_unique' AND parent_object_id = OBJECT_ID('pages'))
        ALTER TABLE pages DROP CONSTRAINT pages_localecode_path_unique
    `)
  }
}

const addIdentityConstraints = async (knex: Knex) => {
  const client = databaseClient(knex)
  if (client === 'pg') {
    await knex.raw(`ALTER TABLE pages ADD CONSTRAINT pages_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)
    await knex.raw(`ALTER TABLE "pageHistory" ADD CONSTRAINT page_history_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)
    await knex.raw(`ALTER TABLE "pageTree" ADD CONSTRAINT page_tree_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)
    await knex.raw(`CREATE UNIQUE INDEX pages_public_identity_unique ON pages ("localeCode", path) WHERE visibility = 'public'`)
    await knex.raw(`CREATE UNIQUE INDEX pages_private_identity_unique ON pages ("ownerId", "localeCode", path) WHERE visibility = 'private'`)
  } else if (client === 'mysql2') {
    await knex.raw(`ALTER TABLE pages ADD CONSTRAINT pages_visibility_owner_check CHECK ((visibility = 'public' AND \`ownerId\` IS NULL) OR (visibility = 'private' AND \`ownerId\` IS NOT NULL))`)
    await knex.raw(`ALTER TABLE \`pageHistory\` ADD CONSTRAINT page_history_visibility_owner_check CHECK ((visibility = 'public' AND \`ownerId\` IS NULL) OR (visibility = 'private' AND \`ownerId\` IS NOT NULL))`)
    await knex.raw(`ALTER TABLE \`pageTree\` ADD CONSTRAINT page_tree_visibility_owner_check CHECK ((visibility = 'public' AND \`ownerId\` IS NULL) OR (visibility = 'private' AND \`ownerId\` IS NOT NULL))`)
    await knex.raw('ALTER TABLE pages ADD COLUMN `identityOwnerId` INT GENERATED ALWAYS AS (IFNULL(`ownerId`, 0)) STORED')
    await knex.raw('CREATE UNIQUE INDEX pages_identity_unique ON pages (`identityOwnerId`, `localeCode`, path)')
  } else if (client === 'mssql') {
    await knex.raw(`ALTER TABLE pages ADD CONSTRAINT pages_visibility_owner_check CHECK ((visibility = 'public' AND [ownerId] IS NULL) OR (visibility = 'private' AND [ownerId] IS NOT NULL))`)
    await knex.raw(`ALTER TABLE [pageHistory] ADD CONSTRAINT page_history_visibility_owner_check CHECK ((visibility = 'public' AND [ownerId] IS NULL) OR (visibility = 'private' AND [ownerId] IS NOT NULL))`)
    await knex.raw(`ALTER TABLE [pageTree] ADD CONSTRAINT page_tree_visibility_owner_check CHECK ((visibility = 'public' AND [ownerId] IS NULL) OR (visibility = 'private' AND [ownerId] IS NOT NULL))`)
    await knex.raw('ALTER TABLE pages ADD [identityOwnerId] AS (ISNULL([ownerId], 0)) PERSISTED')
    await knex.raw('CREATE UNIQUE INDEX pages_identity_unique ON pages ([identityOwnerId], [localeCode], path)')
  }

  await knex.schema.alterTable('pages', table => {
    table.index(['visibility', 'ownerId', 'localeCode', 'path'], 'pages_visibility_owner_lookup')
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.index(['visibility', 'ownerId', 'pageId'], 'page_history_visibility_owner_lookup')
  })
  await knex.schema.alterTable('pageTree', table => {
    table.index(['visibility', 'ownerId', 'localeCode', 'path'], 'page_tree_visibility_owner_lookup')
  })
}

export const up = async (knex: Knex) => {
  const client = databaseClient(knex)
  for (const table of ['pages', 'pageHistory', 'pageTree']) {
    const count = await privateCount(knex, table)
    if (count > 0) {
      throw new Error(`Cannot migrate ${count} legacy private row(s) in ${table}: owner identity is unavailable`)
    }
  }

  await dropLegacyIdentity(knex)

  await knex.schema.alterTable('pages', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    const ownerId = table.integer('ownerId').unsigned().nullable().references('id').inTable('users')
    if (client !== 'mssql') ownerId.onDelete('RESTRICT')
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    const ownerId = table.integer('ownerId').unsigned().nullable().references('id').inTable('users')
    if (client !== 'mssql') ownerId.onDelete('RESTRICT')
  })
  await knex.schema.alterTable('pageTree', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    table.integer('ownerId').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
  })

  await addIdentityConstraints(knex)

  for (const tableName of ['pages', 'pageHistory', 'pageTree']) {
    for (const columnName of ['isPrivate', 'privateNS']) {
      if (await knex.schema.hasColumn(tableName, columnName)) {
        await knex.schema.alterTable(tableName, table => {
          table.dropColumn(columnName)
        })
      }
    }
  }
}

export const down = async (knex: Knex) => {
  const client = databaseClient(knex)

  await knex.schema.alterTable('pages', table => {
    table.dropIndex([], client === 'pg' ? 'pages_public_identity_unique' : 'pages_identity_unique')
    if (client === 'pg') table.dropIndex([], 'pages_private_identity_unique')
    table.dropIndex([], 'pages_visibility_owner_lookup')
    table.dropChecks(['pages_visibility_owner_check'])
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.dropIndex([], 'page_history_visibility_owner_lookup')
    table.dropChecks(['page_history_visibility_owner_check'])
  })
  await knex.schema.alterTable('pageTree', table => {
    table.dropIndex([], 'page_tree_visibility_owner_lookup')
    table.dropChecks(['page_tree_visibility_owner_check'])
  })
  if (client !== 'pg') {
    await knex.schema.alterTable('pages', table => {
      table.dropColumn('identityOwnerId')
    })
  }

  await knex.schema.alterTable('pages', table => {
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.string('privateNS').nullable()
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.string('privateNS').nullable()
  })
  await knex.schema.alterTable('pageTree', table => {
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.string('privateNS').nullable()
  })

  if (client === 'pg') {
    await knex.raw(`UPDATE pages SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
    await knex.raw(`UPDATE "pageHistory" SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
    await knex.raw(`UPDATE "pageTree" SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
  } else if (client === 'mysql2') {
    await knex.raw(`UPDATE pages SET \`isPrivate\` = (visibility = 'private'), \`privateNS\` = CASE WHEN visibility = 'private' THEN CONCAT('owner:', \`ownerId\`) ELSE NULL END`)
    await knex.raw(`UPDATE \`pageHistory\` SET \`isPrivate\` = (visibility = 'private'), \`privateNS\` = CASE WHEN visibility = 'private' THEN CONCAT('owner:', \`ownerId\`) ELSE NULL END`)
    await knex.raw(`UPDATE \`pageTree\` SET \`isPrivate\` = (visibility = 'private'), \`privateNS\` = CASE WHEN visibility = 'private' THEN CONCAT('owner:', \`ownerId\`) ELSE NULL END`)
  } else if (client === 'mssql') {
    await knex.raw(`UPDATE pages SET [isPrivate] = CASE WHEN visibility = 'private' THEN 1 ELSE 0 END, [privateNS] = CASE WHEN visibility = 'private' THEN 'owner:' + CONVERT(varchar(20), [ownerId]) ELSE NULL END`)
    await knex.raw(`UPDATE [pageHistory] SET [isPrivate] = CASE WHEN visibility = 'private' THEN 1 ELSE 0 END, [privateNS] = CASE WHEN visibility = 'private' THEN 'owner:' + CONVERT(varchar(20), [ownerId]) ELSE NULL END`)
    await knex.raw(`UPDATE [pageTree] SET [isPrivate] = CASE WHEN visibility = 'private' THEN 1 ELSE 0 END, [privateNS] = CASE WHEN visibility = 'private' THEN 'owner:' + CONVERT(varchar(20), [ownerId]) ELSE NULL END`)
  }

  for (const tableName of ['pageTree', 'pageHistory', 'pages']) {
    await knex.schema.alterTable(tableName, table => {
      table.dropColumn('visibility')
      table.dropColumn('ownerId')
    })
  }
  await knex.schema.alterTable('pages', table => {
    table.unique(['localeCode', 'path'], { indexName: 'pages_localecode_path_unique' })
  })
}
