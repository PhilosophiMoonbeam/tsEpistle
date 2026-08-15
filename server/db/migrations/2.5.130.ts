import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('durableJobs', table => {
    table.uuid('id').primary()
    table.string('type', 128).notNullable()
    table.integer('version').unsigned().notNullable().defaultTo(1)
    table.text('payload').notNullable()
    table.string('state', 16).notNullable().defaultTo('pending')
    table.integer('attempts').unsigned().notNullable().defaultTo(0)
    table.integer('maxAttempts').unsigned().notNullable().defaultTo(5)
    table.dateTime('nextRunAt').notNullable()
    table.string('leaseOwner', 128).nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.text('lastError').nullable()
    table.string('deduplicationKey', 255).nullable().unique('durable_jobs_deduplication_unique')
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
    table.index(['state', 'nextRunAt'], 'durable_jobs_ready_lookup')
    table.index(['state', 'leaseExpiresAt'], 'durable_jobs_lease_lookup')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('durableJobs')
}
