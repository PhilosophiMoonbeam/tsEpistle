import type { Knex } from 'knex'
export const up = async (db: Knex): Promise<void> => {
  await db.schema.createTable('tlsOperations', table => {
    table.uuid('id').primary()
    table.string('kind', 30).notNullable()
    table.string('state', 20).notNullable()
    table.string('phase', 40).notNullable()
    table.integer('actorId').nullable()
    table.integer('apiKeyId').nullable()
    table.text('reason').notNullable()
    table.string('reviewFingerprint', 64).notNullable()
    table.string('effectFingerprint', 64).notNullable()
    table.string('materialKey', 64).nullable()
    table.uuid('materialCheckId').nullable()
    table.boolean('allowRestart').notNullable().defaultTo(false)
    table.uuid('ownerId').notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('heartbeatAt', { useTz: true }).notNullable()
    table.timestamp('completedAt', { useTz: true }).nullable()
    table.text('summary').notNullable()
    table.jsonb('result').nullable()
    table.index(['createdAt', 'id'], 'tls_operations_history')
    table.check("kind IN ('public-check','native-check','validate-material','apply-certificate','renew-certificate')", [], 'tls_operations_kind')
    table.check("state IN ('running','succeeded','failed','uncertain')", [], 'tls_operations_state')
  })
  await db.raw('CREATE UNIQUE INDEX tls_operations_single_active ON "tlsOperations" ((true)) WHERE state = \'running\'')
  await db('settings').insert({ key: 'sslAdministration', value: '{}', updatedAt: new Date().toISOString() }).onConflict('key').ignore()
}
export const down = async (db: Knex): Promise<void> => {
  await db.transaction(async tx => {
    await tx.raw('LOCK TABLE "tlsOperations" IN ACCESS EXCLUSIVE MODE')
    if (await tx('tlsOperations').first('id')) throw new Error('Cannot discard recorded HTTPS operations. Restore a backup or apply a forward fix.')
    await tx.schema.dropTable('tlsOperations')
  })
}
