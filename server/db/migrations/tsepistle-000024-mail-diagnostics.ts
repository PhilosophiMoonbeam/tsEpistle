import type { Knex } from 'knex'
export const up = async (db: Knex): Promise<void> => {
  await db.schema.createTable('mailChecks', table => {
    table.uuid('id').primary()
    table.string('kind', 20).notNullable()
    table.string('state', 20).notNullable()
    table.integer('actorId').nullable()
    table.string('recipient', 254).nullable()
    table.text('configurationRevision').notNullable()
    table.string('reviewFingerprint', 64).notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('completedAt', { useTz: true }).nullable()
    table.text('summary').notNullable()
    table.index(['createdAt', 'id'], 'mail_checks_history')
    table.check("kind IN ('connection','dkim','test')", [], 'mail_checks_kind')
    table.check("state IN ('running','succeeded','failed','uncertain')", [], 'mail_checks_state')
  })
  await db.raw('CREATE UNIQUE INDEX mail_checks_single_active ON "mailChecks" ((true)) WHERE state = \'running\'')
  await db('settings').insert({ key: 'mailAdministration', value: '{}', updatedAt: new Date().toISOString() }).onConflict('key').ignore()
}
export const down = async (db: Knex): Promise<void> => {
  await db.transaction(async tx => {
    await tx.raw('LOCK TABLE "mailChecks" IN ACCESS EXCLUSIVE MODE')
    if (await tx('mailChecks').first('id')) throw new Error('Cannot discard recorded Mail diagnostics. Restore a backup or apply a forward fix.')
    await tx.schema.dropTable('mailChecks')
  })
}
