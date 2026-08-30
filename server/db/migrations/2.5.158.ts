import type { Knex } from 'knex'

const tableName = 'durableJobs'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasColumn(tableName, 'leaseToken'))) {
    await knex.schema.alterTable(tableName, table => {
      table.uuid('leaseToken').nullable()
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasColumn(tableName, 'leaseToken')) {
    await knex.schema.alterTable(tableName, table => {
      table.dropColumn('leaseToken')
    })
  }
}
