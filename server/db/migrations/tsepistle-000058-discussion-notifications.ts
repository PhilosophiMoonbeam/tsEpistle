import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('userNotificationPreferences', table => {
    table.integer('userId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('category', 32).notNullable()
    table.boolean('inAppEnabled').notNullable().defaultTo(false)
    table.boolean('emailEnabled').notNullable().defaultTo(false)
    table.dateTime('updatedAt').notNullable()
    table.primary(['userId', 'category'], 'user_notification_preferences_primary')
    table.index(['category', 'userId'], 'user_notification_preferences_audience_lookup')
  })
  await knex.schema.alterTable('pageWatchNotifications', table => {
    // Null identifies an existing per-page watch notification; project it as pageWatch at read time.
    table.string('category', 32).nullable()
    table.integer('commentId').unsigned().nullable()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('pageWatchNotifications', table => {
    table.dropColumn('commentId')
    table.dropColumn('category')
  })
  await knex.schema.dropTableIfExists('userNotificationPreferences')
}
