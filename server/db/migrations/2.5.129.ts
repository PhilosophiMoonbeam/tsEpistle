import type { Knex } from 'knex'

const privateCount = async (knex: Knex, table: string): Promise<number> => {
  const row = await knex(table).where('isPrivate', true).count<{ count: string }[]>({ count: '*' }).first()
  return Number(row?.count ?? 0)
}

export const up = async (knex: Knex) => {
  for (const table of ['pages', 'pageHistory', 'pageTree']) {
    const count = await privateCount(knex, table)
    if (count > 0) {
      throw new Error(`Cannot migrate ${count} legacy private row(s) in ${table}: owner identity is unavailable`)
    }
  }

  await knex.raw('ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_localecode_path_unique')
  await knex.raw('DROP INDEX IF EXISTS pages_localecode_path_unique')

  await knex.schema.alterTable('pages', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    table.integer('ownerId').nullable().references('id').inTable('users').onDelete('RESTRICT')
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    table.integer('ownerId').nullable().references('id').inTable('users').onDelete('RESTRICT')
  })
  await knex.schema.alterTable('pageTree', table => {
    table.string('visibility', 16).notNullable().defaultTo('public')
    table.integer('ownerId').nullable().references('id').inTable('users').onDelete('CASCADE')
  })

  await knex.raw(`ALTER TABLE pages ADD CONSTRAINT pages_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)
  await knex.raw(`ALTER TABLE "pageHistory" ADD CONSTRAINT page_history_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)
  await knex.raw(`ALTER TABLE "pageTree" ADD CONSTRAINT page_tree_visibility_owner_check CHECK ((visibility = 'public' AND "ownerId" IS NULL) OR (visibility = 'private' AND "ownerId" IS NOT NULL))`)

  await knex.raw(`CREATE UNIQUE INDEX pages_public_identity_unique ON pages ("localeCode", path) WHERE visibility = 'public'`)
  await knex.raw(`CREATE UNIQUE INDEX pages_private_identity_unique ON pages ("ownerId", "localeCode", path) WHERE visibility = 'private'`)
  await knex.raw(`CREATE INDEX pages_visibility_owner_lookup ON pages (visibility, "ownerId", "localeCode", path)`)
  await knex.raw(`CREATE INDEX page_history_visibility_owner_lookup ON "pageHistory" (visibility, "ownerId", "pageId")`)
  await knex.raw(`CREATE INDEX page_tree_visibility_owner_lookup ON "pageTree" (visibility, "ownerId", "localeCode", path)`)

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
  await knex.raw(`UPDATE pages SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
  await knex.raw(`UPDATE "pageHistory" SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
  await knex.raw(`UPDATE "pageTree" SET "isPrivate" = (visibility = 'private'), "privateNS" = CASE WHEN visibility = 'private' THEN 'owner:' || "ownerId"::text ELSE NULL END`)
  await knex.schema.alterTable('pageTree', table => {
    table.dropColumn('visibility')
    table.dropColumn('ownerId')
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.dropColumn('visibility')
    table.dropColumn('ownerId')
  })
  await knex.schema.alterTable('pages', table => {
    table.dropColumn('visibility')
    table.dropColumn('ownerId')
  })
}
