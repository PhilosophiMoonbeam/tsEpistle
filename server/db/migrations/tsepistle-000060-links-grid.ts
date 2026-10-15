import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex('contentExtensions')
    .insert({
      key: 'links-grid',
      version: 1,
      isEnabled: false,
      updatedAt: knex.fn.now(),
      updatedBy: null
    })
    .onConflict('key')
    .ignore()
}

export const down = async (): Promise<void> => {
  // Registry rows can contain administrator state and cannot be safely removed.
}
