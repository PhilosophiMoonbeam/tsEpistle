import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageWatchers', table => {
    table.integer('pageId').unsigned().notNullable()
    table.integer('userId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.dateTime('createdAt').notNullable()
    table.boolean('emailEnabled').notNullable().defaultTo(true)
    table.boolean('inAppEnabled').notNullable().defaultTo(true)
    table.primary(['pageId', 'userId'], 'page_watchers_primary')
    table.index(['userId', 'createdAt'], 'page_watchers_user_lookup')
  })

  await knex.schema.createTable('pageWatchNotifications', table => {
    table.uuid('id').primary()
    table.uuid('eventId').notNullable().references('id').inTable('outboxEvents').onDelete('CASCADE')
    table.integer('userId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('pageId').unsigned().notNullable()
    table.string('eventType', 64).notNullable()
    table.string('actorName', 255).notNullable()
    table.string('title', 255).notNullable()
    table.text('path').notNullable()
    table.string('localeCode', 32).notNullable()
    table.string('visibility', 16).notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('readAt').nullable()
    table.unique(['eventId', 'userId'], { indexName: 'page_watch_notifications_idempotency_unique' })
    table.index(['userId', 'readAt', 'createdAt'], 'page_watch_notifications_inbox_lookup')
  })

  await knex.schema.createTable('pageWatchDeliveries', table => {
    table.uuid('id').primary()
    table.uuid('eventId').notNullable().references('id').inTable('outboxEvents').onDelete('CASCADE')
    table.integer('userId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('jobId').notNullable().references('id').inTable('durableJobs').onDelete('CASCADE')
    table.dateTime('createdAt').notNullable()
    table.dateTime('deliveredAt').nullable()
    table.text('lastError').nullable()
    table.unique(['eventId', 'userId'], { indexName: 'page_watch_deliveries_idempotency_unique' })
    table.index(['userId', 'createdAt'], 'page_watch_deliveries_user_lookup')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('pageWatchDeliveries')
  await knex.schema.dropTableIfExists('pageWatchers')
  await knex.schema.dropTableIfExists('pageWatchNotifications')
}
