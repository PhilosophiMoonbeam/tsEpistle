import type { Knex } from 'knex'

const ASSET_LOCATION_LOCK = 0x41534c54
const ASSET_LOCATION_FENCE = 0x41534c46
const ASSET_LOCATION_FENCE_KEY = 1
const localLocks = new Map<string, Promise<void>>()

export class AssetLocationBusyError extends Error {
  readonly status = 409
  readonly code = 'ASSET_LOCATION_BUSY'

  constructor() {
    super('Asset location is still being reconciled.')
    this.name = 'AssetLocationBusyError'
  }
}

type AssertHeld = () => Promise<void>
type AssetLocationWork<T> = (assertHeld?: AssertHeld) => Promise<T>

const databaseType = (): string | undefined => {
  const runtime = (globalThis as typeof globalThis & { WIKI?: unknown }).WIKI
  if (!runtime || typeof runtime !== 'object') return undefined
  const config = Reflect.get(runtime, 'config')
  if (!config || typeof config !== 'object') return undefined
  const db = Reflect.get(config, 'db')
  return db && typeof db === 'object' && typeof Reflect.get(db, 'type') === 'string' ? Reflect.get(db, 'type') : undefined
}

const noOpAssertHeld: AssertHeld = async () => undefined

/**
 * Hold the single cross-process asset mutation fence on a pinned PostgreSQL
 * session. Remote storage calls intentionally happen outside a transaction,
 * so this must not use a transaction-scoped advisory lock.
 */
export const withAssetLocationFence = async <T>(db: Knex, work: (assertHeld: AssertHeld) => Promise<T>): Promise<T> => {
  if (databaseType() !== 'postgres' || typeof db.client?.acquireConnection !== 'function') return work(noOpAssertHeld)

  const connection = await db.client.acquireConnection()
  let locked = false
  let reusable = false
  try {
    const result = await db.raw('SELECT pg_try_advisory_lock(?, ?) AS locked', [ASSET_LOCATION_FENCE, ASSET_LOCATION_FENCE_KEY]).connection(connection)
    locked = result.rows?.[0]?.locked === true
    reusable = true
    if (!locked) throw new AssetLocationBusyError()

    const assertHeld: AssertHeld = async () => {
      const held = await db
        .raw(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted) AS held",
          [ASSET_LOCATION_FENCE, ASSET_LOCATION_FENCE_KEY]
        )
        .connection(connection)
      if (held.rows?.[0]?.held !== true) throw new AssetLocationBusyError()
    }
    return await work(assertHeld)
  } finally {
    if (locked) {
      try {
        const result = await db.raw('SELECT pg_advisory_unlock(?, ?) AS unlocked', [ASSET_LOCATION_FENCE, ASSET_LOCATION_FENCE_KEY]).connection(connection)
        reusable = result.rows?.[0]?.unlocked === true
      } catch {
        reusable = false
      }
    }
    if (reusable) await db.client.releaseConnection(connection)
    else {
      try {
        await db.client.destroyRawConnection(connection)
      } finally {
        await db.client.releaseConnection(connection)
      }
    }
  }
}

/** Serialize location-changing asset writes in one process and across PostgreSQL workers. */
export const withAssetLocationLocks = async <T>(keys: readonly string[], work: AssetLocationWork<T>, db?: Knex): Promise<T> => {
  const ordered = [...new Set(keys.filter(key => typeof key === 'string' && key.length > 0))].sort()
  const acquire = async (index: number, assertHeld?: AssertHeld): Promise<T> => {
    const key = ordered[index]
    if (key === undefined) return work(assertHeld)
    const previous = localLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>(resolve => {
            release = resolve
          })
      )
    localLocks.set(key, held)
    await previous.catch(() => undefined)
    try {
      return await acquire(index + 1, assertHeld)
    } finally {
      release()
      if (localLocks.get(key) === held) localLocks.delete(key)
    }
  }
  const run = (assertHeld?: AssertHeld): Promise<T> => acquire(0, assertHeld)
  return db ? withAssetLocationFence(db, assertHeld => run(assertHeld)) : run()
}

const relocationEffectTable = 'assetRelocationEffects'

/**
 * Unresolved effects retain both paths as reservations. Callers must perform
 * path authorization before invoking this helper; the helper deliberately
 * reports only a generic conflict.
 */
const hasRelocationEffectTable = async (transaction: Knex.Transaction): Promise<boolean> => {
  if (typeof transaction !== 'function') return false
  const schema = (transaction as unknown as { schema?: { hasTable?: (name: string) => Promise<boolean> } }).schema
  return !(schema && typeof schema.hasTable === 'function') || (await schema.hasTable(relocationEffectTable))
}

export const assertAssetLocationAssetSettled = async (transaction: Knex.Transaction, assetId: number): Promise<void> => {
  if (!Number.isSafeInteger(assetId) || assetId < 1 || !(await hasRelocationEffectTable(transaction))) return
  const row = await transaction(relocationEffectTable)
    .where('assetId', assetId)
    .where((query: Knex.QueryBuilder) => query.whereNot('status', 'succeeded').orWhereNull('status'))
    .first('id')
  if (row) throw new AssetLocationBusyError()
}

export const assertAssetLocationReservations = async (transaction: Knex.Transaction, paths: readonly string[]): Promise<void> => {
  const candidates = [...new Set(paths.filter(path => typeof path === 'string' && path.length > 0))]
  if (candidates.length === 0 || !(await hasRelocationEffectTable(transaction))) return
  const rows = await transaction(relocationEffectTable)
    .where(query => query.whereNot('status', 'succeeded').orWhereNull('status'))
    .where((query: Knex.QueryBuilder) => query.whereIn('sourcePath', candidates).orWhereIn('destinationPath', candidates))
    .select('id')
    .limit(1)
  if (rows.length > 0) throw new AssetLocationBusyError()
}

export const lockAssetLocation = async (transaction: Knex.Transaction, key: string): Promise<void> => {
  if (databaseType() !== 'postgres' || typeof transaction.raw !== 'function') return
  await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ASSET_LOCATION_LOCK, key])
}
