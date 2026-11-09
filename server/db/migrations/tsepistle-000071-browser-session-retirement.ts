import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  // The old store created this table at HTTP startup, so a fresh installation
  // can reach migrations without it. Existing bodies, SIDs and expiry stay intact.
  if (!(await knex.schema.hasTable('sessions'))) {
    await knex.schema.createTable('sessions', table => {
      table.string('sid').primary()
      table.json('sess').notNullable()
      table.timestamp('expired').notNullable().index()
    })
  }
  await knex.schema.createTable('browserSessionLifecycles', table => {
    table.string('sid').primary()
    table.uuid('generation').notNullable()
    table.timestamp('retiredAt', { useTz: true }).nullable()
    table.timestamp('expiresAt', { useTz: true }).notNullable().index()
  })
  await knex.raw(`INSERT INTO ?? (??, ??, ??, ??)
    SELECT ??, gen_random_uuid(), NULL, ?? FROM ??`, [
    'browserSessionLifecycles', 'sid', 'generation', 'retiredAt', 'expiresAt',
    'sid', 'expired', 'sessions'
  ])
}

export const down = async (): Promise<void> => {
  throw new Error('Browser-session retirement fences must remain durable; stop old writers and fix forward instead of dropping them.')
}
