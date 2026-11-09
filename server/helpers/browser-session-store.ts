import { randomUUID } from 'node:crypto'
import type { Request, RequestHandler } from 'express'
import session from 'express-session'
import type { Knex } from 'knex'

const lifetimeMilliseconds = 86_400_000
const lifecycleTable = 'browserSessionLifecycles'

interface SessionMarker {
  sid: string
  generation: string
  createBefore: number | null
}
interface Lifecycle {
  sid: string
  generation: string
  retiredAt: Date | null
  expiresAt: Date
}
interface StoreOptions {
  knex: Knex
  cleanupInterval?: number
  onDbCleanupError?: (error: unknown) => void
}

class RetiredBrowserSessionError extends Error {
  readonly code = 'BROWSER_SESSION_RETIRED'
  constructor() {
    super('The browser session is no longer current.')
  }
}

const cleanupBatchSize = 256

/** Native Express sessions with creation capabilities and durable retirement.
 * Session JSON, cookie policy and independent account/federation authority are
 * unchanged. Cutover must drain old unconditional connect-session-knex writers.
 */
export class BrowserSessionStore extends session.Store {
  readonly options: { knex: Knex; cleanupInterval: number; onDbCleanupError: (error: unknown) => void }
  readonly ready: Promise<void>
  private readonly markers = new WeakMap<object, SessionMarker>()
  private timer?: NodeJS.Timeout
  private cleanupPending: Promise<void> | undefined
  private closed = false
  // express-session installs this function during middleware construction.
  declare generate: (request: Request) => void

  constructor(options: StoreOptions) {
    super()
    this.options = {
      knex: options.knex,
      cleanupInterval: options.cleanupInterval ?? 60_000,
      onDbCleanupError: options.onDbCleanupError ?? (error => console.error(error))
    }
    this.ready = (async () => {
      for (const table of ['sessions', lifecycleTable]) {
        if (!(await options.knex.schema.hasTable(table))) throw new Error(`Missing ${table} table; run browser-session migrations before HTTP startup.`)
      }
    })()
    if (this.options.cleanupInterval > 0) this.runScheduledCleanup()
  }

  middleware(options: Omit<session.SessionOptions, 'store'>): RequestHandler {
    const middleware = session({ ...options, store: this })
    const nativeGenerate = this.generate
    this.generate = request => {
      nativeGenerate(request)
      this.markers.set(request.session, {
        sid: request.sessionID,
        generation: randomUUID(),
        // A never-saved request cannot outlive a retirement tombstone and then
        // regain INSERT authority after bounded tombstone retention.
        createBefore: Date.now() + lifetimeMilliseconds
      })
    }
    return middleware
  }

  override createSession(request: Request, data: session.SessionData): session.Session & session.SessionData {
    const marker = this.markers.get(data)
    if (!marker || marker.sid !== request.sessionID) throw new RetiredBrowserSessionError()
    const materialized = super.createSession(request, data)
    this.markers.set(materialized, { ...marker, createBefore: null })
    return materialized
  }

  override get(sid: string, callback: (error: unknown, data?: session.SessionData | null) => void): void {
    const operation = (async () => {
      await this.ready
      return await this.options.knex.transaction(async transaction => {
        let lifecycle = await transaction<Lifecycle>(lifecycleTable).where({ sid }).forUpdate().first()
        if (!lifecycle) {
          // Admit a legacy live row, never an absent SID or a retirement. The
          // conflict path re-locks the winner, including concurrent destroy.
          const legacy = await transaction('sessions').where({ sid }).where('expired', '>', transaction.raw('clock_timestamp()')).first('expired')
          if (!legacy) return null
          await transaction(lifecycleTable).insert({ sid, generation: randomUUID(), retiredAt: null, expiresAt: legacy.expired }).onConflict('sid').ignore()
          lifecycle = await transaction<Lifecycle>(lifecycleTable).where({ sid }).forUpdate().first()
        }
        if (!lifecycle || lifecycle.retiredAt !== null) return null
        const row = await transaction('sessions').where({ sid }).where('expired', '>', transaction.raw('clock_timestamp()')).first('sess')
        if (!row) return null
        const data = (typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess) as session.SessionData
        this.markers.set(data, { sid, generation: lifecycle.generation, createBefore: null })
        return data
      })
    })()
    void operation.then(data => callback(null, data), error => callback(error))
  }

  override set(sid: string, data: session.SessionData, callback?: (error?: unknown) => void): void {
    this.complete(this.write(sid, data, false), callback)
  }

  override touch(sid: string, data: session.SessionData, callback?: (error?: unknown) => void): void {
    this.complete(this.write(sid, data, true), callback)
  }

  private async write(sid: string, data: session.SessionData, touch: boolean): Promise<void> {
    const marker = this.markers.get(data)
    if (!marker || marker.sid !== sid || (marker.createBefore !== null && marker.createBefore <= Date.now())) throw new RetiredBrowserSessionError()
    await this.ready
    await this.options.knex.transaction(async transaction => {
      if (marker.createBefore !== null && !touch) {
        await transaction(lifecycleTable).insert({
          sid, generation: marker.generation, retiredAt: null, expiresAt: new Date(marker.createBefore)
        }).onConflict('sid').ignore()
      }
      const lifecycle = await transaction<Lifecycle>(lifecycleTable).where({ sid }).forUpdate().first()
      if (!lifecycle || lifecycle.generation !== marker.generation || lifecycle.retiredAt !== null) throw new RetiredBrowserSessionError()
      const row = await transaction('sessions').where({ sid }).select('sid', transaction.raw('expired > clock_timestamp() AS live')).first()
      if ((row && !row.live) || (!row && (marker.createBefore === null || touch))) throw new RetiredBrowserSessionError()
      // clock_timestamp(), unlike CURRENT_TIMESTAMP, advances while a
      // transaction waits on another instance's lifecycle lock.
      const clock = await transaction.raw<{ rows: { now: Date }[] }>('SELECT clock_timestamp() AS now')
      const now = clock.rows[0]!.now.getTime()
      if (marker.createBefore !== null && marker.createBefore <= now) throw new RetiredBrowserSessionError()
      const expires = data.cookie.expires
      const maxAge = data.cookie.maxAge
      if ((expires && new Date(expires).getTime() <= now) || (maxAge !== undefined && maxAge !== null && (!Number.isFinite(maxAge) || maxAge < 0))) throw new RetiredBrowserSessionError()
      // Preserve the installed store's default one-day browser-session TTL.
      const expired = new Date(now + (maxAge || lifetimeMilliseconds))
      if (touch && !expires) return
      const values = touch ? { expired: new Date(expires!) } : { expired, sess: JSON.stringify(data) }
      if (row) {
        const updated = await transaction('sessions').where({ sid }).where('expired', '>', transaction.raw('clock_timestamp()')).update(values)
        if (updated !== 1) throw new RetiredBrowserSessionError()
      } else {
        await transaction('sessions').insert({ sid, ...values })
      }
      await transaction(lifecycleTable).where({ sid, generation: marker.generation }).whereNull('retiredAt').update({ expiresAt: values.expired })
    })
    // Only committed persistence turns a creation capability into UPDATE-only.
    marker.createBefore = null
  }

  override destroy(sid: string, callback?: (error?: unknown) => void): void {
    const operation = (async () => {
      await this.ready
      await this.options.knex.transaction(async transaction => {
        await transaction(lifecycleTable).insert({
          sid, generation: randomUUID(), retiredAt: null,
          expiresAt: transaction.raw("clock_timestamp() + interval '1 day'")
        }).onConflict('sid').ignore()
        const lifecycle = await transaction<Lifecycle>(lifecycleTable).where({ sid }).forUpdate().first()
        if (!lifecycle) throw new RetiredBrowserSessionError()
        await transaction(lifecycleTable).where({ sid }).update({
          retiredAt: transaction.raw('clock_timestamp()'),
          expiresAt: transaction.raw("clock_timestamp() + interval '1 day'")
        })
        await transaction('sessions').where({ sid }).delete()
      })
    })()
    this.complete(operation, callback)
  }

  /** Bound each expiry/retirement pass; expired sessions remain unreadable between passes. */
  cleanup(): Promise<void> {
    if (this.cleanupPending) return this.cleanupPending
    const operation = (async () => {
      await this.ready
      await this.options.knex.transaction(async transaction => {
        const candidates = await transaction('sessions').select('sid').where('expired', '<=', transaction.raw('clock_timestamp()'))
          .union(transaction(lifecycleTable).select('sid').whereNotNull('retiredAt').where('expiresAt', '<=', transaction.raw('clock_timestamp()')))
          .union(transaction(lifecycleTable).select('sid').whereNull('retiredAt').whereNotExists(function missingSession() {
            this.select(transaction.raw('1')).from('sessions').whereRaw('?? = ??', ['sessions.sid', `${lifecycleTable}.sid`])
          })).orderBy('sid').limit(cleanupBatchSize)
        for (const { sid } of candidates) {
          // An expired legacy row may not have been read since migration.
          await transaction(lifecycleTable).insert({
            sid, generation: randomUUID(), retiredAt: null,
            expiresAt: transaction.raw("clock_timestamp() + interval '1 day'")
          }).onConflict('sid').ignore()
          const lifecycle = await transaction<Lifecycle>(lifecycleTable).where({ sid }).forUpdate().first()
          if (!lifecycle) continue
          const live = await transaction('sessions').where({ sid }).where('expired', '>', transaction.raw('clock_timestamp()')).first('sid')
          if (lifecycle.retiredAt === null && live) continue
          if (lifecycle.retiredAt === null) {
            await transaction(lifecycleTable).where({ sid }).update({
              retiredAt: transaction.raw('clock_timestamp()'),
              expiresAt: transaction.raw("clock_timestamp() + interval '1 day'")
            })
          }
          await transaction('sessions').where({ sid }).delete()
          await transaction(lifecycleTable).where({ sid }).whereNotNull('retiredAt').where('expiresAt', '<=', transaction.raw('clock_timestamp()')).delete()
        }
      })
    })()
    this.cleanupPending = operation
    void operation.then(() => { this.cleanupPending = undefined }, () => { this.cleanupPending = undefined })
    return operation
  }

  private runScheduledCleanup(): void {
    void this.cleanup().catch(error => this.options.onDbCleanupError(error)).finally(() => {
      if (!this.closed) this.timer = setTimeout(() => this.runScheduledCleanup(), this.options.cleanupInterval).unref()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    // Do not destroy the application's shared pool or cancel in-flight SQL.
    await this.cleanupPending
  }

  private complete(operation: Promise<void>, callback?: (error?: unknown) => void): void {
    void operation.then(() => callback?.(), error => {
      if (callback) callback(error)
      else this.emit('error', error)
    })
  }
}
