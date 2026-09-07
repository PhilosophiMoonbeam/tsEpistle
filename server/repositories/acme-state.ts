import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AcmeAccount, AcmeCertificate } from 'acme'
import type { RootKeypair } from '@root/keypairs'

export class AcmeStateError extends Error {}

export interface AcmeSavedState extends Record<string, unknown> {
  account?: AcmeAccount
  accountKeypair?: RootKeypair
  domain?: string
  payload?: AcmeCertificate
  serverKey?: string
  revision?: string
}
interface Row {
  key: string
  value: unknown
  updatedAt: string
}
export interface AcmeStateSnapshot {
  value: AcmeSavedState
  token: string
}
export interface AcmeStateStore {
  read(): Promise<AcmeStateSnapshot>
  save(expected: AcmeStateSnapshot, value: AcmeSavedState): Promise<AcmeStateSnapshot>
  exclusive<T>(task: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T>
}
const record = (value: unknown): AcmeSavedState => {
  const copy = value && typeof value === 'object' && !Array.isArray(value) ? (structuredClone(value) as AcmeSavedState) : {}
  delete copy.challenge
  return copy
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const snapshot = (row: Row | undefined, fallback: AcmeSavedState): AcmeStateSnapshot => ({
  value: record(row?.value ?? fallback),
  token: stable(row ? [record(row.value), row.updatedAt] : ['absent', record(fallback)])
})
/** Internal snapshots include private material. Only public certificate evidence may leave the service. */
export const createAcmeStateStore = (db: Knex, fallback: () => AcmeSavedState): AcmeStateStore => ({
  async read() {
    return snapshot(await db<Row>('settings').where('key', 'letsencrypt').first(), fallback())
  },
  async save(expected, input) {
    return db.transaction(async tx => {
      const row = await tx<Row>('settings').where('key', 'letsencrypt').forUpdate().first()
      if (snapshot(row, fallback()).token !== expected.token)
        throw new AcmeStateError('Saved ACME state changed. Reload before requesting another certificate.')
      const value = { ...record(input), revision: randomUUID() },
        updatedAt = new Date().toISOString()
      if (row)
        await tx('settings')
          .where('key', 'letsencrypt')
          .update({ value: JSON.stringify(value), updatedAt })
      else await tx('settings').insert({ key: 'letsencrypt', value: JSON.stringify(value), updatedAt })
      return snapshot({ key: 'letsencrypt', value, updatedAt }, value)
    })
  },
  async exclusive(task) {
    const connection = await db.client.acquireConnection()
    let locked = false,
      reusable = false
    try {
      const result = await db.raw('SELECT pg_try_advisory_lock(?, ?) AS locked', [1414743376, 443]).connection(connection)
      locked = result.rows?.[0]?.locked === true
      reusable = true
      if (!locked) throw new AcmeStateError('Another certificate request is already in progress.')
      const assertHeld = async () => {
        const held = await db
          .raw(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted) AS held",
            [1414743376, 443]
          )
          .connection(connection)
        if (held.rows?.[0]?.held !== true) throw new AcmeStateError('Certificate request lock was lost. Inspect saved state before retrying.')
      }
      return await task(assertHeld)
    } finally {
      if (locked) {
        try {
          const result = await db.raw('SELECT pg_advisory_unlock(?, ?) AS unlocked', [1414743376, 443]).connection(connection)
          reusable = result.rows?.[0]?.unlocked === true
        } catch {
          reusable = false
        }
      }
      if (reusable) await db.client.releaseConnection(connection)
      else {
        // PostgreSQL's end/error hooks mark this connection disposed; pool validation
        // then discards it. Release the pool resource even when termination reports failure.
        try {
          await db.client.destroyRawConnection(connection)
        } finally {
          await db.client.releaseConnection(connection)
        }
      }
    }
  }
})
