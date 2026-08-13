import type { Knex } from 'knex'
export const up = async (knex: Knex) => {
  // -> Fix 2.5.117 new installations without isEnabled on local auth (#2382)
  await knex('authentication').where('key', 'local').update({ isEnabled: true })
}

export const down = (knex: Knex) => {
  void knex
}
