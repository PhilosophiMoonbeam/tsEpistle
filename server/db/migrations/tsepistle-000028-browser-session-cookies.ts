import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex('users')
    .whereNot('id', 2)
    .update({
      authVersion: knex.raw('COALESCE(??, 0) + 1', ['authVersion']),
      sessionsRevokedAt: new Date().toISOString()
    })
}

export const down = async (): Promise<void> => {
  throw new Error('Cannot roll down the browser session cookie cutover after human sessions have been revoked.')
}
