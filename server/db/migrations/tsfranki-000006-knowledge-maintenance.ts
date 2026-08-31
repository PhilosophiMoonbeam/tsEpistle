import type { Knex } from 'knex'

const TABLE = 'pageKnowledgeMaintenance'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, table => {
    table.integer('id').primary().defaultTo(1)
    table.integer('version').unsigned().notNullable().defaultTo(1)
    table.bigInteger('epochId').unsigned().notNullable().defaultTo(0)
    table.string('status', 32).notNullable().defaultTo('pending')
    table.bigInteger('highWaterPageId').unsigned().notNullable().defaultTo(0)
    table.bigInteger('cursorPageId').unsigned().notNullable().defaultTo(0)
    table.bigInteger('scanned').unsigned().notNullable().defaultTo(0)
    table.bigInteger('repaired').unsigned().notNullable().defaultTo(0)
    table.bigInteger('requeued').unsigned().notNullable().defaultTo(0)
    table.string('leaseOwner', 255).nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('lastProgressAt').nullable()
    table.dateTime('completedAt').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.text('lastError').nullable()
  })
  }
  await knex(TABLE).insert({ id: 1 }).onConflict('id').ignore()
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE)
}
