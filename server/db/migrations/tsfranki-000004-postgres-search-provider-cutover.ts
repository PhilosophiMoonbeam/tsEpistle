import type { Knex } from 'knex'

const SEARCH_ENGINES = 'searchEngines'
const STORAGE_TARGETS = 'storage'
const REMOVED_SEARCH_ENGINES = ['algolia', 'elasticsearch', 'aws', 'azure', 'manticore', 'solr', 'sphinx', 'db']
const REMOVED_STORAGE_TARGETS = ['box', 'dropbox', 'gdrive', 'onedrive']

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const postgres = await transaction(SEARCH_ENGINES).where({ key: 'postgres' }).first('key')
    if (!postgres) {
      await transaction(SEARCH_ENGINES).insert({
        key: 'postgres',
        isEnabled: false,
        config: JSON.stringify({ dictLanguage: 'english' })
      })
    }

    await transaction(SEARCH_ENGINES).update({ isEnabled: false })
    await transaction(SEARCH_ENGINES).where({ key: 'postgres' }).update({ isEnabled: true })
    await transaction(SEARCH_ENGINES).whereIn('key', REMOVED_SEARCH_ENGINES).delete()
    await transaction(STORAGE_TARGETS).whereIn('key', REMOVED_STORAGE_TARGETS).delete()
  })
}

export const down = async (): Promise<void> => {
  // Removed provider definitions and their configuration cannot be reconstructed.
}
