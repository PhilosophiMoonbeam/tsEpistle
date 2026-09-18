import type { Knex } from 'knex'
export const up = async (db: Knex): Promise<void> => {
  await db.schema.createTable('agentMedia', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('messageId').nullable().references('id').inTable('agentMessages').onDelete('CASCADE')
    table.uuid('runId').nullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.string('kind', 24).notNullable()
    table.string('mimeType', 100).notNullable()
    table.string('filename', 180).notNullable()
    table.integer('byteLength').notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('payload').notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('expiresAt', { useTz: true }).nullable()
    table.text('metadata').notNullable()
    table.index(['ownerId', 'sessionId', 'messageId'])
    table.index(['expiresAt'])
  })
  await db.schema.alterTable('agentRuns', table => {
    table.text('mediaRequest').nullable()
  })
}
export const down = async (db: Knex): Promise<void> => {
  if (await db('agentMedia').first('id')) throw new Error('Cannot discard saved agent media. Apply a forward migration.')
  await db.schema.dropTable('agentMedia')
  await db.schema.alterTable('agentRuns', table => {
    table.dropColumn('mediaRequest')
  })
}
