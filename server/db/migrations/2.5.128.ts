import type { Knex } from 'knex'
export const up = async (knex: Knex) => {
  await knex('users').update({
    email: knex.raw('LOWER(??)', ['email'])
  })
}

export const down = (knex: Knex) => {
  void knex
}
