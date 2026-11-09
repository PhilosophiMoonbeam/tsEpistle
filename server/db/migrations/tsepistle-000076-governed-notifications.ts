import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('governedNotificationReceipts', table => {
    table.uuid('id').primary()
    table.uuid('eventId').notNullable().references('id').inTable('outboxEvents').onDelete('RESTRICT')
    table.integer('userId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('pageId').unsigned().notNullable()
    table.string('category', 32).notNullable()
    table.string('channel', 8).notNullable()
    table.string('status', 16).notNullable().defaultTo('pending')
    table.integer('attempt').notNullable().defaultTo(0)
    table.text('messageId').nullable()
    table.text('safeFailureReason').nullable()
    table.timestamp('admittedAt', { useTz: true }).notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.unique(['eventId', 'userId', 'channel'], { indexName: 'governed_notification_root_channel_unique' })
    table.index(['userId', 'updatedAt', 'id'])
    table.index(['status', 'updatedAt'])
    table.check("?? IN ('feedbackStatus','pageLifecycle')", ['category'])
    table.check("?? IN ('in-app','email')", ['channel'])
    table.check("?? IN ('pending','sending','delivered','sent','suppressed','unknown','failed')", ['status'])
    table.check('?? >= 0', ['attempt'])
  })
  await knex.schema.createTable('governedNotificationEmailAttempts', table => {
    table.uuid('receiptId').notNullable().references('id').inTable('governedNotificationReceipts').onDelete('CASCADE')
    table.integer('attempt').notNullable()
    table.string('status', 24).notNullable()
    table.text('messageId').nullable()
    table.boolean('duplicateAcknowledged').notNullable().defaultTo(false)
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.primary(['receiptId', 'attempt'])
    table.index(['status', 'updatedAt'])
    table.check("?? IN ('sending','sent','suppressed','unknown','retry-before-handoff','failed')", ['status'])
    table.check('?? >= 0', ['attempt'])
  })
}
export const down = async (): Promise<void> => {
  throw new Error('Governed notification dedupe and ambiguous email outcomes must survive; fix forward.')
}
