import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('webhooks', table => {
    table.uuid('id').primary()
    table.string('name', 128).notNullable()
    table.text('url').notNullable()
    table.text('events').notNullable()
    table.text('secretCiphertext').notNullable()
    table.boolean('isEnabled').notNullable().defaultTo(true)
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })

  await knex.schema.createTable('outboxEvents', table => {
    table.uuid('id').primary()
    table.string('type', 128).notNullable()
    table.integer('version').unsigned().notNullable().defaultTo(1)
    table.string('aggregateType', 64).notNullable()
    table.string('aggregateId', 128).notNullable()
    table.text('payload').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('publishedAt').nullable()
    table.index(['publishedAt', 'createdAt'], 'outbox_events_unpublished_lookup')
    table.index(['aggregateType', 'aggregateId'], 'outbox_events_aggregate_lookup')
  })

  await knex.schema.createTable('webhookDeliveries', table => {
    table.uuid('id').primary()
    table.uuid('webhookId').notNullable().references('id').inTable('webhooks').onDelete('CASCADE')
    table.uuid('eventId').notNullable().references('id').inTable('outboxEvents').onDelete('CASCADE')
    table.uuid('jobId').notNullable().references('id').inTable('durableJobs').onDelete('CASCADE')
    table.integer('statusCode').nullable()
    table.text('responseSnippet').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('deliveredAt').nullable()
    table.unique(['webhookId', 'eventId'], { indexName: 'webhook_deliveries_idempotency_unique' })
    table.index(['webhookId', 'createdAt'], 'webhook_deliveries_webhook_lookup')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('webhookDeliveries')
  await knex.schema.dropTableIfExists('outboxEvents')
  await knex.schema.dropTableIfExists('webhooks')
}
