import type { Knex } from 'knex'

const ROOM_TABLE = 'pageCollaborationRooms'
const PAGE_TABLE = 'pages'
const CONTRIBUTOR_TABLE = 'pageCollaborationContributors'
const CONNECTION_TABLE = 'pageCollaborationConnections'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable(ROOM_TABLE, table => {
    table.integer('generation').unsigned().notNullable().defaultTo(1)
    table.string('baseSourceRevision', 64).nullable()
  })
  const currentPageSourceRevision = knex(PAGE_TABLE)
    .select('sourceRevision')
    .where(`${PAGE_TABLE}.id`, knex.ref(`${ROOM_TABLE}.pageId`))
  await knex(ROOM_TABLE).update({ baseSourceRevision: currentPageSourceRevision })
  await knex.schema.alterTable(ROOM_TABLE, table => {
    table.string('baseSourceRevision', 64).notNullable().alter()
  })

  await knex.schema.createTable(CONTRIBUTOR_TABLE, table => {
    table.integer('pageId').unsigned().notNullable().references('pageId').inTable(ROOM_TABLE).onDelete('CASCADE')
    table.integer('generation').unsigned().notNullable()
    table.integer('userId').unsigned().notNullable()
    table.primary(['pageId', 'generation', 'userId'])
  })
  const legacyContributors = knex(ROOM_TABLE)
    .select('pageId', 'generation')
    .select(knex.raw('? AS ??', [0, 'userId']))
    .where('revision', '>', 0)
  await knex(CONTRIBUTOR_TABLE)
    .insert(legacyContributors)
    .onConflict(['pageId', 'generation', 'userId'])
    .ignore()

  await knex.schema.createTable(CONNECTION_TABLE, table => {
    table.string('id', 64).primary()
    table.integer('pageId').unsigned().notNullable().references('pageId').inTable(ROOM_TABLE).onDelete('CASCADE')
    table.integer('generation').unsigned().notNullable()
    table.integer('userId').unsigned().notNullable()
    table.dateTime('expiresAt').notNullable()
    table.index(['pageId', 'generation'])
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(CONNECTION_TABLE)
  await knex.schema.dropTableIfExists(CONTRIBUTOR_TABLE)
  await knex.schema.alterTable(ROOM_TABLE, table => {
    table.dropColumn('baseSourceRevision')
    table.dropColumn('generation')
  })
}
