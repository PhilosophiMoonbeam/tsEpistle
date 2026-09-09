import type { Knex } from 'knex'

const TABLE = 'federatedLoginAttempts'
const PAYLOAD_LIMIT = 16 * 1_024
const PAYLOAD_CHECK = 'federated_login_attempts_payload_size_check'

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TABLE)) return

  await knex.schema.createTable(TABLE, table => {
    table.uuid('id').primary()
    table.binary('stateHash').notNullable().unique('federated_login_attempts_state_unique')
    table.binary('requestIdHash').nullable().unique('federated_login_attempts_request_id_unique')
    table.string('providerKey', 255).notNullable()
    table.string('protocol', 32).notNullable()
    table.string('providerRevision', 255).notNullable()
    table.string('sessionId', 255).notNullable()
    table.binary('browserNonceHash').nullable()
    table.dateTime('issuedAt').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.text('payload').notNullable()
    table.unique(['providerKey', 'protocol', 'sessionId'], { indexName: 'federated_login_attempts_slot_unique' })
    table.index(['expiresAt'], 'federated_login_attempts_expiry_idx')
    table.index(['sessionId', 'expiresAt'], 'federated_login_attempts_session_expiry_idx')
  })

  if (isPostgres(knex)) {
    await knex.raw(
      `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${PAYLOAD_CHECK}" CHECK (octet_length("payload") <= ${PAYLOAD_LIMIT})`
    )
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE)
}
