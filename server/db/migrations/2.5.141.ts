import type { Knex } from 'knex'

const TABLE_NAME = 'agentProviderSecrets'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TABLE_NAME)) return
  await knex.schema.createTable(TABLE_NAME, table => {
    table.uuid('id').primary()
    table.string('keyId', 128).notNullable()
    table.string('algorithm', 32).notNullable()
    table.binary('nonce').notNullable()
    table.binary('ciphertext').notNullable()
    table.binary('authTag').notNullable()
    table.integer('createdBy').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.index(['keyId'], 'agent_provider_secrets_key_idx')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(TABLE_NAME)) return
  const row = await knex(TABLE_NAME).count<{ count: string }[]>({ count: '*' }).first()
  if (Number(row?.count ?? 0) > 0) throw new Error(`Cannot roll down provider secret migration while ${TABLE_NAME} contains data`)
  await knex.schema.dropTable(TABLE_NAME)
}
