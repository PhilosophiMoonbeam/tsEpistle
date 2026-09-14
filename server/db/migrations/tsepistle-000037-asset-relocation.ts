import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { isStorageInternalPath } from '../../modules/storage/internal-path.ts'

const ASSET_TABLE = 'assets'
const ASSET_FOLDERS_TABLE = 'assetFolders'
const PROTECTED_ASSETS_TABLE = 'pageProtectedAssets'
const DURABLE_JOBS_TABLE = 'durableJobs'
const ASSET_PATH_UNIQUE = 'assets_folder_filename_unique'
const PROTECTED_ASSET_ID_INDEX = 'page_protected_assets_asset_id_lookup'
const OPERATIONS_TABLE = 'assetRelocationOperations'
const EFFECTS_TABLE = 'assetRelocationEffects'
const ROLLBACK_ERROR =
  'Cannot roll down asset relocation migration while relocation state or protected asset identity would be lost. Preserve it and apply a forward fix or restore a compatible database backup.'
const ROLLBACK_LOCK_TABLES = [ASSET_TABLE, ASSET_FOLDERS_TABLE, PROTECTED_ASSETS_TABLE, OPERATIONS_TABLE, DURABLE_JOBS_TABLE, EFFECTS_TABLE]

const usesPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLocaleLowerCase())

const lockTableForRollback = async (knex: Knex, tableName: string): Promise<void> => {
  if (usesPostgres(knex)) await knex.raw(`LOCK TABLE "${tableName}" IN SHARE ROW EXCLUSIVE MODE`)
}

const hasRows = async (knex: Knex, tableName: string, where?: Record<string, unknown>): Promise<boolean> => {
  if (!(await knex.schema.hasTable(tableName))) return false
  const query = knex(tableName).select('*')
  if (where) query.where(where)
  return Boolean(await query.first())
}
const hasAssetRelocationJobs = async (knex: Knex): Promise<boolean> => {
  if (!(await knex.schema.hasTable(DURABLE_JOBS_TABLE))) return false
  if (!(await knex.schema.hasColumn(DURABLE_JOBS_TABLE, 'type'))) throw new Error(ROLLBACK_ERROR)
  return hasRows(knex, DURABLE_JOBS_TABLE, { type: 'asset-relocation' })
}

const positiveInteger = (value: unknown): number | null => {
  const candidate = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null
}

const nullableInteger = (value: unknown): number | null | undefined => {
  if (value === null) return null
  const candidate = positiveInteger(value)
  if (candidate !== null) return candidate
  if (value === 0 || value === '0') return 0
  return undefined
}

interface AssetBindingRow {
  readonly assetId: unknown
  readonly assetPath: unknown
}

interface AssetIdentityRow {
  readonly id: unknown
  readonly hash: unknown
  readonly filename: unknown
  readonly folderId: unknown
}

interface AssetFolderIdentityRow {
  readonly id: unknown
  readonly slug: unknown
  readonly parentId: unknown
}

const validPathSegment = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0')

const loadAssetFolderRows = async (knex: Knex): Promise<Map<number, AssetFolderIdentityRow> | null> => {
  if (!(await knex.schema.hasTable(ASSET_FOLDERS_TABLE))) return null
  if (
    !(await knex.schema.hasColumn(ASSET_FOLDERS_TABLE, 'id')) ||
    !(await knex.schema.hasColumn(ASSET_FOLDERS_TABLE, 'slug')) ||
    !(await knex.schema.hasColumn(ASSET_FOLDERS_TABLE, 'parentId'))
  )
    return null
  const rows = (await knex<AssetFolderIdentityRow>(ASSET_FOLDERS_TABLE).select('id', 'slug', 'parentId')) as AssetFolderIdentityRow[]
  const byId = new Map<number, AssetFolderIdentityRow>()
  for (const row of rows) {
    const id = positiveInteger(row.id)
    if (id === null || byId.has(id)) return null
    byId.set(id, row)
  }
  return byId
}

const canonicalAssetPath = (asset: AssetIdentityRow, folders: Map<number, AssetFolderIdentityRow> | null): string | null => {
  if (!validPathSegment(asset.filename)) return null
  const folderId = nullableInteger(asset.folderId)
  if (folderId === undefined) return null
  if (folderId === null || folderId === 0) return asset.filename
  if (!folders) return null

  const segments: string[] = []
  const seen = new Set<number>()
  let currentId: number | null = folderId
  while (currentId !== null) {
    if (seen.has(currentId)) return null
    seen.add(currentId)
    const folder = folders.get(currentId)
    if (!folder || !validPathSegment(folder.slug)) return null
    segments.push(folder.slug)
    const parentId = nullableInteger(folder.parentId)
    if (parentId === undefined || parentId === 0) return null
    currentId = parentId
  }
  segments.reverse()
  return `${segments.join('/')}/${asset.filename}`
}

const validateProtectedAssetBindings = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(PROTECTED_ASSETS_TABLE)) || !(await knex.schema.hasColumn(PROTECTED_ASSETS_TABLE, 'assetId'))) return
  const hasAssetPath = await knex.schema.hasColumn(PROTECTED_ASSETS_TABLE, 'assetPath')
  const bindings = hasAssetPath
    ? await knex<AssetBindingRow>(PROTECTED_ASSETS_TABLE).whereNotNull('assetId').select('assetId', 'assetPath')
    : await knex<Pick<AssetBindingRow, 'assetId'>>(PROTECTED_ASSETS_TABLE).whereNotNull('assetId').select('assetId')
  if (bindings.length === 0) return
  if (!hasAssetPath) throw new Error(ROLLBACK_ERROR)
  if (
    !(await knex.schema.hasTable(ASSET_TABLE)) ||
    !(await knex.schema.hasColumn(ASSET_TABLE, 'id')) ||
    !(await knex.schema.hasColumn(ASSET_TABLE, 'hash')) ||
    !(await knex.schema.hasColumn(ASSET_TABLE, 'filename')) ||
    !(await knex.schema.hasColumn(ASSET_TABLE, 'folderId'))
  )
    throw new Error(ROLLBACK_ERROR)

  const assets = (await knex<AssetIdentityRow>(ASSET_TABLE).select('id', 'hash', 'filename', 'folderId')) as AssetIdentityRow[]
  const byHash = new Map<string, AssetIdentityRow[]>()
  for (const asset of assets) {
    if (typeof asset.hash !== 'string' || asset.hash.length === 0) throw new Error(ROLLBACK_ERROR)
    const matches = byHash.get(asset.hash) ?? []
    matches.push(asset)
    byHash.set(asset.hash, matches)
  }
  const folders = await loadAssetFolderRows(knex)

  for (const binding of bindings as AssetBindingRow[]) {
    if (typeof binding.assetPath !== 'string' || binding.assetPath.length === 0 || isStorageInternalPath(binding.assetPath)) throw new Error(ROLLBACK_ERROR)
    const expectedHash = assetHash(binding.assetPath)
    const matches = byHash.get(expectedHash)
    if (!matches || matches.length !== 1) throw new Error(ROLLBACK_ERROR)
    const asset = matches[0]
    if (!asset) throw new Error(ROLLBACK_ERROR)
    const boundId = positiveInteger(binding.assetId)
    const currentId = positiveInteger(asset.id)
    if (boundId === null || currentId === null || boundId !== currentId) throw new Error(ROLLBACK_ERROR)
    if (asset.hash !== expectedHash || canonicalAssetPath(asset, folders) !== binding.assetPath) throw new Error(ROLLBACK_ERROR)
  }
}

const assetPathKey = (folderId: unknown, filename: unknown): string =>
  `${folderId === null || folderId === undefined ? 0 : String(folderId)}:${String(filename).toLowerCase()}`

const assetHash = (assetPath: string): string => createHash('sha1').update(assetPath).digest('hex')

const createAssetPathConstraint = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('assets'))) return
  if (!(await knex.schema.hasColumn('assets', 'folderId')) || !(await knex.schema.hasColumn('assets', 'filename'))) return
  const rows = (await knex('assets').select('folderId', 'filename')) as Array<{ folderId: number | null; filename: string }>
  const seen = new Set<string>()
  for (const row of rows) {
    const key = assetPathKey(row.folderId, row.filename)
    if (seen.has(key)) throw new Error(`Duplicate asset path ${row.folderId ?? 0}/${row.filename}; refuse to add asset path uniqueness`)
    seen.add(key)
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "${ASSET_PATH_UNIQUE}" ON "assets" (COALESCE("folderId", 0), lower("filename"))`)
}
const addProtectedAssetIdentity = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('pageProtectedAssets'))) return
  if (!(await knex.schema.hasColumn('pageProtectedAssets', 'pageId')) || !(await knex.schema.hasColumn('pageProtectedAssets', 'assetPath'))) return
  if (!(await knex.schema.hasColumn('pageProtectedAssets', 'assetId'))) {
    await knex.schema.alterTable('pageProtectedAssets', table => {
      table.integer('assetId').unsigned().nullable()
    })
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS "${PROTECTED_ASSET_ID_INDEX}" ON "pageProtectedAssets" ("assetId")`)
  if (!(await knex.schema.hasTable('assets'))) return
  if (!(await knex.schema.hasColumn('assets', 'hash'))) return
  const links = (await knex('pageProtectedAssets').select('pageId', 'assetPath')) as Array<{ pageId: number; assetPath: string }>
  for (const link of links) {
    const path = typeof link.assetPath === 'string' ? link.assetPath : ''
    if (!path) continue
    const asset = await knex<{ id: number }>('assets').where('hash', assetHash(path)).first('id')
    const assetId = asset?.id
    if (typeof assetId === 'number' && Number.isSafeInteger(assetId) && assetId > 0) {
      await knex('pageProtectedAssets').where({ pageId: link.pageId, assetPath: path }).update({ assetId })
    }
  }
}

const createRelocationTables = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(OPERATIONS_TABLE))) {
    await knex.schema.createTable(OPERATIONS_TABLE, table => {
      table.uuid('id').primary()
      table.integer('assetId').unsigned().nullable()
      table.integer('actorId').unsigned().nullable()
      table.string('sourcePath', 512).notNullable()
      table.string('destinationPath', 512).notNullable()
      table.string('sourceHash', 64).notNullable()
      table.string('destinationHash', 64).notNullable()
      table.string('contentSha256', 64).notNullable()
      table.string('status', 16).notNullable().defaultTo('pending')
      table.text('lastError').nullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.dateTime('completedAt').nullable()
      table.index(['assetId', 'createdAt'], 'asset_relocation_asset_time_idx')
      table.index(['status', 'updatedAt'], 'asset_relocation_status_idx')
    })
  }
  if (!(await knex.schema.hasTable(EFFECTS_TABLE))) {
    await knex.schema.createTable(EFFECTS_TABLE, table => {
      table.uuid('id').primary()
      table.uuid('operationId').notNullable().references('id').inTable(OPERATIONS_TABLE).onDelete('CASCADE')
      table.uuid('jobId').notNullable().references('id').inTable('durableJobs').onDelete('CASCADE')
      table.integer('assetId').unsigned().notNullable()
      table.string('targetKey', 128).notNullable()
      table.string('targetConfigurationRevision', 128).notNullable()
      table.string('sourcePath', 512).notNullable()
      table.string('destinationPath', 512).notNullable()
      table.string('contentSha256', 64).notNullable()
      table.string('status', 16).notNullable().defaultTo('pending')
      table.text('lastError').nullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.dateTime('completedAt').nullable()
      table.unique(['operationId', 'targetKey', 'targetConfigurationRevision'], { indexName: 'asset_relocation_effect_identity_unique' })
      table.index(['status', 'updatedAt'], 'asset_relocation_effect_status_idx')
      table.index(['assetId', 'targetKey'], 'asset_relocation_effect_asset_target_idx')
    })
  }
}

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    await createAssetPathConstraint(transaction)
    await addProtectedAssetIdentity(transaction)
    await createRelocationTables(transaction)
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const existingTables: string[] = []
    for (const tableName of ROLLBACK_LOCK_TABLES) {
      if (await transaction.schema.hasTable(tableName)) existingTables.push(tableName)
    }
    for (const tableName of existingTables) await lockTableForRollback(transaction, tableName)

    if ((await hasRows(transaction, EFFECTS_TABLE)) || (await hasRows(transaction, OPERATIONS_TABLE)) || (await hasAssetRelocationJobs(transaction)))
      throw new Error(ROLLBACK_ERROR)
    await validateProtectedAssetBindings(transaction)

    if (await transaction.schema.hasTable(EFFECTS_TABLE)) await transaction.schema.dropTable(EFFECTS_TABLE)
    if (await transaction.schema.hasTable(OPERATIONS_TABLE)) await transaction.schema.dropTable(OPERATIONS_TABLE)
    if (await transaction.schema.hasTable(PROTECTED_ASSETS_TABLE)) {
      await transaction.raw(`DROP INDEX IF EXISTS "${PROTECTED_ASSET_ID_INDEX}"`)
      if (await transaction.schema.hasColumn(PROTECTED_ASSETS_TABLE, 'assetId')) {
        await transaction.schema.alterTable(PROTECTED_ASSETS_TABLE, table => {
          table.dropColumn('assetId')
        })
      }
    }
    if (await transaction.schema.hasTable(ASSET_TABLE)) await transaction.raw(`DROP INDEX IF EXISTS "${ASSET_PATH_UNIQUE}"`)
  })
}
