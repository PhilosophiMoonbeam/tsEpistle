import type { Knex } from 'knex'

const ASSET_HASH_UNIQUE = 'assets_hash_unique'
const ASSET_DATA_ASSET_FK = 'asset_data_asset_fk'

export const up = async (knex: Knex): Promise<void> => {
  const duplicate = await knex('assets').select('hash').groupBy('hash').havingRaw('COUNT(*) > 1').first()
  if (duplicate) throw new Error(`Duplicate asset identity ${duplicate.hash}; refuse to add assets.hash uniqueness`)

  const orphanData = await knex('assetData as data').leftJoin('assets as asset', 'asset.id', 'data.id').whereNull('asset.id').first('data.id')
  if (orphanData) throw new Error(`assetData ${orphanData.id} has no asset; refuse to add asset data foreign key`)

  const missingData = await knex('assets as asset').leftJoin('assetData as data', 'data.id', 'asset.id').whereNull('data.id').first('asset.id')
  if (missingData) throw new Error(`Asset ${missingData.id} has no assetData; refuse to enforce asset aggregate integrity`)

  await knex.schema.alterTable('assets', table => {
    table.unique(['hash'], { indexName: ASSET_HASH_UNIQUE })
  })
  await knex.schema.alterTable('assetData', table => {
    table.foreign('id', ASSET_DATA_ASSET_FK).references('id').inTable('assets').onDelete('CASCADE')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('assetData', table => {
    table.dropForeign(['id'], ASSET_DATA_ASSET_FK)
  })
  await knex.schema.alterTable('assets', table => {
    table.dropUnique(['hash'], ASSET_HASH_UNIQUE)
  })
}
