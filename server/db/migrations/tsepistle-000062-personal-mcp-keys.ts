import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('apiKeys', table => {
    table.integer('personalOwnerId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.string('personalAccess', 16).nullable()
    table.index(['personalOwnerId'], 'api_keys_personal_owner_idx')
  })
  // Access is also the permanent credential-kind marker: deleting an owner must
  // never turn their MCP credential into an ordinary service credential.
  await knex.raw(`ALTER TABLE "apiKeys" ADD CONSTRAINT api_keys_personal_access_check CHECK (("personalOwnerId" IS NULL OR "personalAccess" IS NOT NULL) AND ("personalAccess" IS NULL OR "personalAccess" IN ('read-only', 'read-write')))`)
}

export const down = async (_knex: Knex): Promise<void> => {
  throw new Error('Personal MCP credentials cannot safely become service credentials; fix forward.')
}
