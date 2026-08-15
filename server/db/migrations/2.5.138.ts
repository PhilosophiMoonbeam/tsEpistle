import type { Knex } from 'knex'

const TABLE_NAME = 'contentExtensions'
const EXTENSIONS = [
  'tabs',
  'spoiler',
  'infobox',
  'pdf',
  'media',
  'youtube',
  'diagram',
  'kroki',
  'plantuml',
  'map'
] as const

export const up = async (knex: Knex): Promise<void> => {
  for (const key of EXTENSIONS) {
    const existing = await knex(TABLE_NAME).where({ key }).first('key')
    if (!existing) {
      await knex(TABLE_NAME).insert({
        key,
        isEnabled: false,
        version: 1,
        updatedAt: knex.fn.now(),
        updatedBy: null
      })
    }
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex(TABLE_NAME).whereIn('key', EXTENSIONS).delete()
}
